import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/app-env";
import { createApiToken } from "../src/api-tokens";
import { DEFAULT_ORG_ID } from "../src/access";
import { en } from "../src/i18n/en";
import worker from "../src/index";
import { can } from "../src/permissions";
import { routePermissions, ROUTE_NEEDS } from "../src/route-permissions";
import { base64url } from "../src/session";
import { admitSignIn, loadUser } from "../src/users";
import { BASE, googleIdentity, signIn } from "./helpers";

type Json = Record<string, unknown>;

const RESOURCE = `${BASE}/mcp`;
const LOOPBACK = "http://127.0.0.1:43210/callback";

function fetchApp(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, { redirect: "manual", ...init });
}

async function fetchWith(overrides: Partial<Env>, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, { redirect: "manual", ...init }),
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const get = (path: string, cookie: string) => fetchApp(path, { headers: { cookie } });

function postForm(path: string, fields: Record<string, string>, headers: Json = {}) {
  return fetchApp(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      ...headers,
    } as HeadersInit,
    body: new URLSearchParams(fields).toString(),
  });
}

async function setMcpForMembers(value: string) {
  await env.DB.prepare("UPDATE orgs SET mcp_for_members = ? WHERE id = ?")
    .bind(value, DEFAULT_ORG_ID)
    .run();
}

async function storedSetting(): Promise<string | null> {
  const row = await env.DB.prepare("SELECT mcp_for_members AS value FROM orgs WHERE id = ?")
    .bind(DEFAULT_ORG_ID)
    .first<{ value: string }>();
  return row?.value ?? null;
}

