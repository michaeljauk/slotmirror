import type { OffboardingOwner } from "./account-sync";
import { auditStatement, errorLogFields, recordAudit } from "./audit";
import { HOLD_LEASE_MS, openTombstone } from "./cleanup";
import { parseRuleOptions } from "./config";
import { accountSync } from "./durable";
import { deleteEmptyFeeds, revokeFeeds } from "./feeds";
import { ruleTagFor } from "./sync/plan";
import { syncWindow } from "./sync/rules";

/**
 * Removing accounts and users, and pausing a user. The blocks go through the removal queue of each
 * target account's Durable Object, so a request never waits for the providers. An account that
 * goes retires: its Durable Object removes its queued blocks, then forgets the tokens. Every removal
 * has a tombstone in D1 before its job exists, see `src/cleanup.ts`, and ends with a result in the
 * tombstone and in the audit log, see `cleanup_finished`.
 *
 * A request that stops a rule writes a hold of its own, in the same D1 step. The hold states that the
 * rule ran. The rule runs again only once no hold is left and none of its accounts retires, so that
 * a failed request cannot start a rule that another request stopped. If a request dies or its answer
 * is unclear, its hold stays, and `releaseHeldRules()` reads it from the cron.
 */

interface OwnedRule {
  ruleId: string;
  sourceAccountId: string;
  targetAccountId: string;
  remoteCalendarId: string;
  calendarName: string;
  optionsJson: string;
  enabled: number;
  /** 1 if a hold stopped the rule: it ran before that offboarding. */
  held: number;
}

/**
 * A removal could not be queued, so the rows stay: without them no one knows the blocks. No account
 * went, and the rules run again. Removals of other target accounts stay queued and run to their end,
 * so the rules write their blocks again afterwards. The same request can run again; the caller's
 * error page says so.
 */
export class CleanupNotQueued extends Error {
  constructor(failed: number) {
    super(`${failed} block removals could not be queued`);
    this.name = "CleanupNotQueued";
  }
}

/**
 * Queue the removal of every block the rules wrote, with one call per target account. Returns the
 * rules whose removal is not queued.
 */
async function queueRemovals(
  env: Env,
  rules: OwnedRule[],
  offboarding?: OffboardingOwner,
): Promise<number> {
  const byTarget = Map.groupBy(rules, (rule) => rule.targetAccountId);
  let failed = 0;
  for (const [accountId, jobs] of byTarget) {
    try {
      await accountSync(env, accountId).queueRemovals(
        jobs.map(({ ruleId, remoteCalendarId }) => ({ ruleId, remoteCalendarId })),
        offboarding ? { offboarding: { ...offboarding, accountId } } : {},
      );
    } catch (error) {
      failed += jobs.length;
      console.error("Queueing removals failed", accountId, ...errorLogFields(error));
    }
  }
  return failed;
}

