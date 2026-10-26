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
 * Window for removing a rule's blocks: from the start of the current UTC day to one year and a
 * month ahead, wider than any rule window. Past blocks stay as a record of when the user was busy.
 */
export function cleanupWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 400 * 24 * 60 * 60 * 1000) };
}
