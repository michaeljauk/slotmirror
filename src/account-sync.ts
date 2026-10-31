import { DurableObject } from "cloudflare:workers";
import {
  accountOwner,
  auditStatement,
  errorCode,
  errorLogFields,
  recordAudit,
  recordAuditChecked,
  runsWithOutcome,
  type AuditEvent,
  type AuditKind,
  type CleanupResult,
  type SyncRunDetail,
} from "./audit";
import type { Provider } from "./config";
import {
  calendarClient,
  oneCallAtATime,
  type CalendarClient,
  type CalendarInfo,
  type ChangeFeed,
} from "./providers/calendar-client";
import { clientCredentials, oauthClient } from "./providers/oauth-clients";
import { TokenError, type TokenResponse } from "./providers/oauth-token";
import {
  blocksAtEdge,
  claimsFrom,
  countDuplicates,
  desiredBlocks,
  endsAtStart,
  inPrecedenceOrder,
  markerFor,
  planSync,
  ruleTagFor,
  type EdgeRead,
} from "./sync/plan";
import {
  cleanupWindow,
  edgeReadWindow,
  leftoverCalendars,
  loadRule,
  originLine,
  ownerMayRun,
  ruleWritesInto,
  rulesIntoCalendar,
  rulesRunningFromAlarm,
  rulesTargetingAccount,
  rulesThroughOtherRows,
  type RuleContext,
  siblingRuleIds,
  readWindow,
  startsBeyond,
  syncWindow,
  targetCalendars,
  targetReadWindow,
} from "./sync/rules";
import {
  addSlice,
  blockReadWindow,
  COMPARE_TIMEOUT_MS,
  compareSlice,
  failureDetail,
  finishScan,
  halveSlice,
  MAX_SLICE_ITEMS,
  MAX_SLICE_READS,
  newCompare,
  ruleSetHash,
  scanHorizon,
  sliceAfter,
  sliceItems,
  type SliceWindow,
  sourceReadWindow,
  startConfirmScan,
  type CompareFailure,
  type CompareMode,
  type CompareReport,
  type CompareRule,
  type CompareState,
} from "./sync/compare";
import {
  clampRetryAfter,
  formatStatuses,
  throttleDelayMs,
  type BatchResult,
} from "./sync/throttle";
import type { ExistingBlock, SourceEvent, SyncPlan } from "./sync/types";
import { decryptJson, encryptJson } from "./token-crypto";
import { detailLevelFor } from "./detail-policy";
import { accountSync } from "./durable";
import {
  feedCalendarsOfAccount,
  limitFeedEvents,
  storeFeedOwnership,
  type FeedLimits,
} from "./feeds";
import type { Watch } from "./providers/calendar-client";
import {
  addFakeEvent,
  FakeCalendar,
  injectFakeFault,
  measureFetchBudget,
  readFakeStats,
  recordFakeStep,
  seedFakeEvents,
  shiftFakeEvents,
  type FakeEvent,
  type FakeFault,
  type FetchBudget,
} from "./providers/fake-calendar";
import { notifyChange, requestSyncs, SyncRequestError, webhookToken, webhookUrl } from "./webhooks";
import { OWNER_COLUMNS, ownerAdmission, type OwnerColumns } from "./users";
import {
  compareAlertsAfter,
  sendAbortAlert,
  sendCompareAlert,
  sendReconnectAlert,
  type CompareAlert,
} from "./alerts";

export interface StoredTokens {
  refreshToken: string;
  accessToken: string;
  /** Unix milliseconds. */
  accessExpiresAt: number;
}

export interface RunResult {
  ruleId: string;
  dryRun: boolean;
  stats: SyncPlan["stats"];
  /** Actions written in this run; the rest follows in the next alarm. */
  applied: number;
  failed: number;
  /** Actions not written yet, including throttled ones. */
  remaining: number;
  /** Set if the provider throttled the run: wait this long before the next request. */
  retryAfterMs?: number;
}

export interface RunOptions {
  /** Plan only and write nothing. */
  dryRun?: boolean;
  /**
   * The alarm runs the rule. It keeps unfinished rules queued itself, and it skips a rule whose
   * source account needs reconnecting.
   */
  fromAlarm?: boolean;
  /** Set by `startRun`. `closed` turns true once the marker of the run may go. */
  progress?: { runId: string; closed: boolean };
}

/** Pause between two alarm runs of one queue when nothing is throttled. */
const NEXT_RUN_MS = 1_000;

/** Wait this long after a change notification before syncing, so that bursts collapse into one run. */
const DEBOUNCE_MS = 5_000;

/** Durable Object storage key of the rules still to run in the current cycle. */
const RULE_QUEUE_KEY = "ruleQueue";

/**
 * Durable Object storage key: queued rules whose source account throttled, with the time before
 * which they do not run again. The other queued rules run meanwhile. The entry stays until the
 * rule leaves the queue, so that a rule whose wait is over still counts as one that waited.
 */
const RULE_NOT_BEFORE_KEY = "ruleNotBefore";

/**
 * While only waiting rules are queued, the alarm comes back at least this often. Removals, retries
 * of sync requests, change checks and rules that a tick queues then do not wait for the longest
 * `Retry-After` of five minutes. A requested full cycle and change notifications still wait until
 * the queue is empty. Cost: up to 10 wakes per 5 minutes, each with one D1 query and no provider
 * call.
 */
const WAITING_RULES_CHECK_MS = 30_000;

/**
 * If D1 fails to tell which queued rules may run, the alarm tries again after this long. The wait
 * doubles with each failure in a row, up to RULE_LOOKUP_RETRY_MAX_MS.
 */
const RULE_LOOKUP_RETRY_MS = 30_000;
const RULE_LOOKUP_RETRY_MAX_MS = 10 * 60_000;

/** Durable Object storage key: failed rule lookups in a row. See RULE_LOOKUP_RETRY_MS. */
const RULE_LOOKUP_FAILURES_KEY = "ruleLookupFailures";

/** Result of a source read over RPC. See `readSourceForRule()`. */
type SourceRead = { events: SourceEvent[] } | { throttled: { message: string; waitMs: number } };

/**
 * The source account of a rule throttled the read of the source calendar. The message is the one
 * of the provider error, so that the audit log and `throttleDelayMs()` read it as before.
 */
class SourceThrottledError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/**
 * Durable Object storage key: a full cycle is requested. The next full cycle clears it when it
 * stores its queue. If it is still set when a queue is done, the request came during that queue,
 * after some rules ran, so one more full cycle follows.
 */
const CYCLE_AGAIN_KEY = "fullCycleRequested";

/** Durable Object storage key: event IDs this instance wrote recently, with the time. */
const RECENT_WRITES_KEY = "recentWrites";

/** A change notification this soon after our own write is recognised as its echo. */
const RECENT_WRITE_MS = 2 * 60_000;

/**
 * How long written IDs are kept. A change check can wait for the longest `Retry-After` of five
 * minutes; it compares with the notification's time, not with its own.
 */
const RECENT_WRITES_KEPT_MS = 10 * 60_000;

/** Durable Object storage key prefix: the change feed's sync token per calendar, for Google. */
const SYNC_TOKEN_PREFIX = "syncToken:";

/**
 * Durable Object storage key of the Google calendars whose change feed is still to read, with the
 * time of the last notification about each.
 */
const CHANGED_CALENDARS_KEY = "changedCalendars";

interface ChangedCalendar {
  calendarId: string;
  notifiedAt: number;
}

/** A queued calendar. A plain ID was queued before the queue kept notification times. */
function changedCalendar(queued: ChangedCalendar | string): ChangedCalendar {
  return typeof queued === "string" ? { calendarId: queued, notifiedAt: Date.now() } : queued;
}

/**
 * Durable Object storage key of the event IDs from Graph notifications that are still to check,
 * with the time of the last notification about each.
 */
const NOTIFIED_EVENTS_KEY = "notifiedEvents";

/**
 * Durable Object storage key: the pending alarm is only for checking change notifications (true),
 * or only for the retry of a failed sync request (`RETRY_ALARM`). Without it, an alarm with an
 * empty rule queue starts a full cycle.
 */
const FEED_ONLY_ALARM_KEY = "feedOnlyAlarm";

const RETRY_ALARM = "retry";

/** Mark of an alarm that only waits for a removal's next attempt. */
const REMOVAL_ALARM = "removal";

/** Mark of an alarm that only reads the next slice of a comparison. */
const COMPARE_ALARM = "compare";

/** Alarm marks that other work may replace; the alarm sets them again when it is done. */
const WAITING_ALARMS: readonly unknown[] = [RETRY_ALARM, REMOVAL_ALARM, COMPARE_ALARM];

/**
 * Durable Object storage key of sync requests that failed after a change: the accounts (all that
 * the change concerns if unknown), the failed attempts, and when to try again.
 */
const SYNC_REQUEST_RETRY_KEY = "syncRequestRetry";

interface SyncRequestRetry {
  accountIds?: string[];
  attempts: number;
  at: number;
}

/** Give up on a failed sync request after this many attempts; the hourly full cycle catches up. */
const MAX_SYNC_REQUEST_ATTEMPTS = 4;

/** Wait before the first retry of a failed sync request; each further retry waits twice as long. */
const SYNC_REQUEST_RETRY_MS = 30_000;

/** Durable Object storage key: when the last full cycle over all rules started. */
const FULL_CYCLE_KEY = "fullCycleAt";

/**
 * With change notifications, a full cycle over all rules runs once an hour as a check; the cron in
 * between polls only rules whose calendars have no active watch.
 */
const FULL_CYCLE_EVERY_MS = 60 * 60_000;

/** Durable Object storage key: when the next check of the owners of feed calendars is due. */
const FEED_OWNERSHIP_CHECK_KEY = "feedOwnershipCheckAt";

/** A successful check of the owners of feed calendars holds for this long. */
const FEED_OWNERSHIP_CHECK_EVERY_MS = 24 * 60 * 60_000;

/** A check that lost a calendar holds for this long, so that one short list soon heals. */
const FEED_OWNERSHIP_RECHECK_MS = 60 * 60_000;

/** Durable Object storage key of block removals for deleted or switched-off rules. */
const REMOVAL_QUEUE_KEY = "removalQueue";

/**
 * Token errors that mean the refresh token is gone for good: revoked, expired (Google's testing
 * mode ends tokens after 7 days), or new consent needed.
 */
const RECONNECT_CODES = new Set(["invalid_grant", "interaction_required", "consent_required"]);

/**
 * Durable Object storage key of the pause after a refused refresh token. While it is set, the
 * instance asks no provider and its alarm does no sync work. New tokens end it.
 */
const PAUSE_KEY = "needsReconnect";

/** While paused, try the refused token again after this long; some refusals end by themselves. */
const PROBE_EVERY_MS = 24 * 60 * 60_000;

interface Pause {
  /** The provider's error code. */
  code: string;
  /** When the refusal was seen. Tells this pause from a later one. */
  since: number;
  /** D1 does not show the account as needing a reconnect yet. */
  flagPending: boolean;
  /** The alert to ALERT_WEBHOOK_URL is not sent yet. */
  alertPending: boolean;
  /** No token probe before this time. */
  probeAt: number;
}

/**
 * How long a source calendar's events are reused. Within one sync cycle, every rule from that
 * calendar reads it; with ten accounts that is nine reads of the same data. A new cycle (cron or a
 * change notification) clears the cache, so a change is never missed.
 */
const SOURCE_CACHE_MS = 60_000;

/** How long a new watch lasts. Graph allows under 7 days for events. */
const WATCH_LIFETIME_MS = 6 * 24 * 60 * 60 * 1000;

/** Renew a watch when less than this is left. The cron runs every 10 minutes, so this is plenty. */
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

/**
 * Durable Object storage key: until when the provider throttles this account (Unix ms). `client()`
 * sets it from every throttled answer. Feed reads do not call the provider before it; the sync
 * keeps waiting through its alarm.
 */
const THROTTLED_UNTIL_KEY = "throttledUntil";

/** A feed read reached the provider queue during a penalty; it made no provider call. */
class PenaltyActive extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Provider penalty active");
  }
}

/** Outcome of a feed read. A throttled or unreadable calendar is an answer, not an error. */
export type FeedRead =
  | { kind: "events"; events: SourceEvent[]; cutAt?: string | null }
  | { kind: "throttled"; retryAfterMs: number }
  | { kind: "unavailable" };

/**
 * Durable Object storage prefix of start markers, `runStarted:<ruleId>:<runId>`. A real run writes
 * its marker first and removes it once its audit event is written. Each run has its own key, so a
 * later run cannot overwrite the marker of a run that died.
 */
const RUN_MARKER_PREFIX = "runStarted:";

/** Aborted runs that one tick or alarm reports. The rest follows in the next one. */
const MAX_ABORT_REPORTS = 5;

/**
 * Durable Object storage key: IDs of rules with an aborted run that the operator has not heard of
 * yet. They stay until the webhook accepts the alert.
 */
const ABORT_ALERTS_KEY = "abortAlerts";

/**
 * Durable Object storage key: finished comparisons with confirmed deviations that the operator has
 * not heard of yet, at most one per calendar. They stay until the webhook accepts the alert, also
 * through the repeat lock of their calendar, or until a newer result replaces or ends them.
 */
const COMPARE_ALERTS_KEY = "compareAlerts";

/** The ID of a comparison. A calendar has one open comparison, and a new one starts later. */
function compareRunKey(alert: CompareAlert): string {
  return `${alert.calendarId}@${alert.scanStartedAt}`;
}

interface RunMarker {
  ruleId: string;
  runId: string;
  /** Unix ms. */
  startedAt: number;
}

/** Durable Object storage prefix of open comparisons, `compare:<calendarId>`. See `CompareState`. */
const COMPARE_PREFIX = "compare:";

/**
 * Durable Object storage prefix: the start time of a rule's last successful run. A hit of a
 * comparison counts only after such a run; see `finishScan`.
 */
const RULE_OK_PREFIX = "ruleOkAt:";

/** Durable Object storage key: when the last daily comparison started. */
const NEAR_COMPARE_KEY = "nearCompareAt";

/** What a request to start comparisons did with each calendar. */
export interface CompareStart {
  started: number;
  /** A comparison was open already. */
  open: number;
  /** The calendar cannot be compared now; the audit log names the reason. */
  failed: number;
}

/** The daily comparison of the first slice. It is no substitute for a full comparison. */
const NEAR_COMPARE_EVERY_MS = 24 * 60 * 60_000;

/** A read of a comparison met a condition that ends it. */
class CompareStopped extends Error {
  constructor(readonly failure: CompareFailure) {
    super(failure.reason);
  }
}

/** The failure of a comparison for an error from its reads. */
function compareFailure(error: unknown): CompareFailure {
  if (error instanceof CompareStopped) return error.failure;
  if (error instanceof PenaltyActive) return { reason: "throttled", code: "penalty" };
  const code = errorCode(error);
  if (throttleDelayMs(error) !== null) return { reason: "throttled", code };
  return { reason: code.startsWith("token_") ? "token_lost" : "read_failed", code };
}

/** The platform refused a read at the subrequest limit, so the slice takes too many pages. */
function isSubrequestLimit(error: unknown): boolean {
  return error instanceof Error && /^Too many subrequests/.test(error.message);
}

/** The rules of a calendar as a comparison needs them, and their hash. */
interface CompareContext {
  rules: RuleContext[];
  inputs: CompareRule[];
  /** See `SliceInput.others`. */
  others: string[];
  hash: string;
}

function compareRule(rule: RuleContext): CompareRule {
  const { accountId, remoteCalendarId } = rule.source;
  return { id: rule.id, options: rule.options, source: `${accountId}|${remoteCalendarId}` };
}

/**
 * Durable Object storage key: forget the tokens once every queued removal ran. The value is the
 * generation of the request that started the retirement. It is `true` if an alarm resumed the
 * retirement, or if a version without generations stored it.
 */
const RETIRING_KEY = "retiring";

/**
 * Durable Object storage key: a retirement ended, and an alarm must read the account's row. A
 * delete can land after the end, and then no cron reaches this instance. Every end writes a new
 * `id`, so that a check under way sees that its read is stale.
 */
const RETIREMENT_CHECK_KEY = "retirementCheck";

interface RetirementCheck {
  id: string;
  endedAt: number;
}

/**
 * Wait before the next alarm of a retirement whose alarm failed, for example in a D1 outage. A check
 * also waits this long after the end before it trusts a row: a delete may still be under way.
 */
const RETIREMENT_RETRY_MS = 60_000;

/** Durable Object storage key: the retiring account tried to stop its watches; `forget()` retries. */
const WATCHES_TRIED_KEY = "watchesTried";

/** Give up on a removal after this many failed attempts in a row; the blocks then stay. */
const MAX_REMOVAL_ATTEMPTS = 5;

/**
 * Wait after the first, second, third and fourth failed attempt of a removal. The rule is gone, so
 * no later run removes its blocks: the attempts span a provider outage of about 14 hours.
 */
const REMOVAL_BACKOFF_MS = [60_000, 10 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];

