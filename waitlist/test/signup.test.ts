import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/crypto";
import {
  BASE,
  call,
  formRequest,
  mockNetwork,
  reset,
  row,
  signupRequest,
  testEnv,
  tokensFrom,
} from "./helpers";

beforeEach(reset);

const NO_IP_LIMIT = { SIGNUPS_PER_IP_PER_HOUR: "1000", SIGNUPS_PER_IP_PER_DAY: "1000" };
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
    for (const email of [
      "",
      "no-at-sign",
      "a@b",
      "a b@example.com",
      "x@y@example.com",
      "foo<victim@x.de>",
      "<victim@x.de>",
      "victim@x.de>",
      "a,b@x.de",
      "a@x.de,b@y.de",
      '"a"@x.de',
      "a@x .de",
      ".a@x.de",
      "a..b@x.de",
      "a@-x.de",
      "a@x_y.de",
      "a@x.d1",
    ]) {
      const response = await call(signupRequest(email), NO_IP_LIMIT);
      expect(response.status).toBe(400);
      expect((await response.json()) as { code: string }).toMatchObject({ code: "invalid_email" });
    }
    const response = await call(
      new Request(`${BASE}/api/signup`, { method: "POST", body: "nope" }),
      NO_IP_LIMIT,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("accepts plain addresses with usual symbols", async () => {
    mockNetwork();
    for (const email of ["o'brien+tag@sub.example.co.uk", "a.b_c-d@xn--mnchen-3ya.de"]) {
      expect((await call(signupRequest(email), NO_IP_LIMIT)).status).toBe(200);
    }
  });

  it("reads a form post with the Turnstile field name", async () => {
    const out = mockNetwork();
    const response = await call(
      formRequest({
        email: "Form@Example.com",
        source: "website-footer",
        "cf-turnstile-response": "turnstile-ok",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "check_inbox" });
    expect((await row("form@example.com")).source).toBe("website-footer");
    expect(out.turnstile).toHaveLength(1);
    expect(out.resend).toHaveLength(1);
  });

  it("refuses a form post without a Turnstile token", async () => {
    mockNetwork();
    const response = await call(formRequest({ email: "form@example.com" }));
    expect(response.status).toBe(403);
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

  it("refuses a missing hostname, also with the localhost allowance off", async () => {
    mockNetwork({ turnstile: "no-host" });
    const response = await call(signupRequest("ada@example.com"));
    expect(response.status).toBe(403);
    expect(await row("ada@example.com")).toBeNull();
  });

  it("refuses localhost unless the local test allowance is set", async () => {
    mockNetwork({ turnstile: "localhost" });
    expect((await call(signupRequest("a@example.com"))).status).toBe(403);
    const local = { TURNSTILE_ALLOW_LOCALHOST: "true" };
    expect((await call(signupRequest("b@example.com"), local)).status).toBe(200);
  });

  it("accepts a missing hostname only with the local test allowance", async () => {
    mockNetwork({ turnstile: "no-host" });
    const local = { TURNSTILE_ALLOW_LOCALHOST: "true" };
    expect((await call(signupRequest("ada@example.com"), local)).status).toBe(200);
  });

  it("does not let the local allowance accept an unknown host", async () => {
    mockNetwork({ turnstile: "wrong-host" });
    const local = { TURNSTILE_ALLOW_LOCALHOST: "true" };
    expect((await call(signupRequest("ada@example.com"), local)).status).toBe(403);
  });

  it("treats an unreachable Turnstile as a failed check", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect((await call(signupRequest("ada@example.com"))).status).toBe(403);
  });
});

describe("Resend", () => {
  it("answers like a known address on a Resend error and removes the row", async () => {
    mockNetwork({ resend: 503 });
    const response = await call(signupRequest("ada@example.com"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "check_inbox" });
    expect(await row("ada@example.com")).toBeNull();
  });

  it("gives the cap slot back after a failed send", async () => {
    mockNetwork({ resend: 503 });
    await call(signupRequest("ada@example.com"));
    const counter = await env.DB.prepare("SELECT reserved FROM mail_counter").first<{
      reserved: number;
    }>();
    expect(counter?.reserved).toBe(0);
  });

  it("sends again on the next sign-up after a failed send", async () => {
    mockNetwork({ resend: 503 });
    await call(signupRequest("ada@example.com"));
    vi.restoreAllMocks();
    const out = mockNetwork();
    expect((await call(signupRequest("ada@example.com"))).status).toBe(200);
    expect(out.resend).toHaveLength(1);
    expect((await row("ada@example.com")).mail_sent_at).toBeTypeOf("number");
  });

  it("removes a pending row after a failed resend and keeps a confirmed one", async () => {
    mockNetwork();
    await call(signupRequest("pending@example.com"));
    await call(signupRequest("done@example.com"));
    await env.DB.prepare("UPDATE subscribers SET mail_sent_at = ?")
      .bind(Date.now() - 11 * 60_000)
      .run();
    await env.DB.prepare("UPDATE subscribers SET confirmed_at = 1 WHERE email = ?")
      .bind("done@example.com")
      .run();
    vi.restoreAllMocks();
    mockNetwork({ resend: 500 });
    await call(signupRequest("pending@example.com"));
    await call(signupRequest("done@example.com"));
    expect(await row("pending@example.com")).toBeNull();
    expect((await row("done@example.com")).confirmed_at).toBe(1);
  });

  it("answers the same if Resend is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input instanceof Request ? input.url : input).includes("resend")) {
        throw new Error("offline");
      }
      return Response.json({ success: true, hostname: "slotmirror.com" });
    });
    const response = await call(signupRequest("ada@example.com"));
    expect(response.status).toBe(200);
    expect(await row("ada@example.com")).toBeNull();
  });
});

