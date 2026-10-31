import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSync } from "../src/account-sync";
import { refreshUserCalendars } from "../src/calendars";
import {
  FEED_LEASE_MS,
  FEED_PARALLEL_READ_MS,
  feedResponse,
  hashFeedToken,
  MAX_FEED_EVENTS,
  tokenMatches,
} from "../src/feeds";
import { deleteUser, removeAccounts, setUserActive } from "../src/offboarding";
import { addFakeEvent } from "../src/providers/fake-calendar";
import fixture from "./fixtures/graph/calendar-view.json";
import { BASE, noFakeNetwork, signIn } from "./helpers";

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
async function setup(
  prefix: string,
  email = `${prefix}@org.example`,
  provider: "microsoft" | "google" = "microsoft",
) {
  const { user, cookie } = await signIn(email);
  const accountId = `${prefix}-acc`;
  const calendarId = `${prefix}-cal`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)").bind(
      accountId,
      user.id,
      provider,
      `${prefix}@example.com`,
    ),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, is_default, data_owned) VALUES (?, ?, ?, 'Work', 1, 1)",
    ).bind(calendarId, accountId, REMOTE),
  ]);
  await env.ACCOUNT_SYNC.getByName(accountId).storeTokens(
    accountId,
    {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    },
    provider,
  );
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

beforeEach(() => {
  noFakeNetwork();
});

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
        "INSERT INTO calendars (id, account_id, remote_id, name, data_owned) VALUES (?, 'limit-acc', ?, 'C', 1)",
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
      "INSERT INTO calendars (id, account_id, remote_id, name, data_owned) VALUES ('shared-colleague', ?, 'remote-colleague', 'Colleague', 0)",
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

  it("keeps a Google calendar with the owner role as a rule target, but not as a feed calendar", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/calendarList")) return new Response("unexpected", { status: 500 });
      return Response.json({
        items: [
          { id: "gowner@example.com", summary: "Me", accessRole: "owner", primary: true },
          {
            id: "managed@group.calendar.google.com",
            summary: "Managed",
            accessRole: "owner",
            dataOwner: "colleague@example.com",
          },
        ],
      });
    });
    const { user, cookie } = await signIn("gowner@org.example");
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES ('gowner-acc', ?, 'google', ?)",
    )
      .bind(user.id, "gowner@example.com")
      .run();
    await env.ACCOUNT_SYNC.getByName("gowner-acc").storeTokens(
      "gowner-acc",
      { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + 3_600_000 },
      "google",
    );
    await refreshUserCalendars(env, user.id);
    const ids = await env.DB.prepare(
      "SELECT remote_id AS remoteId, id, can_edit AS canEdit, data_owned AS dataOwned FROM calendars WHERE account_id = 'gowner-acc'",
    ).all<{ remoteId: string; id: string; canEdit: number; dataOwned: number }>();
    const byRemote = new Map(ids.results.map((row) => [row.remoteId, row]));
    const primary = byRemote.get("gowner@example.com");
    const managed = byRemote.get("managed@group.calendar.google.com");
    expect(managed).toMatchObject({ canEdit: 1, dataOwned: 0 });

    // As on main, the calendar is a valid rule target.
    const rule = new FormData();
    rule.set("source", primary?.id ?? "");
    rule.set("target", managed?.id ?? "");
    const created = await exports.default.fetch(`${BASE}/rules`, {
      method: "POST",
      body: rule,
      headers: { cookie },
      redirect: "manual",
    });
    expect(created.status).toBe(302);
    const rules = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM rules WHERE user_id = ? AND target_calendar_id = ?",
    )
      .bind(user.id, managed?.id ?? "")
      .first<{ n: number }>();
    expect(rules?.n).toBe(1);

    // It cannot go into a feed, and the picker does not offer it.
    expect((await createFeed(cookie, [managed?.id ?? ""])).status).toBe(404);
    const html = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(html).toContain(`value="${primary?.id ?? "-"}"`);
    expect(html).not.toContain(`value="${managed?.id ?? "-"}"`);
  });

  it("gives no partial feed once a calendar is no longer owned, and names it", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("unowned");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, data_owned) VALUES ('unowned-2', ?, 'remote-unowned-2', 'Handed over', 1)",
    )
      .bind(accountId)
      .run();
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId, "unowned-2"]));
    await env.DB.prepare("UPDATE calendars SET data_owned = 0 WHERE id = 'unowned-2'").run();
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(503);
    expect(reads).toHaveLength(0);
    expect((await feedRow(parts(url).feedId))?.error_calendar_id).toBe("unowned-2");
    const html = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(html).toContain("“Handed over” cannot be read any more");
  });

  it("keeps the feeds and answers 503 while the access settings admit nobody", async () => {
    fakeGraph();
    const { cookie, calendarId } = await setup("empty-policy");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId, token } = parts(url);
    // A redeploy with the empty ALLOWED_* values of the shipped wrangler.jsonc.
    const unset = { ...env, ALLOWED_EMAILS: "", ALLOWED_DOMAINS: "", ADMIN_EMAILS: "" };
    const response = await feedResponse(unset, feedId, `${token}.ics`, BASE);
    expect(response.status).toBe(503);
    expect(await feedRow(feedId)).not.toBeNull();
    expect((await exports.default.fetch(url)).status).toBe(200);
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
      "INSERT INTO calendars (id, account_id, remote_id, name, data_owned) VALUES ('cache-set-cal-2', ?, 'remote-feed-2', 'Team', 1)",
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
  it("answers a failing feed from the row for 15 minutes: five fetches, one provider call", async () => {
    const reads = fakeGraph(() =>
      Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 }),
    );
    const { cookie, calendarId, accountId } = await setup("negative");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    noCacheApi();
    for (let i = 0; i < 5; i++) {
      await clearSourceCache(accountId);
      const response = await exports.default.fetch(url);
      expect(response.status).toBe(503);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(reads).toHaveLength(1);
    expect((await feedRow(feedId))?.error_calendar_id).toBe(calendarId);
  });

  it("also answers other read failures from the row", async () => {
    const reads = fakeGraph(() => new Response("boom", { status: 500 }));
    const { cookie, calendarId, accountId } = await setup("negative-500");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    noCacheApi();
    for (let i = 0; i < 5; i++) {
      await clearSourceCache(accountId);
      expect((await exports.default.fetch(url)).status).toBe(503);
    }
    expect(reads).toHaveLength(1);
  });

  it("never shortens a longer penalty with a shorter one", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: "ApplicationThrottled" } }), {
          status: 429,
          headers: { "retry-after": "5" },
        }),
    );
    const { accountId } = await setup("shorter");
    await throttle(accountId, 300_000);
    const stub = env.ACCOUNT_SYNC.getByName(accountId);
    // A sync call does not wait for the penalty; its own 429 asks for 5 seconds only.
    const refused = await stub.listCalendars().then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
    const until = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<number>("throttledUntil"),
    );
    expect((until ?? 0) - Date.now()).toBeGreaterThan(250_000);
  });

  it("lets only one of two concurrent feed reads reach a throttling provider", async () => {
    const reads = fakeGraph(() => undefined);
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      reads.push(url);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify({ error: { code: "ApplicationThrottled" } }), {
        status: 429,
        headers: { "retry-after": "120" },
      });
    });
    const { cookie, calendarId } = await setup("concurrent");
    const short = await feedUrlFrom(await createFeed(cookie, [calendarId], "30"));
    const long = await feedUrlFrom(await createFeed(cookie, [calendarId], "60"));
    noCacheApi();
    const responses = await Promise.all([
      exports.default.fetch(short),
      exports.default.fetch(long),
    ]);
    expect(responses.map((response) => response.status)).toEqual([503, 503]);
    expect(reads).toHaveLength(1);
  });

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
      "INSERT INTO calendars (id, account_id, remote_id, name, data_owned) VALUES ('gone-cal-2', ?, 'remote-gone', 'Old project', 1)",
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
    expect((await feedRow(feedId))?.error_until).toBeNull();
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
        "INSERT INTO calendars (id, account_id, remote_id, name, data_owned) VALUES ('keep-b-cal', 'keep-b-acc', 'remote-b', 'B', 1)",
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

