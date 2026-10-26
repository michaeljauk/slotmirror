import { DurableObject } from "cloudflare:workers";
import { accountOwner, errorCode, recordAudit, type SyncRunDetail } from "./audit";
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
  rulesTargetingAccount,
  siblingRuleIds,
  syncWindow,
} from "./sync/rules";
import { clampRetryAfter, formatStatuses, throttleDelayMs } from "./sync/throttle";
import type { SourceEvent, SyncPlan } from "./sync/types";
import { decryptJson, encryptJson } from "./token-crypto";
import { detailLevelFor } from "./detail-policy";
import { accountSync } from "./durable";
import type { Watch } from "./providers/calendar-client";
import { FakeCalendar, fakeCallCounts, seedFakeEvents } from "./providers/fake-calendar";
import { notifyChange, webhookToken, webhookUrl } from "./webhooks";
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

/** Pause between two alarm runs of one queue when nothing is throttled. */
const NEXT_RUN_MS = 1_000;

/** Wait this long after a change notification before syncing, so that bursts collapse into one run. */
const DEBOUNCE_MS = 5_000;

/** Durable Object storage key of the rules still to run in the current cycle. */
const RULE_QUEUE_KEY = "ruleQueue";

/** Durable Object storage key: event IDs this instance wrote recently, with the time. */
const RECENT_WRITES_KEY = "recentWrites";

/** A change notification this soon after our own write is recognised as its echo. */
const RECENT_WRITE_MS = 2 * 60_000;

/**
 * How long written IDs are kept. A check of Graph notifications can wait for the longest
 * `Retry-After` of five minutes; it compares with the notification's time, not with its own.
 */
const RECENT_WRITES_KEPT_MS = 10 * 60_000;

/** Durable Object storage key prefix: the change feed's sync token per calendar, for Google. */
const SYNC_TOKEN_PREFIX = "syncToken:";

/** Durable Object storage key of the calendars whose change feed is still to read. */
const CHANGED_CALENDARS_KEY = "changedCalendars";

/**
 * Durable Object storage key of the event IDs from Graph notifications that are still to check,
 * with the time of the last notification about each.
 */
const NOTIFIED_EVENTS_KEY = "notifiedEvents";

/**
 * Durable Object storage key: the pending alarm is only for checking change notifications. Without
 * it, an alarm with an empty rule queue starts a full cycle.
 */
const FEED_ONLY_ALARM_KEY = "feedOnlyAlarm";

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

/** Give up on a removal after this many failed attempts; the blocks then stay. */
const MAX_REMOVAL_ATTEMPTS = 5;

interface Removal {
  ruleId: string;
  remoteCalendarId: string;
  attempts: number;
}

