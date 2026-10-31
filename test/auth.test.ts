import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAUTH_COOKIE } from "../src/oauth";
import { identityFromIdToken } from "../src/providers/microsoft";
import { base64url, SESSION_COOKIE } from "../src/session";
import { addAccount, BASE, signIn } from "./helpers";

function fakeIdToken(claims: Record<string, unknown>): string {
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
      id_token: fakeIdToken({
        tid: "t1",
        oid: "o-stranger",
        preferred_username: "stranger@example.com",
      }),
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
  const claims = { tid: "t", oid: "o", email: "A@B.com", preferred_username: "X@y.com" };

  it("counts the email claim as verified only with xms_edov, and lowercases it", () => {
    expect(identityFromIdToken(fakeIdToken({ ...claims, xms_edov: true }))).toEqual({
      provider: "microsoft",
      email: "a@b.com",
      tenantId: "t",
      subject: "o",
      addresses: ["a@b.com", "x@y.com"],
    });
    for (const edov of ["true", "1"]) {
      expect(identityFromIdToken(fakeIdToken({ ...claims, xms_edov: edov }))).toMatchObject({
        email: "a@b.com",
      });
    }
    // Without the claim, or with false, the email claim does not count as verified.
    for (const extra of [{}, { xms_edov: false }, { xms_edov: "0" }]) {
      expect(identityFromIdToken(fakeIdToken({ ...claims, ...extra }))).toEqual({
        provider: "microsoft",
        email: "x@y.com",
        tenantId: "t",
        subject: "o",
        addresses: ["x@y.com"],
        unverifiedEmail: "a@b.com",
      });
    }
  });

  it("does not throw on an xms_edov of an unexpected type", () => {
    for (const edov of [1, { value: true }, null, ["true"]]) {
      expect(identityFromIdToken(fakeIdToken({ ...claims, xms_edov: edov }))).toMatchObject({
        email: "x@y.com",
      });
    }
  });

  it("throws if only an unverified email claim names the user", () => {
    expect(() =>
      identityFromIdToken(fakeIdToken({ tid: "t", oid: "o", email: "a@b.com" })),
    ).toThrow();
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
      id_token: fakeIdToken({ tid: "t1", oid: "o9", preferred_username: "stranger@example.com" }),
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

/** Run a sign-in whose ID token carries these claims. */
async function providerSignIn(provider: "microsoft" | "google", claims: Record<string, unknown>) {
  const flow = await startFlow(`/auth/${provider}/login`);
  mockTokenEndpoint({ access_token: "access", expires_in: 3600, id_token: fakeIdToken(claims) });
  const response = await exports.default.fetch(
    `${BASE}/auth/${provider}/callback?code=abc&state=${flow.state}`,
    { headers: { cookie: flow.cookie }, redirect: "manual" },
  );
  vi.restoreAllMocks();
  const cookie = /slotmirror_session=[^;]+/.exec(response.headers.get("set-cookie") ?? "")?.[0];
  const refused = await env.DB.prepare(
    "SELECT detail FROM audit_events WHERE kind = 'sign_in_refused' ORDER BY id DESC",
  ).first<{ detail: string }>();
  return {
    status: response.status,
    session: cookie !== undefined,
    cookie,
    body: await response.text(),
    reason:
      response.status === 403
        ? (JSON.parse(refused?.detail ?? "{}") as { reason?: string }).reason
        : undefined,
  };
}

const microsoftSignIn = (claims: Record<string, unknown>) => providerSignIn("microsoft", claims);
const googleSignIn = (email: string, sub: string) =>
  providerSignIn("google", { sub, email, email_verified: true });

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";
const CONSUMER = "9188040d-6c67-4c5b-b112-36a304b66dad";

interface UserRow {
  id: string;
  email: string;
  tenant_id: string | null;
  ms_tenant_id: string | null;
  ms_object_id: string | null;
  google_subject: string | null;
}

async function userRow(email: string) {
  return env.DB.prepare(
    "SELECT id, email, tenant_id, ms_tenant_id, ms_object_id, google_subject FROM users WHERE email = ?",
  )
    .bind(email)
    .first<UserRow>();
}

/** A user row as it exists from before the binding: signed in with Microsoft, not bound yet. */
async function legacyUser(email: string, tenantId: string | null): Promise<string> {
  const { user } = await signIn(email);
  await env.DB.prepare("UPDATE users SET tenant_id = ? WHERE id = ?").bind(tenantId, user.id).run();
  return user.id;
}

/** The user ID a session cookie stands for, read from its payload. */
function sessionUser(cookie: string | undefined): string | undefined {
  const body = cookie?.split("=")[1]?.split(".")[0];
  if (!body) return undefined;
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(body.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    ),
  );
  return (JSON.parse(json) as { userId: string }).userId;
}

describe("Microsoft identity binding", () => {
  it("binds a user to tenant and object ID at the first sign-in", async () => {
    const first = await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-bound",
      preferred_username: "bound@org.example",
    });
    expect(first.status).toBe(302);
    expect(await userRow("bound@org.example")).toMatchObject({
      ms_tenant_id: TENANT_A,
      ms_object_id: "oid-bound",
    });

    const again = await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-bound",
      preferred_username: "bound@org.example",
    });
    expect(again).toMatchObject({ status: 302, session: true });
  });

  it("finds a bound user by tenant and object ID, whatever the address says", async () => {
    await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-move",
      preferred_username: "move@org.example",
    });
    const before = await userRow("move@org.example");
    const result = await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-move",
      preferred_username: "moved.upn@org.example",
    });
    expect(result.status).toBe(302);
    expect(sessionUser(result.cookie)).toBe(before?.id);
    // The stored address stays; no second user appears under the new UPN.
    expect(await userRow("move@org.example")).toMatchObject({ id: before?.id });
    expect(await userRow("moved.upn@org.example")).toBeNull();
  });

  it("refuses a sign-in with the same address from another tenant or object", async () => {
    await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-real",
      preferred_username: "real@org.example",
    });
    const before = await userRow("real@org.example");

    for (const claims of [
      { tid: TENANT_B, oid: "oid-other", preferred_username: "real@org.example" },
      { tid: TENANT_A, oid: "oid-other", preferred_username: "real@org.example" },
      { tid: TENANT_B, oid: "oid-real", preferred_username: "real@org.example" },
    ]) {
      const result = await microsoftSignIn(claims);
      expect(result).toMatchObject({ status: 403, session: false, reason: "identity" });
    }
    // The stored tenant stays the real user's.
    expect(await userRow("real@org.example")).toEqual(before);
  });

  it("binds an unbound user through the email claim of the tenant that signed them in", async () => {
    // Mail and UPN differ; the app registration sends no xms_edov.
    const aliceId = await legacyUser("alice@org.example", TENANT_A);
    const result = await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-alice",
      email: "alice@org.example",
      preferred_username: "a.smith@org.example",
    });
    expect(result.status).toBe(302);
    expect(sessionUser(result.cookie)).toBe(aliceId);
    expect(await userRow("alice@org.example")).toMatchObject({
      id: aliceId,
      ms_tenant_id: TENANT_A,
      ms_object_id: "oid-alice",
    });
    expect(await userRow("a.smith@org.example")).toBeNull();
  });

  it("never gives that user to the same unverified email claim from another tenant", async () => {
    const bobId = await legacyUser("bob@org.example", TENANT_A);
    const result = await microsoftSignIn({
      tid: TENANT_B,
      oid: "oid-intruder",
      email: "bob@org.example",
      preferred_username: "b.intruder@org.example",
    });
    expect(sessionUser(result.cookie)).not.toBe(bobId);
    expect(await userRow("bob@org.example")).toMatchObject({
      tenant_id: TENANT_A,
      ms_object_id: null,
    });
  });

  it("refuses an unbound admin address from an unverified email claim of another tenant", async () => {
    await legacyUser("admin@example.com", TENANT_A);
    const result = await microsoftSignIn({
      tid: TENANT_B,
      oid: "oid-mallory",
      email: "Admin@Example.com",
      preferred_username: "mallory@evil.example",
    });
    // The identity is mallory@evil.example, which the policy does not admit.
    expect(result).toMatchObject({ status: 403, session: false, reason: "policy" });
    expect(await userRow("admin@example.com")).toMatchObject({
      tenant_id: TENANT_A,
      ms_object_id: null,
    });
  });

  it("binds a user from before the binding through preferred_username", async () => {
    const id = await legacyUser("legacy@org.example", null);
    const result = await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-legacy",
      preferred_username: "legacy@org.example",
    });
    expect(result.status).toBe(302);
    expect(await userRow("legacy@org.example")).toMatchObject({ id, ms_object_id: "oid-legacy" });
  });

  it("never binds an existing user to a personal Microsoft account", async () => {
    await legacyUser("personal@org.example", CONSUMER);
    for (const claims of [
      { tid: CONSUMER, oid: "oid-msa", preferred_username: "personal@org.example" },
      { tid: CONSUMER, oid: "oid-msa", email: "personal@org.example", xms_edov: true },
      { tid: CONSUMER, oid: "oid-msa", email: "personal@org.example", preferred_username: "x@y.z" },
    ]) {
      const result = await microsoftSignIn(claims);
      expect(result).toMatchObject({ status: 403, session: false });
    }
    expect(await userRow("personal@org.example")).toMatchObject({ ms_object_id: null });
  });

  it("refuses another person's sign-in after SCIM moved a bound user to their address", async () => {
    await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-carl",
      preferred_username: "carl@org.example",
    });
    const carl = await userRow("carl@org.example");
    const rename = await exports.default.fetch(`${BASE}/scim/v2/Users/${carl?.id}`, {
      method: "PATCH",
      headers: { authorization: "Bearer test-scim-token", "content-type": "application/scim+json" },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "userName", value: "mallory@org.example" }],
      }),
    });
    expect(rename.status).toBe(200);

    const mallory = await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-mallory",
      preferred_username: "mallory@org.example",
    });
    expect(mallory).toMatchObject({ status: 403, session: false, reason: "identity" });
    // A Google account on the new address does not get the row either.
    const google = await googleSignIn("mallory@org.example", "google-mallory");
    expect(google).toMatchObject({ status: 403, session: false, reason: "provider" });
    expect(google.body).toContain("Microsoft");
    // The renamed person still signs in under the new address.
    const renamed = await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-carl",
      preferred_username: "mallory@org.example",
    });
    expect(renamed).toMatchObject({ status: 302, session: true });
  });
});

