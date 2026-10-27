import { DurableObject } from "cloudflare:workers";
import { accountOwner, errorCode, errorLogFields, recordAudit, type SyncRunDetail } from "./audit";
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
import { desiredBlocks, inPrecedenceOrder, planSync, ruleTagFor } from "./sync/plan";
import {
  cleanupWindow,
  loadRule,
  ruleWritesInto,
  rulesRunningFromAlarm,
  rulesTargetingAccount,
  siblingRuleIds,
  startsBeyond,
  syncWindow,
  targetReadWindow,
} from "./sync/rules";
import { clampRetryAfter, formatStatuses, throttleDelayMs } from "./sync/throttle";
import type { SourceEvent, SyncPlan } from "./sync/types";
import { decryptJson, encryptJson } from "./token-crypto";
import { detailLevelFor } from "./detail-policy";
import { accountSync } from "./durable";
import type { Watch } from "./providers/calendar-client";
import { FakeCalendar, fakeCallCounts, seedFakeEvents } from "./providers/fake-calendar";
import { notifyChange, requestSyncs, SyncRequestError, webhookToken, webhookUrl } from "./webhooks";
import { sendReconnectAlert } from "./alerts";

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

/** Durable Object storage key: forget the tokens once every queued removal ran. */
const RETIRING_KEY = "retiring";

/** Durable Object storage key: the retiring account tried to stop its watches; `forget()` retries. */
const WATCHES_TRIED_KEY = "watchesTried";

/** Give up on a removal after this many failed attempts; the blocks then stay. */
const MAX_REMOVAL_ATTEMPTS = 5;

/**
 * Wait after the first, second, third and fourth failed attempt of a removal. The rule is gone, so
 * no later run removes its blocks: the attempts span a provider outage of about 14 hours.
 */
const REMOVAL_BACKOFF_MS = [60_000, 10 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];

