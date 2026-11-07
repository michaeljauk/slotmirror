import { closeAbandonedTombstones } from "./cleanup";
import { GoogleApiError } from "./providers/google-calendar";
import { GraphError } from "./providers/graph-calendar";
import { TokenError } from "./providers/microsoft";
import { parseProviderErrorMessage } from "./sync/throttle";
import { safeCode, safeMessage } from "./error-fields";
import { log } from "./telemetry";

/**
 * The audit log answers "who did what, and did the sync work". It stores IDs, times, counts and
 * codes. Never put event content or tokens into `detail`.
 */
export type AuditKind =
  | "sign_in"
  | "sign_in_refused"
  | "sign_in_reset"
  | "sign_out"
  | "account_connected"
  | "account_disconnected"
  | "account_disconnect_failed"
  | "cleanup_finished"
  | "account_renamed"
  | "token_refresh_failed"
  | "rule_created"
  | "rule_deleted"
  | "rule_enabled"
  | "rule_paused"
  | "rule_updated"
  | "group_changed"
  | "settings_changed"
  | "user_deleted"
  | "sync_run"
  | "sync_failed"
  | "sync_run_aborted"
  | "account_paused"
  | "account_resumed"
  | "alert_sent"
  | "alert_test"
  | "compare_run"
  | "compare_failed"
  | "api_token_created"
  | "api_token_revoked"
  | "mcp_app_connected"
  | "mcp_app_disconnected"
  | "mcp_policy_changed";

/** How the removal of an offboarding ended. */
export type CleanupResult =
  | "removed"
  | "incomplete"
  | "token_refused"
  | "no_tokens"
  | "deadline"
  | "not_started"
  | "kept";

/**
 * Detail of a `cleanup_finished` event. `left` is the count of the last step that could count, or
 * with `estimated`, of the rule's last sync run if no step could.
 */
export type CleanupDetail = {
  result: CleanupResult;
  removed: number;
  left?: number;
  estimated?: true;
};

/** Detail of a `sync_run` event. */
export interface SyncRunDetail {
  /** ID of the run, as in its start marker. A dry run has no marker and no ID. */
  runId?: string;
  dryRun: boolean;
  create: number;
  update: number;
  delete: number;
  unchanged: number;
  /** Extra blocks of a wanted event that the run planned to delete; part of `delete`. */
  duplicates: number;
  applied: number;
  failed: number;
  remaining: number;
  /** Actions the provider throttled; they are part of `remaining`. */
  throttled: number;
  /** Status and reason of failed and throttled actions, e.g. "429 ApplicationThrottled:13". */
  statuses: string;
  /** Edge reads that failed, so blocks at the start of the window stayed; see `planSync`. */
  edgeReadsFailed: number;
  durationMs: number;
}

export interface AuditEvent {
  orgId: string;
  userId?: string | null;
  accountId?: string | null;
  ruleId?: string | null;
  kind: AuditKind;
  detail?: Record<string, string | number | boolean>;
  /** Makes the event unique: a statement that runs again adds no second row. */
  reportId?: string;
}

/** Audit rows older than this many days are deleted by the cron handler. */
export const AUDIT_RETENTION_DAYS = 90;

/** Audit rows that one lookup of a run's outcome reads at most. */
export const RUN_OUTCOME_SCAN_ROWS = 500;

/** A lookup starts this long before a run's start: the instance and D1 have different clocks. */
const RUN_OUTCOME_SKEW_MS = 60_000;

/** Rows shown on an activity page. */
export const ACTIVITY_LIMIT = 100;

/**
 * The insert of one event, for a batch. With `onlyIf` the row is written only if the event's rule
 * exists, for example after an insert that a concurrent request made a no-op, only if the rule
 * runs, or only if no end of the rule's tombstone is stored. An event with a `reportId` that D1 holds
 * already adds no row.
 */
export function auditStatement(
  db: D1Database,
  event: AuditEvent,
  onlyIf?: "rule_exists" | "rule_runs" | "tombstone_not_ended",
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, report_id)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?8
       WHERE CASE ?7
         WHEN 0 THEN 1
         WHEN 3 THEN NOT EXISTS (SELECT 1 FROM cleanup_tombstones t
           WHERE t.account_id = ?3 AND t.rule_id = ?4 AND t.state <> 'open')
         ELSE EXISTS (SELECT 1 FROM rules WHERE id = ?4 AND (?7 = 1 OR enabled = 1))
       END
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      event.orgId,
      event.userId ?? null,
      event.accountId ?? null,
      event.ruleId ?? null,
      event.kind,
      JSON.stringify(event.detail ?? {}),
      onlyIf === "tombstone_not_ended"
        ? 3
        : onlyIf === "rule_runs"
          ? 2
          : onlyIf === "rule_exists"
            ? 1
            : 0,
      event.reportId ?? null,
    );
}