describe("Google identity binding", () => {
  it("binds the first Google sign-in and refuses another Google account later", async () => {
    expect((await googleSignIn("gina@org.example", "sub-gina")).status).toBe(302);
    expect(await userRow("gina@org.example")).toMatchObject({ google_subject: "sub-gina" });
    expect(await googleSignIn("gina@org.example", "sub-gina")).toMatchObject({ status: 302 });
    expect(await googleSignIn("gina@org.example", "sub-other")).toMatchObject({
      status: 403,
      session: false,
      reason: "identity",
    });
  });

  it("refuses a Microsoft sign-in for a user bound to Google, naming Google", async () => {
    await googleSignIn("hank@org.example", "sub-hank");
    const result = await microsoftSignIn({
      tid: TENANT_A,
      oid: "oid-hank",
      preferred_username: "hank@org.example",
    });
    expect(result).toMatchObject({ status: 403, session: false, reason: "provider" });
    expect(result.body).toContain("Google");
    expect(await userRow("hank@org.example")).toMatchObject({ ms_object_id: null });
  });

  it("refuses a Google account for an unbound user of an Entra tenant, naming Microsoft", async () => {
    await legacyUser("ida@org.example", TENANT_A);
    const result = await googleSignIn("ida@org.example", "sub-ida");
    expect(result).toMatchObject({ status: 403, session: false, reason: "provider" });
    expect(result.body).toContain("Microsoft");
    expect(await userRow("ida@org.example")).toMatchObject({
      tenant_id: TENANT_A,
      google_subject: null,
    });
  });
});

