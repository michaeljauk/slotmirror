import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { setupStatus, signInProviders } from "../src/config";
import { dataJurisdiction } from "../src/durable";
import worker from "../src/index";
import { BASE } from "./helpers";

async function fetchWith(path: string, overrides: Partial<Env>): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE}${path}`), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("SIGN_IN_PROVIDERS", () => {
  it("offers every configured provider when unset", () => {
    expect(signInProviders(env)).toEqual({ microsoft: true, google: true });
  });

  it("limits sign-in to the listed providers", async () => {
    const limited = { SIGN_IN_PROVIDERS: "microsoft" };
    expect(signInProviders({ ...env, ...limited })).toEqual({ microsoft: true, google: false });

    const page = await (await fetchWith("/", limited)).text();
    expect(page).toContain("/auth/microsoft/login");
    expect(page).not.toContain("/auth/google/login");

    const refused = await fetchWith("/auth/google/login", limited);
    expect(refused.status).toBe(403);
    const allowed = await fetchWith("/auth/microsoft/login", limited);
    expect(allowed.status).toBe(302);
  });

  it("shows the setup page if no listed provider is configured", () => {
    const status = setupStatus({ ...env, SIGN_IN_PROVIDERS: "apple" });
    expect(status.signIn).toBe(false);
    expect(status.ready).toBe(false);
  });
});

describe("setup checklist for an invalid SIGN_IN_PROVIDERS", () => {
  it("names the value it read and the correction", async () => {
    const bare = {
      DB: env.DB,
      ACCOUNT_SYNC: env.ACCOUNT_SYNC,
      SESSION_SECRET: env.SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
      MICROSOFT_CLIENT_ID: env.MICROSOFT_CLIENT_ID,
      MICROSOFT_CLIENT_SECRET: env.MICROSOFT_CLIENT_SECRET,
      ALLOWED_EMAILS: "owner@example.com",
      SIGN_IN_PROVIDERS: "both",
    } as Env;
    expect(setupStatus(bare).unknownSignInEntries).toEqual(["both"]);
    const response = await worker.fetch(new Request(`${BASE}/`), bare, {} as ExecutionContext);
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("SIGN_IN_PROVIDERS is set to &quot;both&quot;");
    expect(html).toContain("microsoft,google");
    expect(html).toContain("DATA_JURISDICTION");
    expect(html).toContain("https://slotmirror.com/docs/quickstart/");
    expect(html).not.toContain("the README");
  });

  it("lists no entry for valid values", () => {
    const valid = { ...env, SIGN_IN_PROVIDERS: "microsoft, Google" };
    expect(setupStatus(valid).unknownSignInEntries).toEqual([]);
  });

  it("reports an unknown entry such as apple", () => {
    expect(setupStatus({ ...env, SIGN_IN_PROVIDERS: "apple" }).unknownSignInEntries).toEqual([
      "apple",
    ]);
  });
});

describe("DATA_JURISDICTION", () => {
  it("accepts supported jurisdictions only", () => {
    expect(dataJurisdiction({ ...env, DATA_JURISDICTION: "EU" })).toBe("eu");
    expect(dataJurisdiction({ ...env, DATA_JURISDICTION: "mars" })).toBeNull();
    expect(dataJurisdiction(env)).toBeNull();
  });
});
