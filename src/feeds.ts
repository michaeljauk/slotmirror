import { errorCode, recordAudit } from "./audit";
import type { FeedRead } from "./account-sync";
import { accessPolicySchema, DEFAULT_ORG_ID, policyAdmitsAnyone } from "./access";
import { ruleOptionsSchema, setupStatus } from "./config";
import { accountSync } from "./durable";
import { i18nFor, isLocale, LOCALES, type Locale } from "./i18n";
import { renderBusyCalendar, type BusyEvent } from "./ics";
import { base64url } from "./session";
import { isIncluded } from "./sync/plan";
import type { SourceEvent } from "./sync/types";
import { admittedUser, type CurrentUser } from "./users";

/**
 * Private free/busy feeds. A feed is a secret ICS address that shows the busy times of calendars
 * its user chose, as events with a fixed title and nothing else. People outside the deployment
 * subscribe to it in their calendar app.
 *
 * The address holds a random token. D1 stores only its SHA-256 hash, so a database dump does not
 * give access. Each fetch checks the token, the user and the calendars again before it reads.
 */

export const FEED_DEFAULT_DAYS = 60;
export const FEED_MAX_DAYS = 180;
/** Days before today in the feed, so that a subscriber also sees the past week. */
export const FEED_DAYS_BEHIND = 7;
export const MAX_FEED_CALENDARS = 5;
export const MAX_FEEDS_PER_USER = 10;
/**
 * Busy blocks per feed, after merging. Keeps a fetch inside the 10 ms CPU of the Free plan. Above
 * it, past blocks go first, then the end of the window.
 */
export const MAX_FEED_EVENTS = 1000;
/**
 * How long a rendered feed is reused, from the copy in D1 or from the Cache API, and how often apps
 * should fetch it.
 */
export const FEED_CACHE_SECONDS = 15 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The same busy semantics as a rule with default options: skip free, declined and all-day. */
const DEFAULT_OPTIONS = ruleOptionsSchema.parse({});

