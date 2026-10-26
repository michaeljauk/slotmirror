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
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret");
  });
});