/** Write one event. Never throws: a broken log must not break a sync or a sign-in. */
export async function recordAudit(db: D1Database, event: AuditEvent): Promise<void> {
  await recordAuditChecked(db, event);
}

/**
 * `recordAudit` for a caller that must know the outcome. Returns true only if D1 reports a new row.
 */
export async function recordAuditChecked(db: D1Database, event: AuditEvent): Promise<boolean> {
  try {
    const { meta } = await auditStatement(db, event).run();
    return meta.changes > 0;
  } catch (error) {
    log.error("audit.write_failed", { auditKind: event.kind }, error);
    return false;
  }
}

/** The start of a run, as far as a lookup of its outcome needs it. */
export interface RunStart {
  ruleId: string;
  runId: string;
  /** Unix ms. */
  startedAt: number;
}

/**
 * The lookup of one run's outcome event. It walks the index on user and time from the start of the
 * run and stops after `RUN_OUTCOME_SCAN_ROWS` rows. If a run's event lies further on, the run
 * counts as without an outcome. A result event follows the start of its run within minutes, and a
 * marker waits at most one tick, unless D1 stays down.
 */
export function runOutcomeStatement(
  db: D1Database,
  userId: string,
  { ruleId, runId, startedAt }: RunStart,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ?1 AS runId FROM (
         SELECT rule_id, kind, detail FROM audit_events
         WHERE user_id = ?2 AND created_at >= ?3
         ORDER BY created_at
         LIMIT ?4
       )
       WHERE rule_id = ?5
         AND kind IN ('sync_run', 'sync_failed', 'sync_run_aborted')
         AND json_extract(detail, '$.runId') = ?1
       LIMIT 1`,
    )
    .bind(
      runId,
      userId,
      new Date(startedAt - RUN_OUTCOME_SKEW_MS).toISOString(),
      RUN_OUTCOME_SCAN_ROWS,
      ruleId,
    );
}

/** The IDs among `runs` with an outcome event. One batch is one subrequest. Throws on error. */
export async function runsWithOutcome(
  db: D1Database,
  userId: string,
  runs: RunStart[],
): Promise<Set<string>> {
  const results = await db.batch<{ runId: string }>(
    runs.map((run) => runOutcomeStatement(db, userId, run)),
  );
  return new Set(results.flatMap(({ results: rows }) => rows.map((row) => row.runId)));
}

/** A short code for an error, safe to store: no response bodies, no event content. */
export function errorCode(error: unknown): string {
  if (error instanceof TokenError) {
    // The code comes from the token endpoint; only a plain code goes into a log or the audit log.
    return `token_${/^[a-z0-9_]{1,64}$/i.test(error.code) ? error.code : "unknown_error"}`;
  }
  if (error instanceof GraphError) return withReason(`graph_${error.status}`, error.reason);
  if (error instanceof GoogleApiError) return withReason(`google_${error.status}`, error.reason);
  if (error instanceof Error) {
    // Over the Durable Object boundary a subclass becomes a plain Error with its own properties.
    if (error.name === "Error") {
      // A TokenError that crossed the boundary: its message is its code.
      const code = safeCode(error);
      if (code && error.message.startsWith(code)) return `token_${code}`;
      // A provider error that crossed the boundary: the same code as before it crossed.
      const crossed = parseProviderErrorMessage(error.message);
      if (crossed) {
        return withReason(`${crossed.provider.toLowerCase()}_${crossed.status}`, crossed.reason);
      }
      return safeMessage(error) ?? code ?? "Error";
    }
    return error.name;
  }
  return "unknown";
}

function withReason(code: string, reason: string | undefined): string {
  return reason ? `${code}_${reason}` : code;
}

/** The org and user that own an account, or null if the account is gone. */
export async function accountOwner(
  db: D1Database,
  accountId: string,
): Promise<{ orgId: string; userId: string } | null> {
  return db
    .prepare(
      `SELECT u.org_id AS orgId, u.id AS userId FROM accounts a
       JOIN users u ON u.id = a.user_id WHERE a.id = ?`,
    )
    .bind(accountId)
    .first<{ orgId: string; userId: string }>();
}

/** Delete events past the retention period and close abandoned tombstones. One statement. */
export async function purgeAuditEvents<T = unknown>(
  db: D1Database,
  /** Runs in the same D1 step, so that a read of the cron costs no subrequest of its own. */
  alongside?: D1PreparedStatement,
  now: number = Date.now(),
): Promise<T[]> {
  const cutoff = `-${AUDIT_RETENTION_DAYS} days`;
  const answers = await db.batch<T>([
    db
      .prepare(
        `DELETE FROM audit_events
         WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
      )
      .bind(cutoff),
    // A tombstone holds a calendar name of an account that may be gone. Same retention as the log.
    db
      .prepare(
        `DELETE FROM cleanup_tombstones
         WHERE updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
      )
      .bind(cutoff),
    ...closeAbandonedTombstones(db, now),
    ...(alongside ? [alongside] : []),
  ]);
  return alongside ? (answers.at(-1)?.results ?? []) : [];
}

export interface ActivityRow {
  id: number;
  kind: AuditKind;
  detail: string;
  createdAt: string;
  /** Set on the org-wide view only. */
  email: string | null;
  /** The connected account, on the view of its own user only. Admins do not get this address. */
  accountEmail?: string | null;
}

/** The latest events of one user. */
export async function userActivity(
  db: D1Database,
  userId: string,
  limit = ACTIVITY_LIMIT,
): Promise<ActivityRow[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.kind, e.detail, e.created_at AS createdAt, NULL AS email,
              a.email AS accountEmail
       FROM audit_events e LEFT JOIN accounts a ON a.id = e.account_id
       WHERE e.user_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<ActivityRow>();
  return results;
}

/** The latest events of an org, with the email of the user they belong to. */
export async function orgActivity(
  db: D1Database,
  orgId: string,
  limit = ACTIVITY_LIMIT,
): Promise<ActivityRow[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.kind, e.detail, e.created_at AS createdAt, u.email
       FROM audit_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.org_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    )
    .bind(orgId, limit)
    .all<ActivityRow>();
  return results;
}

/** Calendars per mode that the admin page shows the last comparison of. */
export const COMPARE_LIMIT = 20;

/**
 * The latest comparison per calendar and mode of an org. Its own query: hourly `sync_run` rows push
 * a comparison out of the rows of `orgActivity`. The limit applies per mode: there are more daily
 * comparisons than full ones, and they must not push the full ones out. It reads the org's rows of
 * the retention period through `audit_events_org_created`, once per view of the admin page.
 */
export async function latestCompares(
  db: D1Database,
  orgId: string,
  limit = COMPARE_LIMIT,
): Promise<ActivityRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, detail, createdAt, email FROM (
         SELECT e.id, e.kind, e.detail, e.created_at AS createdAt, a.email,
                ROW_NUMBER() OVER (
                  PARTITION BY json_extract(e.detail, '$.mode')
                  ORDER BY e.created_at DESC, e.id DESC) AS position
         FROM audit_events e LEFT JOIN accounts a ON a.id = e.account_id
         WHERE e.id IN (
           SELECT MAX(id) FROM audit_events
           WHERE org_id = ? AND kind IN ('compare_run', 'compare_failed')
           GROUP BY account_id, json_extract(detail, '$.calendarId'),
                    json_extract(detail, '$.mode')))
       WHERE position <= ? ORDER BY createdAt DESC, id DESC`,
    )
    .bind(orgId, limit)
    .all<ActivityRow>();
  return results;
}

