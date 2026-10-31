import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addAccount, BASE, signIn } from "./helpers";

const accountExists = async (id: string) =>
  (await env.DB.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(id).first()) !== null;

/** A signed-in user with one account; `disconnect` posts its removal with the given headers. */
async function setup(id: string) {
  const { user, cookie } = await signIn("owner@example.com");
  await addAccount(user.id, id, `${id}@example.com`);
  const disconnect = (headers: Record<string, string>) =>
    exports.default.fetch(`${BASE}/accounts/${id}/disconnect`, {
      method: "POST",
      headers: { cookie, ...headers },
      redirect: "manual",
    });
  return { disconnect };
}

describe("cross-site requests", () => {
  it("refuses a cross-site post and keeps the account", async () => {
    const { disconnect } = await setup("acc-csrf-cross");
    const response = await disconnect({
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Not allowed");
    expect(await accountExists("acc-csrf-cross")).toBe(true);
  });

  it("refuses a post from a sibling subdomain", async () => {
    const { disconnect } = await setup("acc-csrf-sibling");
    const response = await disconnect({
      origin: "https://attacker.example.workers.dev",
      "sec-fetch-site": "same-site",
    });
    expect(response.status).toBe(403);
    expect(await accountExists("acc-csrf-sibling")).toBe(true);
  });

  it("refuses a foreign or opaque origin from a browser without Sec-Fetch-Site", async () => {
    const { disconnect } = await setup("acc-csrf-origin");
    for (const origin of ["https://evil.example", "null", `${BASE}.evil.example`]) {
      const response = await disconnect({ origin });
      expect(response.status).toBe(403);
    }
    expect(await accountExists("acc-csrf-origin")).toBe(true);
  });

  it("refuses a cross-site post to a rule route and to the editor's script endpoint", async () => {
    const { cookie } = await signIn("owner@example.com");
    for (const path of ["/rules/choices", "/rules/settings", "/account/delete", "/auth/logout"]) {
      const response = await exports.default.fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
          cookie,
          "sec-fetch-site": "cross-site",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "settings=1",
        redirect: "manual",
      });
      expect(response.status, path).toBe(403);
    }
    // The user still exists: the delete never ran.
    expect(
      await env.DB.prepare("SELECT 1 FROM users WHERE email = 'owner@example.com'").first(),
    ).not.toBeNull();
  });

  it("accepts a same-origin post", async () => {
    const { disconnect } = await setup("acc-csrf-same");
    const response = await disconnect({ origin: BASE, "sec-fetch-site": "same-origin" });
    expect(response.status).toBe(302);
    expect(await accountExists("acc-csrf-same")).toBe(false);
  });

  it("accepts a post with its own origin from a browser without Sec-Fetch-Site", async () => {
    const { disconnect } = await setup("acc-csrf-own-origin");
    const response = await disconnect({ origin: BASE });
    expect(response.status).toBe(302);
    expect(await accountExists("acc-csrf-own-origin")).toBe(false);
  });

  it("accepts a post with neither header, which no browser sends cross-site", async () => {
    const { disconnect } = await setup("acc-csrf-no-headers");
    const response = await disconnect({});
    expect(response.status).toBe(302);
    expect(await accountExists("acc-csrf-no-headers")).toBe(false);
  });

  it("lets safe methods through from another site", async () => {
    const response = await exports.default.fetch(`${BASE}/`, {
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(response.status).toBe(200);
  });
});

describe("server-to-server endpoints", () => {
  it("still answers the Graph validation request", async () => {
    const response = await exports.default.fetch(`${BASE}/webhooks/microsoft?validationToken=abc`, {
      method: "POST",
      headers: { origin: "https://graph.example", "sec-fetch-site": "cross-site" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc");
  });

  it("still takes Google notifications", async () => {
    const response = await exports.default.fetch(`${BASE}/webhooks/google?account=x`, {
      method: "POST",
      headers: { origin: "https://google.example", "sec-fetch-site": "cross-site" },
    });
    expect(response.status).toBe(200);
  });

  it("still serves SCIM, which authenticates with its bearer token", async () => {
    const response = await exports.default.fetch(`${BASE}/scim/v2/Users`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-scim-token",
        "content-type": "application/scim+json",
        origin: "https://entra.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: "ext-guard",
        userName: "guard@org.example",
        active: true,
      }),
    });
    expect(response.status).toBe(201);
  });
});

describe("form-action 'self'", () => {
  // Chrome applies form-action to the redirects after a form submission. A form whose answer
  // redirects to the provider's sign-in would then fail; sign-in and connect must stay links.
  it("starts sign-in and connect with links, and logout redirects to this origin", async () => {
    const signedOut = await (await exports.default.fetch(`${BASE}/`)).text();
    expect(signedOut).toMatch(/<a [^>]*href="\/auth\/microsoft\/login"/);
    const { cookie } = await signIn("owner@example.com");
    for (const path of ["/", "/rules"]) {
      const html = await (
        await exports.default.fetch(`${BASE}${path}`, { headers: { cookie } })
      ).text();
      expect(html, path).toMatch(/<a [^>]*href="\/auth\/(microsoft|google)\/connect"/);
      const actions = [...html.matchAll(/<form[^>]*action="([^"]*)"/g)].map((match) => match[1]);
      expect(
        actions.filter((action) => action?.startsWith("/auth/")),
        path,
      ).toEqual(["/auth/logout"]);
    }
    const logout = await exports.default.fetch(`${BASE}/auth/logout`, {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "same-origin" },
      redirect: "manual",
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toBe("/");
  });
});

describe("security headers", () => {
  it("sends them with every page", async () => {
    const { cookie } = await signIn("owner@example.com");
    for (const path of ["/", "/rules", "/privacy", "/no-such-page"]) {
      const response = await exports.default.fetch(`${BASE}${path}`, { headers: { cookie } });
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("referrer-policy"), path).toBe("same-origin");
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).toContain("default-src 'none'");
      expect(csp, path).not.toContain("unsafe-eval");
      expect(csp, path).not.toMatch(/script-src[^;]*unsafe-inline/);
    }
  });

  it("sends them with a refused cross-site post too", async () => {
    const response = await exports.default.fetch(`${BASE}/account/delete`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("uses no inline script in a page, so that the policy needs no exception", async () => {
    const { cookie } = await signIn("owner@example.com");
    for (const path of ["/", "/rules", "/admin", "/privacy"]) {
      const html = await (
        await exports.default.fetch(`${BASE}${path}`, { headers: { cookie } })
      ).text();
      // Every script tag loads a file; no handler attribute such as onclick.
      for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag, path).toMatch(/\ssrc="/);
      expect(html, path).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/);
      expect(html, path).not.toMatch(/\son[a-z]+="/);
    }
  });
});
