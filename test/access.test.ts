import { describe, expect, it } from "vitest";
import { decideAccess, policyFromEnv, type AccessPolicy } from "../src/access";

const TENANT_A = "3f2b8c1e-5d4a-4e7b-9c6f-1a2b3c4d5e6f";
const TENANT_B = "7a9e4d21-0c3b-4f58-8e1d-6b5a4c3d2e1f";

function policy(overrides: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    allowedEmails: [],
    allowedDomains: [],
    allowedTenantIds: [],
    adminEmails: [],
    ...overrides,
  };
}

describe("decideAccess", () => {
  it("admits a listed address as member, case-insensitively", () => {
    expect(
      decideAccess(policy({ allowedEmails: ["me@example.com"] }), { email: "Me@Example.com" }),
    ).toEqual({ allowed: true, role: "member" });
  });

  it("admits every address of an allowed domain", () => {
    expect(
      decideAccess(policy({ allowedDomains: ["example.com"] }), { email: "a@example.com" }),
    ).toEqual({ allowed: true, role: "member" });
  });

  it("does not treat a subdomain or a lookalike as the allowed domain", () => {
    const p = policy({ allowedDomains: ["example.com"] });
    expect(decideAccess(p, { email: "a@mail.example.com" }).allowed).toBe(false);
    expect(decideAccess(p, { email: "a@evil-example.com" }).allowed).toBe(false);
    expect(decideAccess(p, { email: "a@example.com.evil.org" }).allowed).toBe(false);
  });

  it("gives admins the admin role even without another rule", () => {
    expect(
      decideAccess(policy({ adminEmails: ["boss@example.com"] }), { email: "boss@example.com" }),
    ).toEqual({ allowed: true, role: "admin" });
  });

  it("refuses Microsoft identities from a tenant that is not allowed", () => {
    const p = policy({ allowedDomains: ["example.com"], allowedTenantIds: [TENANT_A] });
    expect(decideAccess(p, { email: "a@example.com", tenantId: TENANT_A }).allowed).toBe(true);
    expect(decideAccess(p, { email: "a@example.com", tenantId: TENANT_B }).allowed).toBe(false);
  });

  it("refuses everyone else", () => {
    expect(
      decideAccess(policy({ allowedEmails: ["me@example.com"] }), { email: "you@example.com" })
        .allowed,
    ).toBe(false);
  });
});

describe("policyFromEnv", () => {
  it("parses, lowercases and drops invalid entries", () => {
    const env = {
      ALLOWED_EMAILS: " Me@Example.com, not-an-email ,",
      ALLOWED_DOMAINS: "Example.com, -bad.com, nodot",
      ALLOWED_TENANT_IDS: `${TENANT_A.toUpperCase()}, nonsense`,
      ADMIN_EMAILS: "",
    } as Env;
    expect(policyFromEnv(env)).toEqual({
      allowedEmails: ["me@example.com"],
      allowedDomains: ["example.com"],
      allowedTenantIds: [TENANT_A],
      adminEmails: [],
    });
  });
});
