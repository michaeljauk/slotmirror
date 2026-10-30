import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "../src/index";
import { BASE, call, mockNetwork, reset, row, signupRequest, testEnv, tokensFrom } from "./helpers";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

async function signUp(email = "ada@example.com") {
  const out = mockNetwork();
  await call(signupRequest(email));
  const tokens = tokensFrom(out.resend.at(-1)!);
  vi.restoreAllMocks();
  return tokens;
}

const get = (path: string) => call(new Request(`${BASE}${path}`));
const post = (path: string, body = "") =>
  call(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );

describe("confirm", () => {
  it("does not confirm on GET and shows a button that posts", async () => {
    const { confirm } = await signUp();
    const response = await get(`/confirm?t=${confirm}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<form method="post" action="/confirm?t=${confirm}">`);
    expect((await row("ada@example.com")).confirmed_at).toBeNull();
    // A scanner that fetches the link twice, also with HEAD, changes nothing.
    await get(`/confirm?t=${confirm}`);
    await call(new Request(`${BASE}/confirm?t=${confirm}`, { method: "HEAD" }));
    expect((await row("ada@example.com")).confirmed_at).toBeNull();
  });

  it("keeps the landing page private: noindex, no cache, no referrer, no script", async () => {
    const { confirm } = await signUp();
    const response = await get(`/confirm?t=${confirm}`);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await response.text()).not.toContain("<script");
  });

  it("confirms on POST and then reports already confirmed", async () => {
    const { confirm } = await signUp();
    const done = await post(`/confirm?t=${confirm}`);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("You are on the waitlist");
    const stored = await row("ada@example.com");
    expect(stored.confirmed_at).toBeTypeOf("number");
    const again = await post(`/confirm?t=${confirm}`);
    expect(await again.text()).toContain("already on the waitlist");
    expect((await row("ada@example.com")).confirmed_at).toBe(stored.confirmed_at);
    expect(await (await get(`/confirm?t=${confirm}`)).text()).toContain("already on the waitlist");
  });

  it("links the self-host quickstart on the confirmed page", async () => {
    const { confirm } = await signUp();
    expect(await (await post(`/confirm?t=${confirm}`)).text()).toContain(
      "https://slotmirror.com/docs/quickstart/",
    );
  });

  it("refuses an expired token on GET and POST, and sends the user to sign up again", async () => {
    const { confirm } = await signUp();
    await env.DB.prepare("UPDATE subscribers SET confirm_expires_at = ?")
      .bind(Date.now() - 1000)
      .run();
    for (const response of [
      await get(`/confirm?t=${confirm}`),
      await post(`/confirm?t=${confirm}`),
    ]) {
      expect(response.status).toBe(410);
      expect(await response.text()).toContain("Sign up again");
    }
    expect((await row("ada@example.com")).confirmed_at).toBeNull();
  });

  it("lets an expired entry sign up again and confirm with the new link", async () => {
    const old = await signUp();
    await env.DB.prepare("UPDATE subscribers SET confirm_expires_at = 1, mail_sent_at = 1").run();
    const fresh = await signUp();
    expect((await post(`/confirm?t=${old.confirm}`)).status).toBe(400);
    expect((await post(`/confirm?t=${fresh.confirm}`)).status).toBe(200);
  });

  it("refuses unknown and malformed tokens", async () => {
    await signUp();
    for (const t of ["AAAAAAAAAAAAAAAAAAAAAA", "short", "<script>", ""]) {
      const response = await post(`/confirm?t=${encodeURIComponent(t)}`);
      expect(response.status).toBe(400);
    }
    expect((await post("/confirm")).status).toBe(400);
  });
});

describe("unsubscribe", () => {
  it("does not delete on GET", async () => {
    const { unsubscribe } = await signUp();
    const response = await get(`/unsubscribe?t=${unsubscribe}`);
    expect(await response.text()).toContain(`action="/unsubscribe?t=${unsubscribe}"`);
    expect(await row("ada@example.com")).not.toBeNull();
  });

  it("deletes the entry on POST, also for a one-click post (RFC 8058)", async () => {
    const { unsubscribe } = await signUp();
    const response = await post(`/unsubscribe?t=${unsubscribe}`, "List-Unsubscribe=One-Click");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Your data is deleted");
    expect(await row("ada@example.com")).toBeNull();
    expect((await post(`/unsubscribe?t=${unsubscribe}`)).status).toBe(400);
  });

  it("works for a confirmed entry and lets the address sign up again", async () => {
    const { confirm, unsubscribe } = await signUp();
    await post(`/confirm?t=${confirm}`);
    await post(`/unsubscribe?t=${unsubscribe}`);
    expect(await row("ada@example.com")).toBeNull();
    const out = mockNetwork();
    expect((await call(signupRequest("ada@example.com"))).status).toBe(200);
    expect(out.resend).toHaveLength(1);
  });

  it("refuses an expired token", async () => {
    const { unsubscribe } = await signUp();
    await env.DB.prepare("UPDATE subscribers SET unsubscribe_expires_at = 1").run();
    expect((await post(`/unsubscribe?t=${unsubscribe}`)).status).toBe(410);
    expect(await row("ada@example.com")).not.toBeNull();
  });

  it("does not accept the confirm token as unsubscribe token", async () => {
    const { confirm } = await signUp();
    expect((await post(`/unsubscribe?t=${confirm}`)).status).toBe(400);
    expect(await row("ada@example.com")).not.toBeNull();
  });
});

describe("routing and cleanup", () => {
  it("answers 404 and 405", async () => {
    expect((await get("/")).status).toBe(404);
    expect((await get("/api/signup")).status).toBe(405);
    expect((await call(new Request(`${BASE}/confirm`, { method: "DELETE" }))).status).toBe(405);
  });

  it("deletes expired unconfirmed entries and keeps confirmed ones", async () => {
    const a = await signUp("a@example.com");
    await signUp("b@example.com");
    await post(`/confirm?t=${a.confirm}`);
    await env.DB.prepare("UPDATE subscribers SET confirm_expires_at = 1").run();
    await cleanup(testEnv({ RETENTION_UNTIL: "2999-01-01" }));
    expect(await row("a@example.com")).not.toBeNull();
    expect(await row("b@example.com")).toBeNull();
  });

  it("deletes everything after the retention date", async () => {
    const a = await signUp("a@example.com");
    await post(`/confirm?t=${a.confirm}`);
    await cleanup(testEnv({ RETENTION_UNTIL: "2000-01-01" }));
    expect(await row("a@example.com")).toBeNull();
  });
});
