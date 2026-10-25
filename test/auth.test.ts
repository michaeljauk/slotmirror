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
    expect(identity).toEqual({ email: "a@b.com", tenantId: "t", objectId: "o" });
  });

  it("throws without any address claim", () => {
    expect(() => identityFromIdToken(fakeIdToken({ tid: "t", oid: "o" }))).toThrow();
  });
});
