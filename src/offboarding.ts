import type { OffboardingOwner } from "./account-sync";
import { errorLogFields, recordAudit } from "./audit";
import { accountSync } from "./durable";
import { deleteEmptyFeeds, revokeFeeds } from "./feeds";

/**
 * Removing accounts and users, and pausing a user. The blocks go through the removal queue of each
 * target account's Durable Object, so a request never waits for the providers. An account that
 * goes retires: its Durable Object removes its queued blocks, then forgets the tokens. A removal
 * that goes wrong writes its result into the audit log, see `cleanup_finished`.
 */

interface OwnedRule {
  ruleId: string;
  sourceAccountId: string;
  targetAccountId: string;
  remoteCalendarId: string;
  enabled: number;
}

/**
 * A removal could not be queued, so the rows stay: without them no one knows the blocks. No account
 * went, and the rules run again. Removals of other target accounts stay queued and end without
 * removing blocks. The same request can run again; the caller's error page says so.
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
        offboarding ? { offboarding } : {},
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
       tc.remote_id AS remoteCalendarId, r.enabled
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id IN (${marks}) OR tc.account_id IN (${marks})`,
  )
    .bind(...accountIds, ...accountIds)
    .all<OwnedRule>();
  return results;
}

function setRulesEnabled(env: Env, rules: OwnedRule[], enabled: boolean) {
  return env.DB.prepare("UPDATE rules SET enabled = ? WHERE id IN (SELECT value FROM json_each(?))")
    .bind(enabled ? 1 : 0, JSON.stringify(rules.map((rule) => rule.ruleId)))
    .run();
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
 * The accounts that may retire: this or an earlier request started it, or no answer came. Their
 * rules must not run again.
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

/** The rules that touch none of the accounts. */
function rulesApartFrom(rules: OwnedRule[], accountIds: Set<string>): OwnedRule[] {
  return rules.filter(
    (rule) => !accountIds.has(rule.sourceAccountId) && !accountIds.has(rule.targetAccountId),
  );
}

/**
 * Run the stopped rules of the accounts that stay. A removal may have run during the request, so
 * their target accounts sync at once. A failure is logged, so that the caller's error stays.
 */
async function resumeRules(env: Env, accountIds: string[], running: OwnedRule[]): Promise<void> {
  try {
    await setRulesEnabled(env, running, true);
    // The rules of accounts that went earlier in the request left with them.
    const stopped = new Set(running.map((rule) => rule.ruleId));
    const left = await rulesOfAccounts(env, accountIds);
    const targets = new Set(
      left.filter((rule) => stopped.has(rule.ruleId)).map((rule) => rule.targetAccountId),
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
 * go, it and the accounts after it stay, and this throws that error. The rules run again only if no
 * account of theirs retires: jobs that are queued then find them running and end without removing
 * blocks. If the undo fails, the rules of that account stay off, the account can still go, and its
 * row then shows that it needs a reconnect. The same request repairs that.
 */
export async function removeAccounts(
  env: Env,
  user: { id: string; orgId: string },
  accountIds: string[],
): Promise<void> {
  const rules = await rulesOfAccounts(env, accountIds);
  const running = rules.filter((rule) => rule.enabled === 1);
  // Made here: the answer of `retire()` can get lost, and the cancel still has to name it.
  const generation = crypto.randomUUID();
  // The rules stop before the first job exists. A job can run while this request goes on, and a
  // running rule would make its second step give up, or a full cycle write the blocks again.
  await setRulesEnabled(env, running, false);
  const failed = await queueRemovals(env, rules, { orgId: user.orgId, userId: user.id });
  if (failed > 0) {
    await reportKept(env, user, accountIds, { rules: rules.length, cleanupFailed: failed });
    const unclear = await retiringAccounts(env, accountIds);
    await resumeRules(env, accountIds, rulesApartFrom(running, unclear));
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
      const unclear = await retiringAccounts(env, kept);
      if (!cancelled) unclear.add(accountId);
      await resumeRules(env, kept, rulesApartFrom(running, unclear));
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

/**
 * Deactivate or reactivate a user. Deactivated: sign-in and sessions stop, rules no longer run
 * and their blocks are removed; accounts and rules stay for a reactivation, which syncs again.
 * Free/busy feeds are deleted: a reactivation does not publish them again. If a removal cannot be
 * queued, the user stays deactivated and this throws `CleanupNotQueued`. The same request then
 * queues the removals again.
 */
export async function setUserActive(
  env: Env,
  user: { id: string; orgId: string },
  active: boolean,
  by: Actor,
): Promise<void> {
  // A deactivation also ends the sessions for good: a reactivation must not revive them.
  const updated = await env.DB.prepare(
    `UPDATE users SET active = ?, session_version = session_version + ?
     WHERE id = ? AND active <> ?`,
  )
    .bind(active ? 1 : 0, active ? 0 : 1, user.id, active ? 1 : 0)
    .run();
  const changed = updated.meta.changes > 0;
  if (active && !changed) return;
  const { results: accounts } = await env.DB.prepare("SELECT id FROM accounts WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string }>();
  const accountIds = accounts.map((row) => row.id);
  let failed = 0;
  if (active) {
    for (const id of accountIds) await accountSync(env, id).requestSync();
  } else {
    const rules = await rulesOfAccounts(env, accountIds);
    failed = await queueRemovals(env, rules, { orgId: user.orgId, userId: user.id });
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
