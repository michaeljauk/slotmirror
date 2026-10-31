import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendCompareAlert, sendReconnectAlert } from "../src/alerts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconnect alert", () => {
  it("sends nothing without ALERT_WEBHOOK_URL", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await sendReconnectAlert({ ...env, ALERT_WEBHOOK_URL: "" }, "google")).toBe("off");
    expect(await sendReconnectAlert({ ...env, ALERT_WEBHOOK_URL: undefined }, "google")).toBe(
      "off",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a 2xx answer as sent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    expect(await sendReconnectAlert(env, "google")).toBe("sent");
  });

  it.each([301, 404, 500, 503])("reports an answer of %i as failed", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
    expect(await sendReconnectAlert(env, "google")).toBe("failed");
  });

  it("reports a network failure and a URL without https as failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("down"));
    expect(await sendReconnectAlert(env, "google")).toBe("failed");
    expect(
      await sendReconnectAlert({ ...env, ALERT_WEBHOOK_URL: "http://hooks.example/x" }, "google"),
    ).toBe("failed");
  });

  it("refuses a URL without https, and logs no URL", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await sendReconnectAlert(
      { ...env, ALERT_WEBHOOK_URL: "http://hooks.example/secret" },
      "google",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret");
  });

  it("posts Slack-style JSON, and a failing webhook does not throw", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new TypeError("network down at https://hooks.example/secret"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await sendReconnectAlert(
      { ...env, ALERT_WEBHOOK_URL: "https://hooks.example/secret" },
      "google",
    );
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://hooks.example/secret");
    expect(JSON.parse(init?.body as string)).toEqual({
      text: expect.stringContaining("a Google account needs reconnecting"),
    });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("network down");
    expect(logged).toContain("TypeError");
  });

  // These two tests use the real `fetch` of workerd, which accepts fewer `redirect` modes than the
  // standard. A mock of `fetch` hides that. See `outboundService` in vitest.config.ts.
  it("delivers an alert through the real fetch", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent = await sendReconnectAlert(
      { ...env, ALERT_WEBHOOK_URL: "https://hook-accepts.test/secret" },
      "google",
    );
    expect(error.mock.calls).toEqual([]);
    expect(sent).toBe("sent");
  });

  it("does not follow a redirect of the real fetch, and counts the 3xx as failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent = await sendReconnectAlert(
      { ...env, ALERT_WEBHOOK_URL: "https://hook-redirects.test/secret" },
      "google",
    );
    expect(sent).toBe("failed");
    expect(error.mock.calls).toEqual([["Alert webhook answered", 302]]);
  });
});

describe("comparison alert through the real fetch", () => {
  const scope = { orgId: "default", userId: "u", accountId: "a" };
  const found = (calendarId: string) => ({
    calendarId,
    mode: "full" as const,
    scanStartedAt: "2026-10-30T10:00:00.000Z",
    deviations: 1,
    missing: 1,
    surplus: 0,
    mismatched: 0,
    duplicates: 0,
    hitsCapped: false,
  });

  const locksOf = async (calendarId: string) => {
    const { results } = await env.DB.prepare(
      `SELECT id FROM audit_events
       WHERE kind = 'alert_sent' AND json_extract(detail, '$.calendarId') = ?`,
    )
      .bind(calendarId)
      .all();
    return results.length;
  };

  it("delivers the alert and stores its lock", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = "https://hook-accepts.test/secret";
    const result = await sendCompareAlert({ ...env, ALERT_WEBHOOK_URL: url }, scope, [
      found("real-sent"),
    ]);
    expect(error.mock.calls).toEqual([]);
    expect(result).toEqual({ outcome: "sent", open: [] });
    expect(await locksOf("real-sent")).toBe(1);
  });

  it("does not follow a redirect, stores no lock, and keeps the alert open", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const alert = found("real-redirected");
    const url = "https://hook-redirects.test/secret";
    const result = await sendCompareAlert({ ...env, ALERT_WEBHOOK_URL: url }, scope, [alert]);
    expect(result).toEqual({ outcome: "failed", open: [alert] });
    expect(error.mock.calls).toEqual([["Alert webhook answered", 302]]);
    expect(await locksOf("real-redirected")).toBe(0);
  });
});
