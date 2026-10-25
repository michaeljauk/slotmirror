import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "../src/session";

const SECRET = "test-session-secret-at-least-32-characters";

describe("session cookie", () => {
  it("round-trips a valid session", async () => {
    const session = { userId: "user-1", exp: Math.floor(Date.now() / 1000) + 60 };
    const token = await signSession(session, SECRET);
    expect(await verifySession(token, SECRET)).toEqual(session);
  });

  it("rejects an expired session", async () => {
    const token = await signSession({ userId: "user-1", exp: 1 }, SECRET);
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("rejects a session signed with another secret", async () => {
    const session = { userId: "user-1", exp: Math.floor(Date.now() / 1000) + 60 };
    const token = await signSession(session, "another-secret-that-is-also-long-enough");
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const session = { userId: "user-1", exp: Math.floor(Date.now() / 1000) + 60 };
    const [, signature] = (await signSession(session, SECRET)).split(".");
    const forged = btoa(JSON.stringify({ ...session, userId: "user-2" }));
    expect(await verifySession(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifySession("not-a-token", SECRET)).toBeNull();
    expect(await verifySession(undefined, SECRET)).toBeNull();
  });
});
