import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/crypto";
import { BASE, call, mockNetwork, reset, row, signupRequest, tokensFrom } from "./helpers";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

describe("sign-up", () => {
  it("stores a normalized address and sends one double opt-in mail", async () => {
    const out = mockNetwork();
    const response = await call(signupRequest("  Ada@Example.COM ", { source: "Website-Hero" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "check_inbox" });
    const stored = await row("ada@example.com");
    expect(stored.source).toBe("website-hero");
    expect(stored.mail_sent_at).toBeTypeOf("number");
    expect(stored.confirmed_at).toBeNull();
    expect(out.resend).toHaveLength(1);
    expect(out.resend[0]!.body.to).toEqual(["ada@example.com"]);
  });

  it("sends List-Unsubscribe and List-Unsubscribe-Post for one-click unsubscribe", async () => {
    const out = mockNetwork();
    await call(signupRequest("ada@example.com"));
    const mail = out.resend[0]!;
    const { unsubscribe } = tokensFrom(mail);
    expect(mail.body.headers["List-Unsubscribe"]).toBe(`<${BASE}/unsubscribe?t=${unsubscribe}>`);
    expect(mail.body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail.headers.get("authorization")).toBe("Bearer re_test_key");
  });

  it("stores tokens only as hashes and gives them an expiry", async () => {
    const out = mockNetwork();
    const before = Date.now();
    await call(signupRequest("ada@example.com"));
    const { confirm, unsubscribe } = tokensFrom(out.resend[0]!);
    expect(confirm).toHaveLength(22);
    expect(confirm).not.toBe(unsubscribe);
    const stored = await row("ada@example.com");
    expect(stored.confirm_hash).toBe(await hashToken(confirm));
    expect(JSON.stringify(stored)).not.toContain(confirm);
    expect(JSON.stringify(stored)).not.toContain(unsubscribe);
    expect(stored.confirm_expires_at).toBeGreaterThan(before + 6 * 86_400_000);
    expect(stored.confirm_expires_at).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
  });

  it("answers a double submit the same and sends one mail", async () => {
    const out = mockNetwork();
    const first = await call(signupRequest("ada@example.com"));
    const second = await call(signupRequest("ADA@example.com "));
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.clone().json());
    expect(out.resend).toHaveLength(1);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers").first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);
  });

  it("sends the mail again after the cooldown and invalidates the old link", async () => {
    const out = mockNetwork();
    await call(signupRequest("ada@example.com"));
    await env.DB.prepare("UPDATE subscribers SET mail_sent_at = ?")
      .bind(Date.now() - 11 * 60_000)
      .run();
    await call(signupRequest("ada@example.com"));
    expect(out.resend).toHaveLength(2);
    const first = tokensFrom(out.resend[0]!).confirm;
    const second = tokensFrom(out.resend[1]!).confirm;
    expect((await row("ada@example.com")).confirm_hash).toBe(await hashToken(second));
    expect((await row("ada@example.com")).confirm_hash).not.toBe(await hashToken(first));
  });

  it("gives an already confirmed address the same answer without a mail", async () => {
    const out = mockNetwork();
    await call(signupRequest("ada@example.com"));
    await env.DB.prepare("UPDATE subscribers SET confirmed_at = 1, mail_sent_at = 1").run();
    const response = await call(signupRequest("ada@example.com"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "check_inbox" });
    expect(out.resend).toHaveLength(1);
  });

  it("refuses an invalid address and a broken body", async () => {
    mockNetwork();
    for (const email of ["", "no-at-sign", "a@b", "a b@example.com", "x@y@example.com"]) {
      const response = await call(signupRequest(email));
      expect(response.status).toBe(400);
      expect((await response.json()) as { code: string }).toMatchObject({ code: "invalid_email" });
    }
    const response = await call(
      new Request(`${BASE}/api/signup`, { method: "POST", body: "nope" }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("keeps a bad source out of the table", async () => {
    mockNetwork();
    await call(signupRequest("ada@example.com", { source: "<script>" }));
    expect((await row("ada@example.com")).source).toBe("unknown");
  });
});

describe("Turnstile", () => {
  it("refuses a failed check and sends nothing", async () => {
    const out = mockNetwork({ turnstile: "fail" });
    const response = await call(signupRequest("ada@example.com"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "turnstile_failed" });
    expect(out.resend).toHaveLength(0);
    expect(await row("ada@example.com")).toBeNull();
  });

  it("refuses a missing token without asking Cloudflare", async () => {
    const out = mockNetwork();
    const response = await call(signupRequest("ada@example.com", { token: null }));
    expect(response.status).toBe(403);
    expect(out.turnstile).toHaveLength(0);
  });

  it("checks the token on every submit, also for a known address", async () => {
    const out = mockNetwork();
    await call(signupRequest("ada@example.com"));
    await call(signupRequest("ada@example.com"));
    expect(out.turnstile).toHaveLength(2);
  });

  it("accepts a token issued for the .com host and refuses an unknown host", async () => {
    mockNetwork({ turnstile: "ok" });
    expect((await call(signupRequest("ada@example.com"))).status).toBe(200);
    vi.restoreAllMocks();
    mockNetwork({ turnstile: "wrong-host" });
    expect((await call(signupRequest("bob@example.com"))).status).toBe(403);
  });

  it("treats an unreachable Turnstile as a failed check", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect((await call(signupRequest("ada@example.com"))).status).toBe(403);
  });
});

describe("Resend", () => {
  it("answers mail_unavailable on a Resend error and keeps the row for a retry", async () => {
    mockNetwork({ resend: 503 });
    const response = await call(signupRequest("ada@example.com"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "mail_unavailable" });
    expect((await row("ada@example.com")).mail_sent_at).toBeNull();

    vi.restoreAllMocks();
    const out = mockNetwork();
    const retry = await call(signupRequest("ada@example.com"));
    expect(retry.status).toBe(200);
    expect(out.resend).toHaveLength(1);
    expect((await row("ada@example.com")).mail_sent_at).toBeTypeOf("number");
  });

  it("answers mail_unavailable if Resend is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input instanceof Request ? input.url : input).includes("resend")) {
        throw new Error("offline");
      }
      return Response.json({ success: true, hostname: "slotmirror.com" });
    });
    const response = await call(signupRequest("ada@example.com"));
    expect(response.status).toBe(503);
  });
});