describe("storage errors", () => {
  it("answers storage_unavailable with CORS and logs no address", async () => {
    mockNetwork();
    const broken = {
      ...testEnv(),
      DB: {
        prepare: () => {
          throw new Error("D1 down: secret.person@example.com");
        },
        batch: () => {
          throw new Error("D1 down");
        },
      },
    } as unknown as ReturnType<typeof testEnv>;
    const spies = (["log", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const { handle } = await import("../src/index");
    const response = await handle(signupRequest("secret.person@example.com"), broken);
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    vi.restoreAllMocks();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "storage_unavailable" });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://slotmirror.com");
    expect(logged).not.toContain("secret.person");
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

  it("gives a known and an unknown address the same answer at the cap", async () => {
    const out = mockNetwork();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const overrides = { DAILY_MAIL_CAP: "1" };
    expect((await call(signupRequest("known@example.com"), overrides)).status).toBe(200);
    await env.DB.prepare("UPDATE subscribers SET confirmed_at = 1").run();
    const known = await call(signupRequest("known@example.com"), overrides);
    const unknown = await call(signupRequest("new@example.com"), overrides);
    expect(known.status).toBe(503);
    expect(unknown.status).toBe(503);
    expect(await known.json()).toEqual(await unknown.json());
    expect(out.resend).toHaveLength(1);
  });

  it("answers a pending address in its cooldown the same at the cap", async () => {
    mockNetwork();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const overrides = { DAILY_MAIL_CAP: "1" };
    await call(signupRequest("known@example.com"), overrides);
    expect((await call(signupRequest("known@example.com"), overrides)).status).toBe(503);
  });

  it("limits attempts per IP address per day", async () => {
    mockNetwork();
    const overrides = { SIGNUPS_PER_IP_PER_HOUR: "1000", SIGNUPS_PER_IP_PER_DAY: "4" };
    for (const n of [1, 2, 3, 4]) {
      expect((await call(signupRequest(`d${n}@example.com`), overrides)).status).toBe(200);
    }
    const blocked = await call(signupRequest("d5@example.com"), overrides);
    expect(blocked.status).toBe(429);
    expect(
      (await call(signupRequest("d6@example.com", { ip: "198.51.100.9" }), overrides)).status,
    ).toBe(200);
  });

  it("keeps the default limits of one IP address well below the mail cap", () => {
    expect(Number(env.SIGNUPS_PER_IP_PER_DAY)).toBeGreaterThan(0);
    expect(Number(env.SIGNUPS_PER_IP_PER_DAY) * 5).toBeLessThanOrEqual(Number(env.DAILY_MAIL_CAP));
  });

  it("counts a request before it reads the body", async () => {
    mockNetwork();
    const overrides = { SIGNUPS_PER_IP_PER_HOUR: "1" };
    await call(new Request(`${BASE}/api/signup`, { method: "POST", body: "nope" }), overrides);
    const blocked = await call(
      new Request(`${BASE}/api/signup`, { method: "POST", body: "nope" }),
      overrides,
    );
    expect(blocked.status).toBe(429);
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
    expect(rows.results).toHaveLength(2);
    expect(JSON.stringify(rows.results)).not.toContain("203.0.113.7");
    for (const { key_hash } of rows.results) expect(key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("counts an IPv6 network once", async () => {
    mockNetwork();
    await call(signupRequest("a@example.com", { ip: "2001:db8:1:2:aaaa::1" }));
    await call(signupRequest("b@example.com", { ip: "2001:db8:1:2:bbbb::2" }));
    const rows = await env.DB.prepare("SELECT hits FROM rate_hits").all<{ hits: number }>();
    expect(rows.results).toEqual([{ hits: 2 }, { hits: 2 }]);
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
