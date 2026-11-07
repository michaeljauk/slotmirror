import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeTarget, signAccessToken, signResume } from "../src/mcp-oauth";
import worker from "../src/index";
import { OAUTH_COOKIE } from "../src/oauth";
import { base64url, SESSION_COOKIE } from "../src/session";
import { BASE, signIn } from "./helpers";
// @ts-expect-error `?raw` imports are untyped without `vite/client`
import editorScript from "../public/editor.js?raw";

const RESOURCE = `${BASE}/mcp`;
const LOOPBACK = "http://127.0.0.1:33418/callback";

type Json = Record<string, unknown>;

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function newVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

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

function postForm(path: string, fields: Record<string, string>, headers: Json = {}) {
  return fetchApp(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers } as HeadersInit,
    body: new URLSearchParams(fields).toString(),
  });
}

/** Each test client comes from its own address, so that the per-address limit stays out of the way. */
async function register(metadata: Json = {}): Promise<Response> {
  const address = `192.0.2.${Math.floor(Math.random() * 250) + 1}`;
  return fetchApp("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": address },
    body: JSON.stringify({
      client_name: "Test agent",
      redirect_uris: [LOOPBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...metadata,
    }),
  });
}

async function registeredClient(metadata: Json = {}): Promise<Json & { client_id: string }> {
  const response = await register(metadata);
  expect(response.status).toBe(201);
  return (await response.json()) as Json & { client_id: string };
}

interface Flow {
  clientId: string;
  verifier: string;
  redirectUri: string;
}

function authorizeQuery(flow: Flow, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: flow.clientId,
    redirect_uri: flow.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    resource: RESOURCE,
    scope: "mcp:read",
    ...extra,
  }).toString();
}

/** The consent page for a flow, and the ticket its form carries. */
async function consent(cookie: string, flow: Flow, extra: Record<string, string> = {}) {
  const query = authorizeQuery(flow, await challengeOf(flow.verifier), extra);
  const response = await fetchApp(`/oauth/authorize?${query}`, { headers: { cookie } });
  const html = await response.clone().text();
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1];
  return { response, html, ticket };
}

/** Run the whole browser part and return the code. */
async function codeFor(cookie: string, flow: Flow): Promise<string> {
  const { ticket } = await consent(cookie, flow);
  if (!ticket) throw new Error("no ticket");
  const response = await postForm(
    "/oauth/authorize",
    { ticket, decision: "allow" },
    { cookie, origin: BASE },
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  const code = location.searchParams.get("code");
  if (!code) throw new Error(`no code: ${location.toString()}`);
  return code;
}

function exchange(flow: Flow, code: string, extra: Record<string, string> = {}) {
  return postForm("/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.verifier,
    resource: RESOURCE,
    ...extra,
  });
}

function refresh(flow: Flow, refreshToken: string, extra: Record<string, string> = {}) {
  return postForm("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: flow.clientId,
    ...extra,
  });
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

/** A signed-in user with a connected app and its first tokens. */
async function connected(email = "owner@example.com") {
  const { user, cookie } = await signIn(email);
  const client = await registeredClient();
  const flow: Flow = { clientId: client.client_id, verifier: newVerifier(), redirectUri: LOOPBACK };
  const response = await exchange(flow, await codeFor(cookie, flow));
  expect(response.status).toBe(200);
  return { user, cookie, flow, tokens: (await response.json()) as Tokens };
}