interface Removal {
  ruleId: string;
  remoteCalendarId: string;
  /**
   * Failed attempts in a row. An attempt that removed blocks starts the count again, unless its
   * edge read failed. Such an attempt keeps the count while blocks are left. Once none is left, it
   * counts as failed, so that a lasting failure of that read ends the job.
   */
  attempts: number;
  /** After a failed attempt: do not try again before this time. */
  notBefore?: number;
  /**
   * An attempt ran, with any outcome. `attempts` cannot tell this: it goes back to 0 after progress
   * and stays 0 after throttling. Jobs stored before this field count as started if `attempts > 0`.
   * A trim never reads this, so it never sets it.
   */
  started?: true;
  /**
   * Remove only the blocks beyond the rule's current sync window, after its `daysAhead` went down.
   * The rule stays; no run reads that far, so no run removes them.
   */
  trim?: true;
  /** Set if an offboarding queued the job. The job then ends with an entry in the audit log. */
  offboarding?: OffboardingProgress;
  /**
   * How often a request queued this job again. A step that read the rule from D1 compares this,
   * so that it does not act on a read older than the request. The next step starts from 0. A trim
   * never reads this, so it never counts.
   */
  requeued?: number;
}

/** Who gets the result of an offboarding's removal. The rows are gone when the job ends. */
export interface OffboardingOwner {
  orgId: string;
  userId: string;
}

interface OffboardingProgress extends OffboardingOwner {
  /** Blocks removed over all steps of the job. */
  removed: number;
  /** Blocks left after the last step that could count them. */
  left?: number;
}

function sameRemoval(a: Removal, b: Removal): boolean {
  return (
    a.ruleId === b.ruleId &&
    a.remoteCalendarId === b.remoteCalendarId &&
    Boolean(a.trim) === Boolean(b.trim)
  );
}

/** Outcome of one attempt to remove a rule's blocks. */
type RemovalResult = {
  removed: number;
  remaining: number;
  throttled: boolean;
  retryAfterMs?: number;
  /** The edge read failed, so a block at the start of the window may still be there. */
  edgeReadFailed: boolean;
};

/** The first queued removal that may run at `now`. */
function dueRemoval(queue: Removal[], now: number): Removal | undefined {
  return queue.find((job) => (job.notBefore ?? 0) <= now);
}

/** The queued removal that may run first. */
function nextRemoval(queue: Removal[]): Removal | undefined {
  let next: Removal | undefined;
  for (const job of queue) {
    if (next === undefined || (job.notBefore ?? 0) < (next.notBefore ?? 0)) next = job;
  }
  return next;
}

/** Refresh the access token this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;

/** Write batches per invocation; a larger plan continues in the next alarm. */
const MAX_BATCHES_PER_RUN = 25;

/** How long the zone of a mailbox counts before the next lookup. */
const MAILBOX_ZONE_MS = 24 * 60 * 60 * 1000;

/**
 * How long a failed lookup counts. A block keeps the zone of its write, because the zone is not in
 * `contentHash`. So each all-day block that a run writes after a failure can stay off the local
 * day, and a short wait keeps that number small. Only a run with all-day writes makes a lookup.
 */
const MAILBOX_ZONE_RETRY_MS = 15 * 60 * 1000;

/** Durable Object storage key: the last lookup of the mailbox zone; see `allDayZone()`. */
const MAILBOX_ZONE_KEY = "mailboxZone";

/**
 * The answer of a lookup. Null: the mailbox names no usable zone, Graph refused the zone, or a
 * lookup failed with no zone known.
 */
interface MailboxZone {
  zone: string | null;
  at: number;
  /** The lookup failed, so this keeps the known zone for `MAILBOX_ZONE_RETRY_MS`. */
  failed?: boolean;
}

/**
 * Provider requests per invocation, reads and write batches together. The Free plan allows 50
 * subrequests. A token refresh can take one more, which this count does not include.
 */
const MAX_PROVIDER_REQUESTS = 48;

/**
 * The write batches of an invocation after `reads` provider reads. The rest waits for the next
 * step, which plans again from the calendars. A read has no page limit, so one batch always runs:
 * a step makes progress, or it fails at the limit and counts as failed.
 */
function batchBudget(reads: number): number {
  return Math.max(1, Math.min(MAX_BATCHES_PER_RUN, MAX_PROVIDER_REQUESTS - reads));
}

/**
 * One instance per connected account (named by `accounts.id`).
 *
 * The instance owns everything that must not be written concurrently: the encrypted OAuth tokens
 * (Microsoft rotates the refresh token on every use) and the webhook subscriptions. Requests to
 * one instance run one at a time.
 *
 * A rule runs in the instance of its target account. It reads the source events from the source
 * account's instance over RPC, so each instance only ever uses its own tokens. Which blocks exist
 * is read from the target calendar itself (blocks carry a marker), so no mapping state can drift.
 */
export class AccountSync extends DurableObject<Env> {
  private refreshing: Promise<string> | null = null;
  /** Source events per calendar and window, for the rules of one cycle. See SOURCE_CACHE_MS. */
  private sourceCache = new Map<string, { at: number; events: Promise<SourceEvent[]> }>();
  /** The last queued provider call. See `client()`. */
  private providerQueue: Promise<unknown> = Promise.resolve();
  /**
   * Provider reads of this instance so far. A step compares the count before and after its reads;
   * see `batchBudget`. Reads of a request during the step count too: they leave fewer batches.
   */
  private providerReads = 0;
  /**
   * Real rule runs in progress, by rule ID. In memory is enough: requests to one instance share it,
   * and a new instance has no run in progress.
   */
  private runningRules = new Map<string, Promise<RunResult>>();
  /** The report of aborted runs in progress. A tick and an alarm can overlap; they share it. */
  private abortReport: Promise<void> | null = null;
  /** A post of the reconnect alert runs. Lost with the instance, where the stored flag remains. */
  private sendingReconnectAlert = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  /**
   * Ask for a full cycle soon. Repeated calls before the alarm fires do not move it. During a
   * cycle, the alarm goes on with the queue, and one full cycle follows for all calls together.
   */
  async requestSync(): Promise<void> {
    // A new cycle starts from the provider's current data.
    this.sourceCache.clear();
    const pending = await this.pendingAlarm();
    await this.ctx.storage.delete(FEED_ONLY_ALARM_KEY);
    await this.ctx.storage.put(CYCLE_AGAIN_KEY, true);
    // While paused, the mark waits for the alarm that new tokens start.
    if (pending === null && !(await this.pause())) {
      await this.ctx.storage.setAlarm(Date.now() + this.delays().debounce);
    }
  }

  /**
   * The cron's call, every 10 minutes. Once an hour this is a full cycle. In between it queues only
   * rules whose source or target calendar has no active watch; changes to watched calendars
   * arrive as notifications. Without PUBLIC_URL no calendar is watched, so every tick polls all.
   */
  async tick(): Promise<void> {
    const accountId = this.accountIdOrNull();
    if (!accountId) return;
    await this.reportAbortedRuns(accountId, { retryAlerts: true });
    await this.sendCompareAlerts(accountId);
    // The pages show the D1 flag, so the pause follows it. A flag without a pause pauses and
    // probes; a pause whose flag is gone, after its own D1 write, is stale and ends.
    const row = await this.env.DB.prepare(
      "SELECT needs_reconnect AS flag FROM accounts WHERE id = ?",
    )
      .bind(accountId)
      .first<{ flag: number }>();
    let pause = await this.pause();
    if (pause && !pause.flagPending && row?.flag === 0) {
      await this.unpause();
      return;
    }
    if (!pause && row?.flag === 1) pause = await this.pauseForStaleFlag(accountId);
    if (pause) {
      await this.failOpenCompares({ reason: "paused", code: pause.code });
      await this.whilePaused(accountId, pause);
      return;
    }
    await this.compareTick();
    const lastFull = (await this.ctx.storage.get<number>(FULL_CYCLE_KEY)) ?? 0;
    if (Date.now() - lastFull >= FULL_CYCLE_EVERY_MS) {
      await this.requestSync();
      return;
    }
    const now = Date.now();
    // A requested full cycle runs every rule. Queued rules would run before it and delay it.
    if (await this.ctx.storage.get<boolean>(CYCLE_AGAIN_KEY)) {
      if ((await this.pendingAlarm()) === null)
        await this.setSyncAlarm(now + this.delays().debounce);
      return;
    }
    const { results } = await this.env.DB.prepare(
      `SELECT r.id, ${OWNER_COLUMNS} FROM rules r
       JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN accounts sa ON sa.id = sc.account_id
       JOIN calendars tc ON tc.id = r.target_calendar_id
       JOIN users u ON u.id = r.user_id
       JOIN orgs o ON o.id = u.org_id
       WHERE tc.account_id = ? AND r.enabled = 1 AND u.active = 1 AND sa.needs_reconnect = 0
         AND (sc.watched_until IS NULL OR sc.watched_until < ?
              OR tc.watched_until IS NULL OR tc.watched_until < ?)
       ORDER BY r.id`,
    )
      .bind(accountId, now, now)
      .all<{ id: string } & OwnerColumns>();
    const due = results.filter(ownerAdmission(this.env)).map((row) => row.id);
    if (due.length === 0) return;
    await this.updateQueue<string>(RULE_QUEUE_KEY, (queue) =>
      inPrecedenceOrder([...new Set([...queue, ...due])]),
    );
    this.sourceCache.clear();
    if ((await this.pendingAlarm()) === null) {
      await this.setSyncAlarm(now + this.delays().debounce);
    }
  }

  /**
   * True if this instance wrote every event at most two minutes before its notification, or after
   * it: Graph may report a write before the `$batch` call returns.
   */
  private async reportsOwnWrites(notified: Record<string, number>): Promise<boolean> {
    const entries = Object.entries(notified);
    if (entries.length === 0) return false;
    const recent = await this.recentWrites();
    return entries.every(([id, at]) => (recent[id] ?? -Infinity) >= at - RECENT_WRITE_MS);
  }

  /**
   * A Google channel reported a change. Google names no events, so an alarm reads the calendar's
   * change feed and syncs only if something else changed than the blocks this instance wrote. The
   * alarm waits for a running write batch and for `Retry-After`, and one read covers a burst of
   * notifications. Without a known channel the sync starts at once.
   */
  async googleChanged(channelId: string): Promise<void> {
    const accountId = this.accountIdOrNull();
    if (!accountId || (await this.retiring())) return;
    const calendarId = this.storedWatches().find((watch) => watch.id === channelId)?.calendarId;
    if (!calendarId) {
      await notifyChange(this.env, accountId);
      return;
    }
    const changed = { calendarId, notifiedAt: Date.now() };
    // A queued calendar keeps its place, so that one calendar cannot hold back the others.
    await this.updateQueue<ChangedCalendar | string>(CHANGED_CALENDARS_KEY, (stored) => {
      const queue = stored.map(changedCalendar);
      return queue.some((queued) => queued.calendarId === calendarId)
        ? queue.map((queued) => (queued.calendarId === calendarId ? changed : queued))
        : [...queue, changed];
    });
    await this.setCheckAlarm();
  }

  /**
   * Graph reported changes to these events. An alarm syncs only if one of them is not a block this
   * instance wrote. The check must not run at once: Graph may report a new block before the
   * `$batch` call that wrote it returns, so before `rememberWrites()`. Alarms never overlap, so the
   * check sees every write of an alarm. A manual run (`runRule` from the editor) is no alarm; for
   * its writes only the debounce delay gives that time.
   */
  async graphChanged(eventIds: string[]): Promise<void> {
    if (!this.accountIdOrNull() || (await this.retiring())) return;
    const now = Date.now();
    await this.ctx.blockConcurrencyWhile(async () => {
      const queued =
        (await this.ctx.storage.get<Record<string, number>>(NOTIFIED_EVENTS_KEY)) ?? {};
      for (const id of eventIds) queued[id] = now;
      await this.ctx.storage.put(NOTIFIED_EVENTS_KEY, queued);
    });
    await this.setCheckAlarm();
  }

  /** Set an alarm for a change check, unless one is pending. It runs before any other work. */
  private async setCheckAlarm(): Promise<void> {
    if ((await this.pendingAlarm()) === null) {
      await this.ctx.storage.put(FEED_ONLY_ALARM_KEY, true);
      await this.ctx.storage.setAlarm(Date.now() + this.delays().debounce);
    }
  }

  /**
   * Check the reported changes: a due retry of a failed sync request, all IDs from Graph
   * notifications at once, or the change feed of one Google calendar. Sync if they show more than
   * our own writes. Returns false if the alarm may go on with other work: nothing waited, or the
   * check found only our own writes and so made no subrequest.
   */
  private async runChangeCheck(accountId: string): Promise<boolean> {
    if (await this.retiring()) {
      // The account is going: its changes concern no one, so neither read nor report them.
      await this.ctx.storage.delete([
        NOTIFIED_EVENTS_KEY,
        CHANGED_CALENDARS_KEY,
        SYNC_REQUEST_RETRY_KEY,
      ]);
      return false;
    }
    // Read before the first provider call: a notification during it may set the flag anew.
    const feedOnly = (await this.ctx.storage.get(FEED_ONLY_ALARM_KEY)) !== undefined;
    let delayMs = this.delays().nextRun;
    if (!(await this.retrySyncRequest(accountId))) {
      // Out of the queue before the check, so that a notification during the check queues it again.
      const notified = await this.ctx.blockConcurrencyWhile(async () => {
        const queued =
          (await this.ctx.storage.get<Record<string, number>>(NOTIFIED_EVENTS_KEY)) ?? {};
        await this.ctx.storage.delete(NOTIFIED_EVENTS_KEY);
        return queued;
      });
      if (Object.keys(notified).length > 0) {
        const echo = await this.reportsOwnWrites(notified);
        if (!echo) await this.requestSyncAfterChange(accountId);
        // Notifications about a large run arrive for seconds; other work must not wait for a gap.
        // The work sets its own next alarm.
        if (echo && (await this.hasSyncWork(feedOnly))) return false;
      } else {
        const checked = await this.checkChangeFeed(accountId);
        if (checked === null) return false;
        delayMs = checked;
      }
    }
    // Other work waits for the next alarm, so that this one stays within its budget.
    const otherWork = await this.hasSyncWork(feedOnly);
    const left =
      ((await this.ctx.storage.get<string[]>(CHANGED_CALENDARS_KEY)) ?? []).length > 0 ||
      (await this.ctx.storage.get(NOTIFIED_EVENTS_KEY)) !== undefined;
    if (otherWork) await this.setSyncAlarm(Date.now() + delayMs);
    else if (left) {
      // The alarm is for the checks now; other work must not take it for the retry's.
      if (WAITING_ALARMS.includes(await this.ctx.storage.get(FEED_ONLY_ALARM_KEY))) {
        await this.ctx.storage.put(FEED_ONLY_ALARM_KEY, true);
      }
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
    } else await this.ctx.storage.delete(FEED_ONLY_ALARM_KEY);
    return true;
  }

  /**
   * True if sync work waits: a full cycle (the alarm's own, or a requested one), rules, due
   * removals, or the account's retirement. A removal that waits after a failed attempt has its own
   * alarm (`keepRemovalAlarm()`).
   */
  private async hasSyncWork(feedOnly: boolean): Promise<boolean> {
    return (
      !feedOnly ||
      ((await this.ctx.storage.get<boolean>(CYCLE_AGAIN_KEY)) ?? false) ||
      ((await this.ctx.storage.get<string[]>(RULE_QUEUE_KEY)) ?? []).length > 0 ||
      dueRemoval((await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) ?? [], Date.now()) !==
        undefined ||
      ((await this.ctx.storage.get<boolean>(RETIRING_KEY)) ?? false)
    );
  }

  /**
   * Read the change feed of one reported Google calendar, and sync if it shows more than our own
   * writes. Returns the delay for the next alarm, or null if no calendar waits. A throttled read
   * waits for `Retry-After`; any other failed read syncs, so that no change is lost.
   */
  private async checkChangeFeed(accountId: string): Promise<number | null> {
    let first: ChangedCalendar | string | undefined;
    // Out of the queue before the read, so that a notification during the read queues it again.
    await this.updateQueue<ChangedCalendar | string>(CHANGED_CALENDARS_KEY, ([head, ...others]) => {
      first = head;
      return others;
    });
    if (first === undefined) return null;
    const changed = changedCalendar(first);
    const { calendarId, notifiedAt } = changed;
    const tokenKey = `${SYNC_TOKEN_PREFIX}${calendarId}`;
    let delayMs = this.delays().nextRun;
    let feed: ChangeFeed | null = null;
    let throttled = false;
    try {
      const client = await this.client();
      const syncToken = (await this.ctx.storage.get<string>(tokenKey)) ?? null;
      feed = await client.changesSince(calendarId, syncToken);
    } catch (error) {
      const throttleDelay = throttleDelayMs(error);
      if (throttleDelay !== null) {
        const retry = changed;
        // A notification during the read queued the calendar with a later time; that one counts.
        await this.updateQueue<ChangedCalendar | string>(CHANGED_CALENDARS_KEY, (stored) => {
          const queue = stored.map(changedCalendar);
          return queue.some((queued) => queued.calendarId === calendarId)
            ? queue
            : [retry, ...queue];
        });
        throttled = true;
        delayMs = throttleDelay;
      } else {
        console.error("Reading the change feed failed", calendarId, ...errorLogFields(error));
      }
    }
    if (!throttled) {
      const ids = feed?.ids ?? null;
      // A throttled run can delay this check by minutes; a write counts as ours if it happened
      // shortly before the notification, not before the check.
      const echo =
        ids !== null &&
        (ids.length === 0 ||
          (await this.reportsOwnWrites(Object.fromEntries(ids.map((id) => [id, notifiedAt])))));
      const requested = echo || (await this.requestSyncAfterChange(accountId));
      // Only once the sync is requested. After a failure, the next read returns these changes
      // again, so that they still sync if the retries give up.
      if (feed && requested) await this.ctx.storage.put(tokenKey, feed.syncToken);
    }
    return delayMs;
  }

