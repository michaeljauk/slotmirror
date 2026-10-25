import { parseRuleOptions, type RuleOptions } from "../config";

/** A rule with everything the runner needs, joined from D1. */
export interface RuleContext {
  id: string;
  userId: string;
  options: RuleOptions;
  enabled: boolean;
  source: { accountId: string; provider: string; remoteCalendarId: string };
  target: { accountId: string; provider: string; remoteCalendarId: string };
}

interface RuleRow {
  id: string;
  userId: string;
  options: string;
  enabled: number;
  sourceAccountId: string;
  sourceProvider: string;
  sourceRemoteId: string;
  targetAccountId: string;
  targetProvider: string;
  targetRemoteId: string;
}

const RULE_SELECT = `
  SELECT r.id, r.user_id AS userId, r.options, r.enabled,
         sa.id AS sourceAccountId, sa.provider AS sourceProvider, sc.remote_id AS sourceRemoteId,
         ta.id AS targetAccountId, ta.provider AS targetProvider, tc.remote_id AS targetRemoteId
  FROM rules r
  JOIN calendars sc ON sc.id = r.source_calendar_id
  JOIN accounts sa ON sa.id = sc.account_id
  JOIN calendars tc ON tc.id = r.target_calendar_id
  JOIN accounts ta ON ta.id = tc.account_id`;

function toContext(row: RuleRow): RuleContext {
  return {
    id: row.id,
    userId: row.userId,
    options: parseRuleOptions(row.options),
    enabled: row.enabled === 1,
    source: {
      accountId: row.sourceAccountId,
      provider: row.sourceProvider,
      remoteCalendarId: row.sourceRemoteId,
    },
    target: {
      accountId: row.targetAccountId,
      provider: row.targetProvider,
      remoteCalendarId: row.targetRemoteId,
    },
  };
}

export async function loadRule(db: D1Database, ruleId: string): Promise<RuleContext | null> {
  const row = await db.prepare(`${RULE_SELECT} WHERE r.id = ?`).bind(ruleId).first<RuleRow>();
  return row ? toContext(row) : null;
}

/** Enabled rules whose target calendar belongs to the account; they run in its Durable Object. */
export async function rulesTargetingAccount(db: D1Database, accountId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id
       WHERE tc.account_id = ? AND r.enabled = 1 ORDER BY r.id`,
    )
    .bind(accountId)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** The sync window of a rule: from the start of the current UTC day to `daysAhead` days later. */
export function syncWindow(options: RuleOptions, now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + options.daysAhead * 24 * 60 * 60 * 1000);
  return { start, end };
}