function sameRemoval(a: Removal, b: Removal): boolean {
  return a.ruleId === b.ruleId && a.remoteCalendarId === b.remoteCalendarId;
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  /** Ask for a sync soon. Repeated calls before the alarm fires do not move it. */
  async requestSync(): Promise<void> {
    // A new cycle starts from the provider's current data.
    this.sourceCache.clear();
    await this.ctx.storage.delete(FEED_ONLY_ALARM_KEY);
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null) {
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
    const pause = await this.pause();
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
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.setSyncAlarm(now + this.delays().debounce);
    }
  }

  /**
   * True if every event ID belongs to a block this instance wrote in the last two minutes: the
   * notification reports our own write, and a sync would find nothing to do.
   */
  async isOwnEcho(eventIds: string[]): Promise<boolean> {
    const now = Date.now();
    return this.reportsOwnWrites(Object.fromEntries(eventIds.map((id) => [id, now])));
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
    if (!accountId) return;
    const calendarId = this.storedWatches().find((watch) => watch.id === channelId)?.calendarId;
    if (!calendarId) {
      await notifyChange(this.env, accountId);
      return;
    }
    await this.updateQueue<string>(CHANGED_CALENDARS_KEY, (queue) =>
      queue.includes(calendarId) ? queue : [...queue, calendarId],
    );
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
    if (!this.accountIdOrNull()) return;
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
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.put(FEED_ONLY_ALARM_KEY, true);
      await this.ctx.storage.setAlarm(Date.now() + this.delays().debounce);
    }
  }

  /**
   * Check the reported changes: all IDs from Graph notifications at once, or the change feed of one
   * Google calendar. Sync if they show more than our own writes. Returns false if the alarm may go
   * on with other work: nothing waited, or the check found only our own writes and so made no
   * subrequest.
   */
  private async runChangeCheck(accountId: string): Promise<boolean> {
    // Read before the first provider call: a notification during it may set the flag anew.
    const feedOnly = (await this.ctx.storage.get<boolean>(FEED_ONLY_ALARM_KEY)) ?? false;
    let delayMs = this.delays().nextRun;
    // Out of the queue before the check, so that a notification during the check queues it again.
    const notified = await this.ctx.blockConcurrencyWhile(async () => {
      const queued =
        (await this.ctx.storage.get<Record<string, number>>(NOTIFIED_EVENTS_KEY)) ?? {};
      await this.ctx.storage.delete(NOTIFIED_EVENTS_KEY);
      return queued;
    });
    if (Object.keys(notified).length > 0) {
      let echo = false;
      try {
        echo = await this.reportsOwnWrites(notified);
        if (!echo) await notifyChange(this.env, accountId);
      } catch (error) {
        console.error("Requesting a sync after a change failed", error);
      }
      // Notifications about a large run arrive for seconds; other work must not wait for a gap.
      // The work sets its own next alarm.
      if (echo && (await this.hasSyncWork(feedOnly))) return false;
    } else {
      const checked = await this.checkChangeFeed(accountId);
      if (checked === null) return false;
      delayMs = checked;
    }
    // Other work waits for the next alarm, so that this one stays within its budget.
    const otherWork = await this.hasSyncWork(feedOnly);
    const left =
      ((await this.ctx.storage.get<string[]>(CHANGED_CALENDARS_KEY)) ?? []).length > 0 ||
      (await this.ctx.storage.get(NOTIFIED_EVENTS_KEY)) !== undefined;
    if (otherWork) await this.setSyncAlarm(Date.now() + delayMs);
    else if (left) await this.ctx.storage.setAlarm(Date.now() + delayMs);
    else await this.ctx.storage.delete(FEED_ONLY_ALARM_KEY);
    return true;
  }

  /** True if sync work waits: a full cycle, rules, removals, or the account's retirement. */
  private async hasSyncWork(feedOnly: boolean): Promise<boolean> {
    return (
      !feedOnly ||
      ((await this.ctx.storage.get<string[]>(RULE_QUEUE_KEY)) ?? []).length > 0 ||
      ((await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) ?? []).length > 0 ||
      ((await this.ctx.storage.get<boolean>(RETIRING_KEY)) ?? false)
    );
  }

  /**
   * Read the change feed of one reported Google calendar, and sync if it shows more than our own
   * writes. Returns the delay for the next alarm, or null if no calendar waits. A throttled read
   * waits for `Retry-After`; any other failed read syncs, so that no change is lost.
   */
  private async checkChangeFeed(accountId: string): Promise<number | null> {
    let calendarId: string | undefined;
    // Out of the queue before the read, so that a notification during the read queues it again.
    await this.updateQueue<string>(CHANGED_CALENDARS_KEY, ([first, ...others]) => {
      calendarId = first;
      return others;
    });
    if (calendarId === undefined) return null;
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
        const retry = calendarId;
        await this.updateQueue<string>(CHANGED_CALENDARS_KEY, (queue) =>
          queue.includes(retry) ? queue : [retry, ...queue],
        );
        throttled = true;
        delayMs = throttleDelay;
      } else {
        console.error("Reading the change feed failed", calendarId, error);
      }
    }
    if (!throttled) {
      try {
        const ids = feed?.ids ?? null;
        const echo = ids !== null && (ids.length === 0 || (await this.isOwnEcho(ids)));
        if (!echo) await notifyChange(this.env, accountId);
        // Only once the sync is requested. After a failure, the next read returns these changes
        // again; the calendar does not stay queued, so that the failure blocks no other work.
        if (feed) await this.ctx.storage.put(tokenKey, feed.syncToken);
      } catch (error) {
        console.error("Requesting a sync after a change failed", calendarId, error);
      }
    }
    return delayMs;
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
    // Other accounts skip rules from this one while the flag is set.
    await this.env.DB.prepare("UPDATE accounts SET needs_reconnect = 0 WHERE id = ?")
      .bind(this.accountId())
      .run();
    await this.requestSync();
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

  /** Set the D1 flag and send the alert of a pause, each once. */
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
    if (pause.alertPending) {
      await sendReconnectAlert(this.env, this.providerOrDefault());
      await this.updatePause(since, (current) => ({ ...current, alertPending: false }));
    }
  }

  /** The alarm's and the tick's work while paused: finish the pause, and probe once a day. */
  private async whilePaused(accountId: string, pause: Pause): Promise<void> {
    await this.finishPause(accountId, pause.since);
    if (Date.now() >= pause.probeAt) await this.probe(pause.since);
  }

  /**
   * Try the refused token again. Some refusals end by themselves, such as a user who was disabled
   * for a while. If the provider accepts it, the pause ends and a sync starts.
   */
  private async probe(since: number): Promise<void> {
    // The next probe waits a day, also if this one fails or the instance goes away during it.
    const next = Date.now() + PROBE_EVERY_MS;
    if (!(await this.updatePause(since, (current) => ({ ...current, probeAt: next })))) return;
    const stored = await this.readTokens();
    try {
      await this.refresh(stored.accountId, stored.provider, stored.tokens.refreshToken);
    } catch (error) {
      console.error("Token probe failed", errorCode(error));
      return;
    }
    await this.unpause();
  }

  async hasTokens(): Promise<boolean> {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM tokens`).toArray().length > 0;
  }

  /** Delete tokens and subscriptions, and cancel a pending sync. */
  async forget(): Promise<void> {
    // Stop the provider's notifications while the tokens still work. Best effort: watches end
    // on their own within days.
    try {
      const client = await this.client();
      for (const watch of this.storedWatches()) {
        await client.unwatch(watch).catch((error: unknown) => {
          console.error("Stopping a watch failed", watch.id, error);
        });
      }
    } catch (error) {
      console.error("Stopping watches failed", error);
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // The instance can live on after deleteAll(); give it empty tables again.
    this.migrate();
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
    try {
      return await this.executeRule(ruleId, options);
    } catch (error) {
      // Record failed real runs whether the alarm or a user started them; previews stay silent.
      if (!options.dryRun) await this.auditFailure(ruleId, this.accountIdOrNull() ?? "", error);
      throw error;
    }
  }

  private async executeRule(ruleId: string, options: { dryRun?: boolean }): Promise<RunResult> {
    const startedAt = Date.now();
    const rule = await loadRule(this.env.DB, ruleId);
    if (!rule) throw new Error(`Rule ${ruleId} not found`);
    if (rule.target.accountId !== this.accountId()) {
      throw new Error("A rule runs in the instance of its target account");
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
        : await accountSync(this.env, rule.source.accountId).readSourceEvents(
            rule.source.remoteCalendarId,
            window,
            withBody,
          );

    const target = await this.client();
    const ruleTag = await ruleTagFor(rule.id);
    // Rules with a smaller tag into the same calendar take precedence: where they already block
    // an event, this rule writes no second block for it.
    const siblingTags = await Promise.all(
      (await siblingRuleIds(this.env.DB, rule.id)).map((id) => ruleTagFor(id)),
    );
    const precedingTags = siblingTags.filter((tag) => tag < ruleTag);
    const blocks = await target.existingBlocks(rule.target.remoteCalendarId, window, [
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
    const plan = planSync(desired, existing);

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
      // Continue soon; the next run plans again from the calendars, so nothing is lost.
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

  /**
   * Delete the blocks one rule wrote into a calendar of this account, before the rule or an account
   * goes away. Returns how many are left if the limit per invocation was reached.
   */
  async removeRuleBlocks(
    ruleId: string,
    remoteCalendarId: string,
  ): Promise<{ removed: number; remaining: number; throttled: boolean }> {
    const target = await this.client();
    const ruleTag = await ruleTagFor(ruleId);
    const blocks = await target.existingBlocks(remoteCalendarId, cleanupWindow(), [ruleTag]);
    const actions = blocks.map((block) => ({
      kind: "delete" as const,
      targetId: block.targetId,
      marker: block.marker,
    }));
    let removed = 0;
    let throttled = false;
    for (const batch of chunk(actions, target.batchLimit).slice(0, MAX_BATCHES_PER_RUN)) {
      const result = await target.applyBatch(remoteCalendarId, ruleTag, batch);
      if (result.writtenIds?.length) await this.rememberWrites(result.writtenIds);
      removed += batch.length - result.failed - result.throttled;
      if (result.throttled > 0) {
        throttled = true;
        break;
      }
    }
    return { removed, remaining: actions.length - removed, throttled };
  }

  /**
   * Remove the blocks of a rule later, in an alarm. A rule's blocks carry its tag, so they can go
   * after the rule itself is gone. The editor uses this so that a click does not wait for Graph.
   */
  async queueRemoval(ruleId: string, remoteCalendarId: string): Promise<void> {
    const job = { ruleId, remoteCalendarId, attempts: 0 };
    await this.updateQueue<Removal>(REMOVAL_QUEUE_KEY, (queue) =>
      queue.some((queued) => sameRemoval(queued, job)) ? queue : [...queue, job],
    );
    const pending = await this.ctx.storage.getAlarm();
    const soon = Date.now() + this.delays().nextRun;
    if (pending === null || pending > soon) await this.setSyncAlarm(soon);
  }

  /**
   * The account is going: remove the queued blocks first, then stop the watches and forget the
   * tokens. The removals need the tokens, so the account cannot go at once.
   */
  async retire(): Promise<void> {
    await this.ctx.storage.put(RETIRING_KEY, true);
    const pending = await this.ctx.storage.getAlarm();
    const soon = Date.now() + this.delays().nextRun;
    if (pending === null || pending > soon) await this.setSyncAlarm(soon);
  }

  /** Run one queued removal. Returns false if there was none. */
  private async runRemoval(): Promise<boolean> {
    const queue = (await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) ?? [];
    const [job] = queue;
    if (!job) return false;
    let outcome: "done" | "continue" | "retry" = "done";
    let delayMs = this.delays().nextRun;
    try {
      const result = await this.removeRuleBlocks(job.ruleId, job.remoteCalendarId);
      // A run without progress and without throttling failed, for example with 403 on every
      // block. It counts as an attempt, so that the job cannot block the account's syncs forever.
      if (result.remaining > 0 && (result.removed > 0 || result.throttled)) outcome = "continue";
      else if (result.remaining > 0 && job.attempts + 1 < MAX_REMOVAL_ATTEMPTS) outcome = "retry";
    } catch (error) {
      console.error("Queued removal failed", job.ruleId, error);
      const throttleDelay = throttleDelayMs(error);
      if (throttleDelay !== null) delayMs = throttleDelay;
      if (throttleDelay !== null || job.attempts + 1 < MAX_REMOVAL_ATTEMPTS) outcome = "retry";
    }
    // Removals queued during the provider calls are in the stored queue, not in `queue`.
    await this.updateQueue<Removal>(REMOVAL_QUEUE_KEY, (current) => {
      const others = current.filter((queued) => !sameRemoval(queued, job));
      if (outcome === "continue") return [job, ...others];
      if (outcome === "retry") return [...others, { ...job, attempts: job.attempts + 1 }];
      return others;
    });
    await this.setSyncAlarm(Date.now() + delayMs);
    return true;
  }

  /**
   * Run the next rule that targets this account. Each alarm runs one rule, so that every rule gets
   * the full subrequest budget of an invocation; the alarm then schedules itself for the next one.
   * A rule with writes left stays at the front of the queue. If the provider throttled the run,
   * the next alarm waits for its `Retry-After`; the other rules target the same mailbox, so they
   * wait too.
   */
  override async alarm(): Promise<void> {
    const accountId = this.accountIdOrNull();
    if (!accountId) return;
    // Every provider call would fail. The work waits for new tokens, which start a full cycle;
    // queued removals stay. A retiring account cannot remove its blocks, so it goes now.
    const pause = await this.pause();
    if (pause) {
      if (await this.ctx.storage.get<boolean>(RETIRING_KEY)) await this.forget();
      else await this.whilePaused(accountId, pause);
      return;
    }
    // Change feeds come first, then removals, one per alarm; the rules follow once none is left.
    if (await this.runChangeCheck(accountId)) return;
    if (await this.runRemoval()) return;
    if (await this.ctx.storage.get<boolean>(RETIRING_KEY)) {
      await this.forget();
      return;
    }
    let queue = (await this.ctx.storage.get<string[]>(RULE_QUEUE_KEY)) ?? [];
    if (queue.length === 0) {
      const all = await inPrecedenceOrder(await rulesTargetingAccount(this.env.DB, accountId));
      // Stored before the run, so that the end of the run reads the whole cycle back.
      // A tick may have queued some rules meanwhile; the full cycle still runs all of them.
      queue = await this.updateQueue<string>(RULE_QUEUE_KEY, (current) =>
        inPrecedenceOrder([...new Set([...current, ...all])]),
      );
      await this.ctx.storage.put(FULL_CYCLE_KEY, Date.now());
    }
    const [ruleId] = queue;
    if (!ruleId) {
      await this.ensureWatchesSafely();
      return;
    }

    let unfinished = false;
    let removedBlocks = false;
    let delayMs = this.delays().nextRun;
    try {
      const result = await this.runRule(ruleId);
      unfinished = result.remaining > 0;
      removedBlocks = result.stats.delete > 0;
      delayMs = result.retryAfterMs ?? this.delays().nextRun;
    } catch (error) {
      // One broken rule must not stop the others; runRule has recorded the failure.
      console.error("Rule run failed", ruleId, error);
      // A throttled read is retried after the wait instead of in the next cron cycle.
      const throttleDelay = throttleDelayMs(error);
      if (throttleDelay !== null) {
        unfinished = true;
        delayMs = throttleDelay;
      }
    }

    const followers = removedBlocks ? await this.followersOf(ruleId) : [];
    // Rules queued during the run (by a tick) are in the stored queue, not in `queue`.
    const next = await this.updateQueue<string>(RULE_QUEUE_KEY, (current) => {
      const others = current.filter((id) => id !== ruleId);
      const merged = [...new Set([...(unfinished ? [ruleId] : []), ...others, ...followers])];
      return followers.length > 0 ? inPrecedenceOrder(merged) : merged;
    });
    if (next.length > 0) {
      await this.setSyncAlarm(Date.now() + delayMs);
    } else {
      // The cycle is done: check the watches once per cycle, with the rest of the budget.
      await this.ensureWatchesSafely();
    }
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
        console.error("Stopping a watch failed", watch.id, error);
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
        console.error("Watching a calendar failed", calendarId, error);
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
      console.error("Keeping watches failed", error);
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
    if (pause) throw new TokenError(pause.code, "the account needs to be connected again");
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
    // The provider accepted the token, so a flag from an older refusal is stale. No row changes
    // in the normal case.
    await this.env.DB.prepare(
      "UPDATE accounts SET needs_reconnect = 0 WHERE id = ? AND needs_reconnect = 1",
    )
      .bind(accountId)
      .run();
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
      console.error("Audit lookup failed", ruleId, lookupError);
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
