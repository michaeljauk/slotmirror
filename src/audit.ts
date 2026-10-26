import { GoogleApiError } from "./providers/google-calendar";
import { GraphError } from "./providers/graph-calendar";
import { TokenError } from "./providers/microsoft";

/**
 * The audit log answers "who did what, and did the sync work". It stores IDs, times, counts and
 * codes. Never put event content or tokens into `detail`.
 */
export type AuditKind =
  | "sign_in"
  | "sign_in_refused"
  | "sign_out"
  | "account_connected"
  | "account_disconnected"
  | "account_renamed"
  | "token_refresh_failed"
  | "rule_created"
  | "rule_deleted"
  | "rule_enabled"
  | "rule_paused"
  | "rule_updated"
  | "group_changed"
  | "settings_changed"
  | "user_provisioned"
  | "user_deactivated"
  | "user_reactivated"
  | "user_deleted"
  | "sync_run"
  | "sync_failed";

/** Detail of a `sync_run` event. */
export interface SyncRunDetail {
  dryRun: boolean;
  create: number;
  update: number;
  delete: number;
  unchanged: number;
  applied: number;
  failed: number;
  remaining: number;
  /** Actions the provider throttled; they are part of `remaining`. */
  throttled: number;
  /** Status and reason of failed and throttled actions, e.g. "429 ApplicationThrottled:13". */
  statuses: string;
  durationMs: number;
}

export interface AuditEvent {
  orgId: string;
  userId?: string | null;
  accountId?: string | null;
  ruleId?: string | null;
  kind: AuditKind;
  detail?: Record<string, string | number | boolean>;
}

/** Audit rows older than this many days are deleted by the cron handler. */
export const AUDIT_RETENTION_DAYS = 90;

/** Rows shown on an activity page. */
export const ACTIVITY_LIMIT = 100;

/** Write one event. Never throws: a broken log must not break a sync or a sign-in. */
export async function recordAudit(db: D1Database, event: AuditEvent): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.orgId,
        event.userId ?? null,
        event.accountId ?? null,
        event.ruleId ?? null,
        event.kind,
        JSON.stringify(event.detail ?? {}),
      )
      .run();
  } catch (error) {
    console.error("Audit write failed", event.kind, error);
  }
}

/** A short code for an error, safe to store: no response bodies, no event content. */
export function errorCode(error: unknown): string {
  if (error instanceof TokenError) return `token_${error.code}`;
  if (error instanceof GraphError) return withReason(`graph_${error.status}`, error.reason);
  if (error instanceof GoogleApiError) return withReason(`google_${error.status}`, error.reason);
  // Errors thrown by this app carry static messages. Other error types may echo input.
  if (error instanceof Error && error.name === "Error") return error.message.slice(0, 120);
  return error instanceof Error ? error.name : "unknown";
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

/** Delete events past the retention period. One statement. */
export async function purgeAuditEvents(db: D1Database): Promise<void> {
  await db
    .prepare(
      `DELETE FROM audit_events
       WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`,
    )
    .bind(`-${AUDIT_RETENTION_DAYS} days`)
    .run();
}

export interface ActivityRow {
  id: number;
  kind: AuditKind;
  detail: string;
  createdAt: string;
  /** Set on the org-wide view only. */
  email: string | null;
}

/** The latest events of one user. */
export async function userActivity(
  db: D1Database,
  userId: string,
  limit = ACTIVITY_LIMIT,
): Promise<ActivityRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, detail, created_at AS createdAt, NULL AS email
       FROM audit_events WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
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

/** The latest finished (non-dry) run or failure of one rule. */
export interface RuleOutcome {
  ruleId: string;
  accountId: string | null;
  kind: "sync_run" | "sync_failed";
  createdAt: string;
  detail: Partial<SyncRunDetail> & { code?: string };
}

/** Latest outcome per rule of a user. Dry runs do not count: they write nothing. */
export async function latestRuleOutcomes(db: D1Database, userId: string): Promise<RuleOutcome[]> {
  const { results } = await db
    .prepare(
      `SELECT rule_id AS ruleId, account_id AS accountId, kind, created_at AS createdAt, detail
       FROM audit_events
       WHERE id IN (
         SELECT MAX(id) FROM audit_events
         WHERE user_id = ? AND rule_id IS NOT NULL AND kind IN ('sync_run', 'sync_failed')
           AND COALESCE(json_extract(detail, '$.dryRun'), 0) = 0
         GROUP BY rule_id)`,
    )
    .bind(userId)
    .all<Omit<RuleOutcome, "detail"> & { detail: string }>();
  return results.map((row) => ({ ...row, detail: parseDetail(row.detail) }));
}

export function parseDetail(json: string): RuleOutcome["detail"] {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

/** What the accounts page shows for one account. */
export interface AccountSyncStatus {
  state: "ok" | "partial" | "error";
  at: string;
  /** Error code of a failed run. */
  code?: string;
  /** Changes that failed in the last run. */
  failed?: number;
}

const STATE_RANK = { ok: 0, partial: 1, error: 2 } as const;

/**
 * The status of each target account from the latest outcome of each of its rules. The worst
 * state wins, so one broken rule is not hidden by a healthy one. Ties go to the newer event.
 */
export function accountStatuses(outcomes: RuleOutcome[]): Map<string, AccountSyncStatus> {
  const statuses = new Map<string, AccountSyncStatus>();
  for (const outcome of outcomes) {
    if (!outcome.accountId) continue;
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

function statusOf(outcome: RuleOutcome): AccountSyncStatus {
  const at = outcome.createdAt;
  if (outcome.kind === "sync_failed") return { state: "error", at, code: outcome.detail.code };
  const failed = outcome.detail.failed ?? 0;
  if (failed > 0) return { state: "error", at, failed };
  if ((outcome.detail.remaining ?? 0) > 0) return { state: "partial", at };
  return { state: "ok", at };
}