function mcpCall(accessToken: string, method = "tools/list", params: Json = {}) {
  return fetchApp("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
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
      "rules",
      "accounts",
      "audit_events",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discovery", () => {
  it("describes the protected resource at its path and at the root, each as itself", async () => {
    // RFC 9728 3.3: `resource` names the URL into which the well-known path was inserted.
    const documents: [string, string][] = [
      ["/.well-known/oauth-protected-resource/mcp", RESOURCE],
      ["/.well-known/oauth-protected-resource", BASE],
    ];
    for (const [path, resource] of documents) {
      const response = await fetchApp(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toMatchObject({
        resource,
        authorization_servers: [BASE],
        scopes_supported: ["mcp:read"],
        bearer_methods_supported: ["header"],
      });
    }
  });

  it("accepts the deployment's origin as resource too, for a client that read the root", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { ticket } = await consent(cookie, flow, { resource: BASE });
    expect(ticket).toBeTruthy();
    const decided = await postForm(
      "/oauth/authorize",
      { ticket: ticket ?? "", decision: "allow" },
      { cookie, origin: BASE },
    );
    const code = new URL(decided.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const tokens = (await (await exchange(flow, code, { resource: BASE })).json()) as Tokens;
    expect((await mcpCall(tokens.access_token)).status).toBe(200);
  });

  it("lets a browser read even a refusal of the OAuth endpoints", async () => {
    const off = await fetchWith({ MCP_ENABLED: "" }, "/.well-known/oauth-authorization-server");
    expect(off.status).toBe(404);
    expect(off.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("describes the authorization server with PKCE S256 only", async () => {
    const response = await fetchApp("/.well-known/oauth-authorization-server");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp:read"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("answers 404 for every OAuth path while MCP_ENABLED is off", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/oauth/authorize",
    ]) {
      expect((await fetchWith({ MCP_ENABLED: "" }, path)).status).toBe(404);
    }
    for (const path of ["/oauth/token", "/oauth/register", "/oauth/revoke", "/oauth/authorize"]) {
      const response = await fetchWith({ MCP_ENABLED: "" }, path, { method: "POST" });
      expect(response.status).toBe(404);
    }
  });

  it("points a refused MCP request to the resource metadata", async () => {
    const response = await mcpCall("nope");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mcp:read"`,
    );
    const bare = await fetchApp("/mcp", { method: "POST", body: "{}" });
    expect(bare.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mcp:read"`,
    );
  });
});

describe("client registration", () => {
  it("registers a public client with a loopback redirect", async () => {
    const client = await registeredClient();
    expect(client.client_id).toMatch(/^smc_[A-Za-z0-9_-]{22}$/);
    expect(client).not.toHaveProperty("client_secret");
    expect(client).toMatchObject({
      client_name: "Test agent",
      redirect_uris: [LOOPBACK],
      token_endpoint_auth_method: "none",
    });
  });

  it("gives a confidential client its secret once and keeps only a hash", async () => {
    const client = await registeredClient({
      token_endpoint_auth_method: "client_secret_post",
      redirect_uris: ["https://agent.example/callback"],
    });
    const secret = client.client_secret as string;
    expect(secret).toMatch(/^sm_cs_/);
    const row = await env.DB.prepare("SELECT * FROM oauth_clients WHERE id = ?")
      .bind(client.client_id)
      .first();
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("drops control and direction characters from a client's name", async () => {
    const client = await registeredClient({ client_name: "Good\u202eppa live\u0007 app" });
    expect(client.client_name).toBe("Goodppa live app");
  });

  it("refuses redirects that are neither HTTPS nor loopback", async () => {
    for (const uris of [
      ["http://agent.example/callback"],
      ["javascript:alert(1)"],
      ["https://agent.example/callback#part"],
      ["https://user:pw@agent.example/callback"],
      [],
      Array.from({ length: 6 }, (_, i) => `https://agent.example/${i}`),
      ["https://agent.example/" + "x".repeat(600)],
    ]) {
      const response = await register({ redirect_uris: uris });
      expect(response.status).toBe(400);
      expect(((await response.json()) as Json).error).toBe("invalid_redirect_uri");
    }
  });

  it("refuses an unknown authentication method and a malformed body", async () => {
    const method = await register({ token_endpoint_auth_method: "private_key_jwt" });
    expect(((await method.json()) as Json).error).toBe("invalid_client_metadata");
    const malformed = await fetchApp("/oauth/register", { method: "POST", body: "{nope" });
    expect(malformed.status).toBe(400);
  });

  it("stops one address after its daily registrations, and leaves others free", async () => {
    const { REGISTRATIONS_PER_ADDRESS } = await import("../src/mcp-oauth");
    const from = (ip: string) =>
      fetchApp("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ redirect_uris: [LOOPBACK], token_endpoint_auth_method: "none" }),
      });
    for (let i = 0; i < REGISTRATIONS_PER_ADDRESS; i++) {
      expect((await from("203.0.113.7")).status).toBe(201);
    }
    const refused = await from("203.0.113.7");
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as Json).error).toBe("temporarily_unavailable");
    expect((await from("198.51.100.9")).status).toBe(201);
    // The table keeps a keyed hash of the address, never the address.
    const rows = await env.DB.prepare("SELECT * FROM oauth_registrations").all();
    expect(JSON.stringify(rows.results)).not.toContain("203.0.113.7");
  });

  it("counts an IPv6 /64 network as one address", async () => {
    const { REGISTRATIONS_PER_ADDRESS } = await import("../src/mcp-oauth");
    const from = (ip: string) =>
      fetchApp("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ redirect_uris: [LOOPBACK], token_endpoint_auth_method: "none" }),
      });
    for (let i = 0; i < REGISTRATIONS_PER_ADDRESS; i++) {
      expect((await from(`2001:db8:1:2::${(i + 1).toString(16)}`)).status).toBe(201);
    }
    expect((await from("2001:db8:1:2:ffff::9")).status).toBe(429);
    expect((await from("2001:db8:1:3::1")).status).toBe(201);
  });

  it("refuses an IPv6 loopback redirect, which a CSP form-action cannot name", async () => {
    const response = await register({ redirect_uris: ["http://[::1]:5000/callback"] });
    expect(response.status).toBe(400);
  });

  it("reads few rows to register, also with thousands of clients in the table", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
       INSERT INTO oauth_clients (id, name, redirect_uris) SELECT 'smc_bulk' || i, 'x', '[]' FROM n`,
    ).run();
    let rowsRead = 0;
    const counting = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            for (const result of results) rowsRead += result.meta.rows_read;
            return results;
          };
        }
        return Reflect.get(target, key);
      },
    });
    const response = await fetchWith({ DB: counting }, "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.77" },
      body: JSON.stringify({ redirect_uris: [LOOPBACK], token_endpoint_auth_method: "none" }),
    });
    expect(response.status).toBe(201);
    expect(rowsRead).toBeLessThan(200);
  });

  it("registers only JSON, so that a page in a browser cannot register without a preflight", async () => {
    const plain = await fetchApp("/oauth/register", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: JSON.stringify({ redirect_uris: [LOOPBACK], token_endpoint_auth_method: "none" }),
    });
    expect(plain.status).toBe(400);
    const preflight = await fetchApp("/oauth/register", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const clients = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_clients").first<{
      n: number;
    }>();
    expect(clients?.n).toBe(0);
  });

  it("stops registrations at the deployment's daily limit", async () => {
    const { DAILY_CLIENT_REGISTRATIONS } = await import("../src/mcp-oauth");
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO oauth_registrations (key, day, count) VALUES ('all', ?, ?)",
    )
      .bind(day, DAILY_CLIENT_REGISTRATIONS)
      .run();
    const response = await register();
    expect(response.status).toBe(429);
    expect(((await response.json()) as Json).error).toBe("temporarily_unavailable");
  });

  it("keeps a client longer than its longest grant, so that it can connect again", async () => {
    const { cookie, flow } = await connected();
    // The grant ran its full 90 days and ended; the app comes back with its cached client ID.
    await env.DB.prepare("DELETE FROM oauth_grants").run();
    await env.DB.prepare("UPDATE oauth_clients SET created_at = ?1, last_used_at = ?1")
      .bind(new Date(Date.now() - 100 * 86_400_000).toISOString())
      .run();
    expect((await register()).status).toBe(201);
    const again = await consent(cookie, { ...flow, verifier: newVerifier() });
    expect(again.response.status).toBe(200);
  });

  it("keeps a client that connected once, after its connection ended", async () => {
    const { cookie, flow } = await connected();
    const page = await (await fetchApp("/tokens", { headers: { cookie } })).text();
    const grantId = /action="\/tokens\/apps\/([^/]+)\/revoke"/.exec(page)?.[1] ?? "";
    await postForm(`/tokens/apps/${grantId}/revoke`, {}, { cookie, origin: BASE });
    await env.DB.prepare("UPDATE oauth_clients SET created_at = '2020-01-01T00:00:00.000Z'").run();
    expect((await register()).status).toBe(201);
    // The app kept its client ID; it must be able to connect again with it.
    const again = await consent(cookie, { ...flow, verifier: newVerifier() });
    expect(again.response.status).toBe(200);
  });

  it("deletes clients that never connected after 30 days, and keeps those with a grant", async () => {
    const { tokens } = await connected();
    await env.DB.prepare("UPDATE oauth_clients SET created_at = '2020-01-01T00:00:00.000Z'").run();
    await env.DB.prepare(
      `INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
       VALUES ('smc_unused', 'old', '[]', '2020-01-01T00:00:00.000Z')`,
    ).run();
    expect((await register()).status).toBe(201);
    const ids = await env.DB.prepare("SELECT id FROM oauth_clients").all<{ id: string }>();
    expect(ids.results.map((row) => row.id)).not.toContain("smc_unused");
    expect((await mcpCall(tokens.access_token)).status).toBe(200);
  });
});

describe("authorization", () => {
  it("sends a visitor to sign in and back to the request afterwards", async () => {
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const query = authorizeQuery(flow, await challengeOf(flow.verifier));
    const first = await fetchApp(`/oauth/authorize?${query}`);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/");
    const resume = /slotmirror_resume=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")?.[1];
    expect(resume).toBeTruthy();

    // Sign in with Microsoft while the resume cookie is set.
    const login = await fetchApp("/auth/microsoft/login");
    const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
    const flowCookie = new RegExp(`${OAUTH_COOKIE}=([^;]+)`).exec(
      login.headers.get("set-cookie") ?? "",
    )?.[1];
    const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        access_token: "a",
        expires_in: 3600,
        id_token: `${encode({ alg: "none" })}.${encode({
          tid: "t1",
          oid: "o1",
          preferred_username: "owner@example.com",
        })}.s`,
      }),
    );
    const callback = await fetchApp(`/auth/microsoft/callback?code=abc&state=${state}`, {
      headers: { cookie: `${OAUTH_COOKIE}=${flowCookie}; slotmirror_resume=${resume}` },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`/oauth/authorize?${query}`);
    expect(callback.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    expect(callback.headers.get("set-cookie")).toMatch(/slotmirror_resume=;/);
  });

  it("ignores a forged resume cookie and goes home", async () => {
    const login = await fetchApp("/auth/microsoft/login");
    const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
    const flowCookie = new RegExp(`${OAUTH_COOKIE}=([^;]+)`).exec(
      login.headers.get("set-cookie") ?? "",
    )?.[1];
    const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        access_token: "a",
        expires_in: 3600,
        id_token: `${encode({ alg: "none" })}.${encode({
          tid: "t1",
          oid: "o1",
          preferred_username: "owner@example.com",
        })}.s`,
      }),
    );
    const forged = `${encode({ path: "https://evil.example/", exp: 9_999_999_999 })}.sig`;
    const callback = await fetchApp(`/auth/microsoft/callback?code=abc&state=${state}`, {
      headers: { cookie: `${OAUTH_COOKIE}=${flowCookie}; slotmirror_resume=${forged}` },
    });
    expect(callback.headers.get("location")).toBe("/");
  });

  it("ignores a signed resume cookie whose path is not the authorization endpoint", async () => {
    const login = await fetchApp("/auth/microsoft/login");
    const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
    const flowCookie = new RegExp(`${OAUTH_COOKIE}=([^;]+)`).exec(
      login.headers.get("set-cookie") ?? "",
    )?.[1];
    const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        access_token: "a",
        expires_in: 3600,
        id_token: `${encode({ alg: "none" })}.${encode({
          tid: "t1",
          oid: "o1",
          preferred_username: "owner@example.com",
        })}.s`,
      }),
    );
    const signed = await signResume(env, "//evil.example/oauth/authorize?x");
    const callback = await fetchApp(`/auth/microsoft/callback?code=abc&state=${state}`, {
      headers: { cookie: `${OAUTH_COOKIE}=${flowCookie}; slotmirror_resume=${signed}` },
    });
    expect(callback.headers.get("location")).toBe("/");
    for (const path of ["//evil.example/oauth/authorize?x", "/admin", "https://evil.example/"]) {
      expect(await resumeTarget(env, await signResume(env, path))).toBeNull();
    }
    expect(await resumeTarget(env, await signResume(env, "/oauth/authorize?a=1"))).toBe(
      "/oauth/authorize?a=1",
    );
  });

  it("refuses a redirect host that a CSP source cannot hold", async () => {
    for (const uri of [
      "https://x,script-src/cb",
      "https://a$&b.example/cb",
      "https://a;b.example/cb",
    ]) {
      const response = await register({ redirect_uris: [uri] });
      expect(response.status).toBe(400);
    }
  });

  it("holds the decision buttons until the page has been seen", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { html } = await consent(cookie, flow);
    expect(html).toMatch(/<form[^>]*data-hold/);
    // Served off: a click that lands before the script runs hits nothing. Without a script, the
    // noscript form decides.
    const held = /<form[^>]*data-hold[^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
    expect(held.match(/<button[^>]*disabled/g)).toHaveLength(2);
    expect(html).toMatch(/<noscript>[\s\S]*<form[^>]*action="\/oauth\/authorize"/);
    // The script turns them on. Its hold block comes first, so that no error in a later part of
    // the shared page script can leave the consent buttons off for good.
    const script = String(editorScript);
    const firstCode = script
      .split("\n")
      .find((line) => line.trim() !== "" && !line.startsWith("//"));
    expect(firstCode).toBe("{");
    const hold = script.slice(0, script.indexOf("\n}\n"));
    expect(hold).toContain('querySelectorAll("form[data-hold] button")');
    expect(hold).toContain("button.disabled = false");
  });

  it("shows the client's name, where it returns to, and allows that origin as form target", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient({ client_name: "<b>Agent</b>" });
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { response, html, ticket } = await consent(cookie, flow);
    expect(response.status).toBe(200);
    expect(ticket).toBeTruthy();
    expect(html).toContain("&lt;b&gt;Agent&lt;/b&gt;");
    expect(html).not.toContain("<b>Agent</b>");
    expect(html).toContain("127.0.0.1:33418");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self' http://127.0.0.1:33418",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("frames the consent as a step outside the app: no navigation, the account that answers", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient({ client_name: "Agent" });
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { html } = await consent(cookie, flow);
    // Like the sign-in page: the logo bar, but no sidebar, page links or user menu.
    expect(html).toContain('class="topbar"');
    expect(html).not.toContain("has-sidebar");
    expect(html).not.toContain('href="/rules"');
    expect(html).not.toContain('popovertarget="user-menu"');
    expect(html).toContain("Signed in as owner@example.com");
    // The tile shows a letter, never a logo, and the warning and the target stay on the page.
    expect(html).toMatch(/class="consent-tile app"[^>]*>A</);
    expect(html).toContain("slotmirror did not check it");
    expect(html).toContain("Your answer goes back to 127.0.0.1:33418.");
    // The logo appears twice; each pattern id must be unique, or the second mark loses its hatch.
    const ids = [...html.matchAll(/<pattern id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("puts a letter or digit in the app tile, never a symbol that could read as a badge", async () => {
    const { cookie } = await signIn("owner@example.com");
    const cases: [string, string][] = [
      ["\u2705 Verified companion", "V"],
      ["\u200b\u0301agent", "A"],
      ["\ufdfd", "?"],
      ["42 tools", "4"],
    ];
    for (const [name, initial] of cases) {
      const client = await registeredClient({ client_name: name });
      const flow: Flow = {
        clientId: client.client_id,
        verifier: newVerifier(),
        redirectUri: LOOPBACK,
      };
      const { html } = await consent(cookie, flow);
      expect(/class="consent-tile app"[^>]*>([^<]*)</.exec(html)?.[1]).toBe(initial);
    }
  });

  it("signs out a user who is not the right one, and the request waits for the next sign-in", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient({ client_name: "Agent" });
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { html } = await consent(cookie, flow);
    const query = authorizeQuery(flow, await challengeOf(flow.verifier));
    const form = /<form method="post" action="\/auth\/logout"[^>]*>([\s\S]*?)<\/form>/.exec(html);
    expect(form?.[1]).toContain("Not you?");
    const resume = /name="resume" value="([^"]+)"/
      .exec(form?.[1] ?? "")?.[1]
      ?.replaceAll("&amp;", "&");
    expect(resume).toBe(`/oauth/authorize?${query}`);

    const out = await postForm("/auth/logout", { resume: resume ?? "" }, { cookie, origin: BASE });
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(`/oauth/authorize?${query}`);
    expect(out.headers.get("set-cookie")).toMatch(/slotmirror_session=;/);
    // Signed out, the same request sets the resume cookie, as for any visitor.
    const again = await fetchApp(`/oauth/authorize?${query}`);
    expect(again.headers.get("location")).toBe("/");
    expect(again.headers.get("set-cookie")).toContain("slotmirror_resume=");

    // Any other target goes home, so the form cannot send a user to another page or site.
    for (const target of [
      "https://evil.example/",
      "//evil.example/",
      "/rules",
      "/oauth/authorizeX",
      // A line break would make the Location header throw; a long path would not fit the cookie.
      "/oauth/authorize?a\r\nb",
      `/oauth/authorize?${"a".repeat(2000)}`,
    ]) {
      const response = await postForm("/auth/logout", { resume: target }, { origin: BASE });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
    }
  });

  it("accepts any port for a loopback redirect, but not another path", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const base: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const otherPort = await consent(cookie, {
      ...base,
      redirectUri: "http://127.0.0.1:5000/callback",
    });
    expect(otherPort.response.status).toBe(200);
    const otherPath = await consent(cookie, {
      ...base,
      redirectUri: "http://127.0.0.1:5000/other",
    });
    expect(otherPath.response.status).toBe(400);
    expect(otherPath.response.headers.get("location")).toBeNull();
  });

  it("never redirects for an unknown client or an unregistered redirect", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    for (const flow of [
      { clientId: "smc_unknown", verifier: newVerifier(), redirectUri: LOOPBACK },
      {
        clientId: client.client_id,
        verifier: newVerifier(),
        redirectUri: "https://evil.example/cb",
      },
    ]) {
      const { response } = await consent(cookie, flow);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("shows request errors on a page and never redirects to a client before the user acts", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge: "" }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
    ];
    // A registered client of anyone's choosing must not turn this endpoint into an open redirect
    // (RFC 9700 4.11.2). Signed in or not, the error stays on this site.
    for (const [extra, error] of cases) {
      const variants: Record<string, string>[] = [{ cookie }, {}];
      for (const headers of variants) {
        const query = authorizeQuery(flow, await challengeOf(flow.verifier), extra);
        const response = await fetchApp(`/oauth/authorize?${query}`, { headers });
        expect(response.status).toBe(400);
        expect(response.headers.get("location")).toBeNull();
        expect(await response.text()).toContain(error);
      }
    }
  });

  it("returns a code with the state and the issuer if the user allows", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { ticket } = await consent(cookie, flow);
    const response = await postForm(
      "/oauth/authorize",
      { ticket: ticket ?? "", decision: "allow" },
      { cookie, origin: BASE },
    );
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("code")).toMatch(/^sm_ac_/);
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("iss")).toBe(BASE);
  });

  it("returns access_denied if the user denies, and stores no code", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { ticket } = await consent(cookie, flow);
    const response = await postForm(
      "/oauth/authorize",
      { ticket: ticket ?? "", decision: "deny" },
      { cookie, origin: BASE },
    );
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
    const codes = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_codes").first<{
      n: number;
    }>();
    expect(codes?.n).toBe(0);
  });

  it("refuses a changed ticket and the ticket of another user", async () => {
    const owner = await signIn("owner@example.com");
    const other = await signIn("other@elsewhere.org");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { ticket } = await consent(owner.cookie, flow);
    const [body = "", signature = ""] = (ticket ?? "").split(".");
    const changed = `${body.slice(0, -2)}AA.${signature}`;
    for (const [value, cookie] of [
      [changed, owner.cookie],
      [ticket ?? "", other.cookie],
    ] as const) {
      const response = await postForm(
        "/oauth/authorize",
        { ticket: value, decision: "allow" },
        { cookie, origin: BASE },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("refuses a cross-site POST of the decision", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { ticket } = await consent(cookie, flow);
    const response = await postForm(
      "/oauth/authorize",
      { ticket: ticket ?? "", decision: "allow" },
      { cookie, origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
  });
});

describe("token endpoint", () => {
  it("exchanges a code for an access token that reads only the user's data", async () => {
    const { tokens, user } = await connected();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:read" });
    expect(tokens.access_token).toMatch(/^sm_oat_/);
    expect(tokens.refresh_token).toMatch(/^sm_ort_/);
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES ('mine', ?, 'google', 'm@example.com')",
    )
      .bind(user.id)
      .run();
    const other = await signIn("other@elsewhere.org");
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES ('theirs', ?, 'google', 't@example.com')",
    )
      .bind(other.user.id)
      .run();
    const response = await mcpCall(tokens.access_token, "tools/call", {
      name: "list_accounts",
      arguments: {},
    });
    const text = JSON.stringify(await response.json());
    expect(text).toContain("m@example.com");
    expect(text).not.toContain("t@example.com");
  });

  it("answers the token response uncached and stores no token", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const response = await exchange(flow, await codeFor(cookie, flow));
    expect(response.headers.get("cache-control")).toBe("no-store");
    const tokens = (await response.json()) as Tokens;
    const rows = await env.DB.prepare("SELECT * FROM oauth_grants").all();
    expect(JSON.stringify(rows.results)).not.toContain(tokens.refresh_token);
    expect(JSON.stringify(rows.results)).not.toContain(tokens.access_token);
  });

  it("takes a code once, and only with its verifier, redirect and client", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const other = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const wrongs: Record<string, string>[] = [
      { code_verifier: newVerifier() },
      { redirect_uri: "http://127.0.0.1:33418/other" },
      { client_id: other.client_id },
    ];
    for (const extra of wrongs) {
      const code = await codeFor(cookie, flow);
      const wrong = await exchange(flow, code, extra);
      expect(wrong.status).toBe(400);
      expect(((await wrong.json()) as Json).error).toBe("invalid_grant");
      // A failed attempt uses the code up, so that a verifier cannot be guessed.
      expect((await exchange(flow, code)).status).toBe(400);
    }
    const code = await codeFor(cookie, flow);
    expect((await exchange(flow, code)).status).toBe(200);
    expect((await exchange(flow, code)).status).toBe(400);
  });

  it("refuses an expired code", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const code = await codeFor(cookie, flow);
    await env.DB.prepare("UPDATE oauth_codes SET expires_at = '2020-01-01T00:00:00.000Z'").run();
    expect((await exchange(flow, code)).status).toBe(400);
  });

  it("asks a confidential client for its secret", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient({ token_endpoint_auth_method: "client_secret_basic" });
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const without = await exchange(flow, await codeFor(cookie, flow));
    expect(without.status).toBe(401);
    expect(((await without.json()) as Json).error).toBe("invalid_client");
    const basic = btoa(`${client.client_id}:${String(client.client_secret)}`);
    const wrongSecret = await exchange(flow, await codeFor(cookie, flow), {
      client_secret: "sm_cs_wrong",
    });
    expect(wrongSecret.status).toBe(401);
    const ok = await postForm(
      "/oauth/token",
      {
        grant_type: "authorization_code",
        code: await codeFor(cookie, flow),
        redirect_uri: flow.redirectUri,
        code_verifier: flow.verifier,
      },
      { authorization: `Basic ${basic}` },
    );
    expect(ok.status).toBe(200);
  });

  it("answers invalid_client, not a server error, for a malformed Basic header", async () => {
    const response = await postForm(
      "/oauth/token",
      { grant_type: "authorization_code", code: "x" },
      { authorization: `Basic ${btoa("smc_x%zz:secret")}` },
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as Json).error).toBe("invalid_client");
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  it("decodes a form-encoded secret in the Basic header", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient({ token_endpoint_auth_method: "client_secret_basic" });
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const secret = String(client.client_secret);
    const encoded = encodeURIComponent(secret).replaceAll("%20", "+");
    const response = await postForm(
      "/oauth/token",
      {
        grant_type: "authorization_code",
        code: await codeFor(cookie, flow),
        redirect_uri: flow.redirectUri,
        code_verifier: flow.verifier,
      },
      { authorization: `Basic ${btoa(`${client.client_id}:${encoded}`)}` },
    );
    expect(response.status).toBe(200);
  });

  it("ends the grant of a code that comes back after its exchange", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const code = await codeFor(cookie, flow);
    const tokens = (await (await exchange(flow, code)).json()) as Tokens;
    expect((await mcpCall(tokens.access_token)).status).toBe(200);
    expect((await exchange(flow, code)).status).toBe(400);
    // RFC 6749 4.1.2: someone else holds the code, so the tokens it gave are no longer safe.
    expect((await mcpCall(tokens.access_token)).status).toBe(401);
  });

  it("takes a token request without redirect_uri if the client registered only one", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const code = await codeFor(cookie, flow);
    const response = await postForm("/oauth/token", {
      grant_type: "authorization_code",
      code,
      client_id: flow.clientId,
      code_verifier: flow.verifier,
    });
    expect(response.status).toBe(200);
  });

  it("keeps one live code per request: a repeated decision replaces the earlier code", async () => {
    const { cookie } = await signIn("owner@example.com");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { ticket } = await consent(cookie, flow);
    const decide = async () => {
      const response = await postForm(
        "/oauth/authorize",
        { ticket: ticket ?? "", decision: "allow" },
        { cookie, origin: BASE },
      );
      return new URL(response.headers.get("location") ?? "").searchParams.get("code") ?? "";
    };
    const first = await decide();
    const second = await decide();
    expect((await exchange(flow, first)).status).toBe(400);
    expect((await exchange(flow, second)).status).toBe(200);
  });

  it("names an unsupported grant type", async () => {
    const response = await postForm("/oauth/token", { grant_type: "password" });
    expect(((await response.json()) as Json).error).toBe("unsupported_grant_type");
  });

  it("rotates the refresh token and keeps the older access token until it expires", async () => {
    const { flow, tokens } = await connected();
    const response = await refresh(flow, tokens.refresh_token);
    expect(response.status).toBe(200);
    const next = (await response.json()) as Tokens;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect((await mcpCall(next.access_token)).status).toBe(200);
    // A second instance of the same app may still hold the older access token; it works for its
    // hour, and ending the grant ends it at once.
    expect((await mcpCall(tokens.access_token)).status).toBe(200);
  });

  it("lets the loser of two racing refreshes fail without ending the grant", async () => {
    const { flow, tokens } = await connected();
    const next = (await (await refresh(flow, tokens.refresh_token)).json()) as Tokens;
    expect((await refresh(flow, tokens.refresh_token)).status).toBe(400);
    expect((await mcpCall(next.access_token)).status).toBe(200);
  });

  it("ends the whole grant if an old refresh token comes back", async () => {
    const { flow, tokens } = await connected();
    const next = (await (await refresh(flow, tokens.refresh_token)).json()) as Tokens;
    // Past the race window of the refresh before.
    await env.DB.prepare("UPDATE oauth_grants SET refreshed_at = ?")
      .bind(new Date(Date.now() - 60_000).toISOString())
      .run();
    const replay = await refresh(flow, tokens.refresh_token);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as Json).error).toBe("invalid_grant");
    expect((await refresh(flow, next.refresh_token)).status).toBe(400);
    expect((await mcpCall(next.access_token)).status).toBe(401);
  });

  it("ends the grant also for a refresh token two or more rotations old", async () => {
    const { flow, tokens } = await connected();
    const second = (await (await refresh(flow, tokens.refresh_token)).json()) as Tokens;
    const third = (await (await refresh(flow, second.refresh_token)).json()) as Tokens;
    // Someone rotated twice with a copy; the real client comes back with the first token.
    expect((await refresh(flow, tokens.refresh_token)).status).toBe(400);
    expect((await refresh(flow, third.refresh_token)).status).toBe(400);
    expect((await mcpCall(third.access_token)).status).toBe(401);
  });

  it("ends nothing for a forged refresh token that names a grant", async () => {
    const { flow, tokens } = await connected();
    const grant = await env.DB.prepare("SELECT id FROM oauth_grants").first<{ id: string }>();
    const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
    const forged = `sm_ort_${encode({ typ: "refresh", grant: grant?.id, gen: -1, exp: 9_999_999_999 })}.AAAA`;
    expect((await refresh(flow, forged)).status).toBe(400);
    expect((await mcpCall(tokens.access_token)).status).toBe(200);
  });

  it("refuses a refresh token of another client", async () => {
    const { flow, tokens } = await connected();
    const other = await registeredClient();
    const response = await refresh({ ...flow, clientId: other.client_id }, tokens.refresh_token);
    expect(response.status).toBe(400);
    expect((await refresh(flow, tokens.refresh_token)).status).toBe(200);
  });

  it("refuses an access token that is changed, expired, or meant for another resource", async () => {
    const { tokens } = await connected();
    const grant = await env.DB.prepare("SELECT id, generation FROM oauth_grants").first<{
      id: string;
      generation: number;
    }>();
    const changed = `${tokens.access_token.slice(0, -2)}AA`;
    const expired = await signAccessToken(env, {
      grantId: grant?.id ?? "",
      generation: grant?.generation ?? 0,
      audience: RESOURCE,
      expiresAt: Date.now() - 1000,
    });
    const foreign = await signAccessToken(env, {
      grantId: grant?.id ?? "",
      generation: grant?.generation ?? 0,
      audience: "https://other.example/mcp",
      expiresAt: Date.now() + 60_000,
    });
    for (const token of [changed, expired, foreign]) {
      expect((await mcpCall(token)).status).toBe(401);
    }
    expect((await mcpCall(tokens.access_token)).status).toBe(200);
  });

  it("keeps one grant per user and client: a new authorization replaces the old", async () => {
    const { cookie, flow, tokens } = await connected();
    const second = (await (await exchange(flow, await codeFor(cookie, flow))).json()) as Tokens;
    expect((await mcpCall(tokens.access_token)).status).toBe(401);
    expect((await mcpCall(second.access_token)).status).toBe(200);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_grants").first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);
  });

  it("forgets expired connections: they free their slot and leave the list", async () => {
    const { MAX_GRANTS_PER_USER } = await import("../src/mcp-oauth");
    const { cookie, user } = await signIn("owner@example.com");
    for (let i = 0; i < MAX_GRANTS_PER_USER; i++) {
      const client = await registeredClient({ client_name: `App ${i}` });
      const flow: Flow = {
        clientId: client.client_id,
        verifier: newVerifier(),
        redirectUri: LOOPBACK,
      };
      expect((await exchange(flow, await codeFor(cookie, flow))).status).toBe(200);
    }
    await env.DB.prepare(
      "UPDATE oauth_grants SET refresh_expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?",
    )
      .bind(user.id)
      .run();
    const page = await (await fetchApp("/tokens", { headers: { cookie } })).text();
    expect(page).not.toContain("App 0");
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    expect((await exchange(flow, await codeFor(cookie, flow))).status).toBe(200);
  });

  it("keeps the old grant if a new one for the same app does not fit", async () => {
    const { MAX_GRANTS_PER_USER } = await import("../src/mcp-oauth");
    const { cookie, flow, tokens } = await connected();
    // The consent passed; then other apps fill the user's slots before the exchange.
    const code = await codeFor(cookie, { ...flow, verifier: flow.verifier });
    for (let i = 1; i < MAX_GRANTS_PER_USER; i++) {
      const client = await registeredClient();
      const other: Flow = {
        clientId: client.client_id,
        verifier: newVerifier(),
        redirectUri: LOOPBACK,
      };
      expect((await exchange(other, await codeFor(cookie, other))).status).toBe(200);
    }
    const extra = await registeredClient();
    await env.DB.prepare(
      `INSERT INTO oauth_grants (id, client_id, user_id, scope, resource, session_version,
                                 refresh_hash, refresh_expires_at, expires_at)
       SELECT ?, ?, user_id, 'mcp:read', ?, session_version, 'x', '2099-01-01', '2099-01-01'
       FROM oauth_grants LIMIT 1`,
    )
      .bind(crypto.randomUUID(), extra.client_id, RESOURCE)
      .run();
    expect((await exchange(flow, code)).status).toBe(400);
    expect((await mcpCall(tokens.access_token)).status).toBe(200);
  });

  it("marks a client as used only when its grant was made", async () => {
    const { MAX_GRANTS_PER_USER } = await import("../src/mcp-oauth");
    const { cookie } = await signIn("owner@example.com");
    const late = await registeredClient();
    const lateFlow: Flow = {
      clientId: late.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const code = await codeFor(cookie, lateFlow);
    for (let i = 0; i < MAX_GRANTS_PER_USER; i++) {
      const client = await registeredClient();
      const flow: Flow = {
        clientId: client.client_id,
        verifier: newVerifier(),
        redirectUri: LOOPBACK,
      };
      expect((await exchange(flow, await codeFor(cookie, flow))).status).toBe(200);
    }
    expect((await exchange(lateFlow, code)).status).toBe(400);
    const row = await env.DB.prepare("SELECT last_used_at AS used FROM oauth_clients WHERE id = ?")
      .bind(late.client_id)
      .first<{ used: string | null }>();
    expect(row?.used).toBeNull();
  });

  it("stops at the maximum of connected apps per user", async () => {
    const { MAX_GRANTS_PER_USER } = await import("../src/mcp-oauth");
    const { cookie } = await signIn("owner@example.com");
    for (let i = 0; i < MAX_GRANTS_PER_USER; i++) {
      const client = await registeredClient();
      const flow: Flow = {
        clientId: client.client_id,
        verifier: newVerifier(),
        redirectUri: LOOPBACK,
      };
      expect((await exchange(flow, await codeFor(cookie, flow))).status).toBe(200);
    }
    const client = await registeredClient();
    const flow: Flow = {
      clientId: client.client_id,
      verifier: newVerifier(),
      redirectUri: LOOPBACK,
    };
    const { response } = await consent(cookie, flow);
    expect(response.status).toBe(409);
  });
});

describe("ending a connection", () => {
  it("lists the app on the token page and disconnects it", async () => {
    const { cookie, tokens } = await connected();
    const page = await fetchApp("/tokens", { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain("Test agent");
    const grantId = /action="\/tokens\/apps\/([^/]+)\/revoke"/.exec(html)?.[1];
    expect(grantId).toBeTruthy();
    const response = await postForm(`/tokens/apps/${grantId}/revoke`, {}, { cookie, origin: BASE });
    expect(response.status).toBe(302);
    expect((await mcpCall(tokens.access_token)).status).toBe(401);
  });

  it("shows the admin's end button for a user who has only a connected app", async () => {
    const admin = await signIn("admin@example.com");
    const { user } = await connected();
    const page = await (await fetchApp("/admin", { headers: { cookie: admin.cookie } })).text();
    expect(page).toContain(`/admin/users/${user.id}/revoke-tokens`);
  });

  it("ends grants with the admin's End API tokens and with a sign-in reset", async () => {
    const admin = await signIn("admin@example.com");
    for (const path of ["revoke-tokens", "reset-sign-in"]) {
      const { user, tokens, flow } = await connected();
      const response = await postForm(
        `/admin/users/${user.id}/${path}`,
        {},
        { cookie: admin.cookie, origin: BASE },
      );
      expect(response.status).toBe(302);
      expect((await mcpCall(tokens.access_token)).status).toBe(401);
      expect((await refresh(flow, tokens.refresh_token)).status).toBe(400);
      // The rows go too: a reset must free the slots, not only stop the tokens.
      const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ?")
        .bind(user.id)
        .first<{ n: number }>();
      expect(left?.n).toBe(0);
    }
  });

  it("keeps the grant through a refresh while the policy does not admit the user", async () => {
    const { flow, tokens } = await connected();
    const response = await fetchWith({ ALLOWED_EMAILS: "other@elsewhere.org" }, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: flow.clientId,
      }).toString(),
    });
    expect(response.status).toBe(400);
    // The policy admits the user again: the same refresh token still works.
    expect((await refresh(flow, tokens.refresh_token)).status).toBe(200);
  });

  it("stops the access token while the policy does not admit the user", async () => {
    const { tokens } = await connected();
    const response = await fetchWith({ ALLOWED_EMAILS: "other@elsewhere.org" }, "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("revokes a refresh token at the revocation endpoint and answers 200 for unknown ones", async () => {
    const { flow, tokens } = await connected();
    const response = await postForm("/oauth/revoke", {
      token: tokens.refresh_token,
      client_id: flow.clientId,
    });
    expect(response.status).toBe(200);
    expect((await mcpCall(tokens.access_token)).status).toBe(401);
    const unknown = await postForm("/oauth/revoke", {
      token: "sm_ort_nope",
      client_id: flow.clientId,
    });
    expect(unknown.status).toBe(200);
  });

  it("revokes the grant of an access token, and asks an unknown client to authenticate", async () => {
    const { flow, tokens } = await connected();
    const response = await postForm("/oauth/revoke", {
      token: tokens.access_token,
      client_id: flow.clientId,
    });
    expect(response.status).toBe(200);
    expect((await refresh(flow, tokens.refresh_token)).status).toBe(400);
    const stranger = await postForm("/oauth/revoke", { token: "x", client_id: "smc_nobody" });
    expect(stranger.status).toBe(401);
    expect(stranger.headers.get("www-authenticate")).toContain("Basic");
  });
});
