import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, signIn } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A signed-in user with one calendar that a feed may show. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accountId = `${prefix}-acc`;
  const calendarId = `${prefix}-cal`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(accountId, user.id, `${prefix}@example.com`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, is_default, data_owned) VALUES (?, ?, 'remote', 'Work', 1, 1)",
    ).bind(calendarId, accountId),
  ]);
  await env.ACCOUNT_SYNC.getByName(accountId).storeTokens(accountId, {
    refreshToken: "r",
    accessToken: "a",
    accessExpiresAt: Date.now() + 3_600_000,
  });
  return { cookie, accountId, calendarId };
}

function feedForm(calendarId: string): FormData {
  const form = new FormData();
  form.append("calendar", calendarId);
  form.set("days", "60");
  return form;
}

const feedCount = async (calendarId: string) => {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM feed_calendars WHERE calendar_id = ?")
    .bind(calendarId)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

describe("feed responses", () => {
  it("keeps the strict referrer policy and the other headers", async () => {
    const { cookie, calendarId } = await setup("headers-feed");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ value: [] }));

    const page = await exports.default.fetch(`${BASE}/feeds`, {
      method: "POST",
      body: feedForm(calendarId),
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const address = /value="https:\/\/[^"]+(\/ics\/[^"]+\.ics)"/.exec(await page.text())?.[1];
    if (!address) throw new Error("No feed address on the page");

    const feed = await exports.default.fetch(`${BASE}${address}`);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("referrer-policy")).toBe("no-referrer");
    expect(feed.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("leaves the default policy on other pages", async () => {
    const { cookie } = await setup("headers-home");
    const page = await exports.default.fetch(`${BASE}/`, { headers: { cookie } });
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
  });
});

describe("posts from another site", () => {
  it("are refused on every feed, account and editor route", async () => {
    const { cookie, accountId, calendarId } = await setup("headers-post");
    const paths = [
      "/feeds",
      "/feeds/some-feed/rotate",
      "/feeds/some-feed/delete",
      `/feeds/some-feed/calendars/${calendarId}/remove`,
      `/accounts/${accountId}/settings`,
      `/accounts/${accountId}/name`,
      `/rules/source-calendar/${calendarId}`,
      `/rules/group/${accountId}`,
      "/rules/group/all",
      "/rules/direction",
      "/rules/direction/details",
      "/rules/direction/reset",
      "/rules/direction/check",
      "/rules/source/buffer",
      "/rules/choices",
      "/rules/settings",
    ];
    for (const path of paths) {
      const response = await exports.default.fetch(`${BASE}${path}`, {
        method: "POST",
        body: feedForm(calendarId),
        headers: { cookie, "sec-fetch-site": "cross-site" },
      });
      expect(response.status, path).toBe(403);
    }
    expect(await feedCount(calendarId)).toBe(0);
  });
});
