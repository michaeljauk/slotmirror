import { DurableObject } from "cloudflare:workers";
import { accountOwner, errorCode, recordAudit, type SyncRunDetail } from "./audit";
import type { Provider } from "./config";
import {
  calendarClient,
  oneCallAtATime,
  type CalendarClient,
  type CalendarInfo,
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
import { webhookToken, webhookUrl } from "./webhooks";

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
    const lastFull = (await this.ctx.storage.get<number>(FULL_CYCLE_KEY)) ?? 0;
    if (Date.now() - lastFull >= FULL_CYCLE_EVERY_MS) {
      await this.requestSync();
      return;
    }
    const now = Date.now();
    const { results } = await this.env.DB.prepare(
      `SELECT r.id FROM rules r
       JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN calendars tc ON tc.id = r.target_calendar_id
       JOIN users u ON u.id = r.user_id
       WHERE tc.account_id = ? AND r.enabled = 1 AND u.active = 1
         AND (sc.watched_until IS NULL OR sc.watched_until < ?
              OR tc.watched_until IS NULL OR tc.watched_until < ?)
       ORDER BY r.id`,
    )
      .bind(accountId, now, now)
      .all<{ id: string }>();
    if (results.length === 0) return;
    const queue = (await this.ctx.storage.get<string[]>(RULE_QUEUE_KEY)) ?? [];
    const merged = await inPrecedenceOrder([
      ...new Set([...queue, ...results.map((row) => row.id)]),
    ]);
    await this.ctx.storage.put(RULE_QUEUE_KEY, merged);
    this.sourceCache.clear();
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + this.delays().debounce);
    }
  }

  /**
   * True if every event ID belongs to a block this instance wrote in the last two minutes: the
   * notification reports our own write, and a sync would find nothing to do.
   */
  async isOwnEcho(eventIds: string[]): Promise<boolean> {
    if (eventIds.length === 0) return false;
    const recent = await this.recentWrites();
    return eventIds.every((id) => recent[id] !== undefined);
  }

  private async recentWrites(): Promise<Record<string, number>> {
    const stored = (await this.ctx.storage.get<Record<string, number>>(RECENT_WRITES_KEY)) ?? {};
    const cutoff = Date.now() - RECENT_WRITE_MS;
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

  /** Replace the stored tokens. Called after an OAuth connect and after every refresh. */
  async storeTokens(
    accountId: string,
    tokens: StoredTokens,
    provider: Provider = "microsoft",
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
      await this.ctx.storage.setAlarm(Date.now() + (retryAfterMs ?? this.delays().nextRun));
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
  ): Promise<{ removed: number; remaining: number }> {
    const target = await this.client();
    const ruleTag = await ruleTagFor(ruleId);
    const blocks = await target.existingBlocks(remoteCalendarId, cleanupWindow(), [ruleTag]);
    const actions = blocks.map((block) => ({
      kind: "delete" as const,
      targetId: block.targetId,
      marker: block.marker,
    }));
    let removed = 0;
    for (const batch of chunk(actions, target.batchLimit).slice(0, MAX_BATCHES_PER_RUN)) {
      const result = await target.applyBatch(remoteCalendarId, ruleTag, batch);
      removed += batch.length - result.failed - result.throttled;
      if (result.throttled > 0) break;
    }
    return { removed, remaining: actions.length - removed };
  }

  /**
   * Remove the blocks of a rule later, in an alarm. A rule's blocks carry its tag, so they can go
   * after the rule itself is gone. The editor uses this so that a click does not wait for Graph.
   */
  async queueRemoval(ruleId: string, remoteCalendarId: string): Promise<void> {
    const queue = (await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) ?? [];
    if (!queue.some((job) => job.ruleId === ruleId && job.remoteCalendarId === remoteCalendarId)) {
      queue.push({ ruleId, remoteCalendarId, attempts: 0 });
      await this.ctx.storage.put(REMOVAL_QUEUE_KEY, queue);
    }
    const pending = await this.ctx.storage.getAlarm();
    const soon = Date.now() + this.delays().nextRun;
    if (pending === null || pending > soon) await this.ctx.storage.setAlarm(soon);
  }

  /**
   * The account is going: remove the queued blocks first, then stop the watches and forget the
   * tokens. The removals need the tokens, so the account cannot go at once.
   */
  async retire(): Promise<void> {
    await this.ctx.storage.put(RETIRING_KEY, true);
    const pending = await this.ctx.storage.getAlarm();
    const soon = Date.now() + this.delays().nextRun;
    if (pending === null || pending > soon) await this.ctx.storage.setAlarm(soon);
  }

  /** Run one queued removal. Returns false if there was none. */
  private async runRemoval(): Promise<boolean> {
    const queue = (await this.ctx.storage.get<Removal[]>(REMOVAL_QUEUE_KEY)) ?? [];
    const [job, ...rest] = queue;
    if (!job) return false;
    let next = rest;
    let delayMs = this.delays().nextRun;
    try {
      const { remaining } = await this.removeRuleBlocks(job.ruleId, job.remoteCalendarId);
      if (remaining > 0) next = [job, ...rest];
    } catch (error) {
      console.error("Queued removal failed", job.ruleId, error);
      const throttleDelay = throttleDelayMs(error);
      if (throttleDelay !== null) delayMs = throttleDelay;
      if (throttleDelay !== null || job.attempts + 1 < MAX_REMOVAL_ATTEMPTS) {
        next = [...rest, { ...job, attempts: job.attempts + 1 }];
      }
    }
    if (next.length > 0) await this.ctx.storage.put(REMOVAL_QUEUE_KEY, next);
    else await this.ctx.storage.delete(REMOVAL_QUEUE_KEY);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
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
    // Removals come first, one per alarm; the rules follow once none is left.
    if (await this.runRemoval()) return;
    if (await this.ctx.storage.get<boolean>(RETIRING_KEY)) {
      await this.forget();
      return;
    }
    let queue = (await this.ctx.storage.get<string[]>(RULE_QUEUE_KEY)) ?? [];
    if (queue.length === 0) {
      queue = await inPrecedenceOrder(await rulesTargetingAccount(this.env.DB, accountId));
      await this.ctx.storage.put(FULL_CYCLE_KEY, Date.now());
    }
    const [ruleId, ...rest] = queue;
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

    let next = unfinished ? [ruleId, ...rest] : rest;
    if (removedBlocks) next = await this.withFollowers(ruleId, next);
    if (next.length > 0) {
      await this.ctx.storage.put(RULE_QUEUE_KEY, next);
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
    } else {
      await this.ctx.storage.delete(RULE_QUEUE_KEY);
      // The cycle is done: check the watches once per cycle, with the rest of the budget.
      await this.ensureWatchesSafely();
    }
  }

  /**
   * Add the rules that come after a rule into the same calendar to the queue. They may have left
   * out events whose blocks the rule just removed, and must now write their own.
   */
  private async withFollowers(ruleId: string, queue: string[]): Promise<string[]> {
    const tag = await ruleTagFor(ruleId);
    const followers: string[] = [];
    for (const id of await siblingRuleIds(this.env.DB, ruleId)) {
      if ((await ruleTagFor(id)) > tag) followers.push(id);
    }
    if (followers.length === 0) return queue;
    return inPrecedenceOrder([...new Set([...queue, ...followers])]);
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
        await this.env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
          .bind(accountId)
          .run();
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
    await this.storeTokens(
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
