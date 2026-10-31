import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "../src/session";
import { rulesTargetingAccount } from "../src/sync/rules";
import { admitSignIn, CONSUMER_TENANT_ID } from "../src/users";
import { BASE, googleIdentity, signIn } from "./helpers";

const AUTH = { authorization: "Bearer test-scim-token" };

function scim(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", AUTH.authorization);
  headers.set("content-type", "application/scim+json");
  return exports.default.fetch(`${BASE}/scim/v2${path}`, { ...init, headers });
}

async function provision(userName: string, externalId = `ext-${userName}`) {
  const response = await scim("/Users", {
    method: "POST",
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId,
      userName,
      active: true,
      emails: [{ primary: true, type: "work", value: userName }],
    }),
  });
  const body = (await response.json()) as Record<string, unknown> & { id: string };
  return { response, body };
}

/** A user with one account, a rule from its second calendar into its first, and tokens. */
async function userWithRule(prefix: string) {
  const { user } = await signIn(`${prefix}@org.example`);
  const account = `${prefix}-acc`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(account, user.id, `${prefix}@work.example`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default) VALUES (?, ?, 'main', 'Main', 1, 1), (?, ?, 'other', 'Other', 1, 0)",
    ).bind(`${account}-main`, account, `${account}-other`, account),
    env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES (?, ?, ?, ?)",
    ).bind(`${prefix}-rule`, user.id, `${account}-other`, `${account}-main`),
  ]);
  await env.ACCOUNT_SYNC.getByName(account).storeTokens(account, {
    refreshToken: "r",
    accessToken: "a",
    accessExpiresAt: Date.now() + 3_600_000,
  });
  return { user, account, ruleId: `${prefix}-rule` };
}

const removalsOf = (account: string) =>
  runInDurableObject(env.ACCOUNT_SYNC.getByName(account), (_instance, state) =>
    state.storage.get<{ ruleId: string }[]>("removalQueue"),
  );