  /**
   * Ask this account and the accounts that read its calendars for a sync. If that fails, a later
   * alarm tries again (`retrySyncRequest()`), so that the change does not wait for the hourly cycle.
   * Returns false if the request failed.
   */
  private async requestSyncAfterChange(accountId: string): Promise<boolean> {
    try {
      await notifyChange(this.env, accountId);
      // The request reached every account that a pending retry waits for.
      await this.ctx.storage.delete(SYNC_REQUEST_RETRY_KEY);
      return true;
    } catch (error) {
      console.error("Requesting a sync after a change failed", ...errorLogFields(error));
      const failed = error instanceof SyncRequestError ? error.accountIds : undefined;
      const pending = await this.ctx.storage.get<SyncRequestRetry>(SYNC_REQUEST_RETRY_KEY);
      // A pending retry keeps its attempts and time, so that new changes cannot extend it.
      const accountIds =
        pending === undefined
          ? failed
          : pending.accountIds && failed
            ? [...new Set([...pending.accountIds, ...failed])]
            : undefined;
      await this.ctx.storage.put<SyncRequestRetry>(SYNC_REQUEST_RETRY_KEY, {
        ...(accountIds ? { accountIds } : {}),
        attempts: pending?.attempts ?? 1,
        at: pending?.at ?? Date.now() + SYNC_REQUEST_RETRY_MS,
      });
      return false;
    }
  }

  /**
   * Retry a failed sync request once it is due. Each retry waits twice as long as the one before;
   * after the last attempt the change waits for the hourly full cycle. Returns true if it tried.
   */
  private async retrySyncRequest(accountId: string): Promise<boolean> {
    const retry = await this.ctx.storage.get<SyncRequestRetry>(SYNC_REQUEST_RETRY_KEY);
    if (!retry || retry.at > Date.now()) return false;
    try {
      if (retry.accountIds) await requestSyncs(this.env, retry.accountIds);
      else await notifyChange(this.env, accountId);
      await this.ctx.storage.delete(SYNC_REQUEST_RETRY_KEY);
    } catch (error) {
      const attempts = retry.attempts + 1;
      if (attempts >= MAX_SYNC_REQUEST_ATTEMPTS) {
        console.error(
          "Requesting a sync after a change failed; giving up",
          ...errorLogFields(error),
        );
        await this.ctx.storage.delete(SYNC_REQUEST_RETRY_KEY);
      } else {
        console.error("Requesting a sync after a change failed again", ...errorLogFields(error));
        const accountIds = error instanceof SyncRequestError ? error.accountIds : retry.accountIds;
        await this.ctx.storage.put<SyncRequestRetry>(SYNC_REQUEST_RETRY_KEY, {
          ...(accountIds ? { accountIds } : {}),
          attempts,
          at: Date.now() + SYNC_REQUEST_RETRY_MS * 2 ** (attempts - 1),
        });
      }
    }
    return true;
  }

  /**
   * The pending alarm, or null if it only waits for a retry of a failed sync request or for a
   * removal's next attempt, or only reads a slice of a comparison. Other work may then set an
   * earlier alarm; the alarm sets the waiting one again when it is done.
   */
  private async pendingAlarm(): Promise<number | null> {
    const pending = await this.ctx.storage.getAlarm();
    return WAITING_ALARMS.includes(await this.ctx.storage.get(FEED_ONLY_ALARM_KEY))
      ? null
      : pending;
  }

  /**
   * Keep an alarm for the next slice of a comparison, unless sync work has one. It comes before the
   * waits of removals and retries, which `alarm()` sets again once the scan is over. A retiring
   * account scans no more, so its alarm would only replace the wait of a removal.
   */
  private async keepCompareAlarm(): Promise<void> {
    if (!this.accountIdOrNull() || (await this.retiring())) return;
    if ((await this.pendingAlarm()) !== null) return;
    const scanning = (await this.openCompares()).some((state) => state.phase === "scanning");
    if (!scanning) return;
    await this.ctx.storage.put(FEED_ONLY_ALARM_KEY, COMPARE_ALARM);
    await this.ctx.storage.setAlarm(Date.now() + this.delays().nextRun);
  }

  /**
   * Keep an alarm for a removal that waits after a failed attempt once no other alarm is set. An
   * earlier retry of a failed sync request goes first; this alarm is set after it.
   */
  private async keepRemovalAlarm(): Promise<void> {
    const next = nextRemoval((await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) ?? []);
    if (!next || !this.accountIdOrNull() || (await this.ctx.storage.getAlarm()) !== null) return;
    const at = next.notBefore ?? Date.now();
    const retry = await this.ctx.storage.get<SyncRequestRetry>(SYNC_REQUEST_RETRY_KEY);
    if (retry && retry.at < at) return;
    // The mark lets other work replace this alarm (`pendingAlarm()`), and it keeps the alarm from
    // going on to a full cycle.
    await this.ctx.storage.put(FEED_ONLY_ALARM_KEY, REMOVAL_ALARM);
    await this.ctx.storage.setAlarm(at);
  }

  /** Keep an alarm for a pending retry of a failed sync request once no other alarm is set. */
  private async keepRetryAlarm(): Promise<void> {
    const retry = await this.ctx.storage.get<SyncRequestRetry>(SYNC_REQUEST_RETRY_KEY);
    if (!retry || (await this.ctx.storage.getAlarm()) !== null) return;
    // The mark lets other work replace this alarm (`pendingAlarm()`). After the retry ran, it
    // also keeps the alarm from going on to a full cycle.
    await this.ctx.storage.put(FEED_ONLY_ALARM_KEY, RETRY_ALARM);
    await this.ctx.storage.setAlarm(retry.at);
  }

  /**
   * Set the alarm for sync work: removals, rules, or a full cycle. A pending alarm for change feeds
   * then no longer counts as one, so that the work runs after the feed is read.
   */
  private async setSyncAlarm(at: number): Promise<void> {
    await this.ctx.storage.delete(FEED_ONLY_ALARM_KEY);
    await this.ctx.storage.setAlarm(at);
  }

  private async recentWrites(): Promise<Record<string, number>> {
    const stored = (await this.ctx.storage.get<Record<string, number>>(RECENT_WRITES_KEY)) ?? {};
    const cutoff = Date.now() - RECENT_WRITES_KEPT_MS;
    return Object.fromEntries(Object.entries(stored).filter(([, at]) => at >= cutoff));
  }