/** 32 bytes from `crypto.getRandomValues`, base64url: 43 characters, 256 bits. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FEED_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Compared with the token of a request for an unknown feed, so that both refusals do the same. */
const UNKNOWN_FEED_HASH = "0".repeat(64);

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function sha256(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Hex SHA-256 of a feed token, as `feeds.token_hash` stores it. */
export async function hashFeedToken(token: string): Promise<string> {
  return toHex(await sha256(token));
}

/** True if the token hashes to the stored hash. The comparison takes the same time either way. */
export async function tokenMatches(token: string, storedHash: string): Promise<boolean> {
  const presented = await sha256(token);
  const stored = fromHex(storedHash);
  if (stored.length !== presented.length) return false;
  return crypto.subtle.timingSafeEqual(presented, stored);
}

function newToken(): string {
  return base64url(randomBytes(32));
}

/** The secret address of a feed. */
export function feedUrl(base: string, feedId: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/ics/${feedId}/${token}.ics`;
}

/** From the start of the current UTC day minus 7 days to `daysAhead` days after it. */
export function feedWindow(daysAhead: number, now = new Date()): { start: Date; end: Date } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: new Date(today - FEED_DAYS_BEHIND * DAY_MS),
    end: new Date(today + daysAhead * DAY_MS),
  };
}

export interface FeedSummary {
  id: string;
  createdAt: string;
  rotatedAt: string | null;
  daysAhead: number;
  includeAllDay: boolean;
  calendars: { id: string; name: string; accountEmail: string }[];
  /** Set if the last fetch ended early because of the block cap: the first block left out. */
  cutAt: string | null;
  /** A calendar of the feed that the provider no longer lets the account read. */
  errorCalendar: { id: string; name: string } | null;
}

/** The feeds of a user with their calendars, for the start page. */
export async function listFeeds(db: D1Database, userId: string): Promise<FeedSummary[]> {
  const [feeds, calendars] = await db.batch([
    db
      .prepare(
        `SELECT id, created_at AS createdAt, rotated_at AS rotatedAt, days_ahead AS daysAhead,
                include_all_day AS includeAllDay, cut_at AS cutAt,
                error_calendar_id AS errorCalendarId
         FROM feeds WHERE user_id = ? ORDER BY created_at, id`,
      )
      .bind(userId),
    db
      .prepare(
        `SELECT fc.feed_id AS feedId, c.id, c.name, a.email AS accountEmail
         FROM feeds f
         JOIN feed_calendars fc ON fc.feed_id = f.id
         JOIN calendars c ON c.id = fc.calendar_id
         JOIN accounts a ON a.id = c.account_id
         WHERE f.user_id = ? AND a.user_id = f.user_id
         ORDER BY a.email, c.name`,
      )
      .bind(userId),
  ]);
  const calendarRows = (calendars?.results ?? []) as {
    feedId: string;
    id: string;
    name: string;
    accountEmail: string;
  }[];
  const feedRows = (feeds?.results ?? []) as (Omit<
    FeedSummary,
    "includeAllDay" | "calendars" | "errorCalendar"
  > & { includeAllDay: number; errorCalendarId: string | null })[];
  return feedRows.map(({ errorCalendarId, ...row }) => {
    const own = calendarRows
      .filter((calendar) => calendar.feedId === row.id)
      .map(({ id, name, accountEmail }) => ({ id, name, accountEmail }));
    const failed = own.find((calendar) => calendar.id === errorCalendarId);
    return {
      ...row,
      includeAllDay: row.includeAllDay === 1,
      calendars: own,
      errorCalendar: failed ? { id: failed.id, name: failed.name } : null,
    };
  });
}

export interface FeedInput {
  calendarIds: string[];
  daysAhead: number;
  includeAllDay: boolean;
}

export type CreateFeedResult =
  | { ok: true; feedId: string; token: string }
  | { ok: false; reason: "no_calendar" | "too_many_calendars" | "too_many_feeds" | "not_owned" };

/**
 * Calendars that may go into a feed: those the user's accounts own. A calendar someone else
 * shared with the user is not theirs to publish.
 */
const OWN_CALENDAR = `calendars c JOIN accounts a ON a.id = c.account_id
  WHERE a.user_id = ? AND c.owned = 1`;

/** Create a feed over calendars the user owns. The token is returned only here. */
export async function createFeed(
  env: Env,
  user: CurrentUser,
  input: FeedInput,
  locale: Locale,
): Promise<CreateFeedResult> {
  const calendarIds = [...new Set(input.calendarIds)];
  if (calendarIds.length === 0) return { ok: false, reason: "no_calendar" };
  if (calendarIds.length > MAX_FEED_CALENDARS) return { ok: false, reason: "too_many_calendars" };
  const marks = calendarIds.map(() => "?").join(", ");
  const owned = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${OWN_CALENDAR} AND c.id IN (${marks})`,
  )
    .bind(user.id, ...calendarIds)
    .first<{ n: number }>();
  if ((owned?.n ?? 0) !== calendarIds.length) return { ok: false, reason: "not_owned" };
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM feeds WHERE user_id = ?")
    .bind(user.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_FEEDS_PER_USER) return { ok: false, reason: "too_many_feeds" };

  const feedId = crypto.randomUUID();
  const token = newToken();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feeds (id, user_id, token_hash, uid_salt, days_ahead, include_all_day, locale)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      feedId,
      user.id,
      await hashFeedToken(token),
      toHex(randomBytes(32)),
      input.daysAhead,
      input.includeAllDay ? 1 : 0,
      locale,
    ),
    // The calendar must still be the user's own when the row is written.
    ...calendarIds.map((calendarId) =>
      env.DB.prepare(
        `INSERT INTO feed_calendars (feed_id, calendar_id)
         SELECT ?, c.id FROM ${OWN_CALENDAR} AND c.id = ?`,
      ).bind(feedId, user.id, calendarId),
    ),
  ]);
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: "feed_created",
    detail: { feedId, calendars: calendarIds.length, daysAhead: input.daysAhead },
  });
  return { ok: true, feedId, token };
}

/** Give a feed of the user a new token. The old address stops working at once. */
export async function rotateFeed(
  env: Env,
  user: CurrentUser,
  feedId: string,
): Promise<{ feedId: string; token: string } | null> {
  const token = newToken();
  const updated = await env.DB.prepare(
    `UPDATE feeds SET token_hash = ?, rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND user_id = ?`,
  )
    .bind(await hashFeedToken(token), feedId, user.id)
    .run();
  if (updated.meta.changes === 0) return null;
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: "feed_rotated",
    detail: { feedId },
  });
  return { feedId, token };
}

