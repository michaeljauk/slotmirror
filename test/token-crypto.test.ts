import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson } from "../src/token-crypto";

const KEY = btoa("k".repeat(32));
const OTHER_KEY = btoa("o".repeat(32));

describe("token encryption", () => {
  it("round-trips a value", async () => {
    const blob = await encryptJson({ refreshToken: "r" }, KEY, "account-1");
    expect(await decryptJson(blob, KEY, "account-1")).toEqual({ refreshToken: "r" });
  });

  it("uses a fresh IV per encryption", async () => {
    const a = await encryptJson("same", KEY, "account-1");
    const b = await encryptJson("same", KEY, "account-1");
    expect(new Uint8Array(a.iv)).not.toEqual(new Uint8Array(b.iv));
  });

  it("fails for another account ID", async () => {
    const blob = await encryptJson("secret", KEY, "account-1");
    await expect(decryptJson(blob, KEY, "account-2")).rejects.toThrow();
  });

  it("fails for another key", async () => {
    const blob = await encryptJson("secret", KEY, "account-1");
    await expect(decryptJson(blob, OTHER_KEY, "account-1")).rejects.toThrow();
  });
});
