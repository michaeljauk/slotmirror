import { errorCode, recordAudit } from "./audit";
import { ruleOptionsSchema } from "./config";
import { accountSync } from "./durable";
import { i18nFor, isLocale, LOCALES, type Locale } from "./i18n";
import { renderBusyCalendar, type BusyEvent } from "./ics";
import { base64url } from "./session";
import { isIncluded } from "./sync/plan";
import type { SourceEvent } from "./sync/types";
import { loadUser, type CurrentUser } from "./users";

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
/** Events per feed, nearest first. Keeps a fetch inside the 10 ms CPU of the Free plan. */
export const MAX_FEED_EVENTS = 1000;
/** How long a rendered feed is reused, and how often apps should fetch it. */
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
}

/** The feeds of a user with their calendars, for the start page. */
export async function listFeeds(db: D1Database, userId: string): Promise<FeedSummary[]> {
  const [feeds, calendars] = await db.batch([
    db
      .prepare(
        `SELECT id, created_at AS createdAt, rotated_at AS rotatedAt, days_ahead AS daysAhead,
                include_all_day AS includeAllDay
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
  const feedRows = (feeds?.results ?? []) as (Omit<FeedSummary, "includeAllDay" | "calendars"> & {
    includeAllDay: number;
  })[];
  return feedRows.map((row) => ({
    ...row,
    includeAllDay: row.includeAllDay === 1,
    calendars: calendarRows
      .filter((calendar) => calendar.feedId === row.id)
      .map(({ id, name, accountEmail }) => ({ id, name, accountEmail })),
  }));
}

export interface FeedInput {
  calendarIds: string[];
  daysAhead: number;
  includeAllDay: boolean;
}

export type CreateFeedResult =
  | { ok: true; feedId: string; token: string }
  | { ok: false; reason: "no_calendar" | "too_many_calendars" | "too_many_feeds" | "not_owned" };

/** Create a feed over calendars of the user's own accounts. The token is returned only here. */
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
    `SELECT COUNT(*) AS n FROM calendars c JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? AND c.id IN (${marks})`,
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
    // The calendar must still belong to the user when the row is written.
    ...calendarIds.map((calendarId) =>
      env.DB.prepare(
        `INSERT INTO feed_calendars (feed_id, calendar_id)
         SELECT ?, c.id FROM calendars c JOIN accounts a ON a.id = c.account_id
         WHERE c.id = ? AND a.user_id = ?`,
      ).bind(feedId, calendarId, user.id),
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

/** Why a feed went: its user deleted it, or its last calendar left with an account. */
type FeedDeletedBy = "self" | "account_removed";

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
 * Delete the user's feeds that have no calendar left, after accounts went. An empty feed would
 * tell subscribers that the user is always free; without the feed, their app reports an error.
 */
export async function deleteEmptyFeeds(
  env: Env,
  user: { id: string; orgId: string },
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT f.id FROM feeds f
     WHERE f.user_id = ? AND NOT EXISTS (SELECT 1 FROM feed_calendars fc WHERE fc.feed_id = f.id)`,
  )
    .bind(user.id)
    .all<{ id: string }>();
  for (const { id } of results) await deleteFeed(env, user, id, "account_removed");
}

interface FeedRow {
  id: string;
  userId: string;
  tokenHash: string;
  uidSalt: string;
  daysAhead: number;
  includeAllDay: number;
  locale: string;
}

interface FeedCalendar {
  id: string;
  accountId: string;
  remoteId: string;
  needsReconnect: number;
}

/** Headers of every refusal. A 404 must not be cached anywhere, so that a new feed works at once. */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** A calendar could not be read. Apps keep their last copy and fetch again later. */
function unavailable(): Response {
  return new Response("Unavailable", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": String(FEED_CACHE_SECONDS),
    },
  });
}

const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

/** Headers for the subscriber: no shared cache may keep a feed, and no search engine index it. */
function forSubscriber(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-type", ICS_CONTENT_TYPE);
  headers.set("cache-control", `private, max-age=${FEED_CACHE_SECONDS}`);
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, { status: 200, headers });
}

