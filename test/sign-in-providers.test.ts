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

describe("DATA_JURISDICTION", () => {
  it("accepts supported jurisdictions only", () => {
    expect(dataJurisdiction({ ...env, DATA_JURISDICTION: "EU" })).toBe("eu");
    expect(dataJurisdiction({ ...env, DATA_JURISDICTION: "mars" })).toBeNull();
    expect(dataJurisdiction(env)).toBeNull();
  });
});