interface Removal {
  ruleId: string;
  remoteCalendarId: string;
  attempts: number;
  /** After a failed attempt: do not try again before this time. */
  notBefore?: number;
  /**
   * Remove only the blocks beyond the rule's current sync window, after its `daysAhead` went down.
   * The rule stays; no run reads that far, so no run removes them.
   */
  trim?: true;
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

/**
 * Write batches per invocation. With reads and token refresh this stays well inside the Free plan
 * limit of 50 subrequests; a larger plan continues in the next alarm.
 */
const MAX_BATCHES_PER_RUN = 25;

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
   * Real rule runs in progress, by rule ID. In memory is enough: requests to one instance share it,
   * and a new instance has no run in progress.
   */
  private runningRules = new Map<string, Promise<RunResult>>();

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
    if (!pause && row?.flag === 1) pause = await this.pauseForStaleFlag();
    if (pause) {
      await this.whilePaused(accountId, pause);
      return;
    }
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
      `SELECT r.id FROM rules r
       JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN accounts sa ON sa.id = sc.account_id
       JOIN calendars tc ON tc.id = r.target_calendar_id
       JOIN users u ON u.id = r.user_id
       WHERE tc.account_id = ? AND r.enabled = 1 AND u.active = 1 AND sa.needs_reconnect = 0
         AND (sc.watched_until IS NULL OR sc.watched_until < ?
              OR tc.watched_until IS NULL OR tc.watched_until < ?)
       ORDER BY r.id`,
    )
      .bind(accountId, now, now)
      .all<{ id: string }>();
    if (results.length === 0) return;
    await this.updateQueue<string>(RULE_QUEUE_KEY, (queue) =>
      inPrecedenceOrder([...new Set([...queue, ...results.map((row) => row.id)])]),
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
      const kind = await this.ctx.storage.get(FEED_ONLY_ALARM_KEY);
      if (kind === RETRY_ALARM || kind === REMOVAL_ALARM) {
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
   * removal's next attempt. Other work may then set an earlier alarm; the alarm sets the waiting
   * one again when it is done.
   */
  private async pendingAlarm(): Promise<number | null> {
    const pending = await this.ctx.storage.getAlarm();
    const kind = await this.ctx.storage.get(FEED_ONLY_ALARM_KEY);
    return kind === RETRY_ALARM || kind === REMOVAL_ALARM ? null : pending;
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
   * this call ran.
   */
  async storeTokens(
    accountId: string,
    tokens: StoredTokens,
    provider: Provider = "microsoft",
  ): Promise<void> {
    await this.writeTokens(accountId, tokens, provider);
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
    if (!(await this.pause())) return;
    await this.ctx.storage.delete([PAUSE_KEY, RULE_QUEUE_KEY, FULL_CYCLE_KEY]);
    // Removals that wait after attempts with the refused token may run now.
    await this.updateQueue<Removal>(REMOVAL_QUEUE_KEY, (queue) =>
      queue.map(({ notBefore: _wait, ...job }) => job),
    );
    // Other accounts skip rules from this one while the flag is set.
    const accountId = this.accountId();
    await this.env.DB.prepare("UPDATE accounts SET needs_reconnect = 0 WHERE id = ?")
      .bind(accountId)
      .run();
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
    if (started) await this.finishPause(accountId, since);
  }

  /**
   * D1 shows the account as needing a reconnect, but this instance has no pause. Older versions
   * set only the flag, and a late flag write can outlive a reconnect. Pause and probe at once:
   * if the token works, the probe ends the pause and clears the flag. No alert; the flag was set
   * before.
   */
  private async pauseForStaleFlag(): Promise<Pause> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.pause();
      if (current) return current;
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
    // Claimed before the request, so that the alert goes out at most once. A failed post is lost.
    let claimed = false;
    await this.updatePause(since, (current) => {
      claimed = current.alertPending;
      return { ...current, alertPending: false };
    });
    if (claimed) await sendReconnectAlert(this.env, this.providerOrDefault());
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

  private async retiring(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>(RETIRING_KEY)) ?? false;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return (await this.client()).listCalendars();
  }

  /** Source events of one calendar of this account. Called by the target account's instance. */
  async readSourceEvents(
    remoteCalendarId: string,
    window: { start: Date; end: Date },
    withBody: boolean,
  ): Promise<SourceEvent[]> {
    const key = `${remoteCalendarId}|${window.start.toISOString()}|${window.end.toISOString()}|${withBody}`;
    const cached = this.sourceCache.get(key);
    if (cached && Date.now() - cached.at < SOURCE_CACHE_MS) return cached.events;
    const events = this.client().then((client) =>
      client.sourceEvents(remoteCalendarId, window, { withBody }),
    );
    this.sourceCache.set(key, { at: Date.now(), events });
    // A failed read is not cached.
    events.catch(() => this.sourceCache.delete(key));
    return events;
  }

  /**
   * `readSourceEvents()` for the instance of a rule's target account. An error that crosses RPC
   * keeps only its message, so a throttled read returns its wait instead of throwing.
   */
  async readSourceForRule(
    remoteCalendarId: string,
    window: { start: Date; end: Date },
    withBody: boolean,
  ): Promise<SourceRead> {
    try {
      return { events: await this.readSourceEvents(remoteCalendarId, window, withBody) };
    } catch (error) {
      const waitMs = throttleDelayMs(error);
      if (waitMs === null || !(error instanceof Error)) throw error;
      return { throttled: { message: error.message, waitMs } };
    }
  }

  /** Local load tests only: replace this account's simulated events. */
  async seedFake(seed: number, count: number): Promise<void> {
    if (this.env.DEV_FAKE_CALENDARS !== "1") throw new Error("Simulation is off");
    seedFakeEvents(this.ctx.storage.sql, seed, count);
    this.sourceCache.clear();
  }

  /** Local load tests only: simulated provider calls since the last seed. */
  async fakeStats(): Promise<Record<string, number>> {
    if (this.env.DEV_FAKE_CALENDARS !== "1") throw new Error("Simulation is off");
    return fakeCallCounts(this.ctx.storage.sql);
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

  private startRun(ruleId: string, options: RunOptions = {}): Promise<RunResult> {
    const run: Promise<RunResult> = this.runRuleOnce(ruleId, options).finally(() => {
      if (this.runningRules.get(ruleId) === run) this.runningRules.delete(ruleId);
    });
    this.runningRules.set(ruleId, run);
    return run;
  }

  private async runRuleOnce(ruleId: string, options: RunOptions): Promise<RunResult> {
    try {
      return await this.executeRule(ruleId, options);
    } catch (error) {
      // Record failed real runs whether the alarm or a user started them; previews stay silent.
      if (!options.dryRun) await this.auditFailure(ruleId, this.accountIdOrNull() ?? "", error);
      throw error;
    }
  }

  private async executeRule(ruleId: string, options: RunOptions): Promise<RunResult> {
    const startedAt = Date.now();
    const rule = await loadRule(this.env.DB, ruleId);
    if (!rule) throw new Error(`Rule ${ruleId} not found`);
    if (rule.target.accountId !== this.accountId()) {
      throw new Error("A rule runs in the instance of its target account");
    }
    // The rule was queued before its source account needed reconnecting. Its read would only
    // fail; it runs again in the full cycle after the reconnect. No audit entry.
    if (options.fromAlarm && rule.source.needsReconnect) {
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
    const ruleOptions = {
      ...rule.options,
      detailLevel: detailLevelFor(this.env, rule.options.detailLevel, rule.source, rule.target)
        .level,
    };
    const withBody = ruleOptions.detailLevel === "full";
    const sourceEvents =
      rule.source.accountId === this.accountId()
        ? await this.readSourceEvents(rule.source.remoteCalendarId, window, withBody)
        : await this.readOtherSource(rule.source.accountId, rule.source.remoteCalendarId, {
            window,
            withBody,
          });

    const target = await this.client();
    const ruleTag = await ruleTagFor(rule.id);
    // Rules with a smaller tag into the same calendar take precedence: where they already block
    // an event, this rule writes no second block for it.
    const siblingTags = await Promise.all(
      (await siblingRuleIds(this.env.DB, rule.id)).map((id) => ruleTagFor(id)),
    );
    const precedingTags = siblingTags.filter((tag) => tag < ruleTag);
    const targetRead = targetReadWindow(window);
    const blocks = await target.existingBlocks(rule.target.remoteCalendarId, targetRead, [
      ruleTag,
      ...precedingTags,
    ]);
    const existing = blocks.filter((block) => block.ruleTag === ruleTag);
    const claimed = new Set(
      blocks
        .filter((block) => block.ruleTag !== ruleTag && block.dedupKey !== "")
        .map((block) => block.dedupKey),
    );
    const desired = await desiredBlocks(rule.id, sourceEvents, ruleOptions, {
      scope: rule.userId,
      claimed,
    });
    const plan = planSync(desired, existing, { sync: window, target: targetRead });

    let throttled = 0;
    const statuses: Record<string, number> = {};

    // One audit event per run, written once the outcome is known. Counts only, no event content.
    const audit = async (result: RunResult) => {
      const detail: SyncRunDetail = {
        dryRun: result.dryRun,
        ...plan.stats,
        applied: result.applied,
        failed: result.failed,
        remaining: result.remaining,
        throttled,
        statuses: formatStatuses(statuses),
        durationMs: Date.now() - startedAt,
      };
      await recordAudit(this.env.DB, {
        orgId: rule.orgId,
        userId: rule.userId,
        accountId: rule.target.accountId,
        ruleId,
        kind: "sync_run",
        detail: { ...detail },
      });
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

    const batches = chunk(plan.actions, target.batchLimit);
    let applied = 0;
    let failed = 0;
    let retryAfterMs: number | undefined;
    for (const batch of batches.slice(0, MAX_BATCHES_PER_RUN)) {
      const result = await target.applyBatch(rule.target.remoteCalendarId, ruleTag, batch);
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
    return audit({
      ruleId,
      dryRun: false,
      stats: plan.stats,
      applied,
      failed,
      remaining,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  /** Source events from another account's instance. Throws SourceThrottledError if it throttles. */
  private async readOtherSource(
    accountId: string,
    remoteCalendarId: string,
    { window, withBody }: { window: { start: Date; end: Date }; withBody: boolean },
  ): Promise<SourceEvent[]> {
    const read = await accountSync(this.env, accountId).readSourceForRule(
      remoteCalendarId,
      window,
      withBody,
    );
    if ("throttled" in read) {
      throw new SourceThrottledError(read.throttled.message, read.throttled.waitMs);
    }
    return read.events;
  }

  /**
   * Delete the blocks one rule wrote into a calendar of this account, before the rule or an account
   * goes away. With `beyond`, delete only the blocks that start beyond that window end. Returns how
   * many are left if the limit per invocation was reached.
   */
  async removeRuleBlocks(
    ruleId: string,
    remoteCalendarId: string,
    beyond?: Date,
  ): Promise<RemovalResult> {
    const target = await this.client();
    const ruleTag = await ruleTagFor(ruleId);
    const cleanup = cleanupWindow();
    const window = beyond ? { start: beyond, end: cleanup.end } : cleanup;
    const blocks = (await target.existingBlocks(remoteCalendarId, window, [ruleTag])).filter(
      (block) => !beyond || startsBeyond(block, beyond),
    );
    const actions = blocks.map((block) => ({
      kind: "delete" as const,
      targetId: block.targetId,
      marker: block.marker,
    }));
    let removed = 0;
    let retryAfterMs: number | undefined;
    for (const batch of chunk(actions, target.batchLimit).slice(0, MAX_BATCHES_PER_RUN)) {
      const result = await target.applyBatch(remoteCalendarId, ruleTag, batch);
      if (result.writtenIds?.length) await this.rememberWrites(result.writtenIds);
      removed += batch.length - result.failed - result.throttled;
      if (result.throttled > 0) {
        // Further batches would only extend the penalty.
        retryAfterMs = clampRetryAfter(result.retryAfterMs);
        break;
      }
    }
    const remaining = actions.length - removed;
    if (retryAfterMs === undefined) return { removed, remaining, throttled: false };
    return { removed, remaining, throttled: true, retryAfterMs };
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
    const job: Removal = {
      ruleId,
      remoteCalendarId,
      attempts: 0,
      ...(trim ? { trim: true as const } : {}),
    };
    await this.updateQueue<Removal>(REMOVAL_QUEUE_KEY, (queue) =>
      queue.some((queued) => sameRemoval(queued, job)) ? queue : [...queue, job],
    );
    const pending = await this.ctx.storage.getAlarm();
    const soon = Date.now() + this.delays().nextRun;
    if (pending === null || pending > soon) await this.setSyncAlarm(soon);
  }

  /**
   * The account is going: its alarms stop the watches, remove the queued blocks, and then forget
   * the tokens. The removals need the tokens, so the account cannot go at once. This call only
   * writes storage, so that the request never waits for a provider.
   */
  async retire(): Promise<void> {
    await this.ctx.storage.put(RETIRING_KEY, true);
    const pending = await this.ctx.storage.getAlarm();
    const soon = Date.now() + this.delays().nextRun;
    if (pending === null || pending > soon) await this.setSyncAlarm(soon);
  }

  /** True if the removal's rule writes into its calendar again. If D1 fails, the removal goes on. */
  private async ruleWritesAgain(job: Removal): Promise<boolean> {
    try {
      return await ruleWritesInto(this.env.DB, job.ruleId, job.remoteCalendarId);
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
    if (!end) return { removed: 0, remaining: 0, throttled: false };
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
    // A retry can come hours later. If the rule runs again by then, for example after a group
    // direction went back to busy with the same rule ID, its blocks are wanted again. The first
    // attempt skips this check: it runs right after the request that queued it, which may still
    // be changing the rule. A retiring account skips it too: its rules may still be enabled if
    // the request stopped before it deleted them, and its blocks must go. A trim's rule writes on;
    // the trim reads its window at every attempt.
    if (
      !job.trim &&
      job.attempts > 0 &&
      !(await this.retiring()) &&
      (await this.ruleWritesAgain(job))
    ) {
      await this.updateQueue<Removal>(REMOVAL_QUEUE_KEY, (current) =>
        current.filter((queued) => !sameRemoval(queued, job)),
      );
      // An earlier attempt may have deleted blocks the rule wants again.
      await this.ctx.storage.put(CYCLE_AGAIN_KEY, true);
      await this.setSyncAlarm(Date.now() + this.delays().nextRun);
      return true;
    }
    let outcome: "done" | "continue" | "throttled" | "failed" = "done";
    let delayMs = this.delays().nextRun;
    let giveUp = false;
    try {
      const result: RemovalResult & { end?: Date } = job.trim
        ? await this.trimRuleBlocks(job)
        : await this.removeRuleBlocks(job.ruleId, job.remoteCalendarId);
      if (result.throttled) {
        outcome = "continue";
        delayMs = result.retryAfterMs ?? delayMs;
      } else if (result.remaining > 0) {
        // A run without progress failed, for example with 403 on every block.
        outcome = result.removed > 0 ? "continue" : "failed";
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
        // Refused tokens wait for a reconnect, but a retiring account has no row to reconnect.
        giveUp =
          error instanceof TokenError && RECONNECT_CODES.has(error.code) && (await this.retiring());
      }
    }
    // Throttling is no failed attempt: the job waits for `Retry-After` instead.
    const attempts = giveUp
      ? MAX_REMOVAL_ATTEMPTS
      : outcome === "failed"
        ? job.attempts + 1
        : job.attempts;
    const wait = REMOVAL_BACKOFF_MS[attempts - 1];
    const waits = outcome === "failed" && wait !== undefined;
    const next: Removal = {
      ruleId: job.ruleId,
      remoteCalendarId: job.remoteCalendarId,
      attempts,
      ...(waits ? { notBefore: Date.now() + wait } : {}),
      ...(job.trim ? { trim: true as const } : {}),
    };
    const ended = outcome === "done" || (outcome === "failed" && attempts >= MAX_REMOVAL_ATTEMPTS);
    // The removed blocks may have hidden blocks of other rules. The mark keeps the full cycle owed
    // even if the next removal fails and only sets its own alarm.
    if (ended) await this.ctx.storage.put(CYCLE_AGAIN_KEY, true);
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
    await this.runAlarm();
    // While paused, the alarm runs neither removals nor the retry of a sync request, so an alarm
    // for them would fire again and again. They wait in storage until new tokens start an alarm.
    if (await this.pause()) return;
    // After the last rule or check no alarm is left; a waiting removal or retry still needs one.
    await this.keepRemovalAlarm();
    await this.keepRetryAlarm();
  }

  private async runAlarm(): Promise<void> {
    const accountId = this.accountIdOrNull();
    if (!accountId) {
      // Without tokens no removal can run, for example after `forget()` or a new jurisdiction.
      if ((await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) !== undefined) {
        console.error(
          "Dropping queued removals: no tokens",
          this.ctx.id.name ?? this.ctx.id.toString(),
        );
        await this.ctx.storage.delete(REMOVAL_QUEUE_KEY);
      }
      return;
    }
    // Every provider call would fail. The work waits for new tokens, which start a full cycle;
    // queued removals stay. A retiring account has no row to reconnect, and its refused tokens can
    // neither remove blocks nor stop watches, so it goes now. Its watches end on their own.
    const pause = await this.pause();
    if (pause) {
      if (await this.retiring()) await this.forget();
      else await this.whilePaused(accountId, pause);
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
    if (await this.ctx.storage.get<boolean>(RETIRING_KEY)) {
      await this.forget();
      return;
    }
    let queue = (await this.ctx.storage.get<string[]>(RULE_QUEUE_KEY)) ?? [];
    if (queue.length === 0) {
      // This cycle covers every request so far. Cleared before the rule list is read: a request
      // during the read, for example for a new rule, marks again and gets one more cycle.
      await this.ctx.storage.delete(CYCLE_AGAIN_KEY);
      const all = await inPrecedenceOrder(await rulesTargetingAccount(this.env.DB, accountId));
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
    // A rule disabled or removed while queued leaves the queue without a run and without an audit
    // event. Its removal may be queued already, and a run would write its blocks again.
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
      try {
        const result = await this.runRuleAfterOthers(ruleId);
        unfinished = result.remaining > 0;
        // An update or a delete can free a dedup key that kept a later rule from writing a block.
        // A rule that waited for its source may run after the later rules, so its creates count.
        const { create, update, delete: deleted } = result.stats;
        changedBlocks = update > 0 || deleted > 0 || (waited && create > 0);
        delayMs = result.retryAfterMs ?? this.delays().nextRun;
      } catch (error) {
        // One broken rule must not stop the others; runRule has recorded the failure.
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
      const running = await rulesRunningFromAlarm(this.env.DB, ruleIds);
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
      `SELECT DISTINCT c.remote_id AS remoteId FROM calendars c
       JOIN rules r ON (r.source_calendar_id = c.id OR r.target_calendar_id = c.id)
       JOIN users u ON u.id = r.user_id
       WHERE c.account_id = ? AND r.enabled = 1 AND u.active = 1`,
    )
      .bind(accountId)
      .all<{ remoteId: string }>();
    const needed = url ? new Set(results.map((row) => row.remoteId)) : new Set<string>();
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
    // A refused refresh token stays refused; do not ask the token endpoint again.
    const pause = await this.pause();
    if (pause) throw new TokenError(pause.code);
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
  private async client(): Promise<CalendarClient> {
    const token = await this.accessToken();
    // Local load tests replace the provider; never active without DEV_FAKE_CALENDARS=1.
    const provider =
      this.env.DEV_FAKE_CALENDARS === "1" && token === "fake"
        ? new FakeCalendar(this.ctx.storage.sql, Number(this.env.DEV_FAKE_LATENCY_MS ?? 0))
        : calendarClient(this.providerOrDefault(), token);
    return oneCallAtATime(provider, (call) => {
      const result = this.providerQueue.then(call);
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

  /** Record that a rule run threw. Looks up the owner itself, because the run may not have got far. */
  private async auditFailure(ruleId: string, accountId: string, error: unknown): Promise<void> {
    try {
      const rule = await loadRule(this.env.DB, ruleId);
      if (!rule) return;
      await recordAudit(this.env.DB, {
        orgId: rule.orgId,
        userId: rule.userId,
        accountId,
        ruleId,
        kind: "sync_failed",
        detail: { code: errorCode(error) },
      });
    } catch (lookupError) {
      console.error("Audit lookup failed", ruleId, ...errorLogFields(lookupError));
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
