import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, signIn } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A signed-in user with one calendar. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accountId = `${prefix}-acc`;
  const calendarId = `${prefix}-cal`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(accountId, user.id, `${prefix}@example.com`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, is_default) VALUES (?, ?, 'remote', 'Work', 1)",
    ).bind(calendarId, accountId),
  ]);
  await env.ACCOUNT_SYNC.getByName(accountId).storeTokens(accountId, {
    refreshToken: "r",
    accessToken: "a",
    accessExpiresAt: Date.now() + 3_600_000,
  });
  return { cookie, accountId, calendarId };
}

describe("the referrer policy", () => {
  it("leaves the default policy on other pages", async () => {
    const { cookie } = await setup("headers-home");
    const page = await exports.default.fetch(`${BASE}/`, { headers: { cookie } });
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
  });
});

describe("posts from another site", () => {
  it("are refused on every account and editor route", async () => {
    const { cookie, accountId, calendarId } = await setup("headers-post");
    const paths = [
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
        headers: { cookie, "sec-fetch-site": "cross-site" },
      });
      expect(response.status, path).toBe(403);
    }
  });
});