describe("feed calendar removal", () => {
  it("records the removal of the last calendar as the user's own choice", async () => {
    fakeGraph();
    const { cookie, calendarId, user } = await setup("last-cal");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    const response = await exports.default.fetch(
      `${BASE}/feeds/${feedId}/calendars/${calendarId}/remove`,
      { method: "POST", headers: { cookie }, redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(await feedRow(feedId)).toBeNull();
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'feed_deleted'",
    )
      .bind(user.id)
      .first<{ detail: string }>();
    expect(JSON.parse(audit?.detail ?? "{}")).toMatchObject({ feedId, by: "calendar_removed" });
  });
});

/** Fetch a feed through `feedResponse` at a time the test chooses. */
function fetchAt(url: string, now: Date, target: Env = env) {
  const { feedId, token } = parts(url);
  return feedResponse(target, feedId, `${token}.ics`, BASE, now);
}

/** Store a failed read, as `feedResponse` does. */
async function setErrorUntil(feedId: string, until: number, calendarId: string | null = null) {
  await env.DB.prepare("UPDATE feeds SET error_until = ?, error_calendar_id = ? WHERE id = ?")
    .bind(until, calendarId, feedId)
    .run();
}

/** Store the render lease of a fetch that still reads. */
async function setLease(feedId: string, until: number) {
  await env.DB.prepare("UPDATE feeds SET lease_until = ? WHERE id = ?").bind(until, feedId).run();
}

describe("feed render lease", () => {
  /** An env whose D1 fails the write of the rendered copy, as if the invocation ended before it. */
  function dyingRender(): Env {
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key, target) as unknown;
        return (sql: string) => {
          if (sql.includes("SET last_body")) throw new Error("render stopped");
          return target.prepare(sql);
        };
      },
    });
    return { ...env, DB: db };
  }

  /** An env whose fetch runs `before` directly before the write that `sql` names: a slow fetch. */
  function slowWrite(sql: string, before: () => Promise<unknown>): Env {
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key, target) as unknown;
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes(sql)) return statement;
          return {
            bind: (...values: unknown[]) => ({
              run: async () => {
                await before();
                return statement.bind(...values).run();
              },
            }),
          };
        };
      },
    });
    return { ...env, DB: db };
  }

  /** A fetch after the end of a lease from `now`, for which the provider no longer finds the calendar. */
  async function loseCalendarAfterLease(url: string, accountId: string, now: number) {
    fakeGraph(() => new Response("gone", { status: 404 }));
    await clearSourceCache(accountId);
    expect((await fetchAt(url, new Date(now + FEED_LEASE_MS + 1000))).status).toBe(503);
  }

  it("holds the lease during the reads and frees it after a stored render", async () => {
    let during: Record<string, unknown> | null = null;
    const { cookie, calendarId } = await setup("lease-held");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    const now = new Date();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      during = await feedRow(feedId);
      return Response.json({ value: [] });
    });
    const response = await fetchAt(url, now);
    expect(response.status).toBe(200);
    expect(during).toMatchObject({ lease_until: now.getTime() + FEED_LEASE_MS, error_until: null });
    expect((await feedRow(feedId))?.lease_until).toBeNull();
  });

  it("stores no render that outlived its lease after a calendar was lost", async () => {
    fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-outlived");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    await exports.default.fetch(url);
    await clearSourceCache(accountId);
    await ageStoredCopy(feedId);
    noCacheApi();
    const before = await feedRow(feedId);
    const now = Date.now();
    const slow = slowWrite("SET last_body", () => loseCalendarAfterLease(url, accountId, now));

    expect((await fetchAt(url, new Date(now), slow)).status).toBe(503);
    const after = await feedRow(feedId);
    expect(after).toMatchObject({
      error_calendar_id: calendarId,
      last_rendered_at: before?.last_rendered_at,
    });
    expect(after?.error_until).toBeGreaterThan(now + FEED_LEASE_MS);
    expect((await fetchAt(url, new Date(now + 2 * FEED_LEASE_MS))).status).toBe(503);
  });

  it("stores no render while a later fetch holds the lease", async () => {
    fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-taken");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    await exports.default.fetch(url);
    await clearSourceCache(accountId);
    await ageStoredCopy(feedId);
    noCacheApi();
    const before = await feedRow(feedId);
    const now = Date.now();
    const later = now + 2 * FEED_LEASE_MS;
    const slow = slowWrite("SET last_body", () => setLease(feedId, later));

    expect((await fetchAt(url, new Date(now), slow)).status).toBe(503);
    expect(await feedRow(feedId)).toMatchObject({
      lease_until: later,
      last_rendered_at: before?.last_rendered_at,
    });
  });

  it("stores nothing from a parallel fetch without the lease", async () => {
    fakeGraph();
    const { cookie, calendarId } = await setup("lease-none");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    const lease = Date.now() + FEED_LEASE_MS;
    await setLease(feedId, lease);

    expect((await exports.default.fetch(url)).status).toBe(200);
    expect(await feedRow(feedId)).toMatchObject({ lease_until: lease, last_body: null });
  });

  it("keeps a name that another fetch stored during a failed read", async () => {
    fakeGraph(() => new Response("boom", { status: 500 }));
    const { cookie, calendarId, accountId } = await setup("lease-failed-late");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    noCacheApi();
    const now = Date.now();
    const slow = slowWrite("SET error_until", () => loseCalendarAfterLease(url, accountId, now));

    expect((await fetchAt(url, new Date(now), slow)).status).toBe(503);
    expect((await feedRow(feedId))?.error_calendar_id).toBe(calendarId);
  });

  it("makes no read for the rest of the lease after a render stopped", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-dead");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const now = Date.now();
    await expect(fetchAt(url, new Date(now), dyingRender())).rejects.toThrow("render stopped");
    expect(reads).toHaveLength(1);
    await clearSourceCache(accountId);

    const during = await fetchAt(url, new Date(now + FEED_PARALLEL_READ_MS + 1000));
    expect(during.status).toBe(503);
    expect(Number(during.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(reads).toHaveLength(1);

    const after = await fetchAt(url, new Date(now + FEED_LEASE_MS + 1));
    expect(after.status).toBe(200);
    expect(reads).toHaveLength(2);
  });

  it("serves the last copy while another fetch reads, and reads once", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-copy");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const first = await (await exports.default.fetch(url)).text();
    expect(reads).toHaveLength(1);
    await clearSourceCache(accountId);
    await ageStoredCopy(parts(url).feedId);
    noCacheApi();
    await setLease(parts(url).feedId, Date.now() + FEED_LEASE_MS);
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(first);
    expect(reads).toHaveLength(1);
  });

  it("gives parallel fetches of a healthy feed no error", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-parallel");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    await exports.default.fetch(url);
    await clearSourceCache(accountId);
    await ageStoredCopy(parts(url).feedId);
    noCacheApi();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => exports.default.fetch(url)),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(reads).toHaveLength(2);
  });

  it("reads as before for a parallel fetch of a feed without a copy", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId } = await setup("lease-first");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const responses = await Promise.all([
      exports.default.fetch(url),
      exports.default.fetch(url),
      exports.default.fetch(url),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(reads.length).toBeGreaterThanOrEqual(1);
  });

  it("still answers a failed read with 503 for 14 minutes, with a copy too", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-failure");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    await exports.default.fetch(url);
    await clearSourceCache(accountId);
    await ageStoredCopy(parts(url).feedId);
    noCacheApi();
    const now = Date.now();
    await setErrorUntil(parts(url).feedId, now + 15 * 60 * 1000);
    expect((await fetchAt(url, new Date(now))).status).toBe(503);
    expect((await fetchAt(url, new Date(now + 14 * 60 * 1000))).status).toBe(503);
    expect(reads).toHaveLength(1);
  });

  it("answers 503 until the end of a failure that names no calendar", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-last-minute");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    await exports.default.fetch(url);
    await clearSourceCache(accountId);
    await ageStoredCopy(parts(url).feedId);
    noCacheApi();
    await setErrorUntil(parts(url).feedId, Date.now() + 30_000);
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(503);
    expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(30);
    expect(reads).toHaveLength(1);
  });

  it("answers 503 while a fetch reads again after a named failure", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-after-named");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    await exports.default.fetch(url);
    await clearSourceCache(accountId);
    await ageStoredCopy(feedId);
    noCacheApi();
    const now = Date.now();
    await setErrorUntil(feedId, now - 1, calendarId);
    // The render stops, so its lease stays, as for a fetch that still reads.
    await expect(fetchAt(url, new Date(now), dyingRender())).rejects.toThrow("render stopped");
    expect(reads).toHaveLength(2);
    expect((await feedRow(feedId))?.error_calendar_id).toBe(calendarId);
    const parallel = await fetchAt(url, new Date(now + 1000));
    expect(parallel.status).toBe(503);
    expect(Number(parallel.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(reads).toHaveLength(2);

    // Without the lease, the next fetch reads, and a good read ends the failure.
    await clearSourceCache(accountId);
    const after = await fetchAt(url, new Date(now + FEED_LEASE_MS + 1));
    expect(after.status).toBe(200);
    expect(reads).toHaveLength(3);
    expect(await feedRow(feedId)).toMatchObject({ error_calendar_id: null, lease_until: null });
  });

  it("gives a parallel fetch no blocks of a lost calendar while it is read again", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-lost");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    await exports.default.fetch(url);
    expect(reads).toHaveLength(1);
    await clearSourceCache(accountId);
    await ageStoredCopy(feedId);
    noCacheApi();
    fakeGraph(() => new Response("gone", { status: 404 }));
    const now = Date.now();
    expect((await fetchAt(url, new Date(now))).status).toBe(503);
    expect((await feedRow(feedId))?.error_calendar_id).toBe(calendarId);

    // The failure has run out. One fetch takes the lease, and another arrives during its read.
    const expired = now + 15 * 60 * 1000 + 1;
    let parallel: Response | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      parallel ??= await fetchAt(url, new Date(expired + 1000));
      return new Response("gone", { status: 404 });
    });
    await clearSourceCache(accountId);
    expect((await fetchAt(url, new Date(expired))).status).toBe(503);
    expect(parallel?.status).toBe(503);
    expect(await feedRow(feedId)).toMatchObject({
      error_calendar_id: calendarId,
      lease_until: null,
    });
  });

  it("keeps the name and serves no copy if the read after a named failure is throttled", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-throttled");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    await exports.default.fetch(url);
    await clearSourceCache(accountId);
    await ageStoredCopy(feedId);
    noCacheApi();
    await setErrorUntil(feedId, Date.now() - 1, calendarId);
    await throttle(accountId, 60_000);
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(503);
    expect(reads).toHaveLength(1);
    expect((await feedRow(feedId))?.error_calendar_id).toBe(calendarId);
  });

  it("reads again instead of answering from a copy from before a named failure", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-young-copy");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    await exports.default.fetch(url);
    expect(reads).toHaveLength(1);

    // Both the young copy in D1 and the Cache API would answer without a read.
    await clearSourceCache(accountId);
    await setErrorUntil(feedId, Date.now() - 1, calendarId);
    expect((await exports.default.fetch(url)).status).toBe(200);
    expect(reads).toHaveLength(2);

    await clearSourceCache(accountId);
    await ageStoredCopy(feedId);
    await setErrorUntil(feedId, Date.now() - 1, calendarId);
    expect((await exports.default.fetch(url)).status).toBe(200);
    expect(reads).toHaveLength(3);
  });

  it("keeps the named calendar through a later failure that names none", async () => {
    const reads = fakeGraph(() => new Response("boom", { status: 500 }));
    const { cookie, calendarId } = await setup("lease-keep-name");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    noCacheApi();
    await setErrorUntil(parts(url).feedId, Date.now() - 1, calendarId);
    expect((await exports.default.fetch(url)).status).toBe(503);
    expect(reads).toHaveLength(1);
    expect((await feedRow(parts(url).feedId))?.error_calendar_id).toBe(calendarId);
  });

  it("never serves a copy while a named calendar has failed", async () => {
    const reads = fakeGraph();
    const { cookie, calendarId, accountId } = await setup("lease-named");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    await exports.default.fetch(url);
    await clearSourceCache(accountId);
    await ageStoredCopy(parts(url).feedId);
    noCacheApi();
    await setErrorUntil(parts(url).feedId, Date.now() + 1000, calendarId);
    expect((await exports.default.fetch(url)).status).toBe(503);
    expect(reads).toHaveLength(1);
  });
});

