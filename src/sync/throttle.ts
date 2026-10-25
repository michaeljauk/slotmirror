import type { SyncAction } from "./types";

/**
 * True if a provider refused a request because of too many requests. Microsoft answers 429 (and
 * sometimes 503). Google also answers 403 with the reason `rateLimitExceeded` or
 * `userRateLimitExceeded`. The documented fix is to wait and try again; requests sent sooner
 * extend the penalty.
 *
 * Google's 403 `quotaExceeded` is not throttling: it protects against abuse and a quick retry does
 * not help.
 */
export function isThrottled(status: number, reason?: string): boolean {
  if (status === 429 || status === 503) return true;
  return status === 403 && (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded");
}

/**
 * The provider's error code from an error body: Graph `error.code`, Google `error.errors[0].reason`.
 * Only identifier-like values are kept, so that no message text reaches the audit log.
 */
export function errorReason(body: unknown): string | undefined {
  const error = (body as { error?: { code?: unknown; errors?: { reason?: unknown }[] } } | null)
    ?.error;
  const reason = error?.errors?.[0]?.reason ?? error?.code;
  return typeof reason === "string" && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(reason)
    ? reason
    : undefined;
}

/** Message of a provider error. The status and reason come last, see `throttleDelayMs`. */
export function providerErrorMessage(
  provider: "Graph" | "Google",
  what: string,
  status: number,
  reason: string | undefined,
): string {
  return `${provider} ${what} failed: ${status}${reason ? ` ${reason}` : ""}`;
}

/**
 * Wait this long when a throttled response has no `Retry-After`. Google sends none and recommends
 * exponential backoff up to 32 or 64 seconds; one fixed wait in that range keeps no retry state.
 */
export const DEFAULT_RETRY_AFTER_MS = 30_000;

/** Bounds for a `Retry-After` wait. The cron handler starts a full cycle every 10 minutes anyway. */
const MIN_RETRY_AFTER_MS = 2_000;
const MAX_RETRY_AFTER_MS = 300_000;

/** `Retry-After` as milliseconds: delay seconds or an HTTP date. Undefined if absent or invalid. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function clampRetryAfter(ms: number | undefined): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms ?? DEFAULT_RETRY_AFTER_MS));
}

/** Outcome of one write batch. */
export interface BatchResult {
  /** Actions that failed for another reason than throttling. The next run plans them again. */
  failed: number;
  /** Actions the provider refused because of throttling. They run again after `retryAfterMs`. */
  throttled: number;
  /** Failed and throttled actions counted per "status" or "status reason", e.g. "429 ApplicationThrottled". */
  statuses: Record<string, number>;
  /** The longest `Retry-After` of the throttled actions, if the provider sent one. */
  retryAfterMs?: number;
}

export const EMPTY_BATCH_RESULT: BatchResult = { failed: 0, throttled: 0, statuses: {} };

/**
 * Count the outcome of a batch from the status of each action. A missing status counts as
 * status 0. A delete of a block that is already gone (404, 410) is a success.
 */
export function summarizeBatch(
  actions: SyncAction[],
  outcome: (index: number) => {
    status: number | undefined;
    reason?: string | undefined;
    retryAfterMs?: number | undefined;
  },
): BatchResult {
  const result: BatchResult = { failed: 0, throttled: 0, statuses: {} };
  actions.forEach((action, index) => {
    const { status = 0, reason, retryAfterMs } = outcome(index);
    if (status >= 200 && status < 400) return;
    if (action.kind === "delete" && (status === 404 || status === 410)) return;
    const key = reason ? `${status} ${reason}` : String(status);
    result.statuses[key] = (result.statuses[key] ?? 0) + 1;
    if (isThrottled(status, reason)) {
      result.throttled++;
      if (retryAfterMs !== undefined) {
        result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, retryAfterMs);
      }
    } else {
      result.failed++;
    }
  });
  return result;
}

/** Statuses as a short, stable string for the audit log, e.g. "429 ApplicationThrottled:13,400:2". */
export function formatStatuses(statuses: Record<string, number>): string {
  return Object.entries(statuses)
    .sort(([, a], [, b]) => b - a)
    .map(([status, count]) => `${status}:${count}`)
    .join(",");
}

/**
 * The wait before the next attempt if `error` is a throttled response, otherwise null.
 *
 * Errors that cross a Durable Object RPC boundary keep only their message, so a throttled read of
 * the source account arrives as a plain Error. The message of GraphError and GoogleApiError ends
 * in the status and reason, which identify it.
 */
export function throttleDelayMs(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const { status, retryAfterMs } = error as { status?: unknown; retryAfterMs?: unknown };
  const delay = clampRetryAfter(typeof retryAfterMs === "number" ? retryAfterMs : undefined);
  const { reason } = error as { reason?: unknown };
  if (typeof status === "number") {
    return isThrottled(status, typeof reason === "string" ? reason : undefined) ? delay : null;
  }
  const match = /^(?:Graph|Google) .* failed: (\d{3})(?: (\w+))?$/.exec(error.message);
  return match && isThrottled(Number(match[1]), match[2]) ? delay : null;
}