/**
 * Answer a fetch of `/ics/<feedId>/<token>.ics`. Unknown feeds and wrong tokens both get a plain
 * 404 after the same lookup, hash and comparison. A valid token still yields 404 if the user is
 * inactive or no longer admitted, or if no chosen calendar belongs to the user any more.
 *
 * The rendered feed is cached for 15 minutes under the feed, the token hash and the calendar set,
 * so that a rotated token or a disconnected account never gets a cached answer. Events are read
 * through each account's Durable Object, where provider calls run one at a time.
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
  const feed = await env.DB.prepare(
    `SELECT id, user_id AS userId, token_hash AS tokenHash, uid_salt AS uidSalt,
            days_ahead AS daysAhead, include_all_day AS includeAllDay, locale
     FROM feeds WHERE id = ?`,
  )
    .bind(feedId)
    .first<FeedRow>();
  const matches = await tokenMatches(token, feed?.tokenHash ?? UNKNOWN_FEED_HASH);
  if (!feed || !matches) return notFound();

  // The same checks as a session: a deactivated or removed user shares nothing.
  if (!(await loadUser(env, feed.userId))) return notFound();
  const { results: calendars } = await env.DB.prepare(
    `SELECT c.id, c.account_id AS accountId, c.remote_id AS remoteId,
            a.needs_reconnect AS needsReconnect
     FROM feed_calendars fc
     JOIN calendars c ON c.id = fc.calendar_id
     JOIN accounts a ON a.id = c.account_id
     WHERE fc.feed_id = ? AND a.user_id = ?
     ORDER BY c.id
     LIMIT ?`,
  )
    .bind(feed.id, feed.userId, MAX_FEED_CALENDARS)
    .all<FeedCalendar>();
  if (calendars.length === 0) return notFound();
  // Without its tokens the account cannot be read; every attempt would only ask the provider again.
  if (calendars.some((calendar) => calendar.needsReconnect)) return unavailable();

  const locale: Locale = isLocale(feed.locale) ? feed.locale : LOCALES[0];
  const key = new URL(`${origin}/ics-cache/${feed.id}/${feed.tokenHash}`);
  key.searchParams.set("calendars", calendars.map((calendar) => calendar.id).join(","));
  key.searchParams.set("days", String(feed.daysAhead));
  key.searchParams.set("allDay", String(feed.includeAllDay));
  key.searchParams.set("locale", locale);
  const cacheKey = new Request(key.toString());
  const cache = caches.default;
  const cached = await cache.match(cacheKey).catch(() => undefined);
  if (cached) return forSubscriber(cached);

  const window = feedWindow(feed.daysAhead, now);
  const reads: { calendarId: string; events: SourceEvent[] }[] = [];
  for (const calendar of calendars) {
    try {
      // One after another: two calendars of one account share its mailbox's request limit.
      const events = await accountSync(env, calendar.accountId).readSourceEvents(
        calendar.remoteId,
        window,
        false,
      );
      reads.push({ calendarId: calendar.id, events });
    } catch (error) {
      console.error("Reading a feed calendar failed", feed.id, calendar.id, errorCode(error));
      return unavailable();
    }
  }

  const { t } = i18nFor(locale);
  const body = renderBusyCalendar({
    name: t.feeds.calendarName,
    summary: t.feeds.eventTitle,
    refreshMinutes: FEED_CACHE_SECONDS / 60,
    events: await busyEvents(reads, {
      includeAllDay: feed.includeAllDay === 1,
      uidSalt: feed.uidSalt,
    }),
    now,
  });
  const response = new Response(body, {
    headers: {
      "content-type": ICS_CONTENT_TYPE,
      "cache-control": `max-age=${FEED_CACHE_SECONDS}`,
    },
  });
  try {
    await cache.put(cacheKey, response.clone());
  } catch (error) {
    console.error("Caching a feed failed", feed.id, errorCode(error));
  }
  return forSubscriber(response);
}

/**
 * The busy intervals of the read calendars: events that block time, without any content. Equal
 * intervals from several calendars appear once. At most MAX_FEED_EVENTS, nearest first.
 *
 * A UID is an HMAC of calendar and occurrence key with the feed's salt: stable across fetches, no
 * source event ID, and different in every feed.
 */
export async function busyEvents(
  reads: { calendarId: string; events: SourceEvent[] }[],
  feed: { includeAllDay: boolean; uidSalt: string },
): Promise<BusyEvent[]> {
  const options = { ...DEFAULT_OPTIONS, skipAllDay: !feed.includeAllDay };
  const byInterval = new Map<
    string,
    { key: string; start: string; end: string; allDay: boolean; at: number }
  >();
  for (const { calendarId, events } of reads) {
    for (const event of events) {
      if (!isIncluded(event, options)) continue;
      const at = Date.parse(event.start);
      if (Number.isNaN(at) || Number.isNaN(Date.parse(event.end))) continue;
      const interval = `${event.allDay ? "date" : "time"}|${event.start}|${event.end}`;
      const key = `${calendarId}\u0000${event.occurrenceKey}`;
      const current = byInterval.get(interval);
      // The smaller key wins, so that the UID of an interval does not depend on read order.
      if (!current || key < current.key) {
        byInterval.set(interval, {
          key,
          start: event.start,
          end: event.end,
          allDay: event.allDay,
          at,
        });
      }
    }
  }
  const kept = [...byInterval.values()]
    .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))
    .slice(0, MAX_FEED_EVENTS);
  const hmac = await crypto.subtle.importKey(
    "raw",
    fromHex(feed.uidSalt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoder = new TextEncoder();
  const result: BusyEvent[] = [];
  for (const event of kept) {
    const mac = await crypto.subtle.sign("HMAC", hmac, encoder.encode(event.key));
    result.push({
      uid: `${toHex(new Uint8Array(mac).slice(0, 16))}@slotmirror`,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
    });
  }
  return result;
}