describe("caps", () => {
  it("stops mails at the daily cap and logs only the number", async () => {
    const out = mockNetwork();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const overrides = { DAILY_MAIL_CAP: "2" };
    expect((await call(signupRequest("a@example.com"), overrides)).status).toBe(200);
    expect((await call(signupRequest("b@example.com"), overrides)).status).toBe(200);
    const capped = await call(signupRequest("c@example.com"), overrides);
    expect(capped.status).toBe(503);
    expect(await capped.json()).toMatchObject({ code: "mail_unavailable" });
    expect(out.resend).toHaveLength(2);
    expect(await row("c@example.com")).toBeNull();
    expect(warn).toHaveBeenCalledWith("mail cap reached", 2);
  });

  it("sends no mail if the cap is zero", async () => {
    const out = mockNetwork();
    const response = await call(signupRequest("a@example.com"), { DAILY_MAIL_CAP: "0" });
    expect(response.status).toBe(503);
    expect(out.resend).toHaveLength(0);
  });

  it("limits attempts per IP address without the Rate Limiting binding", async () => {
    mockNetwork();
    const overrides = { SIGNUPS_PER_IP_PER_HOUR: "3" };
    for (const n of [1, 2, 3]) {
      expect((await call(signupRequest(`u${n}@example.com`), overrides)).status).toBe(200);
    }
    const blocked = await call(signupRequest("u4@example.com"), overrides);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: "rate_limited" });
    expect(blocked.headers.get("retry-after")).toBe("3600");
    // Another address on another network is not affected.
    expect(
      (await call(signupRequest("u5@example.com", { ip: "198.51.100.9" }), overrides)).status,
    ).toBe(200);
  });

  it("stores no plain IP address", async () => {
    mockNetwork();
    await call(signupRequest("ada@example.com", { ip: "203.0.113.7" }));
    const rows = await env.DB.prepare("SELECT * FROM rate_hits").all<{ key_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(JSON.stringify(rows.results)).not.toContain("203.0.113.7");
    expect(rows.results[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("counts an IPv6 network once", async () => {
    mockNetwork();
    await call(signupRequest("a@example.com", { ip: "2001:db8:1:2:aaaa::1" }));
    await call(signupRequest("b@example.com", { ip: "2001:db8:1:2:bbbb::2" }));
    const rows = await env.DB.prepare("SELECT hits FROM rate_hits").all<{ hits: number }>();
    expect(rows.results).toEqual([{ hits: 2 }]);
  });

  it("uses the Rate Limiting binding if it is set, and survives a broken binding", async () => {
    mockNetwork();
    const limit = vi.fn().mockResolvedValue({ success: false });
    const blocked = await call(signupRequest("a@example.com"), { RATE_LIMITER: { limit } });
    expect(blocked.status).toBe(429);
    expect(limit).toHaveBeenCalledOnce();
    const broken = { limit: vi.fn().mockRejectedValue(new Error("unsupported")) };
    expect((await call(signupRequest("b@example.com"), { RATE_LIMITER: broken })).status).toBe(200);
  });
});

describe("hosts and CORS", () => {
  it("answers the preflight for the .com form and the .app host", async () => {
    for (const origin of ["https://slotmirror.com", "https://slotmirror.app"]) {
      const response = await call(
        new Request(`${BASE}/api/signup`, { method: "OPTIONS", headers: { origin } }),
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    }
  });

  it("refuses the preflight and the post from another origin", async () => {
    mockNetwork();
    const preflight = await call(
      new Request(`${BASE}/api/signup`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(preflight.status).toBe(403);
    const post = await call(signupRequest("ada@example.com", { origin: "https://evil.example" }));
    expect(post.status).toBe(403);
    expect(post.headers.get("access-control-allow-origin")).toBeNull();
    expect(await row("ada@example.com")).toBeNull();
  });

  it("sets the CORS header on success and on errors for an allowed origin", async () => {
    mockNetwork({ turnstile: "fail" });
    const response = await call(signupRequest("ada@example.com"));
    expect(response.headers.get("access-control-allow-origin")).toBe("https://slotmirror.com");
  });

  it("refuses to run without its secrets", async () => {
    mockNetwork();
    const response = await call(signupRequest("ada@example.com"), { RESEND_API_KEY: "" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "server_misconfigured" });
  });
});

describe("log hygiene", () => {
  it("writes no address or token to the console", async () => {
    mockNetwork({ resend: 500 });
    const spies = (["log", "warn", "error", "info"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    await call(signupRequest("secret.person@example.com"));
    vi.restoreAllMocks();
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain("secret.person");
    expect(logged).not.toMatch(/[A-Za-z0-9_-]{22}/);
  });
});
