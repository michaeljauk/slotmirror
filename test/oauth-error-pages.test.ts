import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { OAUTH_COOKIE } from "../src/oauth";
import { CONNECT_SCOPES } from "../src/providers/microsoft";
import { BASE, signIn } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

async function startFlow(path: string, cookie = ""): Promise<{ cookie: string; state: string }> {
  const response = await exports.default.fetch(`${BASE}${path}`, {
    headers: { cookie },
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  const value = new RegExp(`${OAUTH_COOKIE}=([^;]+)`).exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  return { cookie: `${OAUTH_COOKIE}=${value}`, state: location.searchParams.get("state") ?? "" };
}

async function callback(provider: string, query: Record<string, string>) {
  const flow = await startFlow(`/auth/${provider}/login`);
  const params = new URLSearchParams({ ...query, state: flow.state });
  const response = await exports.default.fetch(`${BASE}/auth/${provider}/callback?${params}`, {
    headers: { cookie: flow.cookie },
    redirect: "manual",
  });
  return { response, html: await response.text() };
}

/** A callback of the "connect" flow, for a user who is signed in. */
async function connectCallback(query: Record<string, string>) {
  const { cookie } = await signIn("owner@example.com");
  const flow = await startFlow("/auth/microsoft/connect", cookie);
  const params = new URLSearchParams({ ...query, state: flow.state });
  const url = `${BASE}/auth/microsoft/callback?${params.toString()}`;
  const response = await exports.default.fetch(url, {
    headers: { cookie: `${cookie}; ${flow.cookie}` },
    redirect: "manual",
  });
  return { response, html: await response.text() };
}

/** The return from the admin consent link: no flow cookie, unless a test passes one. */
async function adminReturn(query: Record<string, string>, cookie = "", provider = "microsoft") {
  const params = new URLSearchParams(query);
  const url = `${BASE}/auth/${provider}/callback?${params.toString()}`;
  const response = await exports.default.fetch(url, {
    headers: { cookie },
    redirect: "manual",
  });
  return { response, html: await response.text() };
}

/** The approval link in the text of the admin request. */
function adminLink(html: string): URL {
  const text = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? "";
  const link = /https:\/\/login\.microsoftonline\.com\S+/.exec(text)?.[0] ?? "";
  return new URL(link.replaceAll("&amp;", "&"));
}

async function fetchWith(path: string, overrides: Partial<Env>, cookie = ""): Promise<string> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, { headers: { cookie } }),
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response.text();
}

async function rowCounts() {
  const count = async (table: string) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
  return { users: await count("users"), audit: await count("audit_events") };
}