/** The latest finished (non-dry) run or failure of one rule. */
export interface RuleOutcome {
  ruleId: string;
  accountId: string | null;
  kind: "sync_run" | "sync_failed";
  createdAt: string;
  /** False if the rule is paused or turned off; its outcome is history, not the current state. */
  enabled: boolean;
  detail: Partial<SyncRunDetail> & { code?: string };
}

/**
 * Latest outcome per rule of a user. Dry runs do not count: they write nothing. Only rules that
 * still exist count, so that a deleted rule does not keep a failure on the pages until the log
 * purges it. Outcomes of paused rules carry `enabled: false`.
 */
export async function latestRuleOutcomes(db: D1Database, userId: string): Promise<RuleOutcome[]> {
  const { results } = await db
    .prepare(
      `SELECT e.rule_id AS ruleId, e.account_id AS accountId, e.kind, e.created_at AS createdAt,
              e.detail, r.enabled
       FROM audit_events e JOIN rules r ON r.id = e.rule_id AND r.user_id = ?
       WHERE e.id IN (
         SELECT MAX(id) FROM audit_events
         WHERE user_id = ? AND rule_id IS NOT NULL AND kind IN ('sync_run', 'sync_failed')
           AND COALESCE(json_extract(detail, '$.dryRun'), 0) = 0
         GROUP BY rule_id)`,
    )
    .bind(userId, userId)
    .all<Omit<RuleOutcome, "detail" | "enabled"> & { detail: string; enabled: number }>();
  return results.map((row) => ({
    ...row,
    enabled: row.enabled === 1,
    detail: parseDetail(row.detail),
  }));
}

