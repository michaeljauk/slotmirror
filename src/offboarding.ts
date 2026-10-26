import { recordAudit } from "./audit";
import { accountSync } from "./durable";
import { deleteEmptyFeeds, revokeFeeds } from "./feeds";

/**
 * Removing accounts and users, and pausing a user. The blocks go through the removal queue of each
 * target account's Durable Object, so a request never waits for the providers. An account that
 * goes retires: its Durable Object removes its queued blocks, then forgets the tokens.
 */

/** Queue the removal of every block a rule wrote, in its target account. */
async function queueRemovals(
  env: Env,
  rules: { ruleId: string; targetAccountId: string; remoteCalendarId: string }[],
): Promise<number> {
  let failed = 0;
  for (const rule of rules) {
    try {
      await accountSync(env, rule.targetAccountId).queueRemoval(rule.ruleId, rule.remoteCalendarId);
    } catch (error) {
      failed++;
      console.error("Queueing a removal failed", rule.ruleId, error);
    }
  }
  return failed;
}

/** Rules that read from or write into any of the accounts, with their target calendar. */
async function rulesOfAccounts(env: Env, accountIds: string[]) {
  if (accountIds.length === 0) return [];
  const marks = accountIds.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT r.id AS ruleId, tc.account_id AS targetAccountId, tc.remote_id AS remoteCalendarId
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id IN (${marks}) OR tc.account_id IN (${marks})`,
  )
    .bind(...accountIds, ...accountIds)
    .all<{ ruleId: string; targetAccountId: string; remoteCalendarId: string }>();
  return results;
}

/**
 * Disconnect accounts of a user: every block that involves them is queued for removal, the
 * accounts retire, and their rows go with their calendars and rules.
 */
export async function removeAccounts(
  env: Env,
  user: { id: string; orgId: string },
  accountIds: string[],
): Promise<void> {
  const rules = await rulesOfAccounts(env, accountIds);
  const failed = await queueRemovals(env, rules);
  for (const accountId of accountIds) {
    await accountSync(env, accountId).retire();
    await env.DB.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?")
      .bind(accountId, user.id)
      .run();
    await recordAudit(env.DB, {
      orgId: user.orgId,
      userId: user.id,
      accountId,
      kind: "account_disconnected",
      detail: { rules: rules.length, cleanup: "queued", cleanupFailed: failed },
    });
  }
  // The accounts' calendars left every feed with them; a feed without calendars goes too.
  await deleteEmptyFeeds(env, user);
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
 * Free/busy feeds are deleted: a reactivation does not publish them again.
 */
export async function setUserActive(
  env: Env,
  user: { id: string; orgId: string },
  active: boolean,
  by: Actor,
): Promise<void> {
  const updated = await env.DB.prepare("UPDATE users SET active = ? WHERE id = ? AND active <> ?")
    .bind(active ? 1 : 0, user.id, active ? 1 : 0)
    .run();
  if (updated.meta.changes === 0) return;
  const { results: accounts } = await env.DB.prepare("SELECT id FROM accounts WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string }>();
  const accountIds = accounts.map((row) => row.id);
  if (active) {
    for (const id of accountIds) await accountSync(env, id).requestSync();
  } else {
    await queueRemovals(env, await rulesOfAccounts(env, accountIds));
    // A feed is a grant to people outside the deployment; it ends with the user's access.
    await revokeFeeds(env, user, "user_deactivated");
  }
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: active ? "user_reactivated" : "user_deactivated",
    detail: { by },
  });
}
