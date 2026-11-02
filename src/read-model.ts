import { recentRuleRuns, statusOf, type RecentRun, type SyncRunDetail } from "./audit";
import { parseRuleOptions } from "./config";
import { detailLevelFor } from "./detail-policy";
import { hasWorkingHours } from "./sync/working-hours";

/**
 * What the read-only API may show. Each field is named here on purpose: the tools never pass on a
 * row, `rules.options` or an audit `detail`. Tenant IDs, remote calendar IDs, category names, block
 * titles and audit texts stay out. All queries read D1 and take the user from the token.
 */

export interface AccountView {
  id: string;
  provider: string;
  email: string;
  name: string;
  needsReconnect: boolean;
  calendars: number;
}

export async function readAccounts(
  db: D1Database,
  userId: string,
): Promise<{ accounts: AccountView[] }> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.provider, a.email, COALESCE(a.display_name, a.email) AS name,
              a.needs_reconnect AS needsReconnect,
              (SELECT COUNT(*) FROM calendars c WHERE c.account_id = a.id) AS calendars
       FROM accounts a WHERE a.user_id = ? ORDER BY a.created_at, a.id`,
    )
    .bind(userId)
    .all<Omit<AccountView, "needsReconnect"> & { needsReconnect: number }>();
  return {
    accounts: results.map((row) => ({ ...row, needsReconnect: row.needsReconnect === 1 })),
  };
}

export interface RuleView {
  id: string;
  source: { accountId: string; calendar: string };
  target: { accountId: string; calendar: string };
  enabled: boolean;
  /** The level the rule runs with, after the deployment's caps. Null: the options do not parse. */
  detailLevel: string | null;
  daysAhead: number | null;
  bufferBefore: number | null;
  bufferAfter: number | null;
  /** Whether a filter is on. Category names can be content themselves, so they stay out. */
  filters: { categories: boolean; workingHours: boolean } | null;
}

function ruleSettings(
  env: Env,
  json: string,
  source: { email: string; tenantId: string | null },
  target: { email: string; tenantId: string | null },
) {
  try {
    const options = parseRuleOptions(json);
    return {
      detailLevel: detailLevelFor(env, options.detailLevel, source, target).level,
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

export async function readRules(env: Env, userId: string): Promise<{ rules: RuleView[] }> {
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
     WHERE r.user_id = ? ORDER BY r.id`,
  )
    .bind(userId)
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
  return {
    rules: results.map((row) => ({
      id: row.id,
      source: { accountId: row.sourceAccountId, calendar: row.sourceCalendar },
      target: { accountId: row.targetAccountId, calendar: row.targetCalendar },
      enabled: row.enabled === 1,
      ...ruleSettings(
        env,
        row.options,
        { email: row.sourceEmail, tenantId: row.sourceTenantId },
        { email: row.targetEmail, tenantId: row.targetTenantId },
      ),
    })),
  };
}

export interface RuleStatusView {
  ruleId: string;
  enabled: boolean;
  /** "unknown": no run within the rows that one call reads. Never reported as healthy. */
  state: "ok" | "partial" | "error" | "paused" | "unknown";
  at: string | null;
  code?: string;
  failed?: number;
  remaining?: number;
  changes?: { create: number; update: number; delete: number; unchanged: number };
  /**
   * Blocks that the last successful run wanted in the target, inside the rule's sync window. This
   * is the state of that run, not a live count of the calendar. `blocksExact` is true only if the
   * run finished all its work, it is the latest outcome, and the rule still runs.
   */
  blocks: number | null;
  blocksExact: boolean;
  blocksAt: string | null;
}

function changesOf(detail: Partial<SyncRunDetail>) {
  return {
    create: detail.create ?? 0,
    update: detail.update ?? 0,
    delete: detail.delete ?? 0,
    unchanged: detail.unchanged ?? 0,
  };
}

function ruleStatus(
  ruleId: string,
  enabled: boolean,
  latest: RecentRun | undefined,
  lastRun: RecentRun | undefined,
): RuleStatusView {
  const unknown = { state: "unknown", at: null, blocks: null, blocksExact: false, blocksAt: null };
  if (!latest) return { ruleId, enabled, ...unknown } as RuleStatusView;
  const state = enabled ? statusOf(latest).state : "paused";
  const changes = lastRun ? changesOf(lastRun.detail) : undefined;
  const remaining = latest.detail.remaining ?? 0;
  const failed = latest.detail.failed ?? 0;
  return {
    ruleId,
    enabled,
    state,
    at: latest.createdAt,
    ...(latest.detail.code ? { code: latest.detail.code } : {}),
    ...(failed > 0 ? { failed } : {}),
    ...(remaining > 0 ? { remaining } : {}),
    ...(changes ? { changes } : {}),
    blocks: changes ? changes.unchanged + changes.create + changes.update : null,
    blocksExact:
      enabled &&
      latest === lastRun &&
      latest.kind === "sync_run" &&
      failed === 0 &&
      remaining === 0,
    blocksAt: lastRun?.createdAt ?? null,
  };
}

/** Rows of the audit log that one status call reads at most. */
function runRowLimit(rules: number): number {
  return Math.max(100, rules * 10);
}

export async function readSyncStatus(
  db: D1Database,
  userId: string,
): Promise<{ rules: RuleStatusView[] }> {
  const { results } = await db
    .prepare("SELECT id, enabled FROM rules WHERE user_id = ? ORDER BY id")
    .bind(userId)
    .all<{ id: string; enabled: number }>();
  const runs = await recentRuleRuns(db, userId, runRowLimit(results.length));
  const latest = new Map<string, RecentRun>();
  const lastRun = new Map<string, RecentRun>();
  for (const run of runs) {
    if (!latest.has(run.ruleId)) latest.set(run.ruleId, run);
    if (run.kind === "sync_run" && !lastRun.has(run.ruleId)) lastRun.set(run.ruleId, run);
  }
  return {
    rules: results.map((rule) =>
      ruleStatus(rule.id, rule.enabled === 1, latest.get(rule.id), lastRun.get(rule.id)),
    ),
  };
}
