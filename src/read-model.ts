import * as z from "zod/mini";
import { recentRuleRuns, statusOf, type RecentRun, type SyncRunDetail } from "./audit";
import { parseRuleOptions } from "./config";
import { detailLevelResolver } from "./detail-policy";
import { hasWorkingHours } from "./sync/working-hours";

/**
 * What the read-only API may show. Each field is named here on purpose: the tools never pass on a
 * row, `rules.options` or an audit `detail`. Tenant IDs, remote calendar IDs, category names, block
 * titles and audit texts stay out. All queries read D1 and take the user from the token.
 */

/**
 * Rules in one answer. `ORDER BY r.rowid` follows the index `rules_user`, so the LIMIT stops the
 * read without a sort, and both rule tools name the same rules. Each rule costs about 6 µs of CPU
 * for its options (measured warm in Node), and a cold isolate is slower: 200 keeps far below 10 ms.
 */
const MAX_LISTED_RULES = 200;
/** Accounts in one answer. The sort reads all accounts of the user, which this bounds as well. */
const MAX_LISTED_ACCOUNTS = 100;

/**
 * The answer shapes. They are strict: the MCP tools publish them as `outputSchema`, and a test
 * refuses an answer that carries a field outside them.
 */
const accountView = z.strictObject({
  id: z.string(),
  provider: z.string(),
  email: z.string(),
  name: z.string(),
  needsReconnect: z.boolean(),
  calendars: z.number(),
});
export type AccountView = z.infer<typeof accountView>;
export const accountsAnswer = z.strictObject({
  accounts: z.array(accountView),
  truncated: z.boolean(),
});

export async function readAccounts(
  db: D1Database,
  userId: string,
): Promise<z.infer<typeof accountsAnswer>> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.provider, a.email, COALESCE(a.display_name, a.email) AS name,
              a.needs_reconnect AS needsReconnect,
              (SELECT COUNT(*) FROM calendars c WHERE c.account_id = a.id) AS calendars
       FROM accounts a WHERE a.user_id = ? ORDER BY a.created_at, a.id LIMIT ?`,
    )
    .bind(userId, MAX_LISTED_ACCOUNTS + 1)
    .all<Omit<AccountView, "needsReconnect"> & { needsReconnect: number }>();
  return {
    truncated: results.length > MAX_LISTED_ACCOUNTS,
    accounts: results
      .slice(0, MAX_LISTED_ACCOUNTS)
      .map((row) => ({ ...row, needsReconnect: row.needsReconnect === 1 })),
  };
}

const calendarRef = z.strictObject({ accountId: z.string(), calendar: z.string() });

const ruleView = z.strictObject({
  id: z.string(),
  source: calendarRef,
  target: calendarRef,
  enabled: z.boolean(),
  /** The level the rule runs with, after the deployment's caps. Null: the options do not parse. */
  detailLevel: z.nullable(z.string()),
  daysAhead: z.nullable(z.number()),
  bufferBefore: z.nullable(z.number()),
  bufferAfter: z.nullable(z.number()),
  /** Whether a filter is on. Category names can be content themselves, so they stay out. */
  filters: z.nullable(z.strictObject({ categories: z.boolean(), workingHours: z.boolean() })),
});
export type RuleView = z.infer<typeof ruleView>;
export const rulesAnswer = z.strictObject({ rules: z.array(ruleView), truncated: z.boolean() });

function ruleSettings(
  detailLevelFor: ReturnType<typeof detailLevelResolver>,
  json: string,
  source: { email: string; tenantId: string | null },
  target: { email: string; tenantId: string | null },
) {
  try {
    const options = parseRuleOptions(json);
    return {
      detailLevel: detailLevelFor(options.detailLevel, source, target).level,
      daysAhead: options.daysAhead,
      bufferBefore: options.bufferBefore,
      bufferAfter: options.bufferAfter,
      filters: {
        categories: options.skipCategories.length > 0 || options.onlyCategories.length > 0,
        workingHours: hasWorkingHours(options),
      },
    };
  } catch {
    return {
      detailLevel: null,
      daysAhead: null,
      bufferBefore: null,
      bufferAfter: null,
      filters: null,
    };
  }
}

export async function readRules(env: Env, userId: string): Promise<z.infer<typeof rulesAnswer>> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.options, r.enabled,
            sc.account_id AS sourceAccountId, sc.name AS sourceCalendar,
            sa.email AS sourceEmail, sa.tenant_id AS sourceTenantId,
            tc.account_id AS targetAccountId, tc.name AS targetCalendar,
            ta.email AS targetEmail, ta.tenant_id AS targetTenantId
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN accounts sa ON sa.id = sc.account_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     JOIN accounts ta ON ta.id = tc.account_id
     WHERE r.user_id = ? ORDER BY r.rowid LIMIT ?`,
  )
    .bind(userId, MAX_LISTED_RULES + 1)
    .all<{
      id: string;
      options: string;
      enabled: number;
      sourceAccountId: string;
      sourceCalendar: string;
      sourceEmail: string;
      sourceTenantId: string | null;
      targetAccountId: string;
      targetCalendar: string;
      targetEmail: string;
      targetTenantId: string | null;
    }>();
  const detailLevelFor = detailLevelResolver(env);
  return {
    truncated: results.length > MAX_LISTED_RULES,
    rules: results.slice(0, MAX_LISTED_RULES).map((row) => ({
      id: row.id,
      source: { accountId: row.sourceAccountId, calendar: row.sourceCalendar },
      target: { accountId: row.targetAccountId, calendar: row.targetCalendar },
      enabled: row.enabled === 1,
      ...ruleSettings(
        detailLevelFor,
        row.options,
        { email: row.sourceEmail, tenantId: row.sourceTenantId },
        { email: row.targetEmail, tenantId: row.targetTenantId },
      ),
    })),
  };
}

