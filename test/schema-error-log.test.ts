import { afterEach, describe, expect, it, vi } from "vitest";
// The providers parse with zod/mini; its error message after the boundary is what is tested.
import * as z from "zod/mini";
import { errorCode } from "../src/audit";
import { errorFields } from "../src/error-fields";
import { TokenError } from "../src/providers/oauth-token";

/** A Graph calendar list whose second calendar has a canEdit that is not a boolean. */
const calendarList = z.object({
  value: z.array(z.object({ id: z.string(), name: z.string(), canEdit: z.optional(z.boolean()) })),
});

function schemaError(): Error {
  const result = calendarList.safeParse({
    value: [
      { id: "SECRET-ID-1", name: "SECRET-NAME", owner: { address: "secret@example.com" } },
      { id: "SECRET-ID-2", name: "SECRET-SHARED", canEdit: "SECRET-YES" },
    ],
  });
  expect(result.success).toBe(false);
  return result.error!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("schema errors in the log", () => {
  it("names the issue code and path of a schema error", () => {
    expect(errorFields(schemaError()).message).toBe("schema invalid_type@value.1.canEdit");
  });

  it("keeps the issue after the Durable Object boundary", () => {
    // Over the boundary only a plain Error with the same message is left.
    const crossed = new Error(schemaError().message);
    expect(errorFields(crossed).message).toBe("schema invalid_type@value.1.canEdit");
  });

  it("logs no value from the provider response", () => {
    const error = schemaError();
    for (const candidate of [error, new Error(error.message)]) {
      const logged = JSON.stringify(errorFields(candidate));
      expect(logged).not.toContain("SECRET");
      expect(logged).not.toContain("secret@example.com");
    }
  });

  it("logs no key of a record, which comes from the data", () => {
    // A Google private extended property set by another app: its key is not a field name.
    const record = z.object({
      extendedProperties: z.object({ private: z.record(z.string(), z.string()) }),
    });
    const result = record.safeParse({
      extendedProperties: { private: { "secret@example.com": 1, Secret: 2 } },
    });
    expect(result.success).toBe(false);
    for (const candidate of [result.error!, new Error(result.error!.message)]) {
      const logged = JSON.stringify(errorFields(candidate));
      expect(logged).toContain("invalid_type@extendedProperties.private.?");
      expect(logged).not.toContain("secret");
      expect(logged).not.toContain("Secret");
    }
  });

  it("ignores a message that only looks like JSON", () => {
    const fields = errorFields(new Error('[{"code":"SECRET VALUE","path":["a"]}]'));
    expect(JSON.stringify(fields)).not.toContain("SECRET");
    expect(fields.message).toBeUndefined();
  });
});

describe("token error codes in the log", () => {
  it("keeps a code that is not a plain code out of errorCode", () => {
    expect(errorCode(new TokenError("x for secret@example.com"))).toBe("token_unknown_error");
  });

  it("keeps a plain code", () => {
    expect(errorCode(new TokenError("invalid_grant"))).toBe("token_invalid_grant");
  });
});
