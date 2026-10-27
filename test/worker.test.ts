import {
  createScheduledController,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_RETENTION_DAYS } from "../src/audit";
import worker from "../src/index";
import { SESSION_COOKIE, signSession } from "../src/session";
import { addAccount, BASE, signIn } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("ticks every account on cron, also after the tick of one account failed", async () => {
    const { user } = await signIn("owner@example.com");
    // Inserted first, so that the cron ticks it first.
    await addAccount(user.id, "acc-cron-broken", "cron-broken@example.com");
    await addAccount(user.id, "acc-cron-fine", "cron-fine@example.com");
    const tokens = { refreshToken: "r", accessToken: "a", accessExpiresAt: 0 };
    const broken = env.ACCOUNT_SYNC.getByName("acc-cron-broken");
    await broken.storeTokens("acc-cron-broken", tokens);
    // Tokens that no longer decrypt, e.g. after a key change: its tick probes and throws.
    await runInDurableObject(broken, (_instance, state) => {
      state.storage.sql.exec("UPDATE tokens SET ciphertext = x'00'");
    });
    await env.DB.prepare(
      "UPDATE accounts SET needs_reconnect = 1 WHERE id = 'acc-cron-broken'",
    ).run();
    const fine = env.ACCOUNT_SYNC.getByName("acc-cron-fine");
    await fine.storeTokens("acc-cron-fine", {
      ...tokens,
      accessExpiresAt: Date.now() + 3_600_000,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await worker.scheduled(createScheduledController(), env);

    expect(
      await runInDurableObject(fine, (_instance, state) => state.storage.getAlarm()),
    ).not.toBeNull();
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("acc-cron-broken");
    expect(logged).not.toContain("cron-broken@example.com");
    // Later tests in this file share the database.
    await env.DB.prepare(
      "UPDATE accounts SET needs_reconnect = 0 WHERE id = 'acc-cron-broken'",
    ).run();
  });

  it("ticks the later accounts and purges the audit log when one tick throws", async () => {
    const { user } = await signIn("owner@example.com");
    for (const id of ["acc-tick-bad", "acc-tick-good"]) {
      await addAccount(user.id, id, `${id}@example.com`);
      await env.ACCOUNT_SYNC.getByName(id).storeTokens(id, {
        refreshToken: "r",
        accessToken: "a",
        accessExpiresAt: Date.now() + 3_600_000,
      });
    }
    await env.DB.prepare(
      `INSERT INTO audit_events (org_id, kind, created_at)
       VALUES ('tick-org', 'old', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))`,
    )
      .bind(`-${AUDIT_RETENTION_DAYS + 1} days`)
      .run();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The tick of one account rejects, as on a transient D1 or Durable Object error.
    const failingEnv = {
      ...env,
      ACCOUNT_SYNC: {
        getByName: (name: string) =>
          name === "acc-tick-bad"
            ? { tick: () => Promise.reject(new Error("D1_ERROR: transient")) }
            : env.ACCOUNT_SYNC.getByName(name),
      },
    } as unknown as Env;

    await worker.scheduled(createScheduledController(), failingEnv);

    const good = env.ACCOUNT_SYNC.getByName("acc-tick-good");
    expect(
      await runInDurableObject(good, (_instance, state) => state.storage.getAlarm()),
    ).not.toBeNull();
    const { results } = await env.DB.prepare(
      "SELECT kind FROM audit_events WHERE org_id = 'tick-org'",
    ).all();
    expect(results).toEqual([]);
  });

  it("does not throw when the audit purge fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failingEnv = {
      ...env,
      DB: {
        prepare: (query: string) => {
          if (query.startsWith("DELETE FROM audit_events")) throw new Error("D1_ERROR: transient");
          return env.DB.prepare(query);
        },
      },
    } as unknown as Env;

    await expect(
      worker.scheduled(createScheduledController(), failingEnv),
    ).resolves.toBeUndefined();
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

    const before = await page();
    expect(before).not.toContain("needs reconnecting");
    expect(before).not.toContain("need reconnecting");
    expect(before).not.toContain("badge error");

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
