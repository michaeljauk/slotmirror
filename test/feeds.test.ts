import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSync } from "../src/account-sync";
import { hashFeedToken, tokenMatches } from "../src/feeds";
import { deleteUser, removeAccounts, setUserActive } from "../src/offboarding";
import fixture from "./fixtures/graph/calendar-view.json";
import { BASE, signIn } from "./helpers";

const REMOTE = "remote-feed";

/** A Graph event full of content that must never reach a feed. */
function secretEvent(id: string, start: string, end: string) {
  const [template] = fixture.value;
  return {
    ...template,
    id,
    type: "singleInstance",
    seriesMasterId: null,
    originalStart: null,
    subject: "Secret merger talk",
    bodyPreview: "Dial-in 555-0100",
    location: { displayName: "Room 7, Vienna" },
    attendees: [{ emailAddress: { name: "Jane Roe", address: "jane@partner.example" } }],
    organizer: { emailAddress: { name: "Max Muster", address: "max@partner.example" } },
    categories: ["Client X"],
    showAs: "busy",
    isAllDay: false,
    start: { dateTime: `${start}.0000000`, timeZone: "UTC" },
    end: { dateTime: `${end}.0000000`, timeZone: "UTC" },
  };
}

/**
 * Fake Graph: every calendarView returns one secret event, unless `respond` answers first. Counts
 * the reads.
 */
function fakeGraph(respond?: (url: string) => Response | undefined) {
  const reads: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/calendarView")) {
      reads.push(url);
      const answer = respond?.(url);
      if (answer) return answer;
      const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      return Response.json({
        value: [secretEvent("AAMkSourceEventId-001", `${day}T09:00:00`, `${day}T10:00:00`)],
      });
    }
    return new Response("unexpected", { status: 500 });
  });
  return reads;
}

/** A signed-in user of its own with one account and one calendar, with tokens. */
async function setup(prefix: string, email = `${prefix}@org.example`) {
  const { user, cookie } = await signIn(email);
  const accountId = `${prefix}-acc`;
  const calendarId = `${prefix}-cal`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(accountId, user.id, `${prefix}@example.com`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, is_default, owned) VALUES (?, ?, ?, 'Work', 1, 1)",
    ).bind(calendarId, accountId, REMOTE),
  ]);
  await env.ACCOUNT_SYNC.getByName(accountId).storeTokens(accountId, {
    refreshToken: "r",
    accessToken: "a",
    accessExpiresAt: Date.now() + 3_600_000,
  });
  return { user, cookie, accountId, calendarId };
}

async function createFeed(cookie: string, calendarIds: string[], days = "60") {
  const form = new FormData();
  for (const id of calendarIds) form.append("calendar", id);
  form.set("days", days);
  return exports.default.fetch(`${BASE}/feeds`, {
    method: "POST",
    body: form,
    headers: { cookie },
  });
}

/** The feed address on the page that shows it once. */
async function feedUrlFrom(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const match = /value="(https:\/\/[^"]+\/ics\/[^"]+\.ics)"/.exec(await response.text());
  if (!match?.[1]) throw new Error("No feed address on the page");
  return match[1];
}

function parts(url: string): { feedId: string; token: string } {
  const [, feedId = "", token = ""] = /\/ics\/([^/]+)\/([^/]+)\.ics$/.exec(url) ?? [];
  return { feedId, token };
}

/** Make the copy in D1 older than 15 minutes, so that it no longer answers a fetch by itself. */
async function ageStoredCopy(feedId: string) {
  await env.DB.prepare(
    "UPDATE feeds SET last_rendered_at = last_rendered_at - 16 * 60 * 1000 WHERE id = ?",
  )
    .bind(feedId)
    .run();
}

/** Let every Cache API lookup miss, as on an address where the cache stores nothing. */
function noCacheApi() {
  // `caches.default` hands out a new object per access; the prototype is shared.
  return vi.spyOn(Cache.prototype, "match").mockResolvedValue(undefined);
}

/** Take the account's tokens away: any read through its Durable Object now fails. */
async function dropTokens(accountId: string) {
  await runInDurableObject(env.ACCOUNT_SYNC.getByName(accountId), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM tokens");
  });
}

/** Put the account into a provider penalty, as a throttled sync run does. */
async function throttle(accountId: string, ms: number) {
  await runInDurableObject(env.ACCOUNT_SYNC.getByName(accountId), async (_instance, state) => {
    await state.storage.put("throttledUntil", Date.now() + ms);
  });
}

