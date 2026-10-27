import { describe, expect, it } from "vitest";
import { parseRuleOptions, setupStatus } from "../src/config";

describe("parseRuleOptions", () => {
  it("fills defaults for an empty object", () => {
    expect(parseRuleOptions("{}")).toEqual({
      detailLevel: "busy",
      blockTitle: "Busy",
      daysAhead: 90,
      skipAllDay: true,
      skipFree: true,
      skipTentative: false,
      skipDeclined: true,
      skipCategories: [],
      workDays: [1, 2, 3, 4, 5, 6, 7],
      workStart: "",
      workEnd: "",
      workTimeZone: "",
      markPrivate: true,
      blockColor: "",
      bufferBefore: 0,
      bufferAfter: 0,
    });
  });

  it("accepts buffers from 0 to 240 whole minutes", () => {
    expect(parseRuleOptions('{"bufferBefore": 240, "bufferAfter": 15}')).toMatchObject({
      bufferBefore: 240,
      bufferAfter: 15,
    });
    for (const value of ["241", "-1", "1.5", '"15"']) {
      expect(() => parseRuleOptions(`{"bufferBefore": ${value}}`)).toThrow();
      expect(() => parseRuleOptions(`{"bufferAfter": ${value}}`)).toThrow();
    }
  });

  it("rejects a window beyond 365 days", () => {
    expect(() => parseRuleOptions('{"daysAhead": 366}')).toThrow();
  });

  it("rejects an unknown detail level", () => {
    expect(() => parseRuleOptions('{"detailLevel": "everything"}')).toThrow();
  });

  it("rejects a blank block title", () => {
    expect(() => parseRuleOptions('{"blockTitle": "   "}')).toThrow();
  });
});

describe("setupStatus", () => {
  const complete = {
    ALLOWED_EMAILS: "owner@example.com",
    ALLOWED_DOMAINS: "",
    ALLOWED_TENANT_IDS: "",
    ADMIN_EMAILS: "",
    SESSION_SECRET: "s".repeat(32),
    TOKEN_ENCRYPTION_KEY: btoa("k".repeat(32)),
    MICROSOFT_CLIENT_ID: "id",
    MICROSOFT_CLIENT_SECRET: "secret",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
  } as Env;

  it("is ready with owners, secrets and one provider", () => {
    expect(setupStatus(complete).ready).toBe(true);
  });

  it("is not ready if the encryption key has the wrong length", () => {
    const status = setupStatus({ ...complete, TOKEN_ENCRYPTION_KEY: btoa("short") });
    expect(status.tokenEncryptionKey).toBe(false);
    expect(status.ready).toBe(false);
  });

  it("is not ready if nobody may sign in", () => {
    const status = setupStatus({ ...complete, ALLOWED_EMAILS: "not-an-email" });
    expect(status.accessConfigured).toBe(false);
    expect(status.ready).toBe(false);
  });

  it("is ready with only a domain", () => {
    expect(
      setupStatus({ ...complete, ALLOWED_EMAILS: "", ALLOWED_DOMAINS: "example.com" }).ready,
    ).toBe(true);
  });

  it("is not ready without any provider", () => {
    expect(setupStatus({ ...complete, MICROSOFT_CLIENT_SECRET: "" }).ready).toBe(false);
  });
});
