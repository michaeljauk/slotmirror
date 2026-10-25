import { describe, expect, it } from "vitest";
import type { AccessPolicy } from "../src/access";
import {
  detailCapsFromEnv,
  effectiveDetailLevel,
  isOrgAccount,
  type DetailCaps,
} from "../src/detail-policy";

const policy: AccessPolicy = {
  allowedEmails: ["someone@gmail.com"],
  allowedDomains: ["netcero.eu"],
  allowedTenantIds: ["11111111-2222-3333-4444-555555555555"],
  adminEmails: [],
};

describe("isOrgAccount", () => {
  it("matches the tenant or the domain, not single addresses", () => {
    expect(isOrgAccount(policy, { email: "a@netcero.eu", tenantId: null })).toBe(true);
    expect(
      isOrgAccount(policy, {
        email: "a@other.com",
        tenantId: "11111111-2222-3333-4444-555555555555",
      }),
    ).toBe(true);
    expect(isOrgAccount(policy, { email: "someone@gmail.com", tenantId: null })).toBe(false);
    expect(isOrgAccount(policy, { email: "a@dectria.com", tenantId: "other" })).toBe(false);
  });
});

describe("effectiveDetailLevel", () => {
  const caps: DetailCaps = { toExternal: "title", fromExternal: "busy" };
  const org = { org: true };
  const external = { org: false };

  it("caps org to external and external to org, and leaves the rest alone", () => {
    expect(effectiveDetailLevel("full", caps, org, external)).toEqual({
      level: "title",
      capped: true,
    });
    expect(effectiveDetailLevel("title", caps, external, org)).toEqual({
      level: "busy",
      capped: true,
    });
    expect(effectiveDetailLevel("full", caps, org, org)).toEqual({ level: "full", capped: false });
    expect(effectiveDetailLevel("full", caps, external, external).capped).toBe(false);
  });

  it("never raises a level", () => {
    expect(effectiveDetailLevel("busy", caps, org, external)).toEqual({
      level: "busy",
      capped: false,
    });
  });
});

describe("detailCapsFromEnv", () => {
  it("means no cap when unset and busy when invalid", () => {
    const base = {} as Env;
    expect(detailCapsFromEnv(base)).toEqual({ toExternal: "full", fromExternal: "full" });
    expect(
      detailCapsFromEnv({
        ...base,
        MAX_DETAIL_TO_EXTERNAL: "Title",
        MAX_DETAIL_FROM_EXTERNAL: "everything",
      }),
    ).toEqual({ toExternal: "title", fromExternal: "busy" });
  });
});
