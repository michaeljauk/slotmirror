import {
  createScheduledController,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { SESSION_COOKIE, signSession } from "../src/session";
import { addAccount, BASE, signIn } from "./helpers";

describe("worker", () => {
  it("answers the health check", async () => {
    const response = await exports.default.fetch(`${BASE}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("echoes the Graph validation token as plain text", async () => {
    const response = await exports.default.fetch(
      `${BASE}/webhooks/microsoft?validationToken=abc%20123`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("abc 123");
  });

  it("shows the sign-in page without a session", async () => {
    const response = await exports.default.fetch(`${BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sign in with Microsoft 365");
    expect(html).toContain("Sign in with Google");
  });

  it("starts a sync for each connected account on cron, and skips accounts without tokens", async () => {
    const { user } = await signIn("owner@example.com");
    await addAccount(user.id, "acc-2", "other@example.com");
    await addAccount(user.id, "acc-no-tokens", "none@example.com");
    const stub = env.ACCOUNT_SYNC.getByName("acc-2");
    await stub.storeTokens("acc-2", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    await worker.scheduled(createScheduledController(), env);

    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const idle = env.ACCOUNT_SYNC.getByName("acc-no-tokens");
    expect(
      await runInDurableObject(idle, (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();
  });

  it("creates the account tables in the Durable Object", async () => {
    const stub = env.ACCOUNT_SYNC.getByName("acc-3");
    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .toArray()
        .map((row) => row.name),
    );
    expect(tables).toEqual(expect.arrayContaining(["subscriptions", "tokens"]));
  });
});

describe("users", () => {
  it("shows each user only their own accounts", async () => {
    const owner = await signIn("owner@example.com");
    const other = await signIn("other@elsewhere.org");
    await addAccount(owner.user.id, "acc-owner", "owner-calendar@example.com");
    await addAccount(other.user.id, "acc-other", "other-calendar@elsewhere.org");

    const html = await (
      await exports.default.fetch(`${BASE}/`, { headers: { cookie: owner.cookie } })
    ).text();
    expect(html).toContain("owner-calendar@example.com");
    expect(html).not.toContain("other-calendar@elsewhere.org");
  });

  it("ends access at the next request once the policy no longer admits the user", async () => {
    // A user row whose address the test bindings do not allow, e.g. after removal from ALLOWED_EMAILS.
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('default', 'Example')"),
      env.DB.prepare(
        "INSERT INTO users (id, org_id, email, role) VALUES ('removed', 'default', 'removed@example.com', 'member')",
      ),
    ]);
    const token = await signSession(
      { userId: "removed", exp: Math.floor(Date.now() / 1000) + 60 },
      env.SESSION_SECRET,
    );
    const html = await (
      await exports.default.fetch(`${BASE}/`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    ).text();
    expect(html).toContain("Sign in with Microsoft 365");
  });
});

describe("admin page", () => {
  it("is refused to members", async () => {
    const { cookie } = await signIn("owner@example.com");
    const response = await exports.default.fetch(`${BASE}/admin`, { headers: { cookie } });
    expect(response.status).toBe(403);
  });

  it("lists the users of the org with their account count for admins", async () => {
    const member = await signIn("owner@example.com");
    await addAccount(member.user.id, "acc-a", "calendar-a@example.com");
    const admin = await signIn("admin@example.com");
    expect(admin.user.role).toBe("admin");

    const response = await exports.default.fetch(`${BASE}/admin`, {
      headers: { cookie: admin.cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("owner@example.com");
    expect(html).toContain("admin@example.com");
    // Metadata only: connected calendar addresses stay private to their user.
    expect(html).not.toContain("calendar-a@example.com");
  });

  it("shows which users have accounts that need reconnecting, without the addresses", async () => {
    const member = await signIn("owner@example.com");
    await addAccount(member.user.id, "acc-admin-ok", "fine@example.com");
    await addAccount(member.user.id, "acc-admin-broken", "broken@example.com");
    const admin = await signIn("admin@example.com");
    const page = async () =>
      (await exports.default.fetch(`${BASE}/admin`, { headers: { cookie: admin.cookie } })).text();

    expect(await page()).not.toContain("need reconnecting");

    await env.DB.prepare(
      "UPDATE accounts SET needs_reconnect = 1 WHERE id = 'acc-admin-broken'",
    ).run();
    const html = await page();
    expect(html).toContain("1 user has an account that needs reconnecting.");
    const row = html.slice(html.indexOf("<td>owner@example.com</td>"));
    expect(row.slice(0, row.indexOf("</tr>"))).toContain(
      '<span class="badge error">1 needs reconnecting</span>',
    );
    const adminRow = html.slice(html.indexOf("<td>admin@example.com</td>"));
    expect(adminRow.slice(0, adminRow.indexOf("</tr>"))).not.toContain("badge error");
    expect(html).not.toContain("broken@example.com");
  });
});

describe("account actions", () => {
  it("disconnects an own account and deletes its tokens", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await addAccount(user.id, "acc-del", "delete-me@example.com");
    const stub = env.ACCOUNT_SYNC.getByName("acc-del");
    await stub.storeTokens("acc-del", { refreshToken: "r", accessToken: "a", accessExpiresAt: 0 });

    const response = await exports.default.fetch(`${BASE}/accounts/acc-del/disconnect`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE id = 'acc-del'").first()).toBeNull();
    // The account retires in its own alarm: queued removals first, then the tokens go.
    expect(await stub.hasTokens()).toBe(true);
    await runDurableObjectAlarm(stub);
    expect(await stub.hasTokens()).toBe(false);

    const event = await env.DB.prepare(
      "SELECT user_id, account_id FROM audit_events WHERE kind = 'account_disconnected'",
    ).first<{ user_id: string; account_id: string }>();
    expect(event).toEqual({ user_id: user.id, account_id: "acc-del" });
  });

  it("asks before disconnecting and names the rules that go with the account", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await addAccount(user.id, "acc-ask", "ask-me@example.com");

    const home = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(home).toContain('href="/accounts/acc-ask/disconnect"');

    const response = await exports.default.fetch(`${BASE}/accounts/acc-ask/disconnect`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Disconnect this account?");
    expect(html).toContain("ask-me@example.com");
    expect(html).toContain("No rule uses this account.");
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/accounts\/acc-ask\/disconnect"/);
    // Showing the page changes nothing.
    expect(
      await env.DB.prepare("SELECT 1 FROM accounts WHERE id = 'acc-ask'").first(),
    ).not.toBeNull();
  });

  it("does not show the disconnect page for someone else's account", async () => {
    const other = await signIn("other@elsewhere.org");
    await addAccount(other.user.id, "acc-foreign", "foreign@elsewhere.org");
    const { cookie } = await signIn("owner@example.com");
    const response = await exports.default.fetch(`${BASE}/accounts/acc-foreign/disconnect`, {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
  });

  it("does not let a user disconnect someone else's account", async () => {
    const other = await signIn("other@elsewhere.org");
    await addAccount(other.user.id, "acc-keep", "keep-me@elsewhere.org");
    const { cookie } = await signIn("owner@example.com");

    const response = await exports.default.fetch(`${BASE}/accounts/acc-keep/disconnect`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(404);
    expect(
      await env.DB.prepare("SELECT 1 FROM accounts WHERE id = 'acc-keep'").first(),
    ).not.toBeNull();
  });

  it("signs out by clearing the session cookie", async () => {
    const { cookie } = await signIn("owner@example.com");
    const response = await exports.default.fetch(`${BASE}/auth/logout`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toMatch(/slotmirror_session=;.*Max-Age=0/);
  });

  it("sends a doctype, so that browsers render in standards mode", async () => {
    const response = await exports.default.fetch(`${BASE}/privacy`);
    expect((await response.text()).startsWith("<!doctype html>")).toBe(true);
  });
});
