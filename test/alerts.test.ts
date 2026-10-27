import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendReconnectAlert } from "../src/alerts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconnect alert", () => {
  it("sends nothing without ALERT_WEBHOOK_URL", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await sendReconnectAlert({ ...env, ALERT_WEBHOOK_URL: "" }, "google");
    await sendReconnectAlert({ ...env, ALERT_WEBHOOK_URL: undefined }, "google");
    expect(fetch).not.toHaveBeenCalled();
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

  it("does not follow a redirect, and fails like any other failed alert", async () => {
    // workerd rejects with a TypeError when `redirect` is "error" and the answer is a 3xx.
    // Any other mode follows the redirect to a second URL, which the mock models as success.
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.redirect === "error") throw new TypeError("redirect at http://evil.example/secret");
      return new Response("ok", { status: 200 });
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await sendReconnectAlert(
      { ...env, ALERT_WEBHOOK_URL: "https://hooks.example/secret" },
      "google",
    );
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("Alert webhook failed");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("evil.example");
  });
});
