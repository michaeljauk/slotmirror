import { parseRuleOptions, type RuleOptions } from "../config";

/** A rule with everything the runner needs, joined from D1. */
export interface RuleContext {
  id: string;
  userId: string;
  orgId: string;
  options: RuleOptions;
  enabled: boolean;
  source: RuleEnd;
  target: RuleEnd;
}

interface RuleEnd {
  accountId: string;
  provider: string;
  remoteCalendarId: string;
  /** Address and Entra tenant of the account; they decide whether it belongs to the org. */
  email: string;
  tenantId: string | null;
  /** The provider refused the account's refresh token; see `accounts.needs_reconnect`. */
  needsReconnect: boolean;
}

interface RuleRow {
  id: string;
  userId: string;
  orgId: string;
  options: string;
  enabled: number;
  sourceAccountId: string;
  sourceProvider: string;
  sourceRemoteId: string;
  sourceEmail: string;
  sourceTenantId: string | null;
  sourceNeedsReconnect: number;
  targetAccountId: string;
  targetProvider: string;
  targetRemoteId: string;
  targetEmail: string;
  targetTenantId: string | null;
  targetNeedsReconnect: number;
}

const RULE_SELECT = `
  SELECT r.id, r.user_id AS userId, u.org_id AS orgId, r.options, r.enabled,
         sa.id AS sourceAccountId, sa.provider AS sourceProvider, sc.remote_id AS sourceRemoteId,
         sa.email AS sourceEmail, sa.tenant_id AS sourceTenantId,
         sa.needs_reconnect AS sourceNeedsReconnect,
         ta.id AS targetAccountId, ta.provider AS targetProvider, tc.remote_id AS targetRemoteId,
         ta.email AS targetEmail, ta.tenant_id AS targetTenantId,
         ta.needs_reconnect AS targetNeedsReconnect
  FROM rules r
  JOIN users u ON u.id = r.user_id
  JOIN calendars sc ON sc.id = r.source_calendar_id
  JOIN accounts sa ON sa.id = sc.account_id
  JOIN calendars tc ON tc.id = r.target_calendar_id
  JOIN accounts ta ON ta.id = tc.account_id`;

function toContext(row: RuleRow): RuleContext {
  return {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    options: parseRuleOptions(row.options),
    enabled: row.enabled === 1,
    source: {
      accountId: row.sourceAccountId,
      provider: row.sourceProvider,
      remoteCalendarId: row.sourceRemoteId,
      email: row.sourceEmail,
      tenantId: row.sourceTenantId,
      needsReconnect: row.sourceNeedsReconnect === 1,
    },
    target: {
      accountId: row.targetAccountId,
      provider: row.targetProvider,
      remoteCalendarId: row.targetRemoteId,
      email: row.targetEmail,
      tenantId: row.targetTenantId,
      needsReconnect: row.targetNeedsReconnect === 1,
    },
  };
}

export async function loadRule(db: D1Database, ruleId: string): Promise<RuleContext | null> {
  const row = await db.prepare(`${RULE_SELECT} WHERE r.id = ?`).bind(ruleId).first<RuleRow>();
  return row ? toContext(row) : null;
}

/**
 * The rules of `ruleIds` that the alarm may run: they exist, are enabled, and their user is active.
 * A queued rule can be disabled or removed before its turn; the editor then queues the removal of
 * its blocks.
 */
export async function rulesRunningFromAlarm(
  db: D1Database,
  ruleIds: string[],
): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT r.id FROM rules r JOIN users u ON u.id = r.user_id
       WHERE r.id IN (SELECT value FROM json_each(?)) AND r.enabled = 1 AND u.active = 1`,
    )
    .bind(JSON.stringify(ruleIds))
    .all<{ id: string }>();
  return new Set(results.map((row) => row.id));
}

/**
 * Enabled rules whose target calendar belongs to the account; they run in its Durable Object.
 * Rules of a deactivated user do not run. Rules from an account that needs reconnecting would
 * only fail, so they wait until it is connected again.
 */
export async function rulesTargetingAccount(db: D1Database, accountId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id
       JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN accounts sa ON sa.id = sc.account_id
       JOIN users u ON u.id = r.user_id
       WHERE tc.account_id = ? AND r.enabled = 1 AND u.active = 1 AND sa.needs_reconnect = 0
       ORDER BY r.id`,
    )
    .bind(accountId)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** True if the rule is enabled, its user is active, and it writes into this calendar. */
export async function ruleWritesInto(
  db: D1Database,
  ruleId: string,
  remoteCalendarId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id
       JOIN users u ON u.id = r.user_id
       WHERE r.id = ? AND tc.remote_id = ? AND r.enabled = 1 AND u.active = 1`,
    )
    .bind(ruleId, remoteCalendarId)
    .first<{ found: number }>();
  return row !== null;
}

/**
 * The other enabled rules of the same user that write into the target calendar of a rule. Their
 * blocks can stand in for the rule's own; see `desiredBlocks`.
 */
export async function siblingRuleIds(db: D1Database, ruleId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT o.id FROM rules r
       JOIN rules o ON o.target_calendar_id = r.target_calendar_id AND o.user_id = r.user_id
       WHERE r.id = ? AND o.id <> r.id AND o.enabled = 1 ORDER BY o.id`,
    )
    .bind(ruleId)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** The sync window of a rule: from the start of the current UTC day to `daysAhead` days later. */
export function syncWindow(options: RuleOptions, now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + options.daysAhead * 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * The window of the target read of a rule: the sync window and one day more on each side. Each
 * provider filters all-day blocks at the midnights of the target calendar's time zone, so only a
 * wider read returns every all-day date that the source read can return; see `planSync`.
 */
export function targetReadWindow(window: { start: Date; end: Date }): { start: Date; end: Date } {
  const day = 24 * 60 * 60 * 1000;
  return {
    start: new Date(window.start.getTime() - day),
    end: new Date(window.end.getTime() + day),
  };
}

/**
 * Window for removing a rule's blocks: from the start of the current UTC day to one year and a
 * month ahead, wider than any rule window. Past blocks stay as a record of when the user was busy.
 */
export function cleanupWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 400 * 24 * 60 * 60 * 1000) };
}