export function parseDetail(json: string): RuleOutcome["detail"] {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

/** One run or failure of a rule, as `recentRuleRuns` reads it. */
/** A run, a failure, or a run that the platform stopped at its CPU or subrequest limit. */
export interface RecentRun {
  ruleId: string;
  kind: "sync_run" | "sync_failed" | "sync_run_aborted";
  createdAt: string;
  detail: Partial<SyncRunDetail> & { code?: string };
}

/**
 * The runs and failures among the newest `limit` audit rows of a user, newest first, without dry
 * runs. Unlike `latestRuleOutcomes`, which reads every audit row of the user, this stops at `limit`:
 * an API client can call it in a loop, and D1 refuses every query of the deployment at its daily
 * limit of rows read. The limit sits in the subquery because a LIMIT on the outer query counts
 * matches, not rows read. A rule that ran only before these rows does not appear.
 */
export async function recentRuleRuns(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<RecentRun[]> {
  const { results } = await db
    .prepare(
      `SELECT rule_id AS ruleId, kind, created_at AS createdAt, detail FROM (
         SELECT id, rule_id, kind, created_at, detail FROM audit_events
         WHERE user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )
       WHERE rule_id IS NOT NULL AND kind IN ('sync_run', 'sync_failed', 'sync_run_aborted')
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(userId, limit)
    .all<Omit<RecentRun, "detail"> & { detail: string }>();
  return results
    .map((row) => ({ ...row, detail: parseDetail(row.detail) }))
    .filter((row) => !row.detail.dryRun);
}

/** What the accounts page shows for one account. */
export interface AccountSyncStatus {
  /** "paused": every rule into the account that ever ran is paused or turned off. */
  state: "ok" | "partial" | "error" | "paused";
  at: string;
  /** Error code of a failed run. */
  code?: string;
  /** Changes that failed in the last run. */
  failed?: number;
}

const STATE_RANK = { paused: -1, ok: 0, partial: 1, error: 2 } as const;

/**
 * The status of each target account from the latest outcome of each of its rules. The worst
 * state wins, so one broken rule is not hidden by a healthy one. Ties go to the newer event. An
 * account whose rules are all paused shows as paused, with the time of the newest run; the
 * outcome of a paused rule says nothing about the current state.
 */
export function accountStatuses(outcomes: RuleOutcome[]): Map<string, AccountSyncStatus> {
  const statuses = new Map<string, AccountSyncStatus>();
  for (const outcome of outcomes) {
    if (!outcome.accountId) continue;
    if (!outcome.enabled) {
      const current = statuses.get(outcome.accountId);
      if (!current || (current.state === "paused" && outcome.createdAt > current.at)) {
        statuses.set(outcome.accountId, { state: "paused", at: outcome.createdAt });
      }
      continue;
    }
    const status = statusOf(outcome);
    const current = statuses.get(outcome.accountId);
    const worse =
      !current ||
      STATE_RANK[status.state] > STATE_RANK[current.state] ||
      (status.state === current.state && status.at > current.at);
    if (worse) statuses.set(outcome.accountId, status);
  }
  return statuses;
}

export function statusOf(
  outcome: Pick<RuleOutcome, "kind" | "createdAt" | "detail">,
): AccountSyncStatus {
  const at = outcome.createdAt;
  if (outcome.kind === "sync_failed") return { state: "error", at, code: outcome.detail.code };
  const failed = outcome.detail.failed ?? 0;
  if (failed > 0) return { state: "error", at, failed };
  if ((outcome.detail.remaining ?? 0) > 0) return { state: "partial", at };
  return { state: "ok", at };
}