  private async rememberWrites(ids: string[]): Promise<void> {
    const recent = await this.recentWrites();
    const now = Date.now();
    for (const id of ids) recent[id] = now;
    // A cap keeps storage small after a large first sync; the oldest entries go first.
    const entries = Object.entries(recent)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5000);
    await this.ctx.storage.put(RECENT_WRITES_KEY, Object.fromEntries(entries));
  }

  /**
   * Store the tokens of an OAuth connect. They end any pause, also one that a refusal stored while
   * this call ran, and any retirement: a reconnect of an account whose row stayed keeps its ID.
   * Queued removals stay and run with the new tokens.
   */
  async storeTokens(
    accountId: string,
    tokens: StoredTokens,
    provider: Provider = "microsoft",
  ): Promise<void> {
    await this.writeTokens(accountId, tokens, provider);
    await this.endRetirement();
    await this.unpause();
  }

  /** Replace the stored tokens. */
  private async writeTokens(
    accountId: string,
    tokens: StoredTokens,
    provider: Provider,
  ): Promise<void> {
    const blob = await encryptJson(tokens, this.env.TOKEN_ENCRYPTION_KEY, accountId);
    this.ctx.storage.sql.exec(
      `INSERT INTO tokens (id, account_id, provider, ciphertext, iv, access_expires_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         account_id = excluded.account_id,
         provider = excluded.provider,
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         access_expires_at = excluded.access_expires_at`,
      accountId,
      provider,
      blob.ciphertext,
      blob.iv,
      tokens.accessExpiresAt,
    );
  }

  private async pause(): Promise<Pause | null> {
    return (await this.ctx.storage.get<Pause>(PAUSE_KEY)) ?? null;
  }

  /** Change the pause that started at `since`. Returns null if that pause is over. */
  private updatePause(since: number, change: (pause: Pause) => Pause): Promise<Pause | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const pause = await this.pause();
      if (pause?.since !== since) return null;
      const next = change(pause);
      await this.ctx.storage.put(PAUSE_KEY, next);
      return next;
    });
  }

  /**
   * End a pause, if any. Its rule queue is stale, so a full cycle starts. A refusal cannot store a
   * pause after this: it compares the refused token with the stored one first, in one step.
   */
  private async unpause(): Promise<void> {
    // The read and the delete are one step, so that of two overlapping calls only one goes on.
    const pause = await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<Pause>(PAUSE_KEY);
      if (current) await txn.delete([PAUSE_KEY, RULE_QUEUE_KEY, FULL_CYCLE_KEY]);
      return current;
    });
    if (!pause) return;
    // Removals that wait after attempts with the refused token may run now.
    await this.updateQueue<Removal>(REMOVAL_QUEUE_KEY, (queue) =>
      queue.map(({ notBefore: _wait, ...job }) => job),
    );
    // Other accounts skip rules from this one while the flag is set.
    const accountId = this.accountId();
    await this.env.DB.prepare("UPDATE accounts SET needs_reconnect = 0 WHERE id = ?")
      .bind(accountId)
      .run();
    await this.auditAccount(accountId, "account_resumed", {
      code: pause.code,
      pausedMs: Date.now() - pause.since,
    });
    await this.requestSync();
    // The accounts that read from this one skipped its rules; they sync now too. A failed request
    // is retried by a later alarm.
    await this.requestSyncAfterChange(accountId);
  }

  /**
   * Pause after the provider refused `refusedToken`. The pause is stored first, so that an
   * eviction cannot lose it; the D1 flag and the alert follow and are finished by a later tick if
   * needed. A reconnect while the refresh waited on the network replaced the refused token; then
   * nothing changes.
   */
  private async pauseAfterRefusal(
    accountId: string,
    refusedToken: string,
    code: string,
  ): Promise<void> {
    const before = await this.env.DB.prepare(
      "SELECT needs_reconnect AS flag FROM accounts WHERE id = ?",
    )
      .bind(accountId)
      .first<{ flag: number }>();
    // A disconnected account is on its way out; it needs no pause and no alert.
    if (!before) return;
    const since = Date.now();
    const started = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.readTokens().catch(() => null);
      if (current?.tokens.refreshToken !== refusedToken || (await this.pause())) return false;
      const pause: Pause = {
        code,
        since,
        flagPending: true,
        // An account that the pages already show as needing a reconnect had its alert.
        alertPending: before.flag !== 1,
        probeAt: since + PROBE_EVERY_MS,
      };
      await this.ctx.storage.put(PAUSE_KEY, pause);
      return true;
    });
    if (!started) return;
    await this.auditAccount(accountId, "account_paused", { code });
    await this.finishPause(accountId, since);
  }

  /**
   * D1 shows the account as needing a reconnect, but this instance has no pause. Older versions
   * set only the flag, and a late flag write can outlive a reconnect. Pause and probe at once:
   * if the token works, the probe ends the pause and clears the flag. No alert; the flag was set
   * before.
   */
  private async pauseForStaleFlag(accountId: string): Promise<Pause> {
    let started = false;
    const stored = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.pause();
      if (current) return current;
      started = true;
      const now = Date.now();
      const pause: Pause = {
        code: "needs_reconnect",
        since: now,
        flagPending: false,
        alertPending: false,
        probeAt: now,
      };
      await this.ctx.storage.put(PAUSE_KEY, pause);
      return pause;
    });
    if (started) await this.auditAccount(accountId, "account_paused", { code: stored.code });
    return stored;
  }

  /** Record an event of this account. Never throws: the work goes on without its event. */
  private async auditAccount(
    accountId: string,
    kind: AuditKind,
    detail: Record<string, string | number | boolean>,
  ): Promise<void> {
    try {
      const owner = await accountOwner(this.env.DB, accountId);
      if (owner) await recordAudit(this.env.DB, { ...owner, accountId, kind, detail });
    } catch (error) {
      console.error("Audit lookup failed", kind, ...errorLogFields(error));
    }
  }

  /**
   * `auditAccount` for a row that must not get lost. Returns true if D1 took the row, or if the
   * account is gone, so that no row can ever be written.
   */
  private async auditAccountChecked(
    accountId: string,
    kind: AuditKind,
    detail: Record<string, string | number | boolean>,
  ): Promise<boolean> {
    try {
      const owner = await accountOwner(this.env.DB, accountId);
      return (
        !owner || (await recordAuditChecked(this.env.DB, { ...owner, accountId, kind, detail }))
      );
    } catch (error) {
      console.error("Audit lookup failed", kind, ...errorLogFields(error));
      return false;
    }
  }

  /** Set the D1 flag and send the alert of a pause, each at most once. */
  private async finishPause(accountId: string, since: number): Promise<void> {
    let pause = await this.pause();
    if (pause?.since !== since) return;
    if (pause.flagPending) {
      await this.env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
        .bind(accountId)
        .run();
      pause = await this.updatePause(since, (current) => ({ ...current, flagPending: false }));
      if (!pause) {
        // New tokens ended the pause during the write, which may have landed after their reset.
        if (!(await this.pause())) {
          await this.env.DB.prepare("UPDATE accounts SET needs_reconnect = 0 WHERE id = ?")
            .bind(accountId)
            .run();
        }
        return;
      }
    }
    if (!pause.alertPending || this.sendingReconnectAlert) return;
    // The stored flag stays until the post ends, so that a call that dies during it loses no alert.
    // The cost is one more alert. In memory, this field keeps two overlapping calls to one post.
    this.sendingReconnectAlert = true;
    try {
      const outcome = await sendReconnectAlert(this.env, this.providerOrDefault());
      if (outcome !== "failed") {
        await this.updatePause(since, (current) => ({ ...current, alertPending: false }));
      }
    } finally {
      this.sendingReconnectAlert = false;
    }
  }

  /** The alarm's and the tick's work while paused: finish the pause, and probe once a day. */
  private async whilePaused(accountId: string, pause: Pause): Promise<void> {
    await this.finishPause(accountId, pause.since);
    await this.probe(pause.since);
  }

  /**
   * Try the refused token again. Some refusals end by themselves, such as a user who was disabled
   * for a while. If the provider accepts it, the pause ends and a sync starts.
   */
  private async probe(since: number): Promise<void> {
    // Claimed in one step: an overlapping tick or alarm finds the next probe a day away. The next
    // probe also waits a day if this one fails or the instance goes away during it.
    let due = false;
    await this.updatePause(since, (current) => {
      const now = Date.now();
      due = now >= current.probeAt;
      return due ? { ...current, probeAt: now + PROBE_EVERY_MS } : current;
    });
    if (!due) return;
    const stored = await this.readTokens();
    try {
      await this.refresh(stored.accountId, stored.provider, stored.tokens.refreshToken);
    } catch (error) {
      console.error("Token probe failed", ...errorLogFields(error));
      return;
    }
    await this.unpause();
  }

  async hasTokens(): Promise<boolean> {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM tokens`).toArray().length > 0;
  }

  /** Delete tokens and subscriptions, and cancel a pending sync. */
  async forget(): Promise<void> {
    await this.stopWatches();
    await this.wipe();
  }

  private async wipe(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // The instance can live on after deleteAll(); give it empty tables again.
    this.migrate();
  }

  /**
   * Stop the provider's notifications while the tokens still work. Best effort: a watch that could
   * not be stopped stays stored for the next try, and ends on its own within days. A watch the
   * provider no longer knows counts as stopped.
   */
  private async stopWatches(): Promise<void> {
    const watches = this.storedWatches();
    if (watches.length === 0) return;
    try {
      const client = await this.client();
      for (const watch of watches) {
        try {
          await client.unwatch(watch);
          this.ctx.storage.sql.exec(`DELETE FROM subscriptions WHERE remote_id = ?`, watch.id);
        } catch (error) {
          console.error("Stopping a watch failed", watch.id, ...errorLogFields(error));
        }
      }
    } catch (error) {
      console.error("Stopping watches failed", ...errorLogFields(error));
    }
  }

  /** True if a retirement runs. A request asks this before it starts rules of the account. */
  async retiring(): Promise<boolean> {
    return (await this.ctx.storage.get(RETIRING_KEY)) !== undefined;
  }

  /** True if this instance still holds tokens and owes a step of a retirement. */
  private async retirementOpen(): Promise<boolean> {
    if (!this.accountIdOrNull()) return false;
    if (await this.retiring()) return true;
    return (await this.ctx.storage.get(RETIREMENT_CHECK_KEY)) !== undefined;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return (await this.client()).listCalendars();
  }

  /**
   * Source events of one calendar of this account. Called by the target account's instance. With
   * `withLink`, each event carries its web link, for rules that write the origin link.
   */
  async readSourceEvents(
    remoteCalendarId: string,
    window: { start: Date; end: Date },
    withBody: boolean,
    options: { respectPenalty?: boolean; withLink?: boolean } = {},
  ): Promise<SourceEvent[]> {
    const withLink = options.withLink === true;
    // A read that respects the penalty fails differently, so it shares no cache entry with others.
    // Reads without the link stay under the key they had before it existed.
    const key = `${remoteCalendarId}|${window.start.toISOString()}|${window.end.toISOString()}|${withBody}|${options.respectPenalty === true}${withLink ? "|link" : ""}`;
    const cached = this.sourceCache.get(key);
    if (cached && Date.now() - cached.at < SOURCE_CACHE_MS) return cached.events;
    const events = this.client(options).then((client) =>
      client.sourceEvents(
        remoteCalendarId,
        window,
        withLink ? { withBody, withLink } : { withBody },
      ),
    );
    this.sourceCache.set(key, { at: Date.now(), events });
    // A failed read is not cached.
    events.catch(() => this.sourceCache.delete(key));
    return events;
  }

  /**
   * Busy events of one calendar of this account for a free/busy feed. While the provider throttles
   * the account, the read makes no provider call, so that a feed never extends the penalty. A
   * calendar the provider no longer finds or lets the account read is reported as unavailable.
   * With `limits`, only the events that the feed can show leave this instance. A comparison reads
   * without them, because it needs every event.
   */
  async readFeedEvents(
    remoteCalendarId: string,
    window: { start: Date; end: Date },
    limits?: FeedLimits,
  ): Promise<FeedRead> {
    // A quick answer before queueing; the queued call checks again, see `client()`.
    const left = await this.penaltyLeft();
    if (left > 0) return { kind: "throttled", retryAfterMs: left };
    try {
      const events = await this.readSourceEvents(remoteCalendarId, window, false, {
        respectPenalty: true,
      });
      return { kind: "events", ...(limits ? limitFeedEvents(events, limits) : { events }) };
    } catch (error) {
      if (error instanceof PenaltyActive) {
        return { kind: "throttled", retryAfterMs: error.retryAfterMs };
      }
      // `client()` has stored the penalty before the error reached this point.
      const delay = throttleDelayMs(error);
      if (delay !== null) return { kind: "throttled", retryAfterMs: delay };
      const { status } = error as { status?: unknown };
      if (status === 403 || status === 404 || status === 410) {
        console.error("A feed calendar can no longer be read", ...errorLogFields(error));
        return { kind: "unavailable" };
      }
      throw error;
    }
  }

  /**
   * True if the owners of this account's feed calendars are due for a check. The first call only
   * starts the wait: a connected account has just loaded its calendars.
   */
  private async feedOwnershipDue(): Promise<boolean> {
    const at = await this.ctx.storage.get<number>(FEED_OWNERSHIP_CHECK_KEY);
    if (at === undefined) {
      await this.ctx.storage.put(
        FEED_OWNERSHIP_CHECK_KEY,
        Date.now() + FEED_OWNERSHIP_CHECK_EVERY_MS,
      );
      return false;
    }
    return Date.now() >= at;
  }

  /**
   * Read who owns this account's feed calendars. A feed answers 503 once the provider names another
   * owner, or a complete list no longer names the calendar. A list that fails changes nothing, and
   * a later full cycle reads it again. The time goes into storage first, so that a failed step
   * cannot repeat in the next alarm. Returns the delay of the next alarm.
   */
  private async checkFeedOwnership(accountId: string): Promise<number> {
    await this.ctx.storage.put(FEED_OWNERSHIP_CHECK_KEY, Date.now() + FULL_CYCLE_EVERY_MS);
    try {
      const stored = await feedCalendarsOfAccount(this.env.DB, accountId);
      let lost = false;
      if (stored.length > 0) {
        const client = await this.client({ respectPenalty: true });
        lost = await storeFeedOwnership(
          this.env.DB,
          stored,
          await client.listCalendars({ complete: true }),
        );
      }
      await this.ctx.storage.put(
        FEED_OWNERSHIP_CHECK_KEY,
        Date.now() + (lost ? FEED_OWNERSHIP_RECHECK_MS : FEED_OWNERSHIP_CHECK_EVERY_MS),
      );
    } catch (error) {
      console.error("Checking feed calendars failed", ...errorLogFields(error));
      return throttleDelayMs(error) ?? this.delays().nextRun;
    }
    return this.delays().nextRun;
  }

  /** Milliseconds left of the current provider penalty, or 0. */
  private async penaltyLeft(): Promise<number> {
    const until = (await this.ctx.storage.get<number>(THROTTLED_UNTIL_KEY)) ?? 0;
    return Math.max(0, until - Date.now());
  }

  /**
   * Remember a provider penalty, so that feed reads wait for it. A shorter penalty never shortens
   * a longer one. Only queued provider calls write the key, one at a time, so the read and the
   * write cannot interleave with another write. A failure is logged: the sync waits through its
   * alarm either way.
   */
  private async notePenalty(delayMs: number | null): Promise<void> {
    if (delayMs === null) return;
    try {
      const until = Date.now() + delayMs;
      const current = (await this.ctx.storage.get<number>(THROTTLED_UNTIL_KEY)) ?? 0;
      if (until > current) await this.ctx.storage.put(THROTTLED_UNTIL_KEY, until);
    } catch (error) {
      console.error("Recording a provider penalty failed", ...errorLogFields(error));
    }
  }

  /**
   * `readSourceEvents()` for the instance of a rule's target account. An error that crosses RPC
   * keeps only its message, so a throttled read returns its wait instead of throwing.
   */
  async readSourceForRule(
    remoteCalendarId: string,
    window: { start: Date; end: Date },
    withBody: boolean,
    withLink = false,
  ): Promise<SourceRead> {
    try {
      return {
        events: await this.readSourceEvents(remoteCalendarId, window, withBody, { withLink }),
      };
    } catch (error) {
      const waitMs = throttleDelayMs(error);
      if (waitMs === null || !(error instanceof Error)) throw error;
      return { throttled: { message: error.message, waitMs } };
    }
  }

  /** Local load tests only: replace this account's simulated events. */
  async seedFake(seed: Parameters<typeof seedFakeEvents>[1], count: number): Promise<void> {
    if (this.env.DEV_FAKE_CALENDARS !== "1") throw new Error("Simulation is off");
    seedFakeEvents(this.ctx.storage.sql, seed, count);
    this.sourceCache.clear();
  }

  /** Local tests only: add one simulated event. */
  async addFakeEvent(event: FakeEvent): Promise<void> {
    if (this.env.DEV_FAKE_CALENDARS !== "1") throw new Error("Simulation is off");
    addFakeEvent(this.ctx.storage.sql, event);
    this.sourceCache.clear();
  }

  /** Local tests only: put a fault into this account's simulated calendar. */
  async injectFakeFault(fault: FakeFault): Promise<void> {
    if (this.env.DEV_FAKE_CALENDARS !== "1") throw new Error("Simulation is off");
    injectFakeFault(this.ctx.storage.sql, fault);
    this.sourceCache.clear();
  }

  /** Local load tests only: simulated provider calls since the last seed. */
  async fakeStats(countBlocks = false): Promise<ReturnType<typeof readFakeStats>> {
    if (this.env.DEV_FAKE_CALENDARS !== "1") throw new Error("Simulation is off");
    return readFakeStats(this.ctx.storage.sql, countBlocks);
  }

  /** Local load tests only: change `count` simulated events, as a burst of edits does. */
  async shiftFake(count: number): Promise<void> {
    if (this.env.DEV_FAKE_CALENDARS !== "1") throw new Error("Simulation is off");
    shiftFakeEvents(this.ctx.storage.sql, count);
    this.sourceCache.clear();
  }

  /**
   * Load tests only: how many fetches this invocation can make after `rpcCalls` calls to another
   * instance. Comparing two values shows if Durable Object RPC counts as a subrequest.
   */
  async fakeFetchBudget(peer: string, rpcCalls: number, attempts: number): Promise<FetchBudget> {
    const url = this.env.DEV_FAKE_FETCH_URL;
    if (this.env.DEV_FAKE_CALENDARS !== "1" || !url) throw new Error("Simulation is off");
    for (let i = 0; i < rpcCalls; i++) await accountSync(this.env, peer).fakeStats();
    return measureFetchBudget(url, attempts);
  }

  /** Load tests only: a step counts before it runs, so that a step that a limit stops shows. */
  private async noteFakeStep(): Promise<void> {
    if (this.env.DEV_FAKE_CALENDARS !== "1") return;
    recordFakeStep(this.ctx.storage.sql);
    await this.ctx.storage.sync();
  }

  /**
   * Run one rule whose target calendar belongs to this account. With `dryRun`, plan only and
   * write nothing.
   */
  async runRule(ruleId: string, options: { dryRun?: boolean } = {}): Promise<RunResult> {
    if (options.dryRun) return this.runRuleOnce(ruleId, options);
    // Two runs that overlap would plan the same creates and write every block twice, for example
    // after a double click on "Run" or a click while the alarm runs the rule. A second run from the
    // UI gets the result of the first, so that "Run" reports what was written. The alarm waits
    // instead (`runRuleAfterOthers()`). A dry run writes nothing and never joins a real run.
    return this.runningRules.get(ruleId) ?? this.startRun(ruleId);
  }

  /**
   * Run a rule after every run of it in progress. The alarm uses this: a run in progress may have
   * read the source before the change that the alarm is for.
   */
  private async runRuleAfterOthers(ruleId: string): Promise<RunResult> {
    for (
      let current = this.runningRules.get(ruleId);
      current;
      current = this.runningRules.get(ruleId)
    ) {
      await current.catch(() => undefined);
    }
    return this.startRun(ruleId, { fromAlarm: true });
  }

  /**
   * A real run, between its start marker and the end. The marker stays if the run ends without a
   * written audit event, and it is what remains if the instance dies. A run without a stored marker
   * still runs: the marker only serves the audit log. Dry runs do not come here.
   */
  private startRun(ruleId: string, options: RunOptions = {}): Promise<RunResult> {
    const marker: RunMarker = { ruleId, runId: crypto.randomUUID(), startedAt: Date.now() };
    const key = `${RUN_MARKER_PREFIX}${ruleId}:${marker.runId}`;
    const progress = { runId: marker.runId, closed: false };
    const run: Promise<RunResult> = this.storeRunMarker(key, marker)
      .then(() => this.runRuleOnce(ruleId, { ...options, progress }))
      .finally(async () => {
        // The marker goes first: without its rule in `runningRules`, it would count as an abort.
        if (progress.closed) await this.dropRunMarker(key);
        if (this.runningRules.get(ruleId) === run) this.runningRules.delete(ruleId);
      });
    this.runningRules.set(ruleId, run);
    return run;
  }

  private async storeRunMarker(key: string, marker: RunMarker): Promise<void> {
    try {
      await this.ctx.storage.put(key, marker);
    } catch (error) {
      console.error("Storing a run marker failed", ...errorLogFields(error));
    }
  }

  /** A marker that stays is settled by the next report, so a failure must not fail the run. */
  private async dropRunMarker(key: string): Promise<void> {
    try {
      await this.ctx.storage.delete(key);
    } catch (error) {
      console.error("Removing a run marker failed", ...errorLogFields(error));
    }
  }

  /**
   * Write `sync_run_aborted` for markers without a run in progress. A run with an outcome event in
   * D1 did not abort: its instance died or failed before it removed the marker. A marker goes only
   * after its event is found or written, so a failed lookup or write repeats in the next tick or
   * alarm. The same call alerts the operator: an invocation that died at a limit cannot. A failed
   * alert waits for a tick, so that a dead webhook costs no subrequest and no wait in every alarm.
   * Never throws: the report must not stop a tick or an alarm.
   */
  private reportAbortedRuns(
    accountId: string,
    { retryAlerts = false }: { retryAlerts?: boolean } = {},
  ): Promise<void> {
    this.abortReport ??= this.writeAbortEvents(accountId)
      .then(async (found) => {
        if (found || retryAlerts) await this.sendAbortAlerts(accountId);
      })
      .catch((error: unknown) => {
        console.error("Reporting aborted runs failed", ...errorLogFields(error));
      })
      .finally(() => {
        this.abortReport = null;
      });
    return this.abortReport;
  }

  /** Returns true if this call found aborted runs. */
  private async writeAbortEvents(accountId: string): Promise<boolean> {
    const markers = await this.ctx.storage.list<RunMarker>({
      prefix: RUN_MARKER_PREFIX,
      // Each run in progress holds a marker. They must not use up the limit of the others.
      limit: MAX_ABORT_REPORTS + this.runningRules.size,
    });
    const aborted = [...markers]
      .filter(([, marker]) => !this.runningRules.has(marker.ruleId))
      .slice(0, MAX_ABORT_REPORTS);
    if (aborted.length === 0) return false;
    const owner = await accountOwner(this.env.DB, accountId);
    const settled = owner
      ? await runsWithOutcome(
          this.env.DB,
          owner.userId,
          aborted.map(([, marker]) => marker),
        )
      : null;
    const lost = aborted.filter(([, { runId }]) => owner && !settled?.has(runId));
    // Stored before the events: once an event exists, its marker counts as settled, and a report
    // that dies between the two would lose the alert.
    if (lost.length > 0) {
      await this.updateQueue<string>(ABORT_ALERTS_KEY, (queue) => [
        ...new Set([...queue, ...lost.map(([, { ruleId }]) => ruleId)]),
      ]);
    }
    for (const [key, { ruleId, runId, startedAt }] of aborted) {
      // A disconnected account has no owner to record the event for, now or later.
      if (owner && !settled?.has(runId)) {
        const written = await recordAuditChecked(this.env.DB, {
          ...owner,
          accountId,
          ruleId,
          kind: "sync_run_aborted",
          detail: { runId, startedAt: new Date(startedAt).toISOString() },
        });
        // The next tick or alarm tries again; more inserts now would likely fail too.
        if (!written) return true;
      }
      await this.ctx.storage.delete(key);
    }
    return lost.length > 0;
  }

  /** Send the open alerts about aborted runs. They stay stored until the webhook accepts them. */
  private async sendAbortAlerts(accountId: string): Promise<void> {
    const ruleIds = (await this.ctx.storage.get<string[]>(ABORT_ALERTS_KEY)) ?? [];
    if (ruleIds.length === 0) return;
    const owner = await accountOwner(this.env.DB, accountId);
    const open = owner
      ? (await sendAbortAlert(this.env, { ...owner, accountId }, ruleIds)).open
      : [];
    const settled = new Set(ruleIds.filter((id) => !open.includes(id)));
    await this.updateQueue<string>(ABORT_ALERTS_KEY, (queue) =>
      queue.filter((id) => !settled.has(id)),
    );
  }

  /**
   * Send the open alerts about comparisons. Only the tick calls this: a comparison ends in an alarm
   * that has used its subrequests for reads, and a failed post waits for the next tick. An alert
   * that a repeat lock holds back costs no read until the lock ends. Never throws: the report must
   * not stop a tick.
   */
  private async sendCompareAlerts(accountId: string): Promise<void> {
    try {
      const alerts = (await this.ctx.storage.get<CompareAlert[]>(COMPARE_ALERTS_KEY)) ?? [];
      const now = Date.now();
      if (!alerts.some((alert) => (alert.notBefore ?? 0) <= now)) return;
      const owner = await accountOwner(this.env.DB, accountId);
      const open = owner
        ? (await sendCompareAlert(this.env, { ...owner, accountId }, alerts, now)).open
        : [];
      const handled = new Set(alerts.map(compareRunKey));
      const kept = new Map(open.map((alert) => [compareRunKey(alert), alert]));
      // A comparison can end during the post. Its newer alert stays as it is.
      await this.updateQueue<CompareAlert>(COMPARE_ALERTS_KEY, (queue) =>
        queue.flatMap((alert) => {
          const key = compareRunKey(alert);
          if (!handled.has(key)) return [alert];
          const stays = kept.get(key);
          return stays ? [stays] : [];
        }),
      );
    } catch (error) {
      console.error("Sending a comparison alert failed", ...errorLogFields(error));
    }
  }

  private async runRuleOnce(ruleId: string, options: RunOptions): Promise<RunResult> {
    try {
      return await this.executeRule(ruleId, options);
    } catch (error) {
      // Record failed real runs whether the alarm or a user started them; previews stay silent.
      if (!options.dryRun) {
        const closed = await this.auditFailure(
          ruleId,
          this.accountIdOrNull() ?? "",
          error,
          options.progress?.runId,
        );
        if (options.progress) options.progress.closed = closed;
      }
      throw error;
    }
  }

  private async executeRule(ruleId: string, options: RunOptions): Promise<RunResult> {
    const startedAt = Date.now();
    const readsBefore = this.providerReads;
    const rule = await loadRule(this.env.DB, ruleId);
    if (!rule) throw new Error(`Rule ${ruleId} not found`);
    if (rule.target.accountId !== this.accountId()) {
      throw new Error("A rule runs in the instance of its target account");
    }
    if (!ownerMayRun(this.env, rule)) {
      throw new Error("The rule's owner is deactivated or no longer admitted");
    }
    // The rule was queued before its source account needed reconnecting. Its read would only
    // fail; it runs again in the full cycle after the reconnect. No audit entry.
    if (options.fromAlarm && rule.source.needsReconnect) {
      if (options.progress) options.progress.closed = true;
      return {
        ruleId,
        dryRun: false,
        stats: { create: 0, update: 0, delete: 0, unchanged: 0 },
        applied: 0,
        failed: 0,
        remaining: 0,
      };
    }

    const window = syncWindow(rule.options);
    // The org's caps apply at every run, so lowering a cap also changes the blocks already written.
    const effective = detailLevelFor(this.env, rule.options.detailLevel, rule.source, rule.target);
    const ruleOptions = { ...rule.options, detailLevel: effective.level };
    const withBody = ruleOptions.detailLevel === "full";
    // A buffered rule reads the source wider than the sync window; see `readWindow`.
    const read = readWindow(window, ruleOptions);
    // The origin note names the source account. Where any cap below "full" applies to the
    // direction, the org limits what crosses from this source, so the rule writes neither the note
    // nor the link, even if the cap does not lower this rule's level.
    const capApplies = detailLevelFor(this.env, "full", rule.source, rule.target).level !== "full";
    const origin = ruleOptions.showOrigin && !capApplies ? originLine(rule) : null;
    // The link needs one more field per occurrence, and detail level "title" or more.
    const withLink = origin !== null && ruleOptions.linkOrigin && effective.level !== "busy";
    const sourceEvents = await this.readRuleSource(rule, read ?? window, withBody, withLink);

    const target = await this.client();
    const ruleTag = await ruleTagFor(rule.id);
    // Rules with a smaller tag into the same calendar take precedence: where they already block
    // an event, this rule writes no second block for it.
    const siblingTags = await Promise.all(
      (await siblingRuleIds(this.env.DB, rule.id)).map((id) => ruleTagFor(id)),
    );
    const precedingTags = siblingTags.filter((tag) => tag < ruleTag);
    // The target read is wider than the source read; see `targetReadWindow` and `planSync`.
    const targetRead = targetReadWindow(window);
    const blocks = await target.existingBlocks(rule.target.remoteCalendarId, targetRead, [
      ruleTag,
      ...precedingTags,
    ]);
    const existing = blocks.filter((block) => block.ruleTag === ruleTag);
    const claimed = claimsFrom(blocks.filter((block) => block.ruleTag !== ruleTag));
    const desired = await desiredBlocks(
      rule.id,
      sourceEvents,
      ruleOptions,
      { scope: rule.userId, claimed },
      origin,
    );
    // A run reads the edge only for a block at the edge without a wanted event; see `planSync`.
    // That is not rare. With a source at UTC or east of it, the main read no longer returns
    // yesterday's all-day event after midnight UTC, even if the event exists. The same holds for
    // a timed event that ends at midnight UTC. Then every run of that UTC day reads the edge:
    // about 144 reads per rule, less what the source cache answers.
    const readsEdge = blocksAtEdge(desired, existing, window).length > 0;
    const edge = readsEdge ? await this.readEdge(rule, window) : undefined;
    const edgeReadsFailed = readsEdge && !edge ? 1 : 0;
    const plan = planSync(desired, existing, { sync: window, target: targetRead, read, edge });

    let throttled = 0;
    const statuses: Record<string, number> = {};

    // One audit event per run, written once the outcome is known. Counts only, no event content.
    const audit = async (result: RunResult) => {
      const detail: SyncRunDetail = {
        ...(options.progress ? { runId: options.progress.runId } : {}),
        dryRun: result.dryRun,
        ...plan.stats,
        duplicates: countDuplicates(plan, desired),
        applied: result.applied,
        failed: result.failed,
        remaining: result.remaining,
        throttled,
        statuses: formatStatuses(statuses),
        edgeReadsFailed,
        durationMs: Date.now() - startedAt,
      };
      const written = await recordAuditChecked(this.env.DB, {
        orgId: rule.orgId,
        userId: rule.userId,
        accountId: rule.target.accountId,
        ruleId,
        kind: "sync_run",
        detail: { ...detail },
      });
      if (options.progress) options.progress.closed = written;
      return result;
    };

    if (options.dryRun) {
      return audit({
        ruleId,
        dryRun: true,
        stats: plan.stats,
        applied: 0,
        failed: 0,
        remaining: 0,
      });
    }

    const writesAllDay = plan.actions.some(
      (action) => action.kind !== "delete" && action.block.allDay,
    );
    const lookup = writesAllDay
      ? await this.allDayZone(target, rule.target.email, this.providerReads - readsBefore)
      : {};
    const batches = chunk(plan.actions, target.batchLimit);
    let applied = 0;
    let failed = 0;
    let retryAfterMs = lookup.waitMs;
    let allDayZone = lookup.zone;
    // A throttled lookup stops the writes: further calls would only extend the penalty.
    const allowed = retryAfterMs === undefined ? batchBudget(this.providerReads - readsBefore) : 0;
    for (const batch of batches.slice(0, allowed)) {
      const result = await target.applyBatch(
        rule.target.remoteCalendarId,
        ruleTag,
        batch,
        allDayZone,
      );
      // Graph can refuse a zone name, and then each all-day write fails. So a 400 for an all-day
      // write means UTC for the day, also if it had another cause, unless another all-day write of
      // the batch shows that Graph takes the zone. A 400 for a timed block or a delete says nothing
      // about the zone.
      if (allDayZone && result.allDayRefused && !result.allDayAccepted) {
        console.error(
          "Graph refused all-day writes in the mailbox zone, so UTC applies for the day",
          ...Object.keys(result.statuses),
        );
        await this.storeMailboxZone(null);
        allDayZone = undefined;
      }
      if (result.writtenIds?.length) await this.rememberWrites(result.writtenIds);
      applied += batch.length - result.failed - result.throttled;
      failed += result.failed;
      throttled += result.throttled;
      for (const [status, count] of Object.entries(result.statuses)) {
        statuses[status] = (statuses[status] ?? 0) + count;
      }
      if (result.throttled > 0) {
        // Further batches would only extend the penalty.
        retryAfterMs = clampRetryAfter(result.retryAfterMs);
        break;
      }
    }
    const remaining = plan.actions.length - applied - failed;
    if (remaining > 0) {
      // Continue soon; the next run plans again from the calendars, so nothing is lost. The alarm
      // keeps its own rule queued; a run outside it owes a full cycle, which no failing removal
      // in the next alarm can drop.
      if (!options.fromAlarm) await this.ctx.storage.put(CYCLE_AGAIN_KEY, true);
      await this.setSyncAlarm(Date.now() + (retryAfterMs ?? this.delays().nextRun));
    }
    const result = await audit({
      ruleId,
      dryRun: false,
      stats: plan.stats,
      applied,
      failed,
      remaining,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
    if (failed === 0 && remaining === 0) await this.noteRuleOk(ruleId, startedAt);
    return result;
  }

  /**
   * The zone for the all-day blocks of a run, at most one answer per day. A mailbox without a
   * usable zone means UTC for the day. A failed lookup says nothing about the mailbox, so the known
   * zone stays for `MAILBOX_ZONE_RETRY_MS`, or UTC if no zone is known. In both cases the run goes
   * on. A throttled lookup gives no answer, so it returns the wait and stores nothing. One batch of
   * a step always runs, and a lookup can take two requests. So a step with fewer than three
   * requests left makes no lookup: its blocks use the known zone, or UTC.
   */
  private async allDayZone(
    target: CalendarClient,
    address: string,
    reads: number,
  ): Promise<{ zone?: string; waitMs?: number }> {
    if (!target.mailboxZone) return {};
    const stored = await this.ctx.storage.get<MailboxZone>(MAILBOX_ZONE_KEY);
    const valid = stored?.failed ? MAILBOX_ZONE_RETRY_MS : MAILBOX_ZONE_MS;
    const known = stored?.zone ? { zone: stored.zone } : {};
    if (stored && Date.now() - stored.at < valid) return known;
    if (reads > MAX_PROVIDER_REQUESTS - 3) return known;
    let zone: string | null;
    try {
      zone = await target.mailboxZone(address);
    } catch (error) {
      const waitMs = throttleDelayMs(error);
      if (waitMs !== null) return { waitMs };
      console.error("Reading the mailbox zone failed", ...errorLogFields(error));
      await this.storeMailboxZone(stored?.zone ?? null, true);
      return known;
    }
    await this.storeMailboxZone(zone);
    return zone ? { zone } : {};
  }

  private async storeMailboxZone(zone: string | null, failed = false): Promise<void> {
    await this.ctx.storage.put<MailboxZone>(MAILBOX_ZONE_KEY, {
      zone,
      at: Date.now(),
      ...(failed ? { failed } : {}),
    });
  }

  /** Comparisons wait for this. A failure must not fail the run: they then time out. */
  private async noteRuleOk(ruleId: string, startedAt: number): Promise<void> {
    try {
      await this.ctx.storage.put(`${RULE_OK_PREFIX}${ruleId}`, startedAt);
    } catch (error) {
      console.error("Noting a successful run failed", ...errorLogFields(error));
    }
  }

  /** The source events of a rule, from this account or from the instance of the source account. */
  private readRuleSource(
    rule: RuleContext,
    window: { start: Date; end: Date },
    withBody: boolean,
    withLink: boolean,
  ): Promise<SourceEvent[]> {
    const { accountId, remoteCalendarId } = rule.source;
    return accountId === this.accountId()
      ? this.readSourceEvents(remoteCalendarId, window, withBody, { withLink })
      : this.readOtherSource(accountId, remoteCalendarId, { window, withBody, withLink });
  }

  /**
   * The edge read of a run, or undefined if it failed: without it the plan deletes nothing at the
   * edge. The next run reads again. If the read fails for the rest of the UTC day, the block no
   * longer ends at the start of the window, and it stays for good. So the audit of the run counts
   * a failed read. A throttled read stops the run, as the main read does, so that the rule waits
   * for `Retry-After`. The read needs identity only, so it asks for no description and no link.
   */
  private async readEdge(
    rule: RuleContext,
    sync: { start: Date; end: Date },
  ): Promise<EdgeRead | undefined> {
    const window = edgeReadWindow(sync);
    try {
      const events = await this.readRuleSource(rule, window, false, false);
      const markers = await Promise.all(
        events.map((event) => markerFor(rule.id, event.occurrenceKey)),
      );
      return { window, markers: new Set(markers) };
    } catch (error) {
      if (throttleDelayMs(error) !== null) throw error;
      console.error("The edge read of a rule failed", ...errorLogFields(error));
      return undefined;
    }
  }

  /** Source events from another account's instance. Throws SourceThrottledError if it throttles. */
  private async readOtherSource(
    accountId: string,
    remoteCalendarId: string,
    {
      window,
      withBody,
      withLink,
    }: { window: { start: Date; end: Date }; withBody: boolean; withLink: boolean },
  ): Promise<SourceEvent[]> {
    // One subrequest here; the other instance reads the pages on its own budget.
    this.providerReads++;
    const read = await accountSync(this.env, accountId).readSourceForRule(
      remoteCalendarId,
      window,
      withBody,
      withLink,
    );
    if ("throttled" in read) {
      throw new SourceThrottledError(read.throttled.message, read.throttled.waitMs);
    }
    return read.events;
  }

  /**
   * Delete the blocks one rule wrote into a calendar of this account, before the rule or an account
   * goes away. With `beyond`, delete only the blocks that start beyond that window end. Returns how
   * many are left if the limit per invocation was reached. If a batch fails after others worked,
   * this also returns how many are left: the run made progress, so it is no failed attempt. A
   * failed edge read does not stop the deletes, but the result reports it.
   */
  async removeRuleBlocks(
    ruleId: string,
    remoteCalendarId: string,
    beyond?: Date,
  ): Promise<RemovalResult> {
    const readsBefore = this.providerReads;
    const target = await this.client();
    const ruleTag = await ruleTagFor(ruleId);
    const cleanup = cleanupWindow();
    const window = beyond ? { start: beyond, end: cleanup.end } : cleanup;
    const blocks = (await target.existingBlocks(remoteCalendarId, window, [ruleTag])).filter(
      (block) => !beyond || startsBeyond(block, beyond),
    );
    let edgeReadFailed = false;
    if (!beyond) {
      // Blocks from before today stay as a record, except those that end at the start of the
      // window. Whether the read above returns those depends on the target's time zone.
      const edge = await this.blocksAtRemovalEdge(target, remoteCalendarId, ruleTag, cleanup);
      edgeReadFailed = edge === undefined;
      const found = new Set(blocks.map((block) => block.targetId));
      blocks.push(...(edge ?? []).filter((block) => !found.has(block.targetId)));
    }
    const actions = blocks.map((block) => ({
      kind: "delete" as const,
      targetId: block.targetId,
      marker: block.marker,
    }));
    let removed = 0;
    let retryAfterMs: number | undefined;
    const batches = chunk(actions, target.batchLimit);
    for (const batch of batches.slice(0, batchBudget(this.providerReads - readsBefore))) {
      let result: BatchResult;
      try {
        result = await target.applyBatch(remoteCalendarId, ruleTag, batch);
      } catch (error) {
        if (removed === 0) throw error;
        console.error("Removal batch failed", ruleId, ...errorLogFields(error));
        retryAfterMs = throttleDelayMs(error) ?? undefined;
        break;
      }
      if (result.writtenIds?.length) await this.rememberWrites(result.writtenIds);
      removed += batch.length - result.failed - result.throttled;
      if (result.throttled > 0) {
        // Further batches would only extend the penalty.
        retryAfterMs = clampRetryAfter(result.retryAfterMs);
        break;
      }
    }
    const remaining = actions.length - removed;
    if (retryAfterMs === undefined) return { removed, remaining, throttled: false, edgeReadFailed };
    return { removed, remaining, throttled: true, retryAfterMs, edgeReadFailed };
  }

  /**
   * The blocks of a rule that end at the start of a removal's window, or undefined if the read
   * failed: the attempt then goes on without them, and the job tries again. Every attempt reads the
   * edge of its own UTC day, so a retry after midnight does not find such a block any more; the
   * block then stays as a record of a past day. A throttled read stops the attempt, as the main
   * read does: the job waits for `Retry-After` and uses up no attempt.
   */
  private async blocksAtRemovalEdge(
    target: CalendarClient,
    remoteCalendarId: string,
    ruleTag: string,
    cleanup: { start: Date; end: Date },
  ): Promise<ExistingBlock[] | undefined> {
    try {
      const window = edgeReadWindow(cleanup);
      const blocks = await target.existingBlocks(remoteCalendarId, window, [ruleTag]);
      return blocks.filter((block) => endsAtStart(block, cleanup));
    } catch (error) {
      if (throttleDelayMs(error) !== null) throw error;
      console.error("The edge read of a removal failed", ...errorLogFields(error));
      return undefined;
    }
  }

  /**
   * Remove the blocks of a rule later, in an alarm. A rule's blocks carry its tag, so they can go
   * after the rule itself is gone. The editor uses this so that a click does not wait for Graph.
   * With `trim`, remove only the blocks beyond the rule's sync window; see `Removal.trim`.
   */
  async queueRemoval(
    ruleId: string,
    remoteCalendarId: string,
    { trim = false }: { trim?: boolean } = {},
  ): Promise<void> {
    await this.queueRemovals([{ ruleId, remoteCalendarId }], { trim });
  }

  /**
   * Queue the removals of several rules in one call and one storage update, so that a save with
   * many rules makes one Durable Object call per account. Same rules as `queueRemoval`; a job
   * that is queued already, or repeated in `rules`, is not added twice. With `offboarding`, a job
   * reports its result to that owner, also a job that was queued already. A job that was queued
   * already counts this call, see `Removal.requeued`.
   */
  async queueRemovals(
    rules: { ruleId: string; remoteCalendarId: string }[],
    { trim = false, offboarding }: { trim?: boolean; offboarding?: OffboardingOwner } = {},
  ): Promise<void> {
    if (rules.length === 0) return;
    const progress = offboarding ? { offboarding: { ...offboarding, removed: 0 } } : {};
    const jobs: Removal[] = rules.map(({ ruleId, remoteCalendarId }) => ({
      ruleId,
      remoteCalendarId,
      attempts: 0,
      ...(trim ? { trim: true as const } : {}),
      ...progress,
    }));
    await this.updateQueue<Removal>(REMOVAL_QUEUE_KEY, (queue) => {
      const next = queue.map((queued) =>
        jobs.some((job) => sameRemoval(queued, job))
          ? {
              ...queued,
              ...(queued.offboarding ? {} : progress),
              ...(queued.trim ? {} : { requeued: (queued.requeued ?? 0) + 1 }),
            }
          : queued,
      );
      for (const job of jobs) {
        if (!next.some((queued) => sameRemoval(queued, job))) next.push(job);
      }
      return next;
    });
    const pending = await this.ctx.storage.getAlarm();
    const soon = Date.now() + this.delays().nextRun;
    if (pending === null || pending > soon) await this.setSyncAlarm(soon);
  }

  /**
   * The account is going: its alarms stop the watches, remove the queued blocks, and then forget
   * the tokens. The removals need the tokens, so the account cannot go at once. This call only
   * writes storage, so that the request never waits for a provider. If the request fails, it calls
   * `cancelRetire()`; a reconnect ends the retirement too. The caller makes the `generation`: it
   * must be able to cancel also if the answer of this call got lost. A caller of a version without
   * generations passes none, and this call then makes one that no cancel names.
   */
  async retire(generation: string = crypto.randomUUID()): Promise<void> {
    await this.ctx.storage.put(RETIRING_KEY, generation);
    await this.ctx.storage.delete(RETIREMENT_CHECK_KEY);
    const pending = await this.ctx.storage.getAlarm();
    const soon = Date.now() + this.delays().nextRun;
    if (pending === null || pending > soon) await this.setSyncAlarm(soon);
  }

  /**
   * Undo `retire()` of a request that failed, also one whose `retire()` never arrived: calling this
   * twice changes nothing. It ends only the retirement of this `generation`, so that a late call
   * leaves the retirement of a newer request alone. Once the tokens or the row went, there is
   * nothing to undo. If this call fails, the retirement goes on, and `finishRetirement()` flags
   * the account. A caller of a version without generations passes none, and this call then does
   * nothing: it cannot tell which request it belongs to.
   */
  async cancelRetire(generation?: string): Promise<void> {
    const accountId = this.accountIdOrNull();
    if (!accountId || generation === undefined) return;
    const row = await this.env.DB.prepare("SELECT 1 AS found FROM accounts WHERE id = ?")
      .bind(accountId)
      .first<{ found: number }>();
    if (row) await this.endRetirement(generation);
  }

  /**
   * End a retirement, if any: with `generation`, only the retirement of that request. Queued
   * removals stay. The next alarm decides about each job: a rule that writes again keeps its
   * blocks. The alarms may have stopped the watches, and a full cycle sets them again. That alarm
   * also reads the row, see `checkEndedRetirement()`.
   */
  private async endRetirement(generation?: string): Promise<void> {
    const ended = await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get(RETIRING_KEY);
      const checking = await txn.get(RETIREMENT_CHECK_KEY);
      if (stored === undefined && checking === undefined) return false;
      if (generation !== undefined && stored !== generation) return false;
      await txn.delete([RETIRING_KEY, WATCHES_TRIED_KEY]);
      await txn.put<RetirementCheck>(RETIREMENT_CHECK_KEY, {
        id: crypto.randomUUID(),
        endedAt: Date.now(),
      });
      return true;
    });
    if (ended) await this.requestSync();
  }

  /**
   * Read the row of an account whose retirement ended. If the row is gone, a delete landed after
   * the end, no cron reaches this instance any more, and the retirement resumes. If the row is
   * there, the check ends only if the read started `RETIREMENT_RETRY_MS` after the end: an earlier
   * read can come before a delete that is under way. Until then `alarm()` keeps an alarm. If D1
   * fails, this throws, and `alarm()` keeps the check.
   */
  private async checkEndedRetirement(accountId: string): Promise<void> {
    const check = await this.ctx.storage.get<RetirementCheck>(RETIREMENT_CHECK_KEY);
    if (check === undefined) return;
    const late = Date.now() - check.endedAt >= RETIREMENT_RETRY_MS;
    const row = await this.env.DB.prepare("SELECT 1 AS found FROM accounts WHERE id = ?")
      .bind(accountId)
      .first<{ found: number }>();
    await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<RetirementCheck>(RETIREMENT_CHECK_KEY);
      if (stored?.id !== check.id || (row && !late)) return;
      await txn.delete(RETIREMENT_CHECK_KEY);
      if (!row) await txn.put(RETIRING_KEY, true);
    });
  }

  /**
   * Forget the tokens of a retiring account. Its row normally left with the request. If the row
   * stayed, the flag shows the account to the user, and other accounts skip its rules. The flag
   * comes first, so that no failure leaves a row without tokens and without the flag. If D1 fails,
   * this throws, and `alarm()` sets the next alarm. A retirement that ended during this call keeps
   * its tokens, and a tick clears the flag through a probe. A removal that was queued during this
   * call needs the tokens: its alarm runs first, and the next alarm comes back here.
   */
  private async finishRetirement(accountId: string): Promise<void> {
    await this.env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
      .bind(accountId)
      .run();
    await this.stopWatches();
    const queue = (await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) ?? [];
    if (queue.length === 0 && (await this.retiring())) await this.wipe();
  }

  /**
   * Write the result of ended offboarding jobs into the audit log, in one D1 call. It runs before
   * the jobs leave the queue, so that the result is there before the account forgets its tokens.
   * If D1 fails, the log loses the result and the job still ends: it cannot hold the account.
   */
  private async reportCleanup(jobs: Removal[], result: CleanupResult): Promise<void> {
    const accountId = this.accountIdOrNull() ?? this.ctx.id.name ?? null;
    const statements = jobs.flatMap(({ ruleId, offboarding }) => {
      if (!offboarding) return [];
      const { orgId, userId, removed, left } = offboarding;
      const detail = { result, removed, ...(left ? { left } : {}) };
      const event: AuditEvent = {
        orgId,
        userId,
        accountId,
        ruleId,
        kind: "cleanup_finished",
        detail,
      };
      return [auditStatement(this.env.DB, event)];
    });
    if (statements.length === 0) return;
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      console.error("Writing a cleanup result failed", ...errorLogFields(error));
    }
  }

  /** True if the removal's rule writes into its calendar again. If D1 fails, the removal goes on. */
  private async ruleWritesAgain(job: Removal): Promise<boolean> {
    try {
      return await ruleWritesInto(this.env, job.ruleId, job.remoteCalendarId);
    } catch (error) {
      console.error("Removal rule lookup failed", errorCode(error));
      return false;
    }
  }

  /**
   * Delete a rule's blocks beyond its current sync window. The window is read at every attempt, so
   * that a `daysAhead` raised meanwhile keeps the blocks the rule wants again. A deleted or
   * disabled rule has its own removal. Returns the window end it trimmed at, if any.
   */
  private async trimRuleBlocks(job: Removal): Promise<RemovalResult & { end?: Date }> {
    const end = await this.trimEnd(job);
    if (!end) return { removed: 0, remaining: 0, throttled: false, edgeReadFailed: false };
    return { ...(await this.removeRuleBlocks(job.ruleId, job.remoteCalendarId, end)), end };
  }

  /** The current sync window end of a trim's rule, or undefined if the rule is gone or disabled. */
  private async trimEnd(job: Removal): Promise<Date | undefined> {
    const rule = await loadRule(this.env.DB, job.ruleId);
    return rule?.enabled ? syncWindow(rule.options).end : undefined;
  }

  /**
   * Run one queued removal that is due. Returns false if none is due, so that the account's rules
   * run while a removal waits after a failed attempt. A retiring account waits for its removals.
   */
  private async runRemoval(): Promise<boolean> {
    const queue = (await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) ?? [];
    if (queue.length === 0) return false;
    // The removal's own alarm runs the job it waits for, even if the clock reads a moment early.
    const ownAlarm = (await this.ctx.storage.get(FEED_ONLY_ALARM_KEY)) === REMOVAL_ALARM;
    const job = dueRemoval(queue, Date.now()) ?? (ownAlarm ? nextRemoval(queue) : undefined);
    if (!job) return this.retiring();
    // A later attempt can come hours later. If the rule runs again by then, for example after a
    // group direction went back to busy with the same rule ID, its blocks are wanted again. Only
    // the first attempt skips this check: it runs right after the request that queued it, which
    // may still be changing the rule. An offboarding stops its rules before it queues the job, so
    // there a rule that runs means a failed request, and the check holds from the first attempt.
    // A retiring account skips it: its rules may still be enabled until the request deletes them,
    // and its blocks must go. A trim's rule writes on; the trim reads its window at every attempt.
    if (
      !job.trim &&
      (job.offboarding !== undefined || job.started === true || job.attempts > 0) &&
      !(await this.retiring()) &&
      (await this.ruleWritesAgain(job))
    ) {
      // The D1 read let other requests in. A request that queued the job again may have stopped
      // the rule after that read, so the next alarm reads the rule again.
      let dropped = false;
      await this.updateQueue<Removal>(REMOVAL_QUEUE_KEY, (current) => {
        const stored = current.find((queued) => sameRemoval(queued, job));
        dropped = stored?.requeued === job.requeued;
        return dropped ? current.filter((queued) => queued !== stored) : current;
      });
      // An earlier attempt may have deleted blocks the rule wants again.
      if (dropped) await this.ctx.storage.put(CYCLE_AGAIN_KEY, true);
      await this.setSyncAlarm(Date.now() + this.delays().nextRun);
      return true;
    }
    let outcome: "done" | "continue" | "throttled" | "failed" = "done";
    let delayMs = this.delays().nextRun;
    let refused = false;
    let removed = 0;
    let left: number | undefined = job.offboarding?.left;
    let edgeReadFailed = false;
    try {
      const result: RemovalResult & { end?: Date } = job.trim
        ? await this.trimRuleBlocks(job)
        : await this.removeRuleBlocks(job.ruleId, job.remoteCalendarId);
      removed = result.removed;
      left = result.remaining;
      edgeReadFailed = result.edgeReadFailed;
      if (result.throttled) {
        outcome = "continue";
        delayMs = result.retryAfterMs ?? delayMs;
      } else if (result.remaining > 0) {
        // A run without progress failed, for example with 403 on every block.
        outcome = result.removed > 0 ? "continue" : "failed";
      } else if (result.edgeReadFailed) {
        // A block at the edge may still be there, and no run reads that far back. This attempt
        // counts even if it removed the last blocks, so that a lasting failure ends the job.
        outcome = "failed";
      } else if (result.end && ((await this.trimEnd(job)) ?? result.end) < result.end) {
        // The window went down again during the trim. That lowering found this job queued, so
        // the job goes on instead of ending.
        outcome = "continue";
      }
    } catch (error) {
      console.error("Queued removal failed", job.ruleId, ...errorLogFields(error));
      const throttleDelay = throttleDelayMs(error);
      if (throttleDelay !== null) {
        outcome = "throttled";
        delayMs = throttleDelay;
      } else {
        outcome = "failed";
        refused = error instanceof TokenError && RECONNECT_CODES.has(error.code);
      }
    }
    const progress = removed > 0;
    // An offboarding can take over the job while the provider calls run; see `queueRemovals`.
    const stored = (await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY))?.find((queued) =>
      sameRemoval(queued, job),
    );
    const offboarding = job.offboarding ?? stored?.offboarding;
    // Throttling is no failed attempt: the job waits for `Retry-After` instead.
    const attempts =
      outcome === "failed" ? job.attempts + 1 : progress && !edgeReadFailed ? 0 : job.attempts;
    const wait = REMOVAL_BACKOFF_MS[attempts - 1];
    const waits = outcome === "failed" && wait !== undefined;
    const next: Removal = {
      ruleId: job.ruleId,
      remoteCalendarId: job.remoteCalendarId,
      attempts,
      ...(waits ? { notBefore: Date.now() + wait } : {}),
      ...(job.trim ? { trim: true as const } : { started: true as const }),
      ...(offboarding
        ? {
            offboarding: {
              orgId: offboarding.orgId,
              userId: offboarding.userId,
              removed: offboarding.removed + removed,
              ...(left === undefined ? {} : { left }),
            },
          }
        : {}),
    };
    const ended = outcome === "done" || (outcome === "failed" && attempts >= MAX_REMOVAL_ATTEMPTS);
    if (ended) {
      const result = outcome === "done" ? "removed" : refused ? "token_refused" : "incomplete";
      await this.reportCleanup([next], result);
    }
    // The removed blocks may have hidden blocks of other rules. Every step that removed blocks sets
    // the mark, so that the full cycle stays owed if a later step of this job waits, or if the next
    // removal fails and only sets its own alarm.
    if (ended || progress) await this.ctx.storage.put(CYCLE_AGAIN_KEY, true);
    // Removals queued during the provider calls are in the stored queue, not in `queue`.
    await this.updateQueue<Removal>(REMOVAL_QUEUE_KEY, (current) => {
      const others = current.filter((queued) => !sameRemoval(queued, job));
      if (outcome === "continue") return [next, ...others];
      if (outcome === "throttled") return [...others, next];
      // After the last attempt the job is dropped, so that it cannot hold the account forever.
      if (outcome === "failed" && attempts < MAX_REMOVAL_ATTEMPTS) return [...others, next];
      return others;
    });
    // After a failed attempt, `keepRemovalAlarm()` sets the next alarm, unless rules or a requested
    // full cycle wait.
    const syncWaits =
      ((await this.ctx.storage.get<string[]>(RULE_QUEUE_KEY)) ?? []).length > 0 ||
      ((await this.ctx.storage.get<boolean>(CYCLE_AGAIN_KEY)) ?? false);
    if (!waits || syncWaits) await this.setSyncAlarm(Date.now() + delayMs);
    return true;
  }

  /**
   * Run the next rule that targets this account. Each alarm runs one rule, so that every rule gets
   * the full subrequest budget of an invocation; the alarm then schedules itself for the next one.
   * A rule with writes left stays at the front of the queue. If this account's mailbox throttled
   * the run, the next alarm waits for its `Retry-After`; the other rules target the same mailbox, so
   * they wait too. If another account throttled the read of a rule's source, only that rule waits.
   */
  override async alarm(): Promise<void> {
    let failed = false;
    try {
      await this.runAlarm();
    } catch (error) {
      // The retries of the platform end after a few attempts, and a retiring account may have no
      // row, so no cron reaches it. Its next alarm comes from here. Other alarms retry as before.
      if (!(await this.retirementOpen())) throw error;
      console.error("A step of a retirement failed", ...errorLogFields(error));
      failed = true;
    }
    // While paused, the alarm runs neither removals nor the retry of a sync request, so an alarm
    // for them would fire again and again. They wait in storage until new tokens start an alarm.
    // A retiring account does not wait for new tokens: its removals use up their attempts. New
    // tokens end the retirement, see `storeTokens()`.
    if (!(await this.pause()) || (await this.retiring())) {
      // After the last rule or check no alarm is left; a waiting removal or retry still needs one.
      await this.keepCompareAlarm();
      await this.keepRemovalAlarm();
      await this.keepRetryAlarm();
    }
    const pending = await this.ctx.storage.getAlarm();
    const retryAt = Date.now() + RETIREMENT_RETRY_MS;
    if (pending === null) {
      if (await this.retirementOpen()) await this.setSyncAlarm(retryAt);
    } else if (failed && pending < retryAt) {
      // The alarms above can be due at once, and every run would fail until D1 answers. The mark of
      // the alarm stays, because the work it waits for stays.
      await this.ctx.storage.setAlarm(retryAt);
    }
  }

  private async runAlarm(): Promise<void> {
    const accountId = this.accountIdOrNull();
    if (!accountId) {
      // Without tokens no removal can run, for example after `forget()` or a new jurisdiction.
      const removals = await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY);
      if (removals !== undefined) {
        console.error(
          "Dropping queued removals: no tokens",
          this.ctx.id.name ?? this.ctx.id.toString(),
        );
        await this.reportCleanup(removals, "no_tokens");
        await this.ctx.storage.delete(REMOVAL_QUEUE_KEY);
      }
      return;
    }
    await this.checkEndedRetirement(accountId);
    await this.reportAbortedRuns(accountId);
    // Every provider call would fail. The work waits for new tokens, which start a full cycle;
    // queued removals stay. A retiring account does not wait for them: its removals use up their
    // attempts, a refusal can end by itself, and then the account goes. A watch that cannot be
    // stopped with a refused token ends on its own.
    const pause = await this.pause();
    if (pause && !(await this.retiring())) {
      await this.failOpenCompares({ reason: "paused", code: pause.code });
      await this.whilePaused(accountId, pause);
      return;
    }
    // A retiring account stops its watches in an alarm of their own, so that `retire()` never
    // waits for a provider. Its removals can take hours; no notifications are needed meanwhile.
    // One try only, so that a watch that cannot be stopped does not cost every alarm a request.
    if (
      (await this.retiring()) &&
      this.storedWatches().length > 0 &&
      (await this.ctx.storage.get(WATCHES_TRIED_KEY)) === undefined
    ) {
      await this.ctx.storage.put(WATCHES_TRIED_KEY, true);
      await this.stopWatches();
      await this.setSyncAlarm(Date.now() + this.delays().nextRun);
      return;
    }
    // Change feeds come first, then due removals, one per alarm; the rules follow once none is due.
    if (await this.runChangeCheck(accountId)) return;
    if (await this.runRemoval()) return;
    if (await this.retiring()) {
      await this.finishRetirement(accountId);
      return;
    }
    // This alarm must not go on to a full cycle. If sync work came up meanwhile, that goes first.
    if (
      (await this.ctx.storage.get(FEED_ONLY_ALARM_KEY)) === COMPARE_ALARM &&
      !(await this.hasSyncWork(true))
    ) {
      // The mark stays during the step. If the step dies, the retry of this alarm must read the
      // slice again, not start a full cycle. A tick may set the next alarm during the step.
      await this.runCompareStep();
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.delete(FEED_ONLY_ALARM_KEY);
      }
      return;
    }
    let queue = (await this.ctx.storage.get<string[]>(RULE_QUEUE_KEY)) ?? [];
    if (queue.length === 0) {
      // A step of its own, before the cycle, so that the rules keep the budget of their alarms.
      if (await this.feedOwnershipDue()) {
        await this.setSyncAlarm(Date.now() + (await this.checkFeedOwnership(accountId)));
        return;
      }
      // This cycle covers every request so far. Cleared before the rule list is read: a request
      // during the read, for example for a new rule, marks again and gets one more cycle.
      await this.ctx.storage.delete(CYCLE_AGAIN_KEY);
      const all = await inPrecedenceOrder(await rulesTargetingAccount(this.env, accountId));
      // Stored before the run, so that the end of the run reads the whole cycle back.
      // A tick may have queued some rules meanwhile; the full cycle still runs all of them.
      queue = await this.updateQueue<string>(RULE_QUEUE_KEY, (current) =>
        inPrecedenceOrder([...new Set([...current, ...all])]),
      );
      await this.ctx.storage.put(FULL_CYCLE_KEY, Date.now());
    }
    if (queue.length === 0) {
      await this.ensureWatchesSafely();
      return;
    }
    const notBefore =
      (await this.ctx.storage.get<Record<string, number>>(RULE_NOT_BEFORE_KEY)) ?? {};
    const due = queue.find((id) => (notBefore[id] ?? 0) <= Date.now());
    // A rule disabled or removed while queued, or one whose owner was deactivated or left the
    // access policy, leaves the queue without a run and without an audit event. Its removal may be
    // queued already, and a run would write its blocks again.
    const running = await this.rulesRunningFromAlarm(due === undefined ? queue : [due]);
    if (!running) return;
    // If every queued rule waits, a stopped one leaves the queue now instead of at its wait's end.
    const ruleId = due ?? queue.find((id) => !running.has(id));
    if (ruleId === undefined) {
      // Every queued rule waits for a throttled source account.
      const at = Math.min(...queue.map((id) => notBefore[id] ?? 0));
      await this.setSyncAlarm(await this.waitingRulesAlarm(at, Date.now() + this.delays().nextRun));
      return;
    }
    const waited = notBefore[ruleId] !== undefined;

    let unfinished = false;
    let changedBlocks = false;
    let deferUntil: number | undefined;
    let delayMs = this.delays().nextRun;
    if (running.has(ruleId)) {
      await this.noteFakeStep();
      try {
        const result = await this.runRuleAfterOthers(ruleId);
        unfinished = result.remaining > 0;
        // An update or a delete can free a dedup key that kept a later rule from writing a block.
        // A rule that waited for its source may run after the later rules, so its creates count.
        const { create, update, delete: deleted } = result.stats;
        changedBlocks = update > 0 || deleted > 0 || (waited && create > 0);
        delayMs = result.retryAfterMs ?? this.delays().nextRun;
      } catch (error) {
        // One broken rule must not stop the others; the run has recorded the failure.
        console.error("Rule run failed", ruleId, ...errorLogFields(error));
        // A throttled read is retried after the wait instead of in the next cron cycle.
        const throttleDelay = throttleDelayMs(error);
        if (throttleDelay !== null && error instanceof SourceThrottledError) {
          // Another account's mailbox throttled. The other rules may still read and write this
          // account, so only this rule waits, behind them.
          deferUntil = Date.now() + throttleDelay;
        } else if (throttleDelay !== null) {
          // This account's mailbox throttled; every queued rule writes into it, so all wait.
          unfinished = true;
          delayMs = throttleDelay;
        }
      }
    }

    const followers = changedBlocks ? await this.followersOf(ruleId) : [];
    // Rules queued during the run (by a tick) are in the stored queue, not in `queue`.
    const next = await this.updateQueue<string>(RULE_QUEUE_KEY, (current) => {
      const others = current.filter((id) => id !== ruleId);
      const merged = [
        ...new Set([
          ...(unfinished ? [ruleId] : []),
          ...others,
          ...followers,
          ...(deferUntil === undefined ? [] : [ruleId]),
        ]),
      ];
      return followers.length > 0 ? inPrecedenceOrder(merged) : merged;
    });
    const waits = await this.storeRuleWaits(next, ruleId, { deferUntil, keepOwn: unfinished });
    if (next.length > 0) {
      // No queued rule runs before its own wait or before the queue's next run.
      const earliest = Date.now() + delayMs;
      const at = Math.min(...next.map((id) => Math.max(earliest, waits[id] ?? 0)));
      await this.setSyncAlarm(await this.waitingRulesAlarm(at, earliest));
    } else {
      // A sync requested during the queue starts a full cycle. It waits for the debounce, so that
      // a stream of notifications still collapses.
      if (await this.ctx.storage.get<boolean>(CYCLE_AGAIN_KEY)) {
        await this.setSyncAlarm(Date.now() + Math.max(delayMs, this.delays().debounce));
      }
      // The cycle is done: check the watches once per cycle, with the rest of the budget. Also
      // before a further cycle, so that a steady stream of changes cannot let the watches expire.
      await this.ensureWatchesSafely();
    }
  }

  /**
   * Keep the waits of the queued rules: set `deferUntil` for `ruleId`, and drop the waits of rules
   * that left the queue. The old wait of `ruleId` stays only with `keepOwn`, for a rule that stays
   * queued with work left. Returns the stored waits.
   */
  private async storeRuleWaits(
    queue: string[],
    ruleId: string,
    { deferUntil, keepOwn }: { deferUntil: number | undefined; keepOwn: boolean },
  ): Promise<Record<string, number>> {
    const stored = (await this.ctx.storage.get<Record<string, number>>(RULE_NOT_BEFORE_KEY)) ?? {};
    const waits = Object.fromEntries(
      Object.entries(stored).filter(([id]) => queue.includes(id) && (id !== ruleId || keepOwn)),
    );
    if (deferUntil !== undefined) waits[ruleId] = deferUntil;
    if (Object.keys(waits).length > 0) await this.ctx.storage.put(RULE_NOT_BEFORE_KEY, waits);
    else await this.ctx.storage.delete(RULE_NOT_BEFORE_KEY);
    return waits;
  }

  /**
   * The rules of `ruleIds` that the alarm may run. If D1 fails, the queue stays as it is, the alarm
   * tries again later, and this returns null: dropping the rule would lose its run.
   */
  private async rulesRunningFromAlarm(ruleIds: string[]): Promise<Set<string> | null> {
    const failures = (await this.ctx.storage.get<number>(RULE_LOOKUP_FAILURES_KEY)) ?? 0;
    try {
      const running = await rulesRunningFromAlarm(this.env, ruleIds);
      if (failures > 0) await this.ctx.storage.delete(RULE_LOOKUP_FAILURES_KEY);
      return running;
    } catch (error) {
      console.error("Rule lookup failed", errorCode(error));
      await this.ctx.storage.put(RULE_LOOKUP_FAILURES_KEY, failures + 1);
      const wait = Math.min(RULE_LOOKUP_RETRY_MAX_MS, RULE_LOOKUP_RETRY_MS * 2 ** failures);
      // A removal or a retry that is due earlier keeps its time.
      const now = Date.now();
      await this.setSyncAlarm(
        await this.waitingRulesAlarm(now + wait, now + this.delays().nextRun, { recheck: false }),
      );
      return null;
    }
  }

  /**
   * The alarm for the queue when its next rule may run at `at`, but no earlier than `earliest`. If
   * only a source wait holds the queue, the alarm comes back within WAITING_RULES_CHECK_MS, or for a
   * removal or a retry that is due earlier. A removal without a wait is due now. Every time is
   * raised to `earliest`, which lies in the future, so the alarm cannot loop. Without `recheck`, the
   * 30-second check does not apply.
   */
  private async waitingRulesAlarm(
    at: number,
    earliest: number,
    { recheck = true } = {},
  ): Promise<number> {
    if (at <= earliest) return earliest;
    const removal = nextRemoval((await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) ?? []);
    const retry = await this.ctx.storage.get<SyncRequestRetry>(SYNC_REQUEST_RETRY_KEY);
    const other = [
      ...(recheck ? [Date.now() + WAITING_RULES_CHECK_MS] : []),
      ...(removal ? [removal.notBefore ?? 0] : []),
      ...(retry ? [retry.at] : []),
    ];
    return Math.max(earliest, Math.min(at, ...other));
  }

  /**
   * The rules that come after a rule into the same calendar. They may have left out events whose
   * blocks the rule just removed, and must now write their own.
   */
  private async followersOf(ruleId: string): Promise<string[]> {
    const tag = await ruleTagFor(ruleId);
    const followers: string[] = [];
    for (const id of await siblingRuleIds(this.env.DB, ruleId)) {
      if ((await ruleTagFor(id)) > tag) followers.push(id);
    }
    return followers;
  }

  /**
   * Read, change and write a stored queue with no other request in between, and return the new
   * queue. A provider call lets other requests into the instance, so a queue read before the call
   * is stale after it; writing it back would drop what they queued.
   */
  private updateQueue<T>(key: string, change: (queue: T[]) => T[] | Promise<T[]>): Promise<T[]> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const next = await change((await this.ctx.storage.get<T[]>(key)) ?? []);
      if (next.length > 0) await this.ctx.storage.put(key, next);
      else await this.ctx.storage.delete(key);
      return next;
    });
  }

  /**
   * Start a comparison of every calendar that this account's rules write into, and with `full` of
   * every writable calendar without a rule. It only stores the state; alarms read the slices. A
   * calendar with an open comparison keeps it, except that a full comparison replaces a daily one:
   * a daily comparison can wait a day for its confirmation, and a full one covers its window.
   */
  async startCompares(mode: "full" | "near" = "full"): Promise<CompareStart> {
    const counts: CompareStart = { started: 0, open: 0, failed: 0 };
    const accountId = this.accountIdOrNull();
    if (!accountId || (await this.retiring())) return counts;
    for (const calendar of await targetCalendars(this.env.DB, accountId)) {
      const context = await this.compareContext(calendar.calendarId);
      if (context.rules.length === 0) continue;
      counts[await this.startCompare(calendar, context, mode)]++;
    }
    if (mode === "full") {
      for (const calendar of await leftoverCalendars(this.env, accountId)) {
        const context = await this.compareContext(calendar.calendarId);
        counts[await this.startCompare(calendar, context, "leftover")]++;
      }
    }
    await this.keepCompareAlarm();
    return counts;
  }

  /** What a comparison of a calendar reads the rules for. */
  private async compareContext(calendarId: string): Promise<CompareContext> {
    const rules = await rulesIntoCalendar(this.env, calendarId);
    const others = await rulesThroughOtherRows(this.env, calendarId);
    const inputs = rules.map(compareRule);
    return { rules, inputs, others, hash: await ruleSetHash(inputs, others) };
  }

  private async startCompare(
    calendar: { calendarId: string; remoteCalendarId: string },
    context: CompareContext,
    mode: CompareMode,
  ): Promise<keyof CompareStart> {
    const key = `${COMPARE_PREFIX}${calendar.calendarId}`;
    const current = await this.ctx.storage.get<CompareState>(key);
    if (current?.mode === "near" && mode === "full" && !current.report) {
      await this.failCompare(current, { reason: "superseded" });
    }
    if (await this.ctx.storage.get(key)) return "open";
    const state = newCompare({ ...calendar, mode, ruleHash: context.hash, now: Date.now() });
    const horizon = scanHorizon(context.inputs, state.startedAt, mode);
    const stop =
      horizon.start >= horizon.end
        ? ({ reason: "empty_horizon" } as const)
        : await this.compareStop(state, context);
    if (stop) {
      await this.failCompare(state, stop);
      return "failed";
    }
    return (await this.openCompare(key, state)) ? "started" : "open";
  }

  /** Store a new comparison, unless a request stored one meanwhile. */
  private openCompare(key: string, state: CompareState): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      if (await txn.get(key)) return false;
      await txn.put(key, state);
      return true;
    });
  }

  private async openCompares(): Promise<CompareState[]> {
    return [...(await this.ctx.storage.list<CompareState>({ prefix: COMPARE_PREFIX })).values()];
  }

  /**
   * Why a calendar cannot be compared now, or null. A queued removal is about to change the
   * calendar, and a paused account cannot be read to the end.
   */
  private async compareStop(
    state: CompareState,
    { rules, hash }: CompareContext,
  ): Promise<CompareFailure | null> {
    if (hash !== state.ruleHash) return { reason: "config_changed" };
    const pause = await this.pause();
    if (pause) return { reason: "paused", code: pause.code };
    if (rules.some((rule) => rule.source.needsReconnect || rule.target.needsReconnect)) {
      return { reason: "paused" };
    }
    const removals = (await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) ?? [];
    return removals.some((job) => job.remoteCalendarId === state.remoteCalendarId)
      ? { reason: "removal_queue" }
      : null;
  }

  /**
   * End a comparison without a result. Such a run never counts as a comparison. A comparison whose
   * result already waits for D1 keeps that result.
   */
  private async failCompare(state: CompareState, failure: CompareFailure): Promise<void> {
    await this.closeCompare(
      state,
      state.report ?? { kind: "compare_failed", detail: failureDetail(state, failure) },
    );
  }

  /**
   * Write the audit row of a comparison, and forget the comparison only if D1 took the row. If not,
   * the row waits in storage, and the next tick writes it without a new read of any calendar.
   */
  private async closeCompare(state: CompareState, report: CompareReport): Promise<void> {
    const key = `${COMPARE_PREFIX}${state.calendarId}`;
    const detail = { ...report.detail };
    // Stored before the row: once the row exists, the comparison is gone, and a call that dies
    // between the two would lose the alert. A result that waits for D1 comes back here in every
    // tick, so only the first close counts it, and a lost lock cannot post it again.
    if (!state.report && report.kind === "compare_run") {
      await this.updateQueue<CompareAlert>(COMPARE_ALERTS_KEY, (queue) =>
        compareAlertsAfter(queue, report.detail),
      );
    }
    if (await this.auditAccountChecked(this.accountId(), report.kind, detail)) {
      await this.ctx.storage.delete(key);
    } else {
      await this.ctx.storage.put(key, { ...state, phase: "reporting", report });
    }
  }

  private async failOpenCompares(failure: CompareFailure): Promise<void> {
    for (const state of await this.openCompares()) await this.failCompare(state, failure);
  }

  /** The tick's part of comparisons. Never throws: it must not stop the tick. */
  private async compareTick(): Promise<void> {
    try {
      for (const state of await this.openCompares()) await this.settleCompare(state);
      const now = Date.now();
      const last = await this.ctx.storage.get<number>(NEAR_COMPARE_KEY);
      // The first tick only starts the wait, so that an update compares nothing at once.
      if (last === undefined) await this.ctx.storage.put(NEAR_COMPARE_KEY, now);
      else if (now - last >= NEAR_COMPARE_EVERY_MS) {
        await this.ctx.storage.put(NEAR_COMPARE_KEY, now);
        await this.startCompares("near");
      }
      await this.keepCompareAlarm();
    } catch (error) {
      console.error("The tick of a comparison failed", ...errorLogFields(error));
    }
  }

  /**
   * End an open comparison that took too long, or start its second scan. That scan is due once
   * every rule of the calendar had a successful run that began after the first scan ended.
   */
  private async settleCompare(state: CompareState): Promise<void> {
    if (state.report) {
      await this.closeCompare(state, state.report);
      return;
    }
    if (Date.now() - (state.first?.at ?? state.startedAt) >= COMPARE_TIMEOUT_MS) {
      await this.failCompare(state, { reason: "timeout" });
      return;
    }
    if (state.phase !== "confirming" || !state.first) return;
    const context = await this.compareContext(state.calendarId);
    const stop = await this.compareStop(state, context);
    if (stop) {
      await this.failCompare(state, stop);
      return;
    }
    for (const rule of context.rules) {
      const ranAt = await this.ctx.storage.get<number>(`${RULE_OK_PREFIX}${rule.id}`);
      if (ranAt === undefined || ranAt < state.first.at) return;
    }
    await this.ctx.storage.put(`${COMPARE_PREFIX}${state.calendarId}`, startConfirmScan(state));
  }

  /** Read and compare one slice of the first open scan. */
  private async runCompareStep(): Promise<void> {
    const state = (await this.openCompares()).find((open) => open.phase === "scanning");
    if (!state) return;
    try {
      await this.compareNextSlice(state);
    } catch (error) {
      console.error("A comparison failed", ...errorLogFields(error));
      if (await this.stillOpen(state)) await this.failCompare(state, compareFailure(error));
    }
  }

  /**
   * True if `state` is still the open comparison of its calendar. A pause, a removal or a full
   * comparison can end it during the reads of a step.
   */
  private async stillOpen(state: CompareState): Promise<boolean> {
    const key = `${COMPARE_PREFIX}${state.calendarId}`;
    const current = await this.ctx.storage.get<CompareState>(key);
    return (
      current !== undefined &&
      current.mode === state.mode &&
      current.startedAt === state.startedAt &&
      !current.report
    );
  }

  private async compareNextSlice(state: CompareState): Promise<void> {
    const key = `${COMPARE_PREFIX}${state.calendarId}`;
    const context = await this.compareContext(state.calendarId);
    const { rules, inputs, others } = context;
    const stop = await this.compareStop(state, context);
    if (stop) {
      await this.failCompare(state, stop);
      return;
    }
    // The step before ended without a word, for example at the CPU limit.
    if (state.attempt === state.sliceStart) {
      await this.shrinkSlice(state);
      return;
    }
    const horizon = scanHorizon(inputs, state.startedAt, state.mode);
    const slice = sliceAfter(state, horizon);
    await this.ctx.storage.put(key, { ...state, attempt: slice.start });
    let read: Awaited<ReturnType<AccountSync["readCompareSlice"]>>;
    try {
      read = await this.readCompareSlice(state, rules, slice);
    } catch (error) {
      if (!isSubrequestLimit(error)) throw error;
      if (await this.stillOpen(state)) await this.shrinkSlice(state);
      return;
    }
    if (!(await this.stillOpen(state))) return;
    if (read.reads > MAX_SLICE_READS || read.items > MAX_SLICE_ITEMS) {
      await this.shrinkSlice(state);
      return;
    }
    const next = addSlice(
      state,
      slice.end,
      await compareSlice({
        rules: inputs,
        events: read.events,
        blocks: read.blocks,
        slice,
        startedAt: state.startedAt,
        others,
      }),
    );
    if (next.sliceStart < horizon.end) {
      await this.ctx.storage.put(key, next);
      return;
    }
    const done = finishScan(next, Date.now());
    if ("state" in done) {
      await this.ctx.storage.put(key, done.state);
      return;
    }
    await this.closeCompare(next, { kind: "compare_run", detail: done.detail });
  }

  private async shrinkSlice(state: CompareState): Promise<void> {
    const smaller = halveSlice(state);
    if (smaller) await this.ctx.storage.put(`${COMPARE_PREFIX}${state.calendarId}`, smaller);
    else await this.failCompare(state, { reason: "slice_too_large" });
  }

  /**
   * The blocks of a slice and the events of all sources of a calendar. Reads run one after the
   * other, and all of them respect a provider penalty as feed reads do: a comparison never extends
   * one. Any read that fails ends the comparison, so that a gap never counts as "no deviation".
   */
  private async readCompareSlice(
    state: CompareState,
    rules: RuleContext[],
    slice: SliceWindow,
  ): Promise<{
    blocks: ExistingBlock[];
    events: Map<string, SourceEvent[]>;
    reads: number;
    items: number;
  }> {
    const readsBefore = this.providerReads;
    const left = await this.penaltyLeft();
    if (left > 0) throw new PenaltyActive(left);
    const target = await this.client({ respectPenalty: true });
    const blocks = await target.allBlocks(state.remoteCalendarId, blockReadWindow(slice));
    const window = sourceReadWindow(slice);
    const ownAccount = this.accountId();
    const events = new Map<string, SourceEvent[]>();
    for (const rule of rules) {
      const { source } = compareRule(rule);
      if (events.has(source)) continue;
      const { accountId, remoteCalendarId } = rule.source;
      if (accountId !== ownAccount) this.providerReads++;
      const read =
        accountId === ownAccount
          ? await this.readFeedEvents(remoteCalendarId, window)
          : await accountSync(this.env, accountId).readFeedEvents(remoteCalendarId, window);
      if (read.kind === "throttled") throw new CompareStopped({ reason: "throttled" });
      if (read.kind === "unavailable") throw new CompareStopped({ reason: "source_unavailable" });
      events.set(source, read.events);
    }
    return {
      blocks,
      events,
      reads: this.providerReads - readsBefore,
      items: sliceItems(blocks.length, rules.map(compareRule), events),
    };
  }

  /**
   * Keep one watch per calendar that a rule reads or writes: create missing ones, renew those that
   * expire within a day, and stop those no rule needs. Without PUBLIC_URL all watches stop, and only
   * the cron syncs. A failure leaves the cron as the fallback for that calendar.
   */
  async ensureWatches(): Promise<void> {
    const accountId = this.accountIdOrNull();
    if (!accountId) return;
    const url = webhookUrl(this.env, this.providerOrDefault(), accountId);
    const stored = this.storedWatches();
    const { results } = await this.env.DB.prepare(
      `SELECT c.remote_id AS remoteId, ${OWNER_COLUMNS} FROM calendars c
       JOIN rules r ON (r.source_calendar_id = c.id OR r.target_calendar_id = c.id)
       JOIN users u ON u.id = r.user_id
       JOIN orgs o ON o.id = u.org_id
       WHERE c.account_id = ? AND r.enabled = 1 AND u.active = 1`,
    )
      .bind(accountId)
      .all<{ remoteId: string } & OwnerColumns>();
    // A calendar of an owner the policy no longer admits loses its watch with the next cycle.
    const admitted = results.filter(ownerAdmission(this.env));
    const needed = url ? new Set(admitted.map((row) => row.remoteId)) : new Set<string>();
    if (needed.size === 0 && stored.length === 0) return;

    const client = await this.client();
    const now = Date.now();
    const markWatched = (calendarId: string, until: number | null) =>
      this.env.DB.prepare(
        "UPDATE calendars SET watched_until = ? WHERE account_id = ? AND remote_id = ?",
      )
        .bind(until, accountId, calendarId)
        .run();
    for (const watch of stored) {
      if (needed.has(watch.calendarId)) continue;
      await client.unwatch(watch).catch((error: unknown) => {
        console.error("Stopping a watch failed", watch.id, ...errorLogFields(error));
      });
      this.ctx.storage.sql.exec(`DELETE FROM subscriptions WHERE remote_id = ?`, watch.id);
      await this.ctx.storage.delete(`${SYNC_TOKEN_PREFIX}${watch.calendarId}`);
      await markWatched(watch.calendarId, null);
    }
    if (!url) return;
    const token = await webhookToken(this.env, accountId);
    for (const calendarId of needed) {
      const current = stored.find((watch) => watch.calendarId === calendarId);
      if (current && current.expiresAt - now > RENEW_BEFORE_MS) {
        await markWatched(calendarId, current.expiresAt);
        continue;
      }
      try {
        const renewed = current ? await client.renew(current, now + WATCH_LIFETIME_MS) : null;
        if (renewed) {
          this.storeWatch(calendarId, renewed, current?.id);
          await markWatched(calendarId, renewed.expiresAt);
          continue;
        }
        const fresh = await client.watch(calendarId, url, token, now + WATCH_LIFETIME_MS);
        this.storeWatch(calendarId, fresh, current?.id);
        await markWatched(calendarId, fresh.expiresAt);
        // Google channels cannot be extended: the old one overlaps briefly, then stops.
        if (current) await client.unwatch(current).catch(() => undefined);
      } catch (error) {
        console.error("Watching a calendar failed", calendarId, ...errorLogFields(error));
        // Without a watch, the cron polls this calendar every 10 minutes.
        await markWatched(calendarId, null);
      }
    }
  }

  /** Watches are an optimisation; a failure, such as a revoked token, must not break the alarm. */
  private async ensureWatchesSafely(): Promise<void> {
    try {
      await this.ensureWatches();
    } catch (error) {
      console.error("Keeping watches failed", ...errorLogFields(error));
    }
  }

  private storedWatches(): (Watch & { calendarId: string })[] {
    return this.ctx.storage.sql
      .exec<{
        remote_id: string;
        calendar_id: string;
        resource_id: string | null;
        expires_at: number;
      }>(`SELECT remote_id, calendar_id, resource_id, expires_at FROM subscriptions`)
      .toArray()
      .map((row) => ({
        id: row.remote_id,
        calendarId: row.calendar_id,
        resourceId: row.resource_id,
        expiresAt: row.expires_at,
      }));
  }

  private storeWatch(calendarId: string, watch: Watch, replaces: string | undefined): void {
    if (replaces)
      this.ctx.storage.sql.exec(`DELETE FROM subscriptions WHERE remote_id = ?`, replaces);
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (remote_id, calendar_id, resource_id, expires_at)
       VALUES (?, ?, ?, ?)`,
      watch.id,
      calendarId,
      watch.resourceId,
      watch.expiresAt,
    );
  }

  /**
   * Alarm delays. Tests set them long through SYNC_DEBOUNCE_MS and SYNC_NEXT_RUN_MS, so that an
   * alarm runs only when a test triggers it: alarms fire by themselves once their time passes.
   */
  private delays(): { debounce: number; nextRun: number } {
    const read = (value: string | undefined, fallback: number) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : fallback;
    };
    return {
      debounce: read(this.env.SYNC_DEBOUNCE_MS, DEBOUNCE_MS),
      nextRun: read(this.env.SYNC_NEXT_RUN_MS, NEXT_RUN_MS),
    };
  }

  /** A valid access token; refreshes and stores the rotated refresh token when needed. */
  private async accessToken(): Promise<string> {
    const stored = await this.readTokens();
    if (stored.tokens.accessExpiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return stored.tokens.accessToken;
    }
    // A refused refresh token stays refused; do not ask the token endpoint again. A retiring account
    // asks at every attempt of its removals: the refusal can end before its tokens go.
    const pause = await this.pause();
    if (pause && !(await this.retiring())) throw new TokenError(pause.code);
    // Requests interleave while a refresh waits on the network; refresh only once.
    this.refreshing ??= this.refresh(
      stored.accountId,
      stored.provider,
      stored.tokens.refreshToken,
    ).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * The calendar adapter for this account's provider, with a valid access token. Its calls run one
   * at a time.
   *
   * Outlook allows four concurrent requests per app and mailbox, and Graph runs four requests of
   * one `$batch` at once. Every call to this account's mailbox starts in this instance: its own
   * rules write here, and other instances read their source events here over RPC. While a call
   * waits on the network, the instance accepts other requests, so the queue keeps a read from
   * running next to a write batch.
   */
  private async client(options: { respectPenalty?: boolean } = {}): Promise<CalendarClient> {
    const token = await this.accessToken();
    // Local load tests replace the provider; never active without DEV_FAKE_CALENDARS=1.
    const provider =
      this.env.DEV_FAKE_CALENDARS === "1" && token === "fake"
        ? new FakeCalendar(this.ctx.storage.sql, this.providerOrDefault(), this.env)
        : calendarClient(this.providerOrDefault(), token, () => this.providerReads++);
    return oneCallAtATime(provider, (call) => {
      const result = this.providerQueue.then(async () => {
        // Checked again here: a feed read queued behind a throttled call must not run after it.
        if (options.respectPenalty) {
          const left = await this.penaltyLeft();
          if (left > 0) throw new PenaltyActive(left);
        }
        // Every throttled answer, read or write, starts a penalty that feed reads respect. It is
        // stored before the next queued call starts.
        try {
          const value = await call();
          await this.notePenalty(batchPenalty(value));
          return value;
        } catch (error) {
          await this.notePenalty(throttleDelayMs(error));
          throw error;
        }
      });
      this.providerQueue = result.catch(() => undefined);
      return result;
    });
  }

  private async refresh(
    accountId: string,
    provider: Provider,
    refreshToken: string,
  ): Promise<string> {
    let response: TokenResponse;
    try {
      response = await oauthClient(provider).refreshToken({
        ...clientCredentials(this.env, provider),
        refreshToken,
      });
    } catch (error) {
      // A refused refresh token does not recover by itself; the user has to connect again.
      if (error instanceof TokenError && RECONNECT_CODES.has(error.code)) {
        await this.pauseAfterRefusal(accountId, refreshToken, error.code);
      }
      const owner = await accountOwner(this.env.DB, accountId);
      if (owner) {
        await recordAudit(this.env.DB, {
          ...owner,
          accountId,
          kind: "token_refresh_failed",
          detail: { code: errorCode(error) },
        });
      }
      throw error;
    }
    await this.writeTokens(
      accountId,
      {
        refreshToken: response.refresh_token ?? refreshToken,
        accessToken: response.access_token,
        accessExpiresAt: Date.now() + response.expires_in * 1000,
      },
      provider,
    );
    return response.access_token;
  }

  /**
   * Record that a rule run threw. Looks up the owner itself, because the run may not have got far.
   * Returns true if the run needs no abort report: the event is written, or no rule can carry one.
   */
  private async auditFailure(
    ruleId: string,
    accountId: string,
    error: unknown,
    runId?: string,
  ): Promise<boolean> {
    try {
      const rule = await loadRule(this.env.DB, ruleId);
      if (!rule) return true;
      return await recordAuditChecked(this.env.DB, {
        orgId: rule.orgId,
        userId: rule.userId,
        accountId,
        ruleId,
        kind: "sync_failed",
        detail: { ...(runId ? { runId } : {}), code: errorCode(error) },
      });
    } catch (lookupError) {
      console.error("Audit lookup failed", ruleId, ...errorLogFields(lookupError));
      return false;
    }
  }

  private async readTokens(): Promise<{
    accountId: string;
    provider: Provider;
    tokens: StoredTokens;
  }> {
    const row = this.ctx.storage.sql
      .exec<{ account_id: string; provider: Provider; ciphertext: ArrayBuffer; iv: ArrayBuffer }>(
        `SELECT account_id, provider, ciphertext, iv FROM tokens WHERE id = 1`,
      )
      .toArray()[0];
    if (!row) throw new Error("Account has no tokens");
    const tokens = await decryptJson<StoredTokens>(
      { ciphertext: row.ciphertext, iv: row.iv },
      this.env.TOKEN_ENCRYPTION_KEY,
      row.account_id,
    );
    return { accountId: row.account_id, provider: row.provider, tokens };
  }

  private providerOrDefault(): Provider {
    const row = this.ctx.storage.sql
      .exec<{ provider: Provider }>(`SELECT provider FROM tokens WHERE id = 1`)
      .toArray()[0];
    return row?.provider ?? "microsoft";
  }

  private accountIdOrNull(): string | null {
    const row = this.ctx.storage.sql
      .exec<{ account_id: string }>(`SELECT account_id FROM tokens WHERE id = 1`)
      .toArray()[0];
    return row?.account_id ?? null;
  }

  private accountId(): string {
    const id = this.accountIdOrNull();
    if (!id) throw new Error("Account has no tokens");
    return id;
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const row = sql.exec<{ version: number }>(`SELECT version FROM schema_version`).toArray()[0];
    const current = row?.version ?? 0;

    for (const [index, statement] of MIGRATIONS.entries()) {
      if (index < current) continue;
      sql.exec(statement);
    }
    if (current === 0) {
      sql.exec(`INSERT INTO schema_version (version) VALUES (?)`, MIGRATIONS.length);
    } else if (current < MIGRATIONS.length) {
      sql.exec(`UPDATE schema_version SET version = ?`, MIGRATIONS.length);
    }
  }
}

/** The wait a write batch asks for, or null if the provider throttled none of its actions. */
function batchPenalty(value: unknown): number | null {
  const result = value as Partial<BatchResult> | null;
  return typeof result?.throttled === "number" && result.throttled > 0
    ? clampRetryAfter(result.retryAfterMs)
    : null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Append only. Each entry runs once, in order. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE tokens (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     account_id TEXT NOT NULL,
     ciphertext BLOB NOT NULL, -- AES-GCM, account ID as additional authenticated data
     iv BLOB NOT NULL,
     access_expires_at INTEGER NOT NULL
   );
   CREATE TABLE subscriptions (
     remote_id TEXT PRIMARY KEY,
     calendar_id TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );`,
  `ALTER TABLE tokens ADD COLUMN provider TEXT NOT NULL DEFAULT 'microsoft'`,
  // Google needs the resource ID to stop a channel.
  `ALTER TABLE subscriptions ADD COLUMN resource_id TEXT`,
];