const ruleStatusView = z.strictObject({
  ruleId: z.string(),
  enabled: z.boolean(),
  /**
   * "paused": the rule is off. "reconnect": an account of the rule needs reconnecting, so the
   * rule does not run. "unknown": no run within the audit rows that one call reads. Neither
   * "reconnect" nor "unknown" is ever reported as healthy.
   */
  state: z.enum(["ok", "partial", "error", "paused", "reconnect", "unknown"]),
  at: z.nullable(z.string()),
  code: z.optional(z.string()),
  failed: z.optional(z.number()),
  remaining: z.optional(z.number()),
  changes: z.optional(
    z.strictObject({
      create: z.number(),
      update: z.number(),
      delete: z.number(),
      unchanged: z.number(),
    }),
  ),
  /**
   * Blocks that the last successful run wanted in the target, inside the rule's sync window. This
   * is the state of that run, not a live count of the calendar. `blocksExact` is true only if the
   * run finished all its work, it is the latest outcome, and the rule still runs.
   */
  blocks: z.nullable(z.number()),
  blocksExact: z.boolean(),
  blocksAt: z.nullable(z.string()),
});
export type RuleStatusView = z.infer<typeof ruleStatusView>;
export const statusAnswer = z.strictObject({
  rules: z.array(ruleStatusView),
  truncated: z.boolean(),
});

function changesOf(detail: Partial<SyncRunDetail>) {
  return {
    create: detail.create ?? 0,
    update: detail.update ?? 0,
    delete: detail.delete ?? 0,
    unchanged: detail.unchanged ?? 0,
  };
}

function ruleStatus(
  rule: { id: string; enabled: boolean; stalled: boolean },
  latest: RecentRun | undefined,
  lastRun: RecentRun | undefined,
): RuleStatusView {
  const state = !rule.enabled
    ? "paused"
    : rule.stalled
      ? "reconnect"
      : latest
        ? statusOf(latest).state
        : "unknown";
  const changes = lastRun ? changesOf(lastRun.detail) : undefined;
  const remaining = latest?.detail.remaining ?? 0;
  const failed = latest?.detail.failed ?? 0;
  return {
    ruleId: rule.id,
    enabled: rule.enabled,
    state,
    at: latest?.createdAt ?? null,
    ...(latest?.detail.code ? { code: latest.detail.code } : {}),
    ...(failed > 0 ? { failed } : {}),
    ...(remaining > 0 ? { remaining } : {}),
    ...(changes ? { changes } : {}),
    blocks: changes ? changes.unchanged + changes.create + changes.update : null,
    blocksExact:
      rule.enabled &&
      !rule.stalled &&
      latest !== undefined &&
      latest === lastRun &&
      latest.kind === "sync_run" &&
      failed === 0 &&
      remaining === 0,
    blocksAt: lastRun?.createdAt ?? null,
  };
}

/** Rows of the audit log that one status call reads at most. */
function runRowLimit(rules: number): number {
  return Math.min(1000, Math.max(100, rules * 10));
}

export async function readSyncStatus(
  db: D1Database,
  userId: string,
): Promise<z.infer<typeof statusAnswer>> {
  // A rule does not run while its source or target account needs reconnecting: the sync skips it,
  // and writes no audit row that would show it.
  const { results } = await db
    .prepare(
      `SELECT r.id, r.enabled, MAX(sa.needs_reconnect, ta.needs_reconnect) AS stalled
       FROM rules r
       JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN accounts sa ON sa.id = sc.account_id
       JOIN calendars tc ON tc.id = r.target_calendar_id
       JOIN accounts ta ON ta.id = tc.account_id
       WHERE r.user_id = ? ORDER BY r.rowid LIMIT ?`,
    )
    .bind(userId, MAX_LISTED_RULES + 1)
    .all<{ id: string; enabled: number; stalled: number }>();
  const rules = results.slice(0, MAX_LISTED_RULES);
  const runs = await recentRuleRuns(db, userId, runRowLimit(rules.length));
  const latest = new Map<string, RecentRun>();
  const lastRun = new Map<string, RecentRun>();
  for (const run of runs) {
    if (!latest.has(run.ruleId)) latest.set(run.ruleId, run);
    if (run.kind === "sync_run" && !lastRun.has(run.ruleId)) lastRun.set(run.ruleId, run);
  }
  return {
    truncated: results.length > MAX_LISTED_RULES,
    rules: rules.map((rule) =>
      ruleStatus(
        { id: rule.id, enabled: rule.enabled === 1, stalled: rule.stalled === 1 },
        latest.get(rule.id),
        lastRun.get(rule.id),
      ),
    ),
  };
}
