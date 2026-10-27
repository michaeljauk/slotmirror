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
  | "sync_failed"
  | "feed_created"
  | "feed_rotated"
  | "feed_deleted";

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

/**
 * The insert of one event, for a batch. With `onlyIfRuleExists` the row is written only if the
 * event's rule exists, for example after an insert that a concurrent request made a no-op.
 */
export function auditStatement(
  db: D1Database,
  event: AuditEvent,
  onlyIfRuleExists = false,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE ?7 = 0 OR EXISTS (SELECT 1 FROM rules WHERE id = ?4)`,
    )
    .bind(
      event.orgId,
      event.userId ?? null,
      event.accountId ?? null,
      event.ruleId ?? null,
      event.kind,
      JSON.stringify(event.detail ?? {}),
      onlyIfRuleExists ? 1 : 0,
    );
}

/** Write one event. Never throws: a broken log must not break a sync or a sign-in. */
export async function recordAudit(db: D1Database, event: AuditEvent): Promise<void> {
  try {
    await auditStatement(db, event).run();
  } catch (error) {
    console.error("Audit write failed", event.kind, ...errorLogFields(error));
  }
}

/**
 * Messages this app throws itself. They hold no provider text and no user data, so they are safe
 * to log and store. A Durable Object error reaches the Worker as a plain `Error`, so the UI and
 * the audit log tell these apart by message.
 */
const STATIC_MESSAGES = new Set([
  "Account has no tokens",
  "Simulation is off",
  "A rule runs in the instance of its target account",
  "Token response carries no ID token",
  "Batch too large",
  "Google listed no sync token",
  "Google address is not verified",
  "Malformed ID token",
  "ID token carries no email or preferred_username",
  "Google event time has neither date nor dateTime",
]);

/**
 * Static text with IDs, status codes or a time zone name: "Rule <id> not found",
 * "Graph <what> failed: 403 <reason>". Also the messages of the runtime and of this app's own
 * error classes. A V8 TypeError or RangeError can quote values and is not listed.
 */
const STATIC_PATTERNS = [
  /^Rule [\w-]{1,64} not found$/,
  // The zone name comes from the provider, not from the user.
  /^Expected UTC times from Graph, got [A-Za-z0-9_/+ .-]{1,64}$/,
  /^(Graph|Google) [A-Za-z $]{1,40} failed: \d{3}( [A-Za-z0-9_.-]{1,64})?$/,
  /^Requesting a sync failed in \d{1,5} account\(s\)$/,
  // workerd and the Workers platform. The first six strings are in the workerd binary; the
  // subrequest and free-tier messages come from the platform and follow its documented wording.
  /^Network connection lost\.$/,
  /^Worker exceeded CPU time limit\.?$/,
  /^internal error; reference = [\w-]{1,64}$/,
  /^Durable Object storage operation exceeded timeout which caused object to be reset\.$/,
  /^Durable Object waited for too long\. The call was canceled and the Durable Object was reset\.$/,
  /^Durable Object storage (deleteAll\(\)|write) caused object to be reset; reference = [\w-]{1,64}$/,
  /^Durable Object's isolate exceeded its memory limit due to overflowing the storage cache\.[ -~]{0,200}$/,
  /^Too many subrequests( by single Worker invocation\.[ -~]{0,160}|\.)$/,
  /^Exceeded allowed (rows read|rows written|duration) in Durable Objects free tier\.$/,
];

/**
 * D1 messages that name tables and columns but quote no bound value: "D1_ERROR: UNIQUE
 * constraint failed: users.email". D1_TYPE_ERROR can quote a bound value and is left out.
 */
const D1_MESSAGE = /^D1_ERROR: [A-Za-z0-9_ .,:()'*-]{1,160}$/;

/**
 * The message of an error, only if it cannot quote provider text or user data: a static message
 * of this app or of the runtime, or a D1 message that holds no bound values.
 */
export function safeMessage(error: Error): string | undefined {
  const { message } = error;
  if (STATIC_MESSAGES.has(message) || STATIC_PATTERNS.some((pattern) => pattern.test(message))) {
    return message;
  }
  if (D1_MESSAGE.test(message)) return message;
  return undefined;
}

/** An own `code` property that survived the Durable Object boundary, if it looks like a code. */
function safeCode(error: Error): string | undefined {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/i.test(code) ? code : undefined;
}

const FRAME = /^\s+at (?:[^\n]* \()?[^\s()]+:\d+:\d+\)?$/;

/**
 * The stack frames, without the message and its extra lines. Only lines of the form
 * "at <name> (<path>:<line>:<col>)" or "at <path>:<line>:<col>" count as frames.
 */
export function stackFrames(error: Error): string {
  // The stack starts with "name: message". A message of several lines takes several lines.
  const lines = (error.stack ?? "").split("\n").slice(error.message.split("\n").length);
  return lines.filter((line) => FRAME.test(line)).join("\n");
}

/**
 * What to log for an error: name, a safe code, a safe message and the stack frames. Never the raw
 * message or stack. A provider's `error_description` can name the user, and a SyntaxError can
 * quote the input. Spread the result into `console.error`.
 */
export function errorLogFields(error: unknown): string[] {
  if (!(error instanceof Error)) return [typeof error];
  const fields = [error.name];
  const code = safeCode(error);
  if (code) fields.push(code);
  const message = safeMessage(error);
  if (message) fields.push(message);
  fields.push(stackFrames(error));
  return fields;
}

/** A short code for an error, safe to store: no response bodies, no event content. */
export function errorCode(error: unknown): string {
  if (error instanceof TokenError) return `token_${error.code}`;
  if (error instanceof GraphError) return withReason(`graph_${error.status}`, error.reason);
  if (error instanceof GoogleApiError) return withReason(`google_${error.status}`, error.reason);
  if (error instanceof Error) {
    // Over the Durable Object boundary a subclass becomes a plain Error with its own properties.
    if (error.name === "Error") {
      // A TokenError that crossed the boundary: its message is its code.
      const code = safeCode(error);
      if (code && error.message.startsWith(code)) return `token_${code}`;
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

function statusOf(outcome: RuleOutcome): AccountSyncStatus {
  const at = outcome.createdAt;
  if (outcome.kind === "sync_failed") return { state: "error", at, code: outcome.detail.code };
  const failed = outcome.detail.failed ?? 0;
  if (failed > 0) return { state: "error", at, failed };
  if ((outcome.detail.remaining ?? 0) > 0) return { state: "partial", at };
  return { state: "ok", at };
}