async function feedRow(feedId: string) {
  return env.DB.prepare("SELECT * FROM feeds WHERE id = ?")
    .bind(feedId)
    .first<Record<string, unknown>>();
}

/** Forget the account's 60-second source cache, so that only the Cache API can answer. */
async function clearSourceCache(accountId: string) {
  await runInDurableObject(env.ACCOUNT_SYNC.getByName(accountId), (instance: AccountSync) => {
    (instance as unknown as { sourceCache: Map<string, unknown> }).sourceCache.clear();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feed token", () => {
  it("stores only the SHA-256 hash and compares it", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId } = await setup("tok");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId, token } = parts(url);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare("SELECT * FROM feeds WHERE id = ?")
      .bind(feedId)
      .first<Record<string, unknown>>();
    expect(Object.values(row ?? {})).not.toContain(token);
    expect(row?.token_hash).toBe(await hashFeedToken(token));
    expect(await tokenMatches(token, String(row?.token_hash))).toBe(true);
    expect(await tokenMatches(`${token.slice(0, -1)}x`, String(row?.token_hash))).toBe(false);
    expect(reads).toHaveLength(0);
  });

  it("answers 404 for a wrong token, an unknown feed and a malformed address", async () => {
    fakeGraph();
    const { cookie, calendarId } = await setup("wrong");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId, token } = parts(url);
    const wrong = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    for (const path of [
      `/ics/${feedId}/${wrong}.ics`,
      `/ics/${crypto.randomUUID()}/${token}.ics`,
      `/ics/${feedId}/${token}`,
      `/ics/${feedId}/short.ics`,
    ]) {
      const response = await exports.default.fetch(`${BASE}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text()).toBe("Not found");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect((await exports.default.fetch(url)).status).toBe(200);
  });

  it("stops the old address at once when the user renews it", async () => {
    fakeGraph();
    const { cookie, calendarId } = await setup("rot");
    const oldUrl = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    // Cached under the old token.
    expect((await exports.default.fetch(oldUrl)).status).toBe(200);
    const { feedId } = parts(oldUrl);
    const newUrl = await feedUrlFrom(
      await exports.default.fetch(`${BASE}/feeds/${feedId}/rotate`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(newUrl).not.toBe(oldUrl);
    expect(parts(newUrl).feedId).toBe(feedId);
    expect((await exports.default.fetch(oldUrl)).status).toBe(404);
    expect((await exports.default.fetch(newUrl)).status).toBe(200);
  });

  it("stops the address when the user deletes the feed", async () => {
    fakeGraph();
    const { cookie, calendarId } = await setup("del");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    expect((await exports.default.fetch(url)).status).toBe(200);
    const response = await exports.default.fetch(`${BASE}/feeds/${parts(url).feedId}/delete`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect((await exports.default.fetch(url)).status).toBe(404);
  });
});

describe("feed content", () => {
  it("serves busy times as ICS without any content of the event", async () => {
    fakeGraph();
    const { cookie, calendarId } = await setup("content");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, max-age=900");
    expect(response.headers.get("set-cookie")).toBeNull();
    const ics = await response.text();
    expect(ics).toContain("BEGIN:VEVENT\r\n");
    expect(ics).toContain("\r\nSUMMARY:Busy\r\nCLASS:PRIVATE\r\nTRANSP:OPAQUE\r\n");
    for (const secret of [
      "Secret",
      "merger",
      "Dial-in",
      "Room 7",
      "Vienna",
      "Jane",
      "jane@partner.example",
      "Max Muster",
      "max@partner.example",
      "Client X",
      "AAMkSourceEventId",
      "content@example.com",
    ]) {
      expect(ics, secret).not.toContain(secret);
    }
  });

  it("uses the language the user had when creating the feed", async () => {
    fakeGraph();
    const { cookie, calendarId } = await setup("lang");
    const form = new FormData();
    form.set("calendar", calendarId);
    form.set("days", "30");
    const page = await exports.default.fetch(`${BASE}/feeds?lang=de`, {
      method: "POST",
      body: form,
      headers: { cookie },
    });
    const ics = await (await exports.default.fetch(await feedUrlFrom(page))).text();
    expect(ics).toContain("\r\nSUMMARY:Belegt\r\n");
  });

  it("answers 503 without reading while an account needs a new connection", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("reconnect");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
      .bind(accountId)
      .run();
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(reads).toHaveLength(0);
  });
});

describe("feed authorization", () => {
  it("refuses another user's calendar", async () => {
    fakeGraph();
    const owner = await setup("auth-owner");
    const other = await setup("auth-other");
    const response = await createFeed(owner.cookie, [owner.calendarId, other.calendarId]);
    expect(response.status).toBe(404);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM feeds WHERE user_id = ?")
      .bind(owner.user.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("refuses more than five calendars and an empty choice", async () => {
    fakeGraph();
    const { cookie, user } = await setup("limit");
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(`limit-cal-${i}`);
      await env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, owned) VALUES (?, 'limit-acc', ?, 'C', 1)",
      )
        .bind(`limit-cal-${i}`, `remote-${i}`)
        .run();
    }
    expect((await createFeed(cookie, ids)).status).toBe(400);
    expect((await createFeed(cookie, [])).status).toBe(400);
    expect((await createFeed(cookie, ids.slice(0, 1), "181")).status).toBe(400);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM feeds WHERE user_id = ?")
      .bind(user.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("lets nobody rotate, delete or change another user's feed", async () => {
    fakeGraph();
    const owner = await setup("foreign-owner");
    const other = await setup("foreign-other");
    const url = await feedUrlFrom(await createFeed(owner.cookie, [owner.calendarId]));
    const { feedId } = parts(url);
    for (const action of ["rotate", "delete", `calendars/${owner.calendarId}/remove`]) {
      const response = await exports.default.fetch(`${BASE}/feeds/${feedId}/${action}`, {
        method: "POST",
        headers: { cookie: other.cookie },
      });
      expect(response.status).toBe(404);
    }
    expect((await exports.default.fetch(url)).status).toBe(200);
  });

  it("deletes the feeds of a deactivated user, so that a reactivation does not revive them", async () => {
    fakeGraph();
    const { cookie, calendarId, user } = await setup("deact");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    expect((await exports.default.fetch(url)).status).toBe(200);
    await setUserActive(env, user, false, "scim");
    expect(await feedRow(parts(url).feedId)).toBeNull();
    expect((await exports.default.fetch(url)).status).toBe(404);
    await setUserActive(env, user, true, "scim");
    expect((await exports.default.fetch(url)).status).toBe(404);
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'feed_deleted'",
    )
      .bind(user.id)
      .first<{ detail: string }>();
    expect(JSON.parse(audit?.detail ?? "{}")).toMatchObject({ by: "user_deactivated" });
  });

  it("deletes the feeds of a user the access policy no longer admits, at their next fetch", async () => {
    fakeGraph();
    const { cookie, calendarId, user } = await setup("removed");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    // The address leaves the policy, as after a removal from ALLOWED_DOMAINS.
    await env.DB.prepare("UPDATE users SET email = 'removed@not-allowed.example' WHERE id = ?")
      .bind(user.id)
      .run();
    expect((await exports.default.fetch(url)).status).toBe(404);
    expect(await feedRow(parts(url).feedId)).toBeNull();
  });

  it("refuses a calendar that someone else shared with the user, and does not offer it", async () => {
    fakeGraph();
    const { cookie, accountId, user } = await setup("shared");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, owned) VALUES ('shared-colleague', ?, 'remote-colleague', 'Colleague', 0)",
    )
      .bind(accountId)
      .run();
    expect((await createFeed(cookie, ["shared-colleague"])).status).toBe(404);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM feeds WHERE user_id = ?")
      .bind(user.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
    const html = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(html).toContain('value="shared-cal"');
    expect(html).not.toContain('value="shared-colleague"');
  });

  it("leaves out a calendar that is no longer owned when the feed is fetched", async () => {
    fakeGraph();
    const { cookie, calendarId } = await setup("unowned");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    await env.DB.prepare("UPDATE calendars SET owned = 0 WHERE id = ?").bind(calendarId).run();
    expect((await exports.default.fetch(url)).status).toBe(404);
  });

  it("drops a calendar whose account moved to another user", async () => {
    fakeGraph();
    const { cookie, calendarId, accountId } = await setup("moved");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const other = await signIn("moved-other@org.example");
    await env.DB.prepare("UPDATE accounts SET user_id = ? WHERE id = ?")
      .bind(other.user.id, accountId)
      .run();
    expect((await exports.default.fetch(url)).status).toBe(404);
  });
});

describe("feed cache", () => {
  it("answers a fetch within 15 minutes from the copy in D1, without the Durable Object", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("stored");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const first = await (await exports.default.fetch(url)).text();
    expect(reads).toHaveLength(1);
    expect((await feedRow(parts(url).feedId))?.last_body).toBe(first);
    // Without tokens, any read through the Durable Object fails, and the Cache API misses.
    await dropTokens(accountId);
    await clearSourceCache(accountId);
    const match = noCacheApi();
    const second = await exports.default.fetch(url);
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(await second.text()).toBe(first);
    expect(match).not.toHaveBeenCalled();
    expect(reads).toHaveLength(1);
    // Once the copy is older than 15 minutes, the fetch reads again.
    await ageStoredCopy(parts(url).feedId);
    expect((await exports.default.fetch(url)).status).toBe(503);
  });

  it("serves a repeated fetch from the Cache API once the copy in D1 is old", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("cache");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const first = await (await exports.default.fetch(url)).text();
    expect(reads).toHaveLength(1);
    await clearSourceCache(accountId);
    await ageStoredCopy(parts(url).feedId);
    const second = await exports.default.fetch(url);
    expect(second.headers.get("cache-control")).toBe("private, max-age=900");
    expect(second.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(await second.text()).toBe(first);
    expect(reads).toHaveLength(1);
  });

  it("reads again once the calendar set changes", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId, user } = await setup("cache-set");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, owned) VALUES ('cache-set-cal-2', ?, 'remote-feed-2', 'Team', 1)",
    )
      .bind(accountId)
      .run();
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId, "cache-set-cal-2"]));
    await exports.default.fetch(url);
    expect(reads).toHaveLength(2);
    await clearSourceCache(accountId);
    noCacheApi();
    // The second calendar leaves the account's registry, e.g. after the user lost access to it.
    await env.DB.prepare("DELETE FROM calendars WHERE id = 'cache-set-cal-2'").run();
    await exports.default.fetch(url);
    expect(reads).toHaveLength(3);
    expect(user.id).toBeTruthy();
  });
});

describe("feed and provider limits", () => {
  it("answers 503 with the remaining wait while the account is throttled and no copy exists", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("penalty");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    await throttle(accountId, 90_000);
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const wait = Number(response.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(80);
    expect(wait).toBeLessThanOrEqual(90);
    expect(reads).toHaveLength(0);
  });

  it("serves the last copy, however old, while the account is throttled", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("stale");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const first = await (await exports.default.fetch(url)).text();
    await clearSourceCache(accountId);
    await ageStoredCopy(parts(url).feedId);
    await ageStoredCopy(parts(url).feedId);
    noCacheApi();
    await throttle(accountId, 60_000);
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(first);
    expect(reads).toHaveLength(1);
  });

  it("does not extend a penalty that a feed read ran into", async () => {
    const reads = fakeGraph(
      () =>
        new Response(JSON.stringify({ error: { code: "ApplicationThrottled" } }), {
          status: 429,
          headers: { "retry-after": "120" },
        }),
    );
    const { cookie, calendarId, accountId } = await setup("extend");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    noCacheApi();
    const first = await exports.default.fetch(url);
    expect(first.status).toBe(503);
    expect(Number(first.headers.get("retry-after"))).toBeGreaterThan(100);
    expect(reads).toHaveLength(1);
    await clearSourceCache(accountId);
    expect((await exports.default.fetch(url)).status).toBe(503);
    expect(reads).toHaveLength(1);
  });

  it("marks a calendar the account can no longer read, and lets the user remove it", async () => {
    fakeGraph((url) =>
      url.includes("remote-gone")
        ? Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 })
        : undefined,
    );
    const { cookie, calendarId, accountId } = await setup("gone-cal");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, owned) VALUES ('gone-cal-2', ?, 'remote-gone', 'Old project', 1)",
    )
      .bind(accountId)
      .run();
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId, "gone-cal-2"]));
    const { feedId } = parts(url);
    // Subscribers get no partial feed.
    expect((await exports.default.fetch(url)).status).toBe(503);
    expect((await feedRow(feedId))?.error_calendar_id).toBe("gone-cal-2");
    const html = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(html).toContain("“Old project” cannot be read any more");
    expect(html).toContain(`/feeds/${feedId}/calendars/gone-cal-2/remove`);

    const removed = await exports.default.fetch(
      `${BASE}/feeds/${feedId}/calendars/gone-cal-2/remove`,
      { method: "POST", headers: { cookie }, redirect: "manual" },
    );
    expect(removed.status).toBe(302);
    expect((await feedRow(feedId))?.error_calendar_id).toBeNull();
    await clearSourceCache(accountId);
    expect((await exports.default.fetch(url)).status).toBe(200);
  });

  it("shows on the start page where a cut feed ends", async () => {
    fakeGraph();
    const { cookie, calendarId } = await setup("cut");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    await env.DB.prepare("UPDATE feeds SET cut_at = '2026-12-01T09:00:00.000Z' WHERE id = ?")
      .bind(parts(url).feedId)
      .run();
    const html = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(html).toContain("Too many busy times: the feed ends before Dec 1, 2026");
  });
});

describe("feed lifecycle", () => {
  it("creates both tables with cascading foreign keys", async () => {
    const columns = async (table: string) =>
      (await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map(
        (row) => row.name,
      );
    expect(await columns("feeds")).toEqual(
      expect.arrayContaining([
        "id",
        "user_id",
        "token_hash",
        "days_ahead",
        "created_at",
        "rotated_at",
      ]),
    );
    expect(await columns("feed_calendars")).toEqual(["feed_id", "calendar_id"]);
    const keys = async (table: string) =>
      (
        await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{
          table: string;
          on_delete: string;
        }>()
      ).results.map((row) => `${row.table}:${row.on_delete}`);
    expect(await keys("feeds")).toEqual(["users:CASCADE"]);
    expect((await keys("feed_calendars")).sort()).toEqual(["calendars:CASCADE", "feeds:CASCADE"]);
  });

  it("deletes a feed whose last calendar went with a disconnected account", async () => {
    fakeGraph();
    const { cookie, calendarId, accountId, user } = await setup("disc");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    await removeAccounts(env, user, [accountId]);
    expect(
      await env.DB.prepare("SELECT 1 FROM feeds WHERE id = ?").bind(feedId).first(),
    ).toBeNull();
    expect((await exports.default.fetch(url)).status).toBe(404);
  });

  it("keeps a feed that still has a calendar of another account", async () => {
    fakeGraph();
    const first = await setup("keep-a");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('keep-b-acc', ?, 'google', 'keep-b@example.com')",
      ).bind(first.user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, owned) VALUES ('keep-b-cal', 'keep-b-acc', 'remote-b', 'B', 1)",
      ),
    ]);
    const url = await feedUrlFrom(await createFeed(first.cookie, [first.calendarId, "keep-b-cal"]));
    await removeAccounts(env, first.user, ["keep-b-acc"]);
    const { results } = await env.DB.prepare(
      "SELECT calendar_id FROM feed_calendars WHERE feed_id = ?",
    )
      .bind(parts(url).feedId)
      .all<{ calendar_id: string }>();
    expect(results.map((row) => row.calendar_id)).toEqual([first.calendarId]);
    expect((await exports.default.fetch(url)).status).toBe(200);
  });

  it("deletes the user's feeds with the user", async () => {
    fakeGraph();
    const { cookie, calendarId, user } = await setup("gone");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    await deleteUser(env, user, "self");
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM feeds WHERE user_id = ?")
      .bind(user.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await exports.default.fetch(url)).status).toBe(404);
  });

  it("records creation, renewal and deletion with IDs only, never the token", async () => {
    fakeGraph();
    const { cookie, calendarId, user } = await setup("audit");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId, token } = parts(url);
    const renewed = await feedUrlFrom(
      await exports.default.fetch(`${BASE}/feeds/${feedId}/rotate`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    await exports.default.fetch(`${BASE}/feeds/${feedId}/delete`, {
      method: "POST",
      headers: { cookie },
    });
    await exports.default.fetch(url);
    const { results } = await env.DB.prepare(
      "SELECT kind, detail FROM audit_events WHERE user_id = ? AND kind LIKE 'feed_%' ORDER BY id",
    )
      .bind(user.id)
      .all<{ kind: string; detail: string }>();
    expect(results.map((row) => row.kind)).toEqual([
      "feed_created",
      "feed_rotated",
      "feed_deleted",
    ]);
    for (const row of results) {
      expect(JSON.parse(row.detail)).toMatchObject({ feedId });
      expect(row.detail).not.toContain(token);
      expect(row.detail).not.toContain(parts(renewed).token);
    }
  });

  it("shows the feeds on the start page without their address", async () => {
    fakeGraph();
    const { cookie, calendarId } = await setup("page");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const html = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(html).toContain("Free/busy feed");
    expect(html).toContain(`/feeds/${parts(url).feedId}/rotate`);
    expect(html).not.toContain(parts(url).token);
  });
});