/** Rules that read from or write into any of the accounts, with both accounts. */
async function rulesOfAccounts(env: Env, accountIds: string[]): Promise<OwnedRule[]> {
  if (accountIds.length === 0) return [];
  const marks = accountIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT r.id AS ruleId, sc.account_id AS sourceAccountId, tc.account_id AS targetAccountId,
       tc.remote_id AS remoteCalendarId, tc.name AS calendarName, r.options AS optionsJson,
       r.enabled, EXISTS (SELECT 1 FROM rule_holds h WHERE h.rule_id = r.id) AS held
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id IN (${marks}) OR tc.account_id IN (${marks})`,
  )
    .bind(...accountIds, ...accountIds)
    .all<OwnedRule>();
  return results;
}

const ids = (rules: OwnedRule[]) => JSON.stringify(rules.map((rule) => rule.ruleId));

/** What a rule wrote: a period and a title for the tombstone. Broken options must not stop this. */
function blocksOf(rule: OwnedRule, now: number) {
  try {
    const options = parseRuleOptions(rule.optionsJson);
    const { start, end } = syncWindow(options, new Date(now));
    return {
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      // Any other detail level copies the title of each event.
      blockTitle: options.detailLevel === "busy" ? options.blockTitle : null,
    };
  } catch {
    return { windowStart: null, windowEnd: null, blockTitle: null };
  }
}

/** The statements that open a tombstone for every rule, for one D1 step with other writes. */
function tombstoneStatements(
  env: Env,
  rules: OwnedRule[],
  owner: OffboardingOwner,
  options?: { whileUserActive: boolean },
): Promise<D1PreparedStatement[]> {
  const now = Date.now();
  return Promise.all(
    rules.map(async (rule) =>
      openTombstone(
        env.DB,
        {
          accountId: rule.targetAccountId,
          remoteCalendarId: rule.remoteCalendarId,
          ruleId: rule.ruleId,
          orgId: owner.orgId,
          userId: owner.userId,
          calendarName: rule.calendarName,
          ruleTag: await ruleTagFor(rule.ruleId),
          openedAt: new Date(now).toISOString(),
          ruleWasOff: rule.enabled !== 1 && rule.held !== 1,
          ...blocksOf(rule, now),
        },
        options,
      ),
    ),
  );
}

/**
 * Hold the rules and open the tombstones in one D1 step. If it fails, nothing changed, so the
 * tombstones always exist before a job or a retirement does.
 */
async function stopRules(
  env: Env,
  hold: string,
  stopped: OwnedRule[],
  tombstones: D1PreparedStatement[],
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO rule_holds (rule_id, hold_id, until)
       SELECT id, ?, ? FROM rules WHERE id IN (SELECT value FROM json_each(?))`,
    ).bind(hold, Date.now() + HOLD_LEASE_MS, ids(stopped)),
    env.DB.prepare(
      "UPDATE rules SET enabled = 0 WHERE id IN (SELECT value FROM json_each(?))",
    ).bind(ids(stopped)),
    ...tombstones,
  ]);
}