describe("SCIM access", () => {
  it("does not exist without SCIM_TOKEN and refuses a wrong token", async () => {
    const ctx = createExecutionContext();
    const off = await worker.fetch(
      new Request(`${BASE}/scim/v2/Users`, { headers: AUTH }),
      { ...env, SCIM_TOKEN: "" },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(off.status).toBe(404);

    const wrong = await exports.default.fetch(`${BASE}/scim/v2/Users`, {
      headers: { authorization: "Bearer guess" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("content-type")).toContain("application/scim+json");
    expect(await wrong.json()).toMatchObject({ status: "401" });
  });
});

describe("SCIM users", () => {
  it("creates a user, refuses a duplicate, and finds it by userName, externalId and email", async () => {
    const { response, body } = await provision("New.Person@org.example", "ext-new");
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      userName: "new.person@org.example",
      active: true,
      externalId: "ext-new",
    });
    expect(String((body.meta as { location: string }).location)).toContain(
      `/scim/v2/Users/${body.id}`,
    );

    const again = await provision("new.person@org.example");
    expect(again.response.status).toBe(409);
    expect(again.body).toMatchObject({ scimType: "uniqueness" });

    for (const filter of [
      'userName eq "new.person@org.example"',
      'externalId eq "ext-new"',
      'emails[type eq "work"].value eq "new.person@org.example"',
    ]) {
      const list = (await (await scim(`/Users?filter=${encodeURIComponent(filter)}`)).json()) as {
        totalResults: number;
        Resources: { id: string }[];
      };
      expect(list.totalResults).toBe(1);
      expect(list.Resources[0]?.id).toBe(body.id);
    }
    const none = (await (
      await scim(`/Users?filter=${encodeURIComponent('userName eq "nobody@org.example"')}`)
    ).json()) as { totalResults: number; Resources: unknown[] };
    expect(none).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await scim(`/Users?filter=${encodeURIComponent('title co "x"')}`)).status).toBe(400);

    expect((await scim(`/Users/${body.id}`)).status).toBe(200);
    expect((await scim("/Users/unknown")).status).toBe(404);
  });

  it("lets a provisioned user sign in with the same user", async () => {
    const { body } = await provision("first.login@org.example");
    const outcome = await admitSignIn(env, googleIdentity("first.login@org.example"));
    expect(outcome).toMatchObject({ user: { id: body.id } });
  });

  it("deactivates a user: no session, no sign-in, no rules, blocks queued; and reactivates", async () => {
    const { user, account, ruleId } = await userWithRule("leaver");
    const { cookie } = await signIn("leaver@org.example");
    const patch = (value: unknown) =>
      scim(`/Users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "Replace", path: "active", value }],
        }),
      });

    const off = await patch(false);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ active: false });
    expect(await rulesTargetingAccount(env, account)).toEqual([]);
    expect(await removalsOf(account)).toEqual([expect.objectContaining({ ruleId })]);
    expect(await admitSignIn(env, googleIdentity("leaver@org.example"))).toEqual({
      refused: "policy",
    });
    const page = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(page).toContain("/auth/microsoft/login");

    // Older Entra tenants send the value as a string.
    const on = await patch("True");
    expect(await on.json()).toMatchObject({ active: true });
    expect(await rulesTargetingAccount(env, account)).toEqual([ruleId]);
  });

  it("replaces a user with PUT", async () => {
    const { body } = await provision("rename.me@org.example");
    const response = await scim(`/Users/${body.id}`, {
      method: "PUT",
      body: JSON.stringify({ userName: "renamed@org.example", externalId: "ext-2", active: true }),
    });
    expect(await response.json()).toMatchObject({
      userName: "renamed@org.example",
      externalId: "ext-2",
    });
  });

  it("deletes a user with accounts and queues the removal of their blocks", async () => {
    const { user, account, ruleId } = await userWithRule("gone");
    const response = await scim(`/Users/${user.id}`, { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(
      await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(user.id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(account).first(),
    ).toBeNull();
    expect(await removalsOf(account)).toEqual([expect.objectContaining({ ruleId })]);
    const retiring = await runInDurableObject(env.ACCOUNT_SYNC.getByName(account), (_i, state) =>
      state.storage.get<string>("retiring"),
    );
    expect(retiring).toEqual(expect.any(String));
    const audit = await env.DB.prepare(
      "SELECT user_id, detail FROM audit_events WHERE kind = 'user_deleted' ORDER BY id DESC",
    ).first<{ user_id: string | null; detail: string }>();
    expect(audit).toEqual({ user_id: null, detail: '{"by":"scim"}' });
  });

  it("answers the discovery endpoints and an empty group list", async () => {
    for (const path of ["/ServiceProviderConfig", "/Schemas", "/ResourceTypes", "/Groups"]) {
      const response = await scim(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/scim+json");
    }
    expect(await (await scim("/Groups")).json()).toMatchObject({ totalResults: 0 });
  });
});

describe("deleting users in the dashboard", () => {
  it("lets users delete their own data after a confirmation", async () => {
    const { account } = await userWithRule("self");
    const { user, cookie } = await signIn("self@org.example");
    const confirm = await (
      await exports.default.fetch(`${BASE}/account/delete`, { headers: { cookie } })
    ).text();
    expect(confirm).toContain("1 connected account, with its tokens");

    const response = await exports.default.fetch(`${BASE}/account/delete`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/slotmirror_session=;.*Max-Age=0/);
    expect(
      await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(user.id).first(),
    ).toBeNull();
    expect(await removalsOf(account)).toHaveLength(1);
  });

  it("lets admins delete other users, but not themselves, and members nobody", async () => {
    const { user: victim } = await signIn("victim@org.example");
    const { user: admin, cookie } = await signIn("admin@example.com");
    const { cookie: memberCookie } = await signIn("owner@example.com");
    const get = (path: string, c: string) =>
      exports.default.fetch(`${BASE}${path}`, { headers: { cookie: c } });

    expect((await get(`/admin/users/${admin.id}/delete`, cookie)).status).toBe(404);
    expect((await get(`/admin/users/${victim.id}/delete`, memberCookie)).status).toBe(404);
    expect((await get(`/admin/users/${victim.id}/delete`, cookie)).status).toBe(200);
    const response = await exports.default.fetch(`${BASE}/admin/users/${victim.id}/delete`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(
      await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(victim.id).first(),
    ).toBeNull();
  });

  it("keeps sessions for twelve hours", () => {
    expect(SESSION_TTL_SECONDS).toBe(12 * 60 * 60);
  });
});

describe("SCIM userName changes", () => {
  const rename = (id: string, userName: string) =>
    scim(`/Users/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "userName", value: userName }],
      }),
    });
  const signedIn = async (cookie: string) => {
    const page = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    return !page.includes("/auth/microsoft/login");
  };

  it("ends the sessions of a user whose userName changes", async () => {
    const { user, cookie } = await signIn("carol@org.example");
    expect(await signedIn(cookie)).toBe(true);

    expect((await rename(user.id, "carol.new@org.example")).status).toBe(200);
    expect(await signedIn(cookie)).toBe(false);

    // SCIM keeps working: the next sign-in with the new address gets a session again.
    const { user: again, cookie: fresh } = await signIn("carol.new@org.example");
    expect(again.id).toBe(user.id);
    expect(await signedIn(fresh)).toBe(true);
  });

  it("sends an old session to the sign-in page after a rename", async () => {
    const { user, cookie } = await signIn("dave@org.example");
    const admin = () =>
      exports.default.fetch(`${BASE}/admin`, { headers: { cookie }, redirect: "manual" });
    expect((await admin()).status).toBe(403);

    // The admin address must be free for the rename; SCIM can delete its row first.
    await env.DB.prepare("DELETE FROM users WHERE email = 'admin@example.com'").run();
    expect((await rename(user.id, "admin@example.com")).status).toBe(200);
    // The old session ended: the admin page sends it to the sign-in page.
    expect((await admin()).status).toBe(302);
  });

  it("keeps sessions when the userName stays the same or other attributes change", async () => {
    const { user, cookie } = await signIn("erin@org.example");
    const put = await scim(`/Users/${user.id}`, {
      method: "PUT",
      body: JSON.stringify({ userName: "Erin@org.example", externalId: "ext-erin", active: true }),
    });
    expect(put.status).toBe(200);
    expect(await signedIn(cookie)).toBe(true);
  });

  it("accepts a session cookie signed before session versions existed", async () => {
    const { user } = await signIn("frank@org.example");
    const token = await signSession(
      { userId: user.id, exp: Math.floor(Date.now() / 1000) + 60 },
      env.SESSION_SECRET,
    );
    expect(await signedIn(`${SESSION_COOKIE}=${token}`)).toBe(true);
  });
});