describe("Microsoft reconnect", () => {
  it("reuses the account row of a mail address when the UPN differs", async () => {
    const { user, cookie: session } = await signIn("owner@example.com");
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email, tenant_id, needs_reconnect) VALUES ('acc-mail', ?, 'microsoft', 'jane@org.example', ?, 1)",
    )
      .bind(user.id, TENANT_A)
      .run();
    const flow = await startFlow("/auth/microsoft/connect", session);
    mockTokenEndpoint({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      id_token: fakeIdToken({
        tid: TENANT_A,
        oid: "oid-jane",
        email: "jane@org.example",
        preferred_username: "j.doe@org.example",
      }),
    });
    const response = await exports.default.fetch(
      `${BASE}/auth/microsoft/callback?code=abc&state=${flow.state}`,
      { headers: { cookie: `${flow.cookie}; ${session}` }, redirect: "manual" },
    );
    expect(response.status).toBe(302);
    const { results } = await env.DB.prepare(
      "SELECT id, email, needs_reconnect FROM accounts WHERE user_id = ? AND email IN ('jane@org.example', 'j.doe@org.example')",
    )
      .bind(user.id)
      .all();
    expect(results).toEqual([{ id: "acc-mail", email: "jane@org.example", needs_reconnect: 0 }]);
    expect(await env.ACCOUNT_SYNC.getByName("acc-mail").hasTokens()).toBe(true);
  });
});