describe("feed read limit", () => {
  const HOUR = 3_600_000;

  /** An account on the simulated provider, with `count` hourly events in the calendar "main". */
  async function fakeAccount(prefix: string, count: number) {
    const { user, cookie } = await signIn(`${prefix}@org.example`);
    const accountId = `${prefix}-acc`;
    const calendarId = `${prefix}-cal`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
      ).bind(accountId, user.id, `${prefix}@example.com`),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, is_default, data_owned) VALUES (?, ?, 'main', 'Work', 1, 1)",
      ).bind(calendarId, accountId),
    ]);
    const stub = env.ACCOUNT_SYNC.getByName(accountId);
    await stub.storeTokens(accountId, {
      refreshToken: "r",
      accessToken: "fake",
      accessExpiresAt: Date.now() + HOUR,
    });
    const from = Date.now() - (Date.now() % HOUR) + 24 * HOUR;
    await runInDurableObject(stub, (_instance, state) => {
      for (let index = 0; index < count; index++) {
        addFakeEvent(state.storage.sql, {
          id: `event-${index}`,
          start: new Date(from + index * HOUR).toISOString(),
          end: new Date(from + index * HOUR + HOUR / 2).toISOString(),
        });
      }
    });
    return { cookie, accountId, calendarId, stub, from };
  }

  it("limits the events of a calendar before they leave its account", async () => {
    const { stub, from } = await fakeAccount("limit-read", MAX_FEED_EVENTS + 5);
    const window = { start: new Date(from - HOUR), end: new Date(from + 2000 * HOUR) };
    const read = await stub.readFeedEvents("main", window, {
      includeAllDay: false,
      today: new Date(from),
    });
    if (read.kind !== "events") throw new Error(read.kind);
    expect(read.events).toHaveLength(MAX_FEED_EVENTS);
    expect(read.cutAt).toBe(new Date(from + MAX_FEED_EVENTS * HOUR).toISOString());
  });

  it("gives a comparison every event", async () => {
    const { stub, from } = await fakeAccount("limit-compare", MAX_FEED_EVENTS + 5);
    const window = { start: new Date(from - HOUR), end: new Date(from + 2000 * HOUR) };
    const read = await stub.readFeedEvents("main", window);
    if (read.kind !== "events") throw new Error(read.kind);
    expect(read.events).toHaveLength(MAX_FEED_EVENTS + 5);
  });

  it("names the place of the cut on the feed", async () => {
    const { cookie, calendarId, from } = await fakeAccount("limit-feed", MAX_FEED_EVENTS + 5);
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId], "60"));
    const response = await exports.default.fetch(url);
    expect(response.status).toBe(200);
    const blocks = (await response.text()).match(/BEGIN:VEVENT/g) ?? [];
    expect(blocks).toHaveLength(MAX_FEED_EVENTS);
    expect((await feedRow(parts(url).feedId))?.cut_at).toBe(
      new Date(from + MAX_FEED_EVENTS * HOUR).toISOString(),
    );
  });
});

