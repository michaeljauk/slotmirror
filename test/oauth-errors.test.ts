import { describe, expect, it } from "vitest";
import {
  classifyExchangeError,
  classifyProviderError,
  DOCUMENTED,
  newReference,
  safeErrorName,
} from "../src/oauth-errors";
// @ts-expect-error `?raw` imports are untyped without `vite/client`
import troubleshootingPage from "../website/src/content/docs/docs/troubleshooting.md?raw";

describe("classifyProviderError", () => {
  it.each([
    ["access_denied", "AADSTS65001: The user has not consented", "AADSTS65001", "aadsts65001"],
    ["access_denied", "AADSTS90094: admin consent required", "AADSTS90094", "aadsts90094"],
    ["interaction_required", "AADSTS90095: admin approval", "AADSTS90095", "aadsts90095"],
    ["access_denied", undefined, "access_denied", "access_denied"],
    ["consent_required", "no code here", "consent_required", "consent_required"],
  ])("sends %s / %s to the consent page", (error, description, code, anchor) => {
    expect(classifyProviderError(error, description)).toEqual({ kind: "consent", code, anchor });
  });

  it("names AADSTS50020 as a tenant problem", () => {
    expect(classifyProviderError("invalid_request", "AADSTS50020: user is not in tenant")).toEqual({
      kind: "tenant",
      code: "AADSTS50020",
      anchor: "aadsts50020",
    });
  });

  it("lets a known number decide before the error name", () => {
    expect(classifyProviderError("access_denied", "AADSTS50020: user is not in tenant")).toEqual({
      kind: "tenant",
      code: "AADSTS50020",
      anchor: "aadsts50020",
    });
  });

  it("keeps the consent page for access_denied with an unknown number", () => {
    expect(classifyProviderError("access_denied", "AADSTS65004: declined")).toEqual({
      kind: "consent",
      code: "AADSTS65004",
      anchor: null,
    });
  });

  it("shows an unknown code without an anchor", () => {
    expect(classifyProviderError("server_error", "AADSTS123456: something")).toEqual({
      kind: "other",
      code: "AADSTS123456",
      anchor: null,
    });
    expect(classifyProviderError("temporarily_unavailable", undefined).code).toBe(
      "temporarily_unavailable",
    );
  });

  it("never passes free text through as a code", () => {
    const hostile = "<script>alert(1)</script> alice@corp.example";
    expect(classifyProviderError(hostile, hostile)).toEqual({
      kind: "other",
      code: null,
      anchor: null,
    });
    expect(safeErrorName("Has Spaces")).toBeNull();
    expect(safeErrorName("a".repeat(41))).toBeNull();
  });
});

describe("classifyExchangeError", () => {
  it("prefers the AADSTS number and links documented codes", () => {
    expect(classifyExchangeError("invalid_client", "7000215")).toEqual({
      kind: "other",
      code: "AADSTS7000215",
      anchor: null,
    });
    expect(classifyExchangeError("invalid_grant", "50020").anchor).toBe("aadsts50020");
  });

  it.each([
    ["invalid_grant", "65001", "AADSTS65001"],
    ["invalid_grant", "90094", "AADSTS90094"],
    ["interaction_required", "90095", "AADSTS90095"],
    ["consent_required", undefined, "consent_required"],
    ["access_denied", undefined, "access_denied"],
  ])("sends %s / %s to the consent page", (error, aadsts, code) => {
    expect(classifyExchangeError(error, aadsts)).toEqual({
      kind: "consent",
      code,
      anchor: code.toLowerCase(),
    });
  });

  it("classifies a token exchange like the callback", () => {
    expect(classifyExchangeError("access_denied", "50020").kind).toBe("tenant");
    expect(classifyExchangeError("invalid_grant", "50020").kind).toBe("tenant");
    expect(classifyExchangeError("invalid_client", "7000215").kind).toBe("other");
  });

  it("filters the error name and the number", () => {
    expect(classifyExchangeError("invalid_client", undefined).code).toBe("invalid_client");
    expect(classifyExchangeError("http_502", undefined).code).toBe("http_502");
    expect(classifyExchangeError("bad code!", "12")).toEqual({
      kind: "other",
      code: null,
      anchor: null,
    });
  });
});

describe("troubleshooting page", () => {
  const page: string = troubleshootingPage;
  const anchors = [...page.matchAll(/^### (.+)$/gm)].map((match) =>
    (match[1] ?? "").trim().toLowerCase(),
  );

  it("has a section for every documented code", () => {
    expect([...DOCUMENTED].sort()).toEqual([...anchors].sort());
  });

  it("links the section of every heading", () => {
    for (const anchor of anchors) {
      const info = anchor.startsWith("aadsts")
        ? classifyProviderError("server_error", `${anchor.toUpperCase()}: text`)
        : classifyProviderError(anchor, undefined);
      expect(info.anchor).toBe(anchor);
    }
  });
});

it("makes short references", () => {
  expect(newReference()).toMatch(/^[0-9a-f]{8}$/);
});
