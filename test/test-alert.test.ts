import { env } from "cloudflare:workers";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { sendTestAlert, TEST_ALERT_SECONDS } from "../src/alerts";
import { en } from "../src/i18n/en";
import worker from "../src/index";
import { BASE, signIn } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// Hosts of `outboundService` in vitest.config.ts. These tests use the real `fetch` of workerd: the
// spies below count calls and pass them on, because a mock of `fetch` hides how workerd behaves.
const ACCEPTS = { ALERT_WEBHOOK_URL: "https://hook-accepts.test/secret-path" };
const REDIRECTS = { ALERT_WEBHOOK_URL: "https://hook-redirects.test/secret-path" };
const REFUSES = { ALERT_WEBHOOK_URL: "https://hook-refuses.test/secret-path" };
const NO_HOOK = { ALERT_WEBHOOK_URL: "" };

async function call(
  path: string,
  options: { cookie?: string; method?: string; headers?: Record<string, string> } = {},
  overrides: Partial<Env> = ACCEPTS,
): Promise<Response> {
  const { cookie, method = "GET", headers = {} } = options;
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: { "accept-language": "en", ...(cookie ? { cookie } : {}), ...headers },
      redirect: "manual",
    }),
    { ...env, ...overrides },
    ctx,
  );
}

const post = (cookie: string | undefined, overrides?: Partial<Env>) =>
  call("/admin/test-alert", { cookie, method: "POST" }, overrides);

async function requests(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'alert_test'",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Move the stored requests into the past, by the D1 clock that the limit reads. */
async function ageRequests(seconds: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE audit_events SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
     WHERE kind = 'alert_test'`,
  )
    .bind(`-${seconds} seconds`)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_events WHERE kind = 'alert_test'").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("test alert on the admin page", () => {
  it("offers the button, and never shows the webhook URL", async () => {
    const { cookie } = await signIn("admin@example.com");
    const html = await (await call("/admin", { cookie })).text();
    expect(html).toContain('action="/admin/test-alert"');
    expect(html).toContain(en.admin.testAlertSend);
    expect(html).not.toContain("hook-accepts");
    expect(html).not.toContain("secret-path");
  });

  it("offers no button without a webhook", async () => {
    const { cookie } = await signIn("admin@example.com");
    const html = await (await call("/admin", { cookie }, NO_HOOK)).text();
    expect(html).not.toContain('action="/admin/test-alert"');
    expect(html).toContain(en.admin.alertsOff);
  });

  it("shows a result only for a known value", async () => {
    const { cookie } = await signIn("admin@example.com");
    const results: Record<string, string> = en.admin.testAlertResults;
    for (const [value, text] of Object.entries(results)) {
      expect(await (await call(`/admin?alert=${value}`, { cookie })).text()).toContain(text);
    }
    for (const value of ["constructor", "__proto__", "%3Cscript%3Ealert(1)%3C/script%3E"]) {
      const html = await (await call(`/admin?alert=${value}`, { cookie })).text();
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("test-alert-result");
    }
  });
});

describe("POST /admin/test-alert", () => {
  it("delivers through the real fetch and reports it, without the URL", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch");
    const { user, cookie } = await signIn("admin@example.com");
    const response = await post(cookie);
    expect(error.mock.calls).toEqual([]);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin?alert=sent");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(ACCEPTS.ALERT_WEBHOOK_URL);
    const { text } = JSON.parse(init?.body as string) as { text: string };
    expect(text).toContain(en.alerts.test(""));
    expect(text).not.toContain(user.email);
    const html = await (await call("/admin?alert=sent", { cookie })).text();
    expect(html).toContain(en.admin.testAlertResults.sent);
    expect(html).not.toContain("secret-path");
  });

  it.each([
    ["a redirect", REDIRECTS],
    ["an error answer", REFUSES],
  ])("reports %s as failed and shows no URL or answer", async (_name, hook) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { cookie } = await signIn("admin@example.com");
    const response = await post(cookie, hook);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin?alert=failed");
    const html = await (await call("/admin?alert=failed", { cookie }, hook)).text();
    expect(html).toContain(en.admin.testAlertResults.failed);
    expect(html).not.toContain("secret-path");
    expect(html).not.toContain("no network in tests");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-path");
  });

  it("sends nothing and stores nothing without a webhook", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { cookie } = await signIn("admin@example.com");
    const response = await post(cookie, NO_HOOK);
    expect(response.headers.get("location")).toBe("/admin?alert=off");
    expect(fetch).not.toHaveBeenCalled();
    expect(await requests()).toBe(0);
  });

  it("allows one request per minute", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { cookie } = await signIn("admin@example.com");
    await post(cookie);
    const second = await post(cookie);
    expect(second.headers.get("location")).toBe("/admin?alert=limited");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await requests()).toBe(1);
  });

  it("counts a failed post, so a broken webhook gets no more calls", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch");
    const { cookie } = await signIn("admin@example.com");
    await post(cookie, REFUSES);
    const second = await post(cookie, REFUSES);
    expect(second.headers.get("location")).toBe("/admin?alert=limited");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("holds the limit until the minute ends", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { cookie } = await signIn("admin@example.com");
    await post(cookie);
    await ageRequests(TEST_ALERT_SECONDS - 5);
    expect((await post(cookie)).headers.get("location")).toBe("/admin?alert=limited");
    await ageRequests(TEST_ALERT_SECONDS + 1);
    expect((await post(cookie)).headers.get("location")).toBe("/admin?alert=sent");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("lets one of two parallel requests through", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { cookie } = await signIn("admin@example.com");
    const answers = await Promise.all([post(cookie), post(cookie), post(cookie)]);
    const places = answers.map((answer) => answer.headers.get("location"));
    expect(places.filter((place) => place === "/admin?alert=sent")).toHaveLength(1);
    expect(places.filter((place) => place === "/admin?alert=limited")).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is for admins only", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const member = await signIn("owner@example.com");
    expect((await post(member.cookie)).status).toBe(404);
    const visitor = await post(undefined);
    expect(visitor.status).toBe(302);
    expect(visitor.headers.get("location")).toBe("/");
    expect(fetch).not.toHaveBeenCalled();
    expect(await requests()).toBe(0);
  });

  it("does not answer a GET", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { cookie } = await signIn("admin@example.com");
    expect((await call("/admin/test-alert", { cookie })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(await requests()).toBe(0);
  });

  it.each([
    [{ "sec-fetch-site": "cross-site", origin: "https://evil.example" }],
    [{ "sec-fetch-site": "same-site", origin: "https://attacker.example.workers.dev" }],
    [{ origin: "https://evil.example" }],
  ])("refuses the cross-site request %o", async (headers) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { cookie } = await signIn("admin@example.com");
    const response = await call("/admin/test-alert", { cookie, method: "POST", headers });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(await requests()).toBe(0);
  });

  it("names the request in the activity log, without the URL", async () => {
    const { cookie } = await signIn("admin@example.com");
    await post(cookie);
    const html = await (await call("/admin", { cookie })).text();
    expect(html).toContain(en.activity.kinds.alert_test);
    expect(html).not.toContain("secret-path");
  });
});

describe("sendTestAlert", () => {
  it("posts nothing if D1 cannot store the request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const broken = {
      prepare: () => {
        throw new Error("D1 is down");
      },
    } as unknown as D1Database;
    await expect(
      sendTestAlert({ ...env, ...ACCEPTS, DB: broken }, { orgId: "default", userId: "u1" }),
    ).rejects.toThrow("D1 is down");
    expect(fetch).not.toHaveBeenCalled();
  });
});