describe("feed calendar ownership", () => {
  const CHECK_KEY = "feedOwnershipCheckAt";
  const DAY = 24 * 3_600_000;
  const HOUR = 3_600_000;

  interface Listed {
    id: string;
    isDefaultCalendar?: boolean;
    owner?: string;
  }

  function graphEntry(calendar: Listed) {
    return {
      id: calendar.id,
      name: "Work",
      canEdit: true,
      isDefaultCalendar: calendar.isDefaultCalendar ?? false,
      owner: { address: calendar.owner ?? "me@example.com" },
    };
  }

  /** Fake Graph: `/me`, the calendar list and calendarView. Counts the list reads. */
  function fakeList(list: (url: string) => Listed[] | Response) {
    const lists: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/calendarView")) return Response.json({ value: [] });
      if (url.includes("/me/calendars")) {
        lists.push(url);
        const answer = list(url);
        if (answer instanceof Response) return answer;
        return Response.json({ value: answer.map(graphEntry) });
      }
      if (url.includes("/me")) {
        return Response.json({ mail: "me@example.com", userPrincipalName: "me@example.com" });
      }
      return new Response("unexpected", { status: 500 });
    });
    return lists;
  }

  /** Let the daily check fall due and start the alarm that runs it. */
  async function checkDue(accountId: string) {
    const stub = env.ACCOUNT_SYNC.getByName(accountId);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(CHECK_KEY, Date.now() - 1);
    });
    await stub.requestSync();
    return stub;
  }

  function nextCheck(accountId: string) {
    return runInDurableObject(env.ACCOUNT_SYNC.getByName(accountId), (_instance, state) =>
      state.storage.get<number>(CHECK_KEY),
    );
  }

  async function dataOwned(calendarId: string) {
    const row = await env.DB.prepare("SELECT data_owned AS owned FROM calendars WHERE id = ?")
      .bind(calendarId)
      .first<{ owned: number }>();
    return row?.owned;
  }

  /** The main calendar of the account, listed as `fakeList` lists it. */
  const main: Listed = { id: "main-remote", isDefaultCalendar: true };

  it("ends the feed once the list names another owner", async () => {
    const lists = fakeList(() => [main, { id: REMOTE, owner: "colleague@example.com" }]);
    const { cookie, calendarId, accountId } = await setup("own-change");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    expect((await exports.default.fetch(url)).status).toBe(200);

    const before = Date.now();
    const stub = await checkDue(accountId);
    await runDurableObjectAlarm(stub);

    expect(lists).toHaveLength(1);
    expect(await dataOwned(calendarId)).toBe(0);
    expect(await nextCheck(accountId)).toBeGreaterThanOrEqual(before + HOUR);
    expect(await nextCheck(accountId)).toBeLessThan(before + 2 * HOUR);
    // The stored copy is young, and it still does not answer.
    expect((await exports.default.fetch(url)).status).toBe(503);
    expect((await feedRow(parts(url).feedId))?.error_calendar_id).toBe(calendarId);
  });

  it("takes an alarm of its own, and the full cycle follows in the next one", async () => {
    const lists = fakeList(() => [main, { id: REMOTE }]);
    const { cookie, calendarId, accountId } = await setup("own-step");
    await createFeed(cookie, [calendarId]);
    const stub = await checkDue(accountId);
    await runDurableObjectAlarm(stub);
    const state = () =>
      runInDurableObject(stub, async (_instance, storage) => ({
        again: await storage.storage.get("fullCycleRequested"),
        cycle: await storage.storage.get("fullCycleAt"),
        alarm: await storage.storage.getAlarm(),
      }));
    const after = await state();
    expect(lists).toHaveLength(1);
    expect(after.again).toBe(true);
    expect(after.cycle).toBeUndefined();
    expect(after.alarm).not.toBeNull();

    await runDurableObjectAlarm(stub);
    expect((await state()).cycle).toBeDefined();
    expect(lists).toHaveLength(1);
  });

  it("gives a calendar back to its feed once the list names the account again", async () => {
    fakeList(() => [main, { id: REMOTE }]);
    const { cookie, calendarId, accountId } = await setup("own-back");
    await createFeed(cookie, [calendarId]);
    await env.DB.prepare("UPDATE calendars SET data_owned = 0 WHERE id = ?").bind(calendarId).run();
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(await dataOwned(calendarId)).toBe(1);
  });

  it("changes nothing if the list cannot be read, and tries again with a later cycle", async () => {
    const lists = fakeList(() => new Response("broken", { status: 500 }));
    const { cookie, calendarId, accountId } = await setup("own-fail");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    expect((await exports.default.fetch(url)).status).toBe(200);
    const before = Date.now();
    const stub = await checkDue(accountId);
    await runDurableObjectAlarm(stub);

    expect(lists.length).toBeGreaterThan(0);
    expect(await dataOwned(calendarId)).toBe(1);
    expect(await nextCheck(accountId)).toBeGreaterThanOrEqual(before + HOUR);
    expect(await nextCheck(accountId)).toBeLessThan(before + DAY);
    expect((await exports.default.fetch(url)).status).toBe(200);
    // The cycle goes on: the next alarm does not list again.
    const count = lists.length;
    await runDurableObjectAlarm(stub);
    expect(lists).toHaveLength(count);
  });

  it("waits for Retry-After if the list is throttled", async () => {
    fakeList(
      () =>
        new Response(JSON.stringify({ error: { code: "ApplicationThrottled" } }), {
          status: 429,
          headers: { "retry-after": "120" },
        }),
    );
    const { cookie, calendarId, accountId } = await setup("own-throttled");
    await createFeed(cookie, [calendarId]);
    const before = Date.now();
    const stub = await checkDue(accountId);
    await runDurableObjectAlarm(stub);
    expect(await dataOwned(calendarId)).toBe(1);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    // The tests' SYNC_NEXT_RUN_MS is 10 minutes, so this alarm follows the provider's wait.
    expect(alarm).toBeGreaterThanOrEqual(before + 120_000);
    expect(alarm).toBeLessThan(before + 300_000);
  });

  it("makes no provider call during a provider penalty", async () => {
    const lists = fakeList(() => [main, { id: REMOTE, owner: "colleague@example.com" }]);
    const { cookie, calendarId, accountId } = await setup("own-penalty");
    await createFeed(cookie, [calendarId]);
    await throttle(accountId, 60_000);
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(lists).toHaveLength(0);
    expect(await dataOwned(calendarId)).toBe(1);
  });

  it("stops a feed whose calendar the list does not name, until the list names it", async () => {
    let listed: Listed[] = [main];
    fakeList(() => listed);
    const { cookie, calendarId, accountId } = await setup("own-absent");
    const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
    const { feedId } = parts(url);
    expect((await exports.default.fetch(url)).status).toBe(200);

    await runDurableObjectAlarm(await checkDue(accountId));
    expect(await dataOwned(calendarId)).toBe(0);
    expect(await nextCheck(accountId)).toBeLessThanOrEqual(Date.now() + HOUR);
    expect((await exports.default.fetch(url)).status).toBe(503);
    expect((await feedRow(feedId))?.error_calendar_id).toBe(calendarId);
    const html = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(html).toContain("“Work” cannot be read any more");

    listed = [main, { id: REMOTE }];
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(await dataOwned(calendarId)).toBe(1);
    noCacheApi();
    const later = await fetchAt(url, new Date(Date.now() + 16 * 60 * 1000));
    expect(later.status).toBe(200);
    expect((await feedRow(feedId))?.error_calendar_id).toBeNull();
  });

  it("checks again after an hour if a check lost a calendar, then after a day", async () => {
    let listed: Listed[] = [main];
    fakeList(() => listed);
    const { cookie, calendarId, accountId } = await setup("own-short-list");
    await createFeed(cookie, [calendarId]);
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(await dataOwned(calendarId)).toBe(0);
    expect(await nextCheck(accountId)).toBeLessThanOrEqual(Date.now() + HOUR);

    // The second short list loses nothing new, so a daily check is enough.
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(await dataOwned(calendarId)).toBe(0);
    expect(await nextCheck(accountId)).toBeGreaterThan(Date.now() + DAY - HOUR);

    // A calendar that returns is no loss either.
    listed = [main, { id: REMOTE }];
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(await dataOwned(calendarId)).toBe(1);
    expect(await nextCheck(accountId)).toBeGreaterThan(Date.now() + DAY - HOUR);
  });

  it("does not lose the owners in a refresh whose list has no owned main calendar", async () => {
    fakeList(() => [
      { ...main, owner: "colleague@example.com" },
      { id: REMOTE, owner: "colleague@example.com" },
      { id: "remote-new" },
    ]);
    const { user, calendarId, accountId } = await setup("own-refresh");
    await refreshUserCalendars(env, user.id);
    expect(await dataOwned(calendarId)).toBe(1);
    const added = await env.DB.prepare(
      "SELECT data_owned AS owned FROM calendars WHERE account_id = ? AND remote_id = 'remote-new'",
    )
      .bind(accountId)
      .first<{ owned: number }>();
    expect(added?.owned).toBe(0);
  });

  it("takes a new calendar's owner from its entry if the first page lacks the main", async () => {
    fakeList(() => [
      { id: REMOTE, owner: "colleague@example.com" },
      { id: "remote-own" },
      { id: "remote-shared", owner: "colleague@example.com" },
    ]);
    const { user, calendarId, accountId } = await setup("own-no-main");
    await refreshUserCalendars(env, user.id);
    expect(await dataOwned(calendarId)).toBe(1);
    const { results } = await env.DB.prepare(
      "SELECT remote_id AS id, data_owned AS owned FROM calendars WHERE account_id = ? AND id != ? ORDER BY remote_id",
    )
      .bind(accountId, calendarId)
      .all<{ id: string; owned: number }>();
    expect(results).toEqual([
      { id: "remote-own", owned: 1 },
      { id: "remote-shared", owned: 0 },
    ]);
  });

  it("stores the owners of a refresh whose list has the owned main calendar", async () => {
    fakeList(() => [main, { id: REMOTE, owner: "colleague@example.com" }]);
    const { user, calendarId } = await setup("own-refresh-main");
    await refreshUserCalendars(env, user.id);
    expect(await dataOwned(calendarId)).toBe(0);
  });

  it("reads every page of the list before it calls a calendar missing", async () => {
    const lists = fakeList((url) =>
      url.includes("page=2")
        ? Response.json({ value: [graphEntry({ id: REMOTE })] })
        : Response.json({
            value: [graphEntry(main)],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars?page=2",
          }),
    );
    const { cookie, calendarId, accountId } = await setup("own-pages");
    await createFeed(cookie, [calendarId]);
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(lists).toHaveLength(2);
    expect(await dataOwned(calendarId)).toBe(1);
  });

  it("changes nothing if a later page of the list fails", async () => {
    fakeList((url) =>
      url.includes("page=2")
        ? new Response("broken", { status: 500 })
        : Response.json({
            value: [graphEntry(main)],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars?page=2",
          }),
    );
    const { cookie, calendarId, accountId } = await setup("own-page-fail");
    await createFeed(cookie, [calendarId]);
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(await dataOwned(calendarId)).toBe(1);
    expect(await nextCheck(accountId)).toBeLessThan(Date.now() + DAY - HOUR);
  });

  it("leaves the list for the calendar choice at its first page", async () => {
    const lists = fakeList(() =>
      Response.json({
        value: [graphEntry(main)],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars?page=2",
      }),
    );
    const { accountId } = await setup("own-choice");
    await env.ACCOUNT_SYNC.getByName(accountId).listCalendars();
    expect(lists).toHaveLength(1);
  });

  it("does not trust a list whose main calendar has another owner", async () => {
    fakeList(() => [
      { ...main, owner: "colleague@example.com" },
      { id: REMOTE, owner: "colleague@example.com" },
    ]);
    const { cookie, calendarId, accountId } = await setup("own-other-main");
    await createFeed(cookie, [calendarId]);
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(await dataOwned(calendarId)).toBe(1);
    expect(await nextCheck(accountId)).toBeLessThan(Date.now() + DAY - HOUR);
  });

  describe("on Google", () => {
    interface GoogleEntry {
      id: string;
      primary?: boolean;
      dataOwner?: string;
      hidden?: boolean;
    }

    /**
     * Fake Google: as the API, the list leaves hidden entries out without `showHidden=true`, and
     * gives `pageSize` entries per page. Returns the addresses of the list reads.
     */
    function fakeGoogle(entries: GoogleEntry[], pageSize = entries.length) {
      const lists: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.includes("/calendarList")) return Response.json({ items: [] });
        lists.push(url);
        const shown = entries.filter((entry) => !entry.hidden || url.includes("showHidden=true"));
        const start = Number(new URL(url).searchParams.get("pageToken") ?? 0);
        const end = start + pageSize;
        return Response.json({
          items: shown
            .slice(start, end)
            .map((entry) => ({ summary: "Work", accessRole: "owner", ...entry })),
          ...(end < shown.length ? { nextPageToken: String(end) } : {}),
        });
      });
      return lists;
    }

    const primary: GoogleEntry = { id: "me@example.com", primary: true };

    it("reads the data owner of a hidden calendar", async () => {
      const lists = fakeGoogle([
        primary,
        { id: REMOTE, dataOwner: "colleague@example.com", hidden: true },
      ]);
      const { cookie, calendarId, accountId } = await setup("own-g-other", undefined, "google");
      const url = await feedUrlFrom(await createFeed(cookie, [calendarId]));
      expect((await exports.default.fetch(url)).status).toBe(200);
      await runDurableObjectAlarm(await checkDue(accountId));
      // Without `showHidden` the calendar is missing from the list, which also ends the feed.
      expect(lists).toHaveLength(1);
      expect(lists[0]).toContain("showHidden=true");
      expect(await dataOwned(calendarId)).toBe(0);
      expect((await exports.default.fetch(url)).status).toBe(503);
    });

    it("reads every page of a complete list before it calls a calendar missing", async () => {
      const lists = fakeGoogle(
        [
          primary,
          { id: "other@example.com" },
          { id: REMOTE, dataOwner: "me@example.com", hidden: true },
        ],
        1,
      );
      const { cookie, calendarId, accountId } = await setup("own-g-pages", undefined, "google");
      await createFeed(cookie, [calendarId]);
      await runDurableObjectAlarm(await checkDue(accountId));
      expect(lists).toHaveLength(3);
      for (const list of lists) expect(list).toContain("showHidden=true");
      expect(await dataOwned(calendarId)).toBe(1);
    });

    it("keeps a hidden calendar whose data owner is the account", async () => {
      fakeGoogle([primary, { id: REMOTE, dataOwner: "ME@example.com", hidden: true }]);
      const { cookie, calendarId, accountId } = await setup("own-g-mine", undefined, "google");
      await createFeed(cookie, [calendarId]);
      await runDurableObjectAlarm(await checkDue(accountId));
      expect(await dataOwned(calendarId)).toBe(1);
    });

    it("takes a secondary calendar without a data owner as not owned", async () => {
      fakeGoogle([primary, { id: REMOTE }]);
      const { cookie, calendarId, accountId } = await setup("own-g-none", undefined, "google");
      await createFeed(cookie, [calendarId]);
      await runDurableObjectAlarm(await checkDue(accountId));
      expect(await dataOwned(calendarId)).toBe(0);
    });

    it("does not trust a list without the primary calendar", async () => {
      fakeGoogle([{ id: REMOTE, dataOwner: "colleague@example.com" }]);
      const { cookie, calendarId, accountId } = await setup("own-g-partial", undefined, "google");
      await createFeed(cookie, [calendarId]);
      await runDurableObjectAlarm(await checkDue(accountId));
      expect(await dataOwned(calendarId)).toBe(1);
    });
  });

  it("does not trust a list without the main calendar", async () => {
    fakeList(() => [{ id: REMOTE, owner: "colleague@example.com" }]);
    const { cookie, calendarId, accountId } = await setup("own-partial");
    await createFeed(cookie, [calendarId]);
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(await dataOwned(calendarId)).toBe(1);
    expect(await nextCheck(accountId)).toBeLessThan(Date.now() + DAY - HOUR);
  });

  it("asks the provider nothing for an account without feeds", async () => {
    const lists = fakeList(() => [main]);
    const { accountId } = await setup("own-none");
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(lists).toHaveLength(0);
    expect(await nextCheck(accountId)).toBeGreaterThan(Date.now() + HOUR);
  });

  it("starts the first wait without a check", async () => {
    const lists = fakeList(() => [main]);
    const { cookie, calendarId, accountId } = await setup("own-first");
    await createFeed(cookie, [calendarId]);
    const stub = env.ACCOUNT_SYNC.getByName(accountId);
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(lists).toHaveLength(0);
    expect(await nextCheck(accountId)).toBeGreaterThan(Date.now() + HOUR);
  });

  it("runs through the provider queue on the simulated provider", async () => {
    const { user, cookie } = await signIn("own-fake@org.example");
    const accountId = "own-fake-acc";
    const calendarId = "own-fake-cal";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', 'f@example.com')",
      ).bind(accountId, user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, is_default, data_owned) VALUES (?, ?, 'main', 'Work', 1, 1)",
      ).bind(calendarId, accountId),
    ]);
    const stub = env.ACCOUNT_SYNC.getByName(accountId);
    await stub.storeTokens(accountId, {
      refreshToken: "r",
      accessToken: "fake",
      accessExpiresAt: Date.now() + HOUR,
    });
    await createFeed(cookie, [calendarId]);
    await env.DB.prepare("UPDATE calendars SET data_owned = 0 WHERE id = ?").bind(calendarId).run();
    await runDurableObjectAlarm(await checkDue(accountId));
    expect(await dataOwned(calendarId)).toBe(1);
    expect((await stub.fakeStats()).calls.listCalendars).toBe(1);
  });
});
