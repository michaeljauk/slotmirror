import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAUTH_COOKIE } from "../src/oauth";
import { identityFromIdToken } from "../src/providers/microsoft";
import { base64url, SESSION_COOKIE } from "../src/session";
import { addAccount, BASE, signIn } from "./helpers";

function fakeIdToken(claims: Record<string, string>): string {
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function mockTokenEndpoint(body: Record<string, unknown>, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(body, { status }));
}

/** Start a flow and return the OAuth cookie and the state the provider would echo back. */
async function startFlow(
  path: string,
  cookie?: string,
): Promise<{ cookie: string; state: string }> {
  const response = await exports.default.fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  const setCookie = response.headers.get("set-cookie") ?? "";
  const value = new RegExp(`${OAUTH_COOKIE}=([^;]+)`).exec(setCookie)?.[1];
  if (!value) throw new Error("No OAuth cookie set");
  return { cookie: `${OAUTH_COOKIE}=${value}`, state: location.searchParams.get("state") ?? "" };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Microsoft sign-in", () => {
  it("redirects to Microsoft with PKCE and sign-in scopes only", async () => {
    const response = await exports.default.fetch(`${BASE}/auth/microsoft/login`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://login.microsoftonline.com");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/microsoft/callback`);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("rejects a callback whose state does not match", async () => {
    const flow = await startFlow("/auth/microsoft/login");
    const response = await exports.default.fetch(
      `${BASE}/auth/microsoft/callback?code=abc&state=wrong`,
      { headers: { cookie: flow.cookie }, redirect: "manual" },
    );
    expect(response.status).toBe(400);
  });

  it("signs in an owner and sets the session cookie", async () => {
    const flow = await startFlow("/auth/microsoft/login");
    const fetchSpy = mockTokenEndpoint({
      access_token: "access",
      expires_in: 3600,
      id_token: fakeIdToken({ tid: "t1", oid: "o1", preferred_username: "Owner@Example.com" }),
    });

    const response = await exports.default.fetch(
      `${BASE}/auth/microsoft/callback?code=abc&state=${flow.state}`,
      { headers: { cookie: flow.cookie }, redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    const form = init?.body as URLSearchParams;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBeTruthy();
  });

  it("refuses an account that is not an owner", async () => {
    const flow = await startFlow("/auth/microsoft/login");
    mockTokenEndpoint({
      access_token: "access",
      expires_in: 3600,
      id_token: fakeIdToken({ tid: "t1", oid: "o1", email: "stranger@example.com" }),
    });
    const response = await exports.default.fetch(
      `${BASE}/auth/microsoft/callback?code=abc&state=${flow.state}`,
      { headers: { cookie: flow.cookie }, redirect: "manual" },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie") ?? "").not.toContain(`${SESSION_COOKIE}=`);
  });
});

describe("Microsoft connect", () => {
  it("requires a session", async () => {
    const response = await exports.default.fetch(`${BASE}/auth/microsoft/connect`, {
      redirect: "manual",
    });
    expect(response.headers.get("location")).toBe("/");
  });

  it("stores the account in D1 and the tokens in its Durable Object", async () => {
    const { cookie: session } = await signIn("owner@example.com");
    const flow = await startFlow("/auth/microsoft/connect", session);
    mockTokenEndpoint({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      id_token: fakeIdToken({ tid: "tenant-a", oid: "o2", preferred_username: "work@example.com" }),
    });

    const response = await exports.default.fetch(
      `${BASE}/auth/microsoft/callback?code=abc&state=${flow.state}`,
      { headers: { cookie: `${flow.cookie}; ${session}` }, redirect: "manual" },
    );
    expect(response.status).toBe(302);

    const account = await env.DB.prepare(
      "SELECT id, tenant_id FROM accounts WHERE provider = 'microsoft' AND email = ?",
    )
      .bind("work@example.com")
      .first<{ id: string; tenant_id: string }>();
    expect(account?.tenant_id).toBe("tenant-a");

    const stub = env.ACCOUNT_SYNC.getByName(account?.id ?? "");
    expect(await stub.hasTokens()).toBe(true);
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ account_id: string }>("SELECT account_id FROM tokens").one(),
    );
    expect(stored.account_id).toBe(account?.id);
  });

  it("clears needs_reconnect when the same account connects again", async () => {
    const { user, cookie: session } = await signIn("owner@example.com");
    await addAccount(user.id, "acc-reconnect", "reconnect@example.com");
    await env.DB.prepare(
      "UPDATE accounts SET needs_reconnect = 1 WHERE id = 'acc-reconnect'",
    ).run();
    const flow = await startFlow("/auth/microsoft/connect", session);
    mockTokenEndpoint({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      id_token: fakeIdToken({ tid: "t", oid: "o3", preferred_username: "reconnect@example.com" }),
    });

    const response = await exports.default.fetch(
      `${BASE}/auth/microsoft/callback?code=abc&state=${flow.state}`,
      { headers: { cookie: `${flow.cookie}; ${session}` }, redirect: "manual" },
    );
    expect(response.status).toBe(302);
    const { results } = await env.DB.prepare(
      "SELECT id, needs_reconnect AS flag FROM accounts WHERE email = 'reconnect@example.com'",
    ).all<{ id: string; flag: number }>();
    expect(results).toEqual([{ id: "acc-reconnect", flag: 0 }]);
    expect(await env.ACCOUNT_SYNC.getByName("acc-reconnect").hasTokens()).toBe(true);

    // The dashboard no longer asks to reconnect.
    vi.restoreAllMocks();
    const home = await (
      await exports.default.fetch(`${BASE}/`, { headers: { cookie: session } })
    ).text();
    expect(home).not.toContain("reconnect-notice");
  });
});

describe("reconnect links", () => {
  async function connectLocation(path: string, cookie: string): Promise<URL> {
    const response = await exports.default.fetch(`${BASE}${path}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location") ?? "");
  }

  it("passes the address of the user's own account as login_hint, encoded", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await addAccount(user.id, "acc-hint", "a+b&prompt=none@example.com");
    const location = await connectLocation("/auth/microsoft/connect?account=acc-hint", cookie);
    expect(location.origin).toBe("https://login.microsoftonline.com");
    expect(location.searchParams.get("login_hint")).toBe("a+b&prompt=none@example.com");
    expect(location.searchParams.getAll("prompt")).toEqual(["select_account"]);

    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES ('acc-hint-g', ?, 'google', 'g@example.com')",
    )
      .bind(user.id)
      .run();
    const google = await connectLocation("/auth/google/connect?account=acc-hint-g", cookie);
    expect(google.searchParams.get("login_hint")).toBe("g@example.com");
  });

  it("gives no hint for another user's account, another provider or an unknown ID", async () => {
    const other = await signIn("other@elsewhere.org");
    await addAccount(other.user.id, "acc-hint-other", "secret-other@example.com");
    const { user, cookie } = await signIn("owner@example.com");
    await addAccount(user.id, "acc-hint-ms", "mine@example.com");
    for (const path of [
      "/auth/microsoft/connect?account=acc-hint-other",
      "/auth/google/connect?account=acc-hint-ms",
      "/auth/microsoft/connect?account=nope",
      "/auth/microsoft/connect?account=https%3A%2F%2Fevil.example",
    ]) {
      const location = await connectLocation(path, cookie);
      expect(location.searchParams.has("login_hint")).toBe(false);
      expect(location.toString()).not.toContain("secret-other");
      expect(location.toString()).not.toContain("evil.example");
    }
  });
});

describe("Microsoft connect conflicts", () => {
  it("refuses an account that another user already connected", async () => {
    const other = await signIn("other@elsewhere.org");
    await addAccount(other.user.id, "acc-taken", "shared@example.com");

    const { cookie: session } = await signIn("owner@example.com");
    const flow = await startFlow("/auth/microsoft/connect", session);
    mockTokenEndpoint({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      id_token: fakeIdToken({ tid: "t", oid: "o", preferred_username: "shared@example.com" }),
    });
    const response = await exports.default.fetch(
      `${BASE}/auth/microsoft/callback?code=abc&state=${flow.state}`,
      { headers: { cookie: `${flow.cookie}; ${session}` }, redirect: "manual" },
    );
    expect(response.status).toBe(409);
    const owner = await env.DB.prepare(
      "SELECT user_id FROM accounts WHERE id = 'acc-taken'",
    ).first<{
      user_id: string;
    }>();
    expect(owner?.user_id).toBe(other.user.id);
  });
});

describe("identityFromIdToken", () => {
  it("prefers the email claim and lowercases it", () => {
    const identity = identityFromIdToken(
      fakeIdToken({ tid: "t", oid: "o", email: "A@B.com", preferred_username: "x@y.com" }),
    );
    expect(identity).toEqual({ email: "a@b.com", tenantId: "t" });
  });

  it("throws without any address claim", () => {
    expect(() => identityFromIdToken(fakeIdToken({ tid: "t", oid: "o" }))).toThrow();
  });
});

/** All audit rows of a kind, with the detail parsed. */
async function auditRows(kind: string) {
  const { results } = await env.DB.prepare(
    "SELECT org_id, user_id, account_id, kind, detail FROM audit_events WHERE kind = ? ORDER BY id",
  )
    .bind(kind)
    .all<{ org_id: string; user_id: string | null; account_id: string | null; detail: string }>();
  return results;
}

describe("audit events of the auth routes", () => {
  it("records a sign-in and a refusal without tokens or addresses", async () => {
    const before = (await auditRows("sign_in")).length;
    const refusedBefore = (await auditRows("sign_in_refused")).length;

    let flow = await startFlow("/auth/microsoft/login");
    mockTokenEndpoint({
      access_token: "secret-access-token",
      refresh_token: "secret-refresh-token",
      expires_in: 3600,
      id_token: fakeIdToken({ tid: "t1", oid: "o1", preferred_username: "owner@example.com" }),
    });
    await exports.default.fetch(`${BASE}/auth/microsoft/callback?code=abc&state=${flow.state}`, {
      headers: { cookie: flow.cookie },
      redirect: "manual",
    });
    vi.restoreAllMocks();

    flow = await startFlow("/auth/microsoft/login");
    mockTokenEndpoint({
      access_token: "secret-access-token",
      expires_in: 3600,
      id_token: fakeIdToken({ tid: "t1", oid: "o9", email: "stranger@example.com" }),
    });
    await exports.default.fetch(`${BASE}/auth/microsoft/callback?code=abc&state=${flow.state}`, {
      headers: { cookie: flow.cookie },
      redirect: "manual",
    });

    const signIns = await auditRows("sign_in");
    const refused = await auditRows("sign_in_refused");
    expect(signIns).toHaveLength(before + 1);
    expect(refused).toHaveLength(refusedBefore + 1);
    expect(signIns.at(-1)?.user_id).toBeTruthy();
    expect(refused.at(-1)).toMatchObject({ user_id: null, org_id: "default" });

    const { results } = await env.DB.prepare("SELECT * FROM audit_events").all();
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("secret-");
    expect(serialized).not.toContain("stranger@example.com");
  });

  it("records a connect and a sign-out", async () => {
    const { user, cookie: session } = await signIn("owner@example.com");
    const flow = await startFlow("/auth/microsoft/connect", session);
    mockTokenEndpoint({
      access_token: "secret-access-token",
      refresh_token: "secret-refresh-token",
      expires_in: 3600,
      id_token: fakeIdToken({ tid: "t", oid: "o", preferred_username: "audited@example.com" }),
    });
    await exports.default.fetch(`${BASE}/auth/microsoft/callback?code=abc&state=${flow.state}`, {
      headers: { cookie: `${flow.cookie}; ${session}` },
      redirect: "manual",
    });
    const account = await env.DB.prepare("SELECT id FROM accounts WHERE email = ?")
      .bind("audited@example.com")
      .first<{ id: string }>();
    const connected = (await auditRows("account_connected")).filter(
      (row) => row.account_id === account?.id,
    );
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({ user_id: user.id, detail: '{"provider":"microsoft"}' });

    await exports.default.fetch(`${BASE}/auth/logout`, {
      method: "POST",
      headers: { cookie: session },
      redirect: "manual",
    });
    expect((await auditRows("sign_out")).some((row) => row.user_id === user.id)).toBe(true);
  });
});