/**
 * Take a calendar out of a feed of the user, for example one the account can no longer read. A
 * feed without calendars goes. Returns false if the user has no such feed and calendar.
 */
export async function removeFeedCalendar(
  env: Env,
  user: CurrentUser,
  feedId: string,
  calendarId: string,
): Promise<boolean> {
  const removed = await env.DB.prepare(
    `DELETE FROM feed_calendars WHERE feed_id = ? AND calendar_id = ?
       AND feed_id IN (SELECT id FROM feeds WHERE user_id = ?)`,
  )
    .bind(feedId, calendarId, user.id)
    .run();
  if (removed.meta.changes === 0) return false;
  // The next fetch reads again instead of answering from the stored failure.
  await env.DB.prepare(
    `UPDATE feeds SET error_calendar_id = NULL, error_until = NULL
     WHERE id = ? AND user_id = ? AND error_calendar_id = ?`,
  )
    .bind(feedId, user.id, calendarId)
    .run();
  await deleteEmptyFeeds(env, user, "calendar_removed");
  return true;
}

/**
 * Why a feed went: its user deleted it, its last calendar left with an account or by the user's
 * choice, or its user was deactivated or is no longer admitted by the access policy.
 */
type FeedDeletedBy =
  | "self"
  | "account_removed"
  | "calendar_removed"
  | "user_deactivated"
  | "user_not_admitted";

/** Delete a feed of the user. Returns false if the user has no such feed. */
export async function deleteFeed(
  env: Env,
  user: { id: string; orgId: string },
  feedId: string,
  by: FeedDeletedBy = "self",
): Promise<boolean> {
  const deleted = await env.DB.prepare("DELETE FROM feeds WHERE id = ? AND user_id = ?")
    .bind(feedId, user.id)
    .run();
  if (deleted.meta.changes === 0) return false;
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: "feed_deleted",
    detail: { feedId, by },
  });
  return true;
}

/**
 * Delete every feed of a user who lost access. A feed is a standing grant to people outside the
 * deployment, so it ends with the access; a reactivation does not bring it back.
 */
export async function revokeFeeds(
  env: Env,
  user: { id: string; orgId: string },
  by: "user_deactivated" | "user_not_admitted",
): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM feeds WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string }>();
  for (const { id } of results) await deleteFeed(env, user, id, by);
}

/**
 * Delete the user's feeds that have no calendar left, after accounts went. An empty feed would
 * tell subscribers that the user is always free; without the feed, their app reports an error.
 */