describe("resetting a sign-in binding", () => {
  it("offers the reset for a user without a binding", async () => {
    const { user: target } = await signIn("unbound.reset@org.example");
    await env.DB.prepare(
      "UPDATE users SET ms_tenant_id = NULL, ms_object_id = NULL, google_subject = NULL WHERE id = ?",
    )
      .bind(target.id)
      .run();
    const { cookie } = await signIn("admin@example.com");

    const page = await (
      await exports.default.fetch(`${BASE}/admin`, { headers: { cookie } })
    ).text();

    expect(page).toContain(`/admin/users/${target.id}/reset-sign-in`);
  });

  it("lets an admin reset another user's binding, ends their sessions, and records it", async () => {
    const { user: target, cookie: targetCookie } = await signIn("rebind@org.example");
    await env.DB.prepare(
      "UPDATE users SET ms_tenant_id = 'tenant-old', ms_object_id = 'oid-old' WHERE id = ?",
    )
      .bind(target.id)
      .run();
    const { user: admin, cookie } = await signIn("admin@example.com");
    const { cookie: memberCookie } = await signIn("owner@example.com");
    const reset = (id: string, c: string) =>
      exports.default.fetch(`${BASE}/admin/users/${id}/reset-sign-in`, {
        method: "POST",
        headers: { cookie: c },
        redirect: "manual",
      });

    const page = await (
      await exports.default.fetch(`${BASE}/admin`, { headers: { cookie } })
    ).text();
    expect(page).toContain(`/admin/users/${target.id}/reset-sign-in`);
    expect((await reset(target.id, memberCookie)).status).toBe(404);
    expect((await reset(admin.id, cookie)).status).toBe(404);

    const response = await reset(target.id, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin");
    const row = await env.DB.prepare(
      `SELECT ms_tenant_id, ms_object_id, google_subject, session_version,
              rebind_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS open
       FROM users WHERE id = ?`,
    )
      .bind(target.id)
      .first();
    expect(row).toEqual({
      ms_tenant_id: null,
      ms_object_id: null,
      google_subject: null,
      session_version: target.sessionVersion + 1,
      open: 1,
    });
    const audit = await env.DB.prepare(
      "SELECT user_id, detail FROM audit_events WHERE kind = 'sign_in_reset' ORDER BY id DESC",
    ).first();
    expect(audit).toEqual({ user_id: target.id, detail: '{"by":"admin"}' });
    // The target's open session ends.
    const home = await (
      await exports.default.fetch(`${BASE}/`, { headers: { cookie: targetCookie } })
    ).text();
    expect(home).toContain("/auth/microsoft/login");

    // Within the window, even a personal Microsoft account with the address binds the user.
    const outcome = await admitSignIn(env, {
      provider: "microsoft",
      email: "rebind@org.example",
      tenantId: CONSUMER_TENANT_ID,
      subject: "oid-new",
      addresses: ["rebind@org.example"],
    });
    expect(outcome).toMatchObject({ user: { id: target.id } });
  });
});

describe("deactivation and sessions", () => {
  it("does not revive a session from before a deactivation", async () => {
    const { user, cookie } = await signIn("returner@org.example");
    const patch = (value: boolean) =>
      scim(`/Users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value }],
        }),
      });
    expect((await patch(false)).status).toBe(200);
    expect((await patch(true)).status).toBe(200);
    const page = await (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(page).toContain("/auth/microsoft/login");
    // A new sign-in works again.
    const { cookie: fresh } = await signIn("returner@org.example");
    const again = await (
      await exports.default.fetch(`${BASE}/`, { headers: { cookie: fresh } })
    ).text();
    expect(again).not.toContain("/auth/microsoft/login");
  });
});