function mcpList(token: string) {
  return fetchApp("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

async function patFor(email: string) {
  const { user, cookie } = await signIn(email);
  const created = await createApiToken(env, user, { name: "test", days: 30 });
  if (!created) throw new Error("no token");
  return { user, cookie, token: created.token };
}

// The OAuth flow, as in mcp-oauth.test.ts, cut to what these tests need.
interface Flow {
  clientId: string;
  verifier: string;
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function newFlow(): Promise<Flow> {
  const response = await fetchApp("/oauth/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
    },
    body: JSON.stringify({
      client_name: "Test agent",
      redirect_uris: [LOOPBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(response.status).toBe(201);
  const client = (await response.json()) as { client_id: string };
  return {
    clientId: client.client_id,
    verifier: base64url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

async function authorizePath(flow: Flow): Promise<string> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: flow.clientId,
    redirect_uri: LOOPBACK,
    code_challenge: await challengeOf(flow.verifier),
    code_challenge_method: "S256",
    state: "state-1",
    resource: RESOURCE,
    scope: "mcp:read",
  });
  return `/oauth/authorize?${query.toString()}`;
}

async function ticketFor(cookie: string, flow: Flow): Promise<string> {
  const html = await (await get(await authorizePath(flow), cookie)).text();
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1];
  if (!ticket) throw new Error("no ticket");
  return ticket;
}

async function codeFor(cookie: string, flow: Flow): Promise<string> {
  const ticket = await ticketFor(cookie, flow);
  const response = await postForm("/oauth/authorize", { ticket, decision: "allow" }, { cookie });
  expect(response.status).toBe(302);
  const code = new URL(response.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error("no code");
  return code;
}

function exchange(flow: Flow, code: string) {
  return postForm("/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: LOOPBACK,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
    resource: RESOURCE,
  });
}

function refresh(flow: Flow, refreshToken: string) {
  return postForm("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: flow.clientId,
  });
}

async function connected(email: string) {
  const { user, cookie } = await signIn(email);
  const flow = await newFlow();
  const response = await exchange(flow, await codeFor(cookie, flow));
  expect(response.status).toBe(200);
  const tokens = (await response.json()) as { access_token: string; refresh_token: string };
  return { user, cookie, flow, tokens };
}

async function grantCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function tokenCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.batch(
    [
      "oauth_codes",
      "oauth_grants",
      "oauth_clients",
      "oauth_registrations",
      "api_tokens",
      "api_usage",
      "api_usage_total",
      "cleanup_tombstones",
      "audit_events",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  // The org exists from here on, with members allowed, as on a deployment from before 0024.
  await signIn("admin@example.com");
  await setMcpForMembers("all");
});

describe("the MCP setting of a new org", () => {
  it("starts with MCP for admins only", async () => {
    await env.DB.batch(
      ["api_tokens", "users", "orgs"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    );
    const outcome = await admitSignIn(env, googleIdentity("owner@example.com"));
    if (!("user" in outcome)) throw new Error("sign-in refused");
    expect(await storedSetting()).toBe("off");
    const user = await loadUser(env, outcome.user.id, outcome.user.sessionVersion);
    expect(user?.mcpForMembers).toBe("off");
    expect(user && can(user, "mcp:read")).toBe(false);
  });

  it("keeps the setting when a sign-in writes the policy of the org again", async () => {
    await setMcpForMembers("all");
    await admitSignIn(env, googleIdentity("owner@example.com", "sub-keep"));
    expect(await storedSetting()).toBe("all");
  });

  it("loads an unknown stored value as off", async () => {
    const { user } = await signIn("owner@example.com");
    await setMcpForMembers("everyone");
    expect((await loadUser(env, user.id, user.sessionVersion))?.mcpForMembers).toBe("off");
  });
});

describe("personal tokens while MCP is off for members", () => {
  it("refuses a new token to a member and creates none", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await setMcpForMembers("off");
    const response = await postForm("/tokens", { name: "agent", days: "30" }, { cookie });
    expect(response.status).toBe(404);
    expect(await tokenCount(user.id)).toBe(0);
  });

  it("still creates a token for an admin", async () => {
    const { user, cookie } = await signIn("admin@example.com");
    await setMcpForMembers("off");
    const response = await postForm("/tokens", { name: "agent", days: "30" }, { cookie });
    expect(response.status).toBe(200);
    expect(await tokenCount(user.id)).toBe(1);
  });

  it("shows a member the tokens with revoke, a notice and no form to create one", async () => {
    const { cookie } = await patFor("owner@example.com");
    await setMcpForMembers("off");
    const response = await get("/tokens", cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(en.tokens.membersOff);
    expect(html).not.toContain(`>${en.tokens.create}<`);
    expect(html).toContain(en.tokens.revoke);
  });

  it("shows the form to a member while MCP is on for members", async () => {
    const { cookie } = await signIn("owner@example.com");
    const html = await (await get("/tokens", cookie)).text();
    expect(html).toContain(`>${en.tokens.create}<`);
    expect(html).not.toContain(en.tokens.membersOff);
  });

  it("lets a member revoke a token", async () => {
    const { user, cookie } = await patFor("owner@example.com");
    await setMcpForMembers("off");
    const html = await (await get("/tokens", cookie)).text();
    const id = /action="\/tokens\/([0-9a-f-]{36})\/revoke"/.exec(html)?.[1];
    expect(id).toBeDefined();
    const response = await postForm(`/tokens/${id}/revoke`, {}, { cookie });
    expect(response.status).toBe(302);
    expect(await tokenCount(user.id)).toBe(0);
  });

  it("stops a member's token at /mcp, keeps it, and lets it work again", async () => {
    const { user, token } = await patFor("owner@example.com");
    expect((await mcpList(token)).status).toBe(200);

    await setMcpForMembers("off");
    const refused = await mcpList(token);
    expect(refused.status).toBe(403);
    // No step-up challenge: a client would only start an authorization that is refused too.
    expect(refused.headers.get("www-authenticate")).toBeNull();
    const body = (await refused.json()) as { error: { message: string } };
    expect(body.error.message).toBe(en.mcp.errors.membersOff);
    expect(await tokenCount(user.id)).toBe(1);

    await setMcpForMembers("all");
    expect((await mcpList(token)).status).toBe(200);
  });

  it("keeps an admin's token working", async () => {
    const { token } = await patFor("admin@example.com");
    await setMcpForMembers("off");
    expect((await mcpList(token)).status).toBe(200);
  });
});

describe("connected apps while MCP is off for members", () => {
  it("shows a member a refusal instead of the consent page", async () => {
    const { cookie } = await signIn("owner@example.com");
    await setMcpForMembers("off");
    const response = await get(await authorizePath(await newFlow()), cookie);
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain(en.consent.mcpOff);
    expect(html).not.toContain('name="ticket"');
  });

  it("refuses a consent that a member started before the change", async () => {
    const { cookie } = await signIn("owner@example.com");
    const flow = await newFlow();
    const ticket = await ticketFor(cookie, flow);
    await setMcpForMembers("off");
    const response = await postForm("/oauth/authorize", { ticket, decision: "allow" }, { cookie });
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses to exchange a code that a member got before the change", async () => {
    const { cookie } = await signIn("owner@example.com");
    const flow = await newFlow();
    const code = await codeFor(cookie, flow);
    await setMcpForMembers("off");
    const response = await exchange(flow, code);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("stops a member's app at /mcp and at the refresh, keeps the grant, then resumes", async () => {
    const { user, flow, tokens } = await connected("owner@example.com");
    await setMcpForMembers("off");

    expect((await mcpList(tokens.access_token)).status).toBe(403);
    const refused = await refresh(flow, tokens.refresh_token);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_grant" });
    expect(await grantCount(user.id)).toBe(1);

    await setMcpForMembers("all");
    expect((await mcpList(tokens.access_token)).status).toBe(200);
    expect((await refresh(flow, tokens.refresh_token)).status).toBe(200);
  });

  it("keeps an admin's app working", async () => {
    const { flow, tokens } = await connected("admin@example.com");
    await setMcpForMembers("off");
    expect((await mcpList(tokens.access_token)).status).toBe(200);
    expect((await refresh(flow, tokens.refresh_token)).status).toBe(200);
  });

  it("answers 404, not a refusal, while the deployment has MCP off", async () => {
    const { cookie } = await signIn("owner@example.com");
    await setMcpForMembers("off");
    const path = await authorizePath({ clientId: "x", verifier: "y" });
    const response = await fetchWith({ MCP_ENABLED: "" }, path, { headers: { cookie } });
    expect(response.status).toBe(404);
  });
});

describe("the MCP setting in the admin page", () => {
  it("lets an admin turn MCP off and on for members, and logs each change", async () => {
    const { cookie } = await signIn("admin@example.com");
    const off = await postForm("/admin/mcp-policy", { mcpForMembers: "off" }, { cookie });
    expect(off.status).toBe(302);
    expect(off.headers.get("location")).toBe("/admin");
    expect(await storedSetting()).toBe("off");

    const on = await postForm("/admin/mcp-policy", { mcpForMembers: "all" }, { cookie });
    expect(on.status).toBe(302);
    expect(await storedSetting()).toBe("all");

    // Saving the same value again is no change.
    expect((await postForm("/admin/mcp-policy", { mcpForMembers: "all" }, { cookie })).status).toBe(
      302,
    );

    const { results } = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE kind = 'mcp_policy_changed' ORDER BY id",
    ).all<{ detail: string }>();
    expect(results.map((row) => JSON.parse(row.detail))).toEqual([
      { mcpForMembers: "off" },
      { mcpForMembers: "all" },
    ]);
  });

  it("refuses an unknown value and keeps the setting", async () => {
    const { cookie } = await signIn("admin@example.com");
    const response = await postForm("/admin/mcp-policy", { mcpForMembers: "some" }, { cookie });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(en.admin.mcpInvalid);
    expect(await storedSetting()).toBe("all");
  });

  it("refuses a member and keeps the setting", async () => {
    const { cookie } = await signIn("owner@example.com");
    const response = await postForm("/admin/mcp-policy", { mcpForMembers: "off" }, { cookie });
    expect(response.status).toBe(404);
    expect(await storedSetting()).toBe("all");
  });

  it("shows the current setting to an admin", async () => {
    const { cookie } = await signIn("admin@example.com");
    await setMcpForMembers("off");
    const html = await (await get("/admin", cookie)).text();
    expect(html).toContain(en.admin.mcpTitle);
    expect(html).toMatch(/value="off"[^>]*checked/);
  });

  it("hides the setting while the deployment has MCP off", async () => {
    const { cookie } = await signIn("admin@example.com");
    const response = await fetchWith({ MCP_ENABLED: "" }, "/admin", { headers: { cookie } });
    expect(await response.text()).not.toContain(en.admin.mcpTitle);
    const post = await fetchWith({ MCP_ENABLED: "" }, "/admin/mcp-policy", {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: "mcpForMembers=off",
    });
    expect(post.status).toBe(404);
    expect(await storedSetting()).toBe("all");
  });
});

describe("admin actions", () => {
  // Every route that only admins may use, from the table, so that a new one is tested too.
  const adminRoutes = Object.entries(ROUTE_NEEDS)
    .filter(([, need]) => need !== "public" && !can({ role: "member", mcpForMembers: "all" }, need))
    .map(([route]) => route);

  it("has admin routes to test", () => {
    expect(adminRoutes.length).toBeGreaterThan(10);
  });

  for (const route of adminRoutes) {
    it(`refuses a member at ${route}`, async () => {
      const { cookie } = await signIn("owner@example.com");
      const other = await signIn("someone@org.example");
      const [method, pattern] = route.split(" ") as [string, string];
      const path = pattern.replace(":id", other.user.id);
      const response =
        method === "GET"
          ? await get(path, cookie)
          : await postForm(path, { mcpForMembers: "off" }, { cookie });
      expect(response.status).toBe(route === "GET /admin" ? 403 : 404);
      expect(response.headers.get("location")).toBeNull();
      // Nothing changed for the other user or the org.
      expect(await loadUser(env, other.user.id, other.user.sessionVersion)).not.toBeNull();
      expect(await storedSetting()).toBe("all");
    });
  }

  it("lets an admin open the admin pages and manage a user", async () => {
    const { cookie } = await signIn("admin@example.com");
    const other = await signIn("someone@org.example");
    expect((await get("/admin", cookie)).status).toBe(200);
    expect((await get("/admin/activity", cookie)).status).toBe(200);
    expect((await get(`/admin/users/${other.user.id}/delete`, cookie)).status).toBe(200);
    expect((await get("/dev/stats", cookie)).status).toBe(200);
    const reset = await postForm(`/admin/users/${other.user.id}/reset-sign-in`, {}, { cookie });
    expect(reset.status).toBe(302);
    expect(await loadUser(env, other.user.id, other.user.sessionVersion)).toBeNull();
  });

  it("shows the rest of deleted users under /cleanup only to an admin", async () => {
    await env.DB.prepare(
      `INSERT INTO cleanup_tombstones (account_id, rule_id, org_id, user_id, calendar_name,
                                       rule_tag, state, blocks_left)
       VALUES ('gone-account', 'gone-rule', ?, 'gone-user', 'Gone calendar', 'tag', 'incomplete', 3)`,
    )
      .bind(DEFAULT_ORG_ID)
      .run();
    const member = await signIn("owner@example.com");
    const admin = await signIn("admin@example.com");
    expect(await (await get("/cleanup", member.cookie)).text()).not.toContain(
      en.cleanup.othersTitle,
    );
    expect(await (await get("/cleanup", admin.cookie)).text()).toContain(en.cleanup.othersTitle);
  });

  it("shows the admin link only to an admin", async () => {
    const member = await signIn("owner@example.com");
    const admin = await signIn("admin@example.com");
    expect(await (await get("/", member.cookie)).text()).not.toContain('href="/admin"');
    expect(await (await get("/", admin.cookie)).text()).toContain('href="/admin"');
  });
});

describe("a route without an entry", () => {
  it("answers 404 to an admin", async () => {
    const { user } = await signIn("admin@example.com");
    const probe = new Hono<AppEnv>();
    probe.use("*", async (c, next) => {
      c.set("user", await loadUser(c.env, user.id, user.sessionVersion));
      await next();
    });
    probe.use(
      "*",
      routePermissions(() => new Response("refused", { status: 403 })),
    );
    probe.get("/unlisted", (c) => c.text("open"));
    probe.all("/any-method", (c) => c.text("open"));
    probe.get("/admin", (c) => c.text("admin"));
    expect((await probe.request("/unlisted", {}, env)).status).toBe(404);
    expect((await probe.request("/any-method", {}, env)).status).toBe(404);
    expect(await (await probe.request("/admin", {}, env)).text()).toBe("admin");
  });
});