/** Run a rule again, unless another request holds it too. */
function startUnlessHeld(env: Env, ruleId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE rules SET enabled = 1 WHERE id = ?
     AND NOT EXISTS (SELECT 1 FROM rule_holds h WHERE h.rule_id = rules.id)`,
  ).bind(ruleId);
}

/** End the holds of this request. A failure keeps them for `releaseHeldRules()`. */
function releaseHolds(env: Env, hold: string, rules: OwnedRule[]) {
  return env.DB.batch([
    env.DB.prepare(
      "DELETE FROM rule_holds WHERE hold_id = ? AND rule_id IN (SELECT value FROM json_each(?))",
    ).bind(hold, ids(rules)),
    ...rules.map((rule) => startUnlessHeld(env, rule.ruleId)),
  ]);
}

/**
 * Undo the retirement of an account that stays. Returns false if the answer is missing: the account
 * may still retire, so its rules must not run again.
 */
async function cancelRetirement(env: Env, accountId: string, generation: string): Promise<boolean> {
  try {
    await accountSync(env, accountId).cancelRetire(generation);
    return true;
  } catch (error) {
    console.error("Cancelling a retirement failed", accountId, ...errorLogFields(error));
    return false;
  }
}

/**
 * The accounts that may retire: any request started it, or no answer came. Their rules must not run
 * again.
 */
async function retiringAccounts(env: Env, accountIds: string[]): Promise<Set<string>> {
  const unclear = new Set<string>();
  for (const accountId of accountIds) {
    try {
      if (await accountSync(env, accountId).retiring()) unclear.add(accountId);
    } catch (error) {
      unclear.add(accountId);
      console.error("Reading a retirement failed", accountId, ...errorLogFields(error));
    }
  }
  return unclear;
}

/** Every account that the rules read from or write into. */
function accountsOf(rules: OwnedRule[]): string[] {
  return [...new Set(rules.flatMap((rule) => [rule.sourceAccountId, rule.targetAccountId]))];
}

/** The rules that touch none of the accounts. */
function rulesApartFrom(rules: OwnedRule[], accountIds: Set<string>): OwnedRule[] {
  return rules.filter(
    (rule) => !accountIds.has(rule.sourceAccountId) && !accountIds.has(rule.targetAccountId),
  );
}

/**
 * Run the stopped rules that touch no retiring account, also an account of another request. Holds of
 * the other rules stay for the cron. A removal may have run during the request, so the target
 * accounts sync at once. A failure is logged, so that the caller's error stays.
 */
async function resumeRules(
  env: Env,
  hold: string,
  accountIds: string[],
  stopped: OwnedRule[],
  unclear: Set<string> = new Set(),
): Promise<void> {
  try {
    const retiring = await retiringAccounts(env, accountsOf(stopped));
    const running = rulesApartFrom(stopped, new Set([...retiring, ...unclear]));
    await releaseHolds(env, hold, running);
    // The rules of accounts that went earlier in the request left with them.
    const released = new Set(running.map((rule) => rule.ruleId));
    const left = await rulesOfAccounts(env, accountIds);
    const targets = new Set(
      left.filter((rule) => released.has(rule.ruleId)).map((rule) => rule.targetAccountId),
    );
    for (const accountId of targets) await accountSync(env, accountId).requestSync();
  } catch (error) {
    console.error("Resuming rules failed", ...errorLogFields(error));
  }
}

/** Record that the accounts stay. */
async function reportKept(
  env: Env,
  user: { id: string; orgId: string },
  accountIds: string[],
  detail: Record<string, number | boolean>,
): Promise<void> {
  for (const accountId of accountIds) {
    await recordAudit(env.DB, {
      orgId: user.orgId,
      userId: user.id,
      accountId,
      kind: "account_disconnect_failed",
      detail,
    });
  }
}

/**
 * Disconnect accounts of a user: every block that involves them is queued for removal, the
 * accounts retire, and their rows go with their calendars and rules. If a removal cannot be queued,
 * nothing goes and this throws `CleanupNotQueued`. If an account cannot retire or its row cannot
 * go, it and the accounts after it stay, and this throws that error. A job that is queued then runs
 * to its end all the same, and a rule that runs again writes its blocks back. A rule runs again only
 * if none of its accounts retires. If the undo fails, its rules stay held, the account can still go,
 * and its row then shows that it needs a reconnect.
 */
export async function removeAccounts(
  env: Env,
  user: { id: string; orgId: string },
  accountIds: string[],
): Promise<void> {
  const rules = await rulesOfAccounts(env, accountIds);
  // A rule that another request stopped counts too: if both fail, the rule still has to run again.
  const stopped = rules.filter((rule) => rule.enabled === 1 || rule.held === 1);
  // Made here: the answer of `retire()` can get lost, and the cancel still has to name it.
  const generation = crypto.randomUUID();
  const owner = { orgId: user.orgId, userId: user.id };
  // The rules stop before the first job exists: a full cycle would write the blocks again.
  await stopRules(env, generation, stopped, await tombstoneStatements(env, rules, owner));
  const failed = await queueRemovals(env, rules, owner);
  if (failed > 0) {
    await reportKept(env, user, accountIds, { rules: rules.length, cleanupFailed: failed });
    await resumeRules(env, generation, accountIds, stopped);
    throw new CleanupNotQueued(failed);
  }
  for (const [index, accountId] of accountIds.entries()) {
    try {
      await accountSync(env, accountId).retire(generation);
      await env.DB.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?")
        .bind(accountId, user.id)
        .run();
    } catch (error) {
      const kept = accountIds.slice(index);
      const cancelled = await cancelRetirement(env, accountId, generation);
      await reportKept(env, user, kept, { rules: rules.length, retireFailed: true });
      await resumeRules(env, generation, kept, stopped, new Set(cancelled ? [] : [accountId]));
      await deleteFeedsAfterFailure(env, user);
      throw error;
    }
    await recordAudit(env.DB, {
      orgId: user.orgId,
      userId: user.id,
      accountId,
      kind: "account_disconnected",
      // The result of each rule's removal follows in its own `cleanup_finished` event.
      detail: { rules: rules.length },
    });
  }
  // The accounts' calendars left every feed with them; a feed without calendars goes too.
  await deleteEmptyFeeds(env, user);
}

/**
 * Accounts that went before a failure can take the last calendar of a feed with them. A failure
 * here is logged, so that the caller's error stays.
 */
async function deleteFeedsAfterFailure(
  env: Env,
  user: { id: string; orgId: string },
): Promise<void> {
  try {
    await deleteEmptyFeeds(env, user);
  } catch (error) {
    console.error("Deleting empty feeds failed", ...errorLogFields(error));
  }
}

/** Who started a deletion or a change of state; recorded without names. */
export type Actor = "self" | "admin" | "scim";

/**
 * Delete a user with every account, rule, feed and block. Activity entries stay until retention.
 * Feeds go with the user row.
 */
export async function deleteUser(
  env: Env,
  user: { id: string; orgId: string },
  by: Actor,
): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM accounts WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string }>();
  await removeAccounts(
    env,
    user,
    results.map((row) => row.id),
  );
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run();
  // The user is gone, so the entry belongs to the org only. It says who acted, not who went.
  await recordAudit(env.DB, { orgId: user.orgId, kind: "user_deleted", detail: { by } });
}

/** The rules whose tombstone is open. A job of an ended tombstone is over. */
async function rulesWithOpenTombstone(env: Env, rules: OwnedRule[]): Promise<OwnedRule[]> {
  if (rules.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT rule_id AS ruleId FROM cleanup_tombstones
     WHERE state = 'open' AND rule_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(ids(rules))
    .all<{ ruleId: string }>();
  const open = new Set(results.map((row) => row.ruleId));
  return rules.filter((rule) => open.has(rule.ruleId));
}

/**
 * Deactivate or reactivate a user. Deactivated: sign-in and sessions stop, rules no longer run
 * and their blocks are removed; accounts and rules stay for a reactivation, which syncs again.
 * Free/busy feeds are deleted: a reactivation does not publish them again. The tombstones open in
 * the D1 step of the deactivation. If that step fails, nothing changed, and this throws. If a
 * removal cannot be queued, the user stays deactivated and this throws `CleanupNotQueued`. The same
 * request then queues the removals again. A request for a user who is deactivated already is no new
 * offboarding: it queues only the removals of open tombstones, and an ended tombstone stays ended,
 * unless its removal never started.
 */
export async function setUserActive(
  env: Env,
  user: { id: string; orgId: string },
  active: boolean,
  by: Actor,
): Promise<void> {
  const { results: accounts } = await env.DB.prepare("SELECT id FROM accounts WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string }>();
  const accountIds = accounts.map((row) => row.id);
  const owner = { orgId: user.orgId, userId: user.id };
  const rules = active ? [] : await rulesOfAccounts(env, accountIds);
  const tombstones = await tombstoneStatements(env, rules, owner, { whileUserActive: true });
  // The tombstones come first: they read whether the user is active. A deactivation also ends the
  // sessions for good: a reactivation must not revive them.
  const answers = await env.DB.batch([
    ...tombstones,
    env.DB.prepare(
      `UPDATE users SET active = ?, session_version = session_version + ?
       WHERE id = ? AND active <> ?`,
    ).bind(active ? 1 : 0, active ? 0 : 1, user.id, active ? 1 : 0),
  ]);
  const changed = (answers.at(-1)?.meta.changes ?? 0) > 0;
  if (active && !changed) return;
  let failed = 0;
  if (active) {
    for (const id of accountIds) await accountSync(env, id).requestSync();
  } else {
    const jobs = changed ? rules : await rulesWithOpenTombstone(env, rules);
    failed = await queueRemovals(env, jobs, owner);
  }
  if (changed) {
    // A feed is a grant to people outside the deployment; it ends with the user's access.
    if (!active) await revokeFeeds(env, user, "user_deactivated");
    await recordAudit(env.DB, {
      orgId: user.orgId,
      userId: user.id,
      kind: active ? "user_reactivated" : "user_deactivated",
      detail: { by },
    });
  }
  if (failed > 0) throw new CleanupNotQueued(failed);
}

/** Held rules that one cron invocation reads. */
export const HOLD_SWEEP_RULES = 4;

/** The most that the release of held rules costs: two accounts and a sync per rule, one D1 step. */
export const HOLD_SWEEP_SUBREQUESTS = 3 * HOLD_SWEEP_RULES + 1;

export interface HeldRule {
  ruleId: string;
  userId: string;
  orgId: string;
  sourceAccountId: string;
  targetAccountId: string;
}

/**
 * The rules whose holds ended their lease, as many as `budget` can release, those that waited longest
 * first. A rule that waits gets a new lease, so it goes behind the others. A rule stays out while a
 * request holds it within its lease.
 */
export function heldRulesStatement(
  env: Env,
  now: number,
  budget: number = HOLD_SWEEP_SUBREQUESTS,
): D1PreparedStatement {
  const limit = Math.max(0, Math.min(HOLD_SWEEP_RULES, Math.floor((budget - 1) / 2)));
  return env.DB.prepare(
    `SELECT r.id AS ruleId, r.user_id AS userId, u.org_id AS orgId,
       sc.account_id AS sourceAccountId, tc.account_id AS targetAccountId
     FROM rules r
     JOIN users u ON u.id = r.user_id
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE EXISTS (SELECT 1 FROM rule_holds h WHERE h.rule_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM rule_holds h WHERE h.rule_id = r.id AND h.until > ?)
     ORDER BY (SELECT MAX(h.until) FROM rule_holds h WHERE h.rule_id = r.id), r.id LIMIT ?`,
  ).bind(now, limit);
}

/**
 * Run the rules whose request failed and left its hold, or died. A failed D1 write in that request
 * or two failed requests in a row lose nothing: the holds name the rules. A rule waits while an
 * account of it retires or gives no answer. A reconnect ends a retirement, so a later call starts
 * the rule. An account without tokens that retires does not end by itself, so its rule waits until
 * a reconnect, and the order of `heldRulesStatement()` keeps it from blocking others. Only holds past their lease go:
 * a newer request may have stopped the rule since the read, and its hold keeps the rule off in the
 * same D1 step. With a small `budget`, the sync of a rule waits for its next tick. Returns the
 * subrequests that this call made.
 */
export async function releaseHeldRules(
  env: Env,
  held: HeldRule[],
  now: number,
  budget: number = HOLD_SWEEP_SUBREQUESTS,
): Promise<number> {
  if (held.length === 0) return 0;
  const accounts = [...new Set(held.flatMap((r) => [r.sourceAccountId, r.targetAccountId]))];
  const retiring = await retiringAccounts(env, accounts);
  const waits = held.filter(
    (rule) => retiring.has(rule.sourceAccountId) || retiring.has(rule.targetAccountId),
  );
  const runs = held.filter((rule) => !waits.includes(rule));
  await env.DB.batch([
    ...waits.map((rule) =>
      env.DB.prepare("UPDATE rule_holds SET until = ? WHERE rule_id = ?").bind(
        now + HOLD_LEASE_MS,
        rule.ruleId,
      ),
    ),
    ...runs.flatMap((rule) => [
      env.DB.prepare("DELETE FROM rule_holds WHERE rule_id = ? AND until <= ?").bind(
        rule.ruleId,
        now,
      ),
      startUnlessHeld(env, rule.ruleId),
      auditStatement(
        env.DB,
        {
          orgId: rule.orgId,
          userId: rule.userId,
          accountId: rule.targetAccountId,
          ruleId: rule.ruleId,
          kind: "rule_enabled",
          detail: { restored: true },
        },
        "rule_runs",
      ),
    ]),
  ]);
  const made = accounts.length + 1;
  const syncs = runs.slice(0, Math.max(0, budget - made));
  for (const { targetAccountId } of syncs) {
    try {
      await accountSync(env, targetAccountId).requestSync();
    } catch (error) {
      console.error("Starting a sync failed", targetAccountId, ...errorLogFields(error));
    }
  }
  return made + syncs.length;
}