describe("consent errors", () => {
  it.each([
    ["access_denied", "AADSTS65001: consent for alice@corp.example", "AADSTS65001", "#aadsts65001"],
    [
      "access_denied",
      "AADSTS90094: admin needed for alice@corp.example",
      "AADSTS90094",
      "#aadsts90094",
    ],
    ["interaction_required", "AADSTS90095: alice@corp.example", "AADSTS90095", "#aadsts90095"],
    ["consent_required", "", "consent_required", "#consent_required"],
    ["access_denied", "", "access_denied", "#access_denied"],
  ])(
    "explains %s / %s with a request, the code and a retry",
    async (error, description, code, anchor) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { response, html } = await callback("microsoft", {
        error,
        error_description: description,
      });
      expect(response.status).toBe(400);
      expect(html).toContain(`<code>${code}</code>`);
      expect(html).toContain(`/docs/troubleshooting/${anchor}`);
      expect(html).toContain(env.MICROSOFT_CLIENT_ID);
      const link = adminLink(html);
      expect(link.origin + link.pathname).toBe(
        "https://login.microsoftonline.com/organizations/v2.0/adminconsent",
      );
      expect(link.searchParams.get("client_id")).toBe(env.MICROSOFT_CLIENT_ID);
      expect(link.searchParams.get("scope")).toBe("https://graph.microsoft.com/.default");
      expect(link.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/microsoft/callback`);
      expect(link.searchParams.get("state")).toBe("admin-consent");
      expect(html).toContain('data-copy="admin-request"');
      expect(html).toContain('href="/auth/microsoft/login"');
      expect(html).not.toContain("alice");
    },
  );

  it("names every permission that the link approves, also after a sign-in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { html } = await callback("microsoft", { error: "consent_required" });
    expect(html).toContain(`: ${CONNECT_SCOPES.join(", ")}\n`);
  });

  it("retries the connect flow and names the same permissions", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { html } = await connectCallback({ error: "consent_required" });
    expect(html).toContain('href="/auth/microsoft/connect"');
    expect(html).not.toContain('href="/auth/microsoft/login"');
    expect(html).toContain(`: ${CONNECT_SCOPES.join(", ")}\n`);
  });

  it("shows the request for a consent code in the token exchange", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { error: "invalid_grant", error_description: "x", error_codes: [65001] },
        { status: 400 },
      ),
    );
    const { response, html } = await callback("microsoft", { code: "abc" });
    expect(response.status).toBe(502);
    expect(html).toContain("<code>AADSTS65001</code>");
    expect(html).toContain('data-copy="admin-request"');
  });

  it("offers no admin request for Google", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, html } = await callback("google", { error: "access_denied" });
    expect(response.status).toBe(400);
    expect(html).toContain("<code>access_denied</code>");
    expect(html).not.toContain("admin-request");
  });
});

describe("other provider errors", () => {
  it("never prints the provider text, and shows a code only in a safe shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hostile = "<script>alert(1)</script> bob@corp.example";
    const { html } = await callback("microsoft", { error: hostile, error_description: hostile });
    expect(html).not.toContain("bob@corp.example");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("Error code");
  });

  it("prints no text of a token endpoint, and shows a code only in a safe shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hostile = "<script>alert(1)</script> bob@corp.example";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: hostile, error_description: hostile }, { status: 400 }),
    );
    const { response, html } = await callback("microsoft", { code: "abc" });
    expect(response.status).toBe(502);
    expect(html).not.toContain("bob@corp.example");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("Error code");
  });

  it("prints no provider text on a link that needs no sign-in flow", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hostile = "<script>alert(1)</script> bob@corp.example";
    const { response, html } = await adminReturn({
      admin_consent: "True",
      error: hostile,
      error_description: hostile,
    });
    expect(response.status).toBe(400);
    expect(html).not.toContain("bob@corp.example");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("Error code");
  });

  it("shows the tenant page for access_denied with AADSTS50020", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { html } = await callback("microsoft", {
      error: "access_denied",
      error_description: "AADSTS50020: User account 'bob@corp.example' does not exist",
    });
    expect(html).toContain("not in the organisation");
    expect(html).toContain("#aadsts50020");
    expect(html).not.toContain("admin-request");
  });

  it("repeats no foreign query parameter", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { html } = await callback("microsoft", {
      error: "access_denied",
      error_subcode: "canary-subcode",
      login_hint: "canary-hint",
      tenant: "canary-tenant",
      redirect_uri: "https://canary.example/",
    });
    expect(html).not.toContain("canary");
  });

  it("explains AADSTS50020 and links its section", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { html } = await callback("microsoft", {
      error: "invalid_request",
      error_description: "AADSTS50020: User account 'bob@corp.example' does not exist",
    });
    expect(html).toContain("<code>AADSTS50020</code>");
    expect(html).toContain("#aadsts50020");
    expect(html).not.toContain("bob@corp.example");
  });

  it("shows code and reference of a failed token exchange, and logs the same reference", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        {
          error: "invalid_client",
          error_description: "AADSTS7000215: bad secret for bob@corp.example",
          error_codes: [7000215],
        },
        { status: 401 },
      ),
    );
    const { response, html } = await callback("microsoft", { code: "abc" });
    expect(response.status).toBe(502);
    expect(html).toContain("<code>AADSTS7000215</code>");
    const reference = /Reference<\/dt><dd><code>([0-9a-f]{8})<\/code>/.exec(html)?.[1];
    expect(reference).toBeDefined();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain(`ref=${reference}`);
    expect(logged).toContain("code=AADSTS7000215");
    expect(logged).not.toContain("bob@corp.example");
    expect(html).not.toContain("bob@corp.example");
  });
});

describe("return from the admin consent link", () => {
  const tenant = "canary-tenant";
  const success = {
    admin_consent: "True",
    tenant,
    scope: "https://graph.microsoft.com/.default",
    state: "admin-consent",
  };

  it("shows a neutral page, without the tenant and without a cookie or a write", async () => {
    const before = await rowCounts();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, html } = await adminReturn(success);
    expect(response.status).toBe(200);
    expect(html).toContain("Back from Microsoft");
    expect(html).not.toContain("Sign-in expired");
    expect(html).not.toContain("canary");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("slotmirror_session");
    expect(response.headers.get("set-cookie") ?? "").not.toContain(OAUTH_COOKIE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rowCounts()).toEqual(before);
  });

  it("leaves a sign-in that runs in the same browser alone", async () => {
    const flow = await startFlow("/auth/microsoft/login");
    const { response } = await adminReturn(success, flow.cookie);
    expect(response.headers.get("set-cookie") ?? "").not.toContain(OAUTH_COOKIE);
  });

  it("recognises the return by admin_consent alone", async () => {
    const { response, html } = await adminReturn({ admin_consent: "True", tenant });
    expect(response.status).toBe(200);
    expect(html).toContain("Back from Microsoft");
  });

  it.each([
    [{ admin_consent: "True", error: "consent_required", state: "admin-consent" }],
    [{ admin_consent: "True", error: "consent_required" }],
    [{ error: "consent_required", state: "admin-consent" }],
  ])("shows the error page for %o", async (query) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, html } = await adminReturn({
      ...query,
      error_description: "AADSTS65004: declined by bob@corp.example",
      tenant,
    });
    expect(response.status).toBe(400);
    expect(html).toContain("<code>AADSTS65004</code>");
    expect(html).not.toContain("Back from Microsoft");
    expect(html).not.toContain("bob");
    expect(html).not.toContain("canary");
  });

  it("does not exchange a code on the admin consent marker", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { response, html } = await adminReturn({ code: "abc", state: "admin-consent" });
    expect(response.status).toBe(400);
    expect(html).toContain("Sign-in expired");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not exist for Google", async () => {
    const { response, html } = await adminReturn(success, "", "google");
    expect(response.status).toBe(400);
    expect(html).toContain("Sign-in expired");
  });
});

describe("Google notice", () => {
  it("shows two lines under the Google button", async () => {
    const html = await (await exports.default.fetch(`${BASE}/`)).text();
    expect(html).toContain("/auth/google/login");
    expect(html).toContain("not verified");
    expect(html).toContain("Advanced");
  });

  it("shows the notice under the connect buttons", async () => {
    const { cookie } = await signIn("owner@example.com");
    const html = await fetchWith("/", {}, cookie);
    expect(html).toContain("/auth/google/connect");
    expect(html).toContain("not verified");
  });

  it("hides the notice on the sign-in page if Google is off", async () => {
    const html = await fetchWith("/", { SIGN_IN_PROVIDERS: "microsoft" });
    expect(html).not.toContain("/auth/google/login");
    expect(html).not.toContain("not verified");
  });

  it("hides the notice under the connect buttons if Google is off", async () => {
    const { cookie } = await signIn("owner@example.com");
    const html = await fetchWith("/", { GOOGLE_CLIENT_ID: "" }, cookie);
    expect(html).toContain("/auth/microsoft/connect");
    expect(html).not.toContain("/auth/google/connect");
    expect(html).not.toContain("not verified");
  });
});