export async function deleteEmptyFeeds(
  env: Env,
  user: { id: string; orgId: string },
  by: "account_removed" | "calendar_removed" = "account_removed",
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT f.id FROM feeds f
     WHERE f.user_id = ? AND NOT EXISTS (SELECT 1 FROM feed_calendars fc WHERE fc.feed_id = f.id)`,
  )
    .bind(user.id)
    .all<{ id: string }>();
  for (const { id } of results) await deleteFeed(env, user, id, by);
}

interface FeedCalendar {
  id: string;
  accountId: string;
  remoteId: string;
  needsReconnect: number;
  /** 0 once the account no longer owns the calendar, e.g. after it was handed over. */
  owned: number;
}

/** Everything a fetch needs, in one D1 read: feed, user, policy, calendars and the last copy. */
interface FeedRow {
  id: string;
  userId: string;
  tokenHash: string;
  uidSalt: string;
  daysAhead: number;
  includeAllDay: number;
  locale: string;
  lastBody: string | null;
  lastRenderedAt: number | null;
  lastKey: string | null;
  errorCalendarId: string | null;
  errorUntil: number | null;
  orgId: string;
  email: string;
  tenantId: string | null;
  active: number;
  policy: string;
  /** JSON array of FeedCalendar: the chosen calendars of the user's accounts. */
  calendars: string;
}

const FEED_SELECT = `
  SELECT f.id, f.user_id AS userId, f.token_hash AS tokenHash, f.uid_salt AS uidSalt,
         f.days_ahead AS daysAhead, f.include_all_day AS includeAllDay, f.locale,
         f.last_body AS lastBody, f.last_rendered_at AS lastRenderedAt, f.last_key AS lastKey,
         f.error_calendar_id AS errorCalendarId, f.error_until AS errorUntil,
         u.org_id AS orgId, u.email, u.tenant_id AS tenantId, u.active, o.policy,
         (SELECT json_group_array(json_object('id', c.id, 'accountId', c.account_id,
                                              'remoteId', c.remote_id,
                                              'needsReconnect', a.needs_reconnect,
                                              'owned', c.owned))
          FROM feed_calendars fc
          JOIN calendars c ON c.id = fc.calendar_id
          JOIN accounts a ON a.id = c.account_id
          WHERE fc.feed_id = f.id AND a.user_id = f.user_id) AS calendars
  FROM feeds f JOIN users u ON u.id = f.user_id JOIN orgs o ON o.id = u.org_id
  WHERE f.id = ?`;

const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

/** Headers of every refusal. A 404 must not be cached anywhere, so that a new feed works at once. */
function notFound(): Response {
  return new Response("Not found", { status: 404, headers: TEXT_HEADERS });
}

/** No calendar data now. Apps keep their last copy and fetch again after `Retry-After`. */
function unavailable(retryAfterMs = FEED_CACHE_SECONDS * 1000): Response {
  return new Response("Unavailable", {
    status: 503,
    headers: {
      ...TEXT_HEADERS,
      "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
    },
  });
}

const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

/** The feed for the subscriber: no shared cache may keep it, and no search engine index it. */
function forSubscriber(body: BodyInit | null): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": ICS_CONTENT_TYPE,
      "cache-control": `private, max-age=${FEED_CACHE_SECONDS}`,
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * Answer a fetch of `/ics/<feedId>/<token>.ics`.
 *
 * 1. One D1 read loads the feed, its user and policy, the calendars of the user's accounts, the
 *    last rendered copy and the last failure. Unknown feeds and wrong tokens both get a plain 404
 *    after the same hash and comparison.
 * 2. If the user is inactive or no longer admitted, their feeds are deleted: 404. If the access
 *    settings admit nobody, the setup is broken: 503, and the feeds stay.
 * 3. A failure in the last 15 minutes answers 503 again, without a read.
 * 4. A calendar the account no longer owns, or no longer can read, gives 503 and a notice on the
 *    start page: subscribers never get a partial feed.
 * 5. A copy younger than 15 minutes from the same calendars and settings answers at once. Then the
 *    Cache API, keyed by feed, token hash and calendar set.
 * 6. Otherwise each calendar is read through its account's Durable Object. While an account is
 *    throttled, the last copy answers, however old; without one, 503 with the remaining wait.
 */
export async function feedResponse(
  env: Env,
  feedId: string,
  file: string,
  origin: string,
  now = new Date(),
): Promise<Response> {
  const token = file.endsWith(".ics") ? file.slice(0, -4) : "";
  if (!FEED_ID_PATTERN.test(feedId) || !TOKEN_PATTERN.test(token)) return notFound();
  const feed = await env.DB.prepare(FEED_SELECT).bind(feedId).first<FeedRow>();
  const matches = await tokenMatches(token, feed?.tokenHash ?? UNKNOWN_FEED_HASH);
  if (!feed || !matches) return notFound();

  // The same checks as a session. Losing access ends the feed for good.
  const admitted =
    feed.active === 1 &&
    admittedUser(env, {
      id: feed.userId,
      orgId: feed.orgId,
      email: feed.email,
      tenantId: feed.tenantId,
      policy: feed.policy,
    });
  if (!admitted) {
    // A policy that admits nobody is a broken setup, e.g. a redeploy with empty ALLOWED_* values.
    // It must not delete every feed; the feeds wait until the setup is whole again.
    if (feed.active === 1 && !policyAdmitsSomeone(env, feed)) return unavailable();
    await revokeFeeds(
      env,
      { id: feed.userId, orgId: feed.orgId },
      feed.active === 1 ? "user_not_admitted" : "user_deactivated",
    );
    return notFound();
  }
  const calendars = (JSON.parse(feed.calendars) as FeedCalendar[])
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_FEED_CALENDARS);
  if (calendars.length === 0) return notFound();

  const locale: Locale = isLocale(feed.locale) ? feed.locale : LOCALES[0];
  // What the body depends on. A copy from other calendars or settings is never served.
  const renderKey = [
    calendars.map((calendar) => calendar.id).join(","),
    feed.daysAhead,
    feed.includeAllDay,
    locale,
  ].join("|");
  const sameCopy = feed.lastBody !== null && feed.lastKey === renderKey;
  // A failed read answers from the row for 15 minutes, so that failures cost no reads either.
  if ((feed.errorUntil ?? 0) > now.getTime()) {
    return unavailable((feed.errorUntil ?? 0) - now.getTime());
  }
  /** Store a failure; `calendarId` names a calendar for the start page. Then answer 503. */
  const failed = async (calendarId: string | null) => {
    const until = now.getTime() + FEED_CACHE_SECONDS * 1000;
    await env.DB.prepare(
      "UPDATE feeds SET error_until = ?, error_calendar_id = COALESCE(?, error_calendar_id) WHERE id = ?",
    )
      .bind(until, calendarId, feed.id)
      .run();
    return unavailable(until - now.getTime());
  };
  // A calendar the account no longer owns is not the user's to publish, and a feed without it
  // would be partial.
  const unowned = calendars.find((calendar) => calendar.owned !== 1);
  if (unowned) return failed(unowned.id);
  if (sameCopy && now.getTime() - (feed.lastRenderedAt ?? 0) < FEED_CACHE_SECONDS * 1000) {
    return forSubscriber(feed.lastBody);
  }

  const cacheKey = new Request(
    `${origin}/ics-cache/${feed.id}/${feed.tokenHash}?${new URLSearchParams({ key: renderKey }).toString()}`,
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey).catch(() => undefined);
  if (cached) return forSubscriber(cached.body);

  // Without its tokens the account cannot be read; every attempt would only ask the provider again.
  if (calendars.some((calendar) => calendar.needsReconnect)) return unavailable();

  const window = feedWindow(feed.daysAhead, now);
  const reads: { calendarId: string; events: SourceEvent[] }[] = [];
  for (const calendar of calendars) {
    let read: FeedRead;
    try {
      // One after another: two calendars of one account share its mailbox's request limit.
      read = await accountSync(env, calendar.accountId).readFeedEvents(calendar.remoteId, window);
    } catch (error) {
      console.error("Reading a feed calendar failed", feed.id, calendar.id, errorCode(error));
      return failed(null);
    }
    if (read.kind === "throttled") {
      // Stale is better than nothing, and no further call may extend the penalty.
      return sameCopy ? forSubscriber(feed.lastBody) : unavailable(read.retryAfterMs);
    }
    if (read.kind === "unavailable") {
      console.error("A feed calendar can no longer be read", feed.id, calendar.id, read.code);
      return failed(calendar.id);
    }
    reads.push({ calendarId: calendar.id, events: read.events });
  }

  const { t } = i18nFor(locale);
  const today = new Date(window.start.getTime() + FEED_DAYS_BEHIND * DAY_MS);
  const blocks = await busyEvents(reads, {
    includeAllDay: feed.includeAllDay === 1,
    uidSalt: feed.uidSalt,
    today,
  });
  const body = renderBusyCalendar({
    name: t.feeds.calendarName,
    summary: t.feeds.eventTitle,
    refreshMinutes: FEED_CACHE_SECONDS / 60,
    events: blocks.events,
    now,
  });
  await env.DB.prepare(
    `UPDATE feeds SET last_body = ?, last_rendered_at = ?, last_key = ?, cut_at = ?,
            error_calendar_id = NULL, error_until = NULL
     WHERE id = ?`,
  )
    .bind(body, now.getTime(), renderKey, blocks.cutAt, feed.id)
    .run();
  try {
    await cache.put(
      cacheKey,
      new Response(body, {
        headers: {
          "content-type": ICS_CONTENT_TYPE,
          "cache-control": `max-age=${FEED_CACHE_SECONDS}`,
        },
      }),
    );
  } catch (error) {
    console.error("Caching a feed failed", feed.id, errorCode(error));
  }
  return forSubscriber(body);
}

/**
 * True if the access settings of the feed user's org admit anyone. If not, the setup is broken,
 * not the user removed.
 */
function policyAdmitsSomeone(env: Env, feed: { orgId: string; policy: string }): boolean {
  if (!setupStatus(env).ready) return false;
  if (feed.orgId === DEFAULT_ORG_ID) return true;
  try {
    return policyAdmitsAnyone(accessPolicySchema.parse(JSON.parse(feed.policy)));
  } catch {
    return false;
  }
}

interface Block {
  allDay: boolean;
  /** Unix ms, or the UTC midnight of an all-day date. */
  start: number;
  end: number;
}

/** Merge overlapping and adjacent intervals. Expects them sorted by start. */
function merge(sorted: Block[]): Block[] {
  const merged: Block[] = [];
  for (const block of sorted) {
    const last = merged.at(-1);
    if (last && block.start <= last.end) last.end = Math.max(last.end, block.end);
    else merged.push({ ...block });
  }
  return merged;
}

/**
 * The busy blocks of the read calendars: events that block time, merged where they overlap or
 * touch, without any content. All-day events form their own blocks. A UID is an HMAC of the
 * block's kind, start and end with the feed's salt: stable while the block stays, different in
 * every feed, and with no link to the events inside it. A moved meeting is a new block.
 *
 * Above MAX_FEED_EVENTS blocks, past blocks go first, those that ended earliest first; a block
 * that runs into today is not past. Then the latest blocks go. `cutAt` is then the start of the
 * first block left out at the end, or null if the end is complete.
 */
export async function busyEvents(
  reads: { calendarId: string; events: SourceEvent[] }[],
  feed: { includeAllDay: boolean; uidSalt: string; today: Date },
): Promise<{ events: BusyEvent[]; cutAt: string | null }> {
  const options = { ...DEFAULT_OPTIONS, skipAllDay: !feed.includeAllDay };
  const timed: Block[] = [];
  const allDay: Block[] = [];
  for (const { events } of reads) {
    for (const event of events) {
      if (!isIncluded(event, options)) continue;
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
      (event.allDay ? allDay : timed).push({ allDay: event.allDay, start, end });
    }
  }
  const byStart = (a: Block, b: Block) => a.start - b.start || a.end - b.end;
  let blocks = [...merge(timed.sort(byStart)), ...merge(allDay.sort(byStart))].sort(
    (a, b) => byStart(a, b) || Number(a.allDay) - Number(b.allDay),
  );

  let cutAt: string | null = null;
  const overflow = blocks.length - MAX_FEED_EVENTS;
  if (overflow > 0) {
    // Past blocks go first, those that ended earliest first. A block that runs into today, such
    // as a multi-day absence, is not past.
    const today = feed.today.getTime();
    const dropped = new Set(
      blocks
        .filter((block) => block.end <= today)
        .sort((a, b) => a.end - b.end)
        .slice(0, overflow),
    );
    blocks = blocks.filter((block) => !dropped.has(block));
    // Then the end of the window, at a block boundary.
    if (blocks.length > MAX_FEED_EVENTS) {
      const first = blocks[MAX_FEED_EVENTS];
      if (first) cutAt = new Date(first.start).toISOString();
      blocks = blocks.slice(0, MAX_FEED_EVENTS);
    }
  }

  const hmac = await crypto.subtle.importKey(
    "raw",
    fromHex(feed.uidSalt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoder = new TextEncoder();
  const events: BusyEvent[] = [];
  for (const block of blocks) {
    const start = block.allDay
      ? new Date(block.start).toISOString().slice(0, 10)
      : new Date(block.start).toISOString();
    const end = block.allDay
      ? new Date(block.end).toISOString().slice(0, 10)
      : new Date(block.end).toISOString();
    const key = `${block.allDay ? "date" : "time"}|${start}|${end}`;
    const mac = await crypto.subtle.sign("HMAC", hmac, encoder.encode(key));
    events.push({
      uid: `${toHex(new Uint8Array(mac).slice(0, 16))}@slotmirror`,
      start,
      end,
      allDay: block.allDay,
    });
  }
  return { events, cutAt };
}
