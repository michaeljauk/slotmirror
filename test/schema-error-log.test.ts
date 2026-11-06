import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { errorCode, errorLogFields } from "../src/audit";
import { GraphCalendar } from "../src/providers/graph-calendar";
import { TokenError } from "../src/providers/oauth-token";

/** Graph answers /me and /me/calendars; the second calendar has an owner of null. */
function calendarsWithNullOwner(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = url.includes("/me/calendars")
      ? {
          value: [
            { id: "SECRET-ID-1", name: "SECRET-NAME", owner: { address: "secret@example.com" } },
            { id: "SECRET-ID-2", name: "SECRET-SHARED", owner: null },
          ],
        }
      : { mail: "secret@example.com", userPrincipalName: "secret@example.com" };
    return Response.json(body);
  });
}

async function schemaError(): Promise<Error> {
  calendarsWithNullOwner();
  const error = await new GraphCalendar("token").listCalendars().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("schema errors in the log", () => {
  it("names the issue code and path of a schema error", async () => {
    const fields = errorLogFields(await schemaError());
    expect(fields).toContain("schema invalid_type@value.1.owner");
  });

  it("keeps the issue after the Durable Object boundary", async () => {
    // Over the boundary only a plain Error with the same message is left.
    const crossed = new Error((await schemaError()).message);
    expect(errorLogFields(crossed)).toContain("schema invalid_type@value.1.owner");
  });

  it("logs no value from the provider response", async () => {
    const error = await schemaError();
    for (const candidate of [error, new Error(error.message)]) {
      const logged = JSON.stringify(errorLogFields(candidate));
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
      const logged = JSON.stringify(errorLogFields(candidate));
      expect(logged).toContain("invalid_type@extendedProperties.private.?");
      expect(logged).not.toContain("secret");
      expect(logged).not.toContain("Secret");
    }
  });

  it("ignores a message that only looks like JSON", () => {
    const fields = errorLogFields(new Error('[{"code":"SECRET VALUE","path":["a"]}]'));
    expect(JSON.stringify(fields)).not.toContain("SECRET");
    expect(fields.some((field) => field.startsWith("schema"))).toBe(false);
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
