import { MAX_BUFFER_MINUTES, parseRuleOptions, type RuleOptions } from "../config";

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
  targetAccountId: string;
  targetProvider: string;
  targetRemoteId: string;
  targetEmail: string;
  targetTenantId: string | null;
}

const RULE_SELECT = `
  SELECT r.id, r.user_id AS userId, u.org_id AS orgId, r.options, r.enabled,
         sa.id AS sourceAccountId, sa.provider AS sourceProvider, sc.remote_id AS sourceRemoteId,
         sa.email AS sourceEmail, sa.tenant_id AS sourceTenantId,
         ta.id AS targetAccountId, ta.provider AS targetProvider, tc.remote_id AS targetRemoteId,
         ta.email AS targetEmail, ta.tenant_id AS targetTenantId
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
    },
    target: {
      accountId: row.targetAccountId,
      provider: row.targetProvider,
      remoteCalendarId: row.targetRemoteId,
      email: row.targetEmail,
      tenantId: row.targetTenantId,
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
 * Rules of a deactivated user do not run.
 */
export async function rulesTargetingAccount(db: D1Database, accountId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id
       JOIN users u ON u.id = r.user_id
       WHERE tc.account_id = ? AND r.enabled = 1 AND u.active = 1 ORDER BY r.id`,
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
 * The window of the source read of a buffered rule: the sync window with the largest buffer added
 * on each side. A block that reaches into the sync window then has its event in the read, whatever
 * the buffers. The window does not depend on the size of the buffers, so that rules with different
 * buffers share one source read, and a lower buffer never narrows it. A rule without a buffer
 * reads the sync window, as before buffers existed: it returns no window then, and its blocks
 * stay exactly the same. The target read is wider still; see `targetReadWindow`.
 */
export function readWindow(
  window: { start: Date; end: Date },
  options: { bufferBefore: number; bufferAfter: number },
): { start: Date; end: Date } | undefined {
  if (options.bufferBefore === 0 && options.bufferAfter === 0) return undefined;
  const margin = MAX_BUFFER_MINUTES * 60_000;
  return {
    start: new Date(window.start.getTime() - margin),
    end: new Date(window.end.getTime() + margin),
  };
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
