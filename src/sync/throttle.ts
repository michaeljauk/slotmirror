import type { SyncAction } from "./types";

/**
 * Microsoft and Google answer 429 (and sometimes 503) when a mailbox or a project gets too many
 * requests. The documented fix is to wait for `Retry-After` and try again; requests sent sooner
 * extend the penalty.
 */
export function isThrottleStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** Wait this long when a throttled response has no `Retry-After`. */
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
  /** HTTP status of each failed or throttled action, counted per status. */
  statuses: Record<number, number>;
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
  outcome: (index: number) => { status: number | undefined; retryAfterMs?: number },
): BatchResult {
  const result: BatchResult = { failed: 0, throttled: 0, statuses: {} };
  actions.forEach((action, index) => {
    const { status = 0, retryAfterMs } = outcome(index);
    if (status >= 200 && status < 400) return;
    if (action.kind === "delete" && (status === 404 || status === 410)) return;
    result.statuses[status] = (result.statuses[status] ?? 0) + 1;
    if (isThrottleStatus(status)) {
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

/** Statuses as a short, stable string for the audit log, e.g. "429:13,400:2". */
export function formatStatuses(statuses: Record<number, number>): string {
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
 * in the status, which identifies it.
 */
export function throttleDelayMs(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const { status, retryAfterMs } = error as { status?: unknown; retryAfterMs?: unknown };
  if (typeof status === "number") {
    return isThrottleStatus(status)
      ? clampRetryAfter(typeof retryAfterMs === "number" ? retryAfterMs : undefined)
      : null;
  }
  return /^(Graph|Google) .*failed: (429|503)$/.test(error.message)
    ? clampRetryAfter(undefined)
    : null;
}
