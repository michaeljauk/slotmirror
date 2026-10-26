import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webhookToken, webhookUrl } from "../src/webhooks";
import { BASE, signIn } from "./helpers";

/** Two accounts with one rule from the first into the second, both with tokens. */
async function setup(prefix: string) {
  const { user } = await signIn("owner@example.com");
  const [a, b] = [`${prefix}-a`, `${prefix}-b`];
  for (const id of [a, b]) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
      ).bind(id, user.id, `${id}@example.com`),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
    ]);
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(id, {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
  }
  await env.DB.prepare(
    "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES (?, ?, ?, ?)",
  )
    .bind(`${prefix}-rule`, user.id, `${a}-cal`, `${b}-cal`)
    .run();
  return { a, b };
}

const alarmOf = (id: string) =>
  runInDurableObject(env.ACCOUNT_SYNC.getByName(id), (_instance, state) =>
    state.storage.getAlarm(),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook address", () => {
  it("needs an https PUBLIC_URL", () => {
    expect(webhookUrl({ ...env, PUBLIC_URL: "" }, "google", "x")).toBeNull();
    expect(webhookUrl({ ...env, PUBLIC_URL: "http://plain.example" }, "google", "x")).toBeNull();
    expect(webhookUrl({ ...env, PUBLIC_URL: "https://sync.example/" }, "microsoft", "a b")).toBe(
      "https://sync.example/webhooks/microsoft?account=a%20b",
    );
  });
});

describe("notifications", () => {
  it("starts a sync in the changed account and in the targets of its rules", async () => {
    const { a, b } = await setup("hook-ms");
    const response = await exports.default.fetch(`${BASE}/webhooks/microsoft?account=${a}`, {
      method: "POST",
      body: JSON.stringify({ value: [{ clientState: await webhookToken(env, a) }] }),
    });
    expect(response.status).toBe(202);
    expect(await alarmOf(a)).not.toBeNull();
    expect(await alarmOf(b)).not.toBeNull();
  });

  it("ignores a notification with a wrong token, and Google's sync message", async () => {
    const { a } = await setup("hook-bad");
    const forged = await exports.default.fetch(`${BASE}/webhooks/microsoft?account=${a}`, {
      method: "POST",
      body: JSON.stringify({ value: [{ clientState: "guess" }] }),
    });
    expect(forged.status).toBe(202);
    const sync = await exports.default.fetch(`${BASE}/webhooks/google?account=${a}`, {
      method: "POST",
      headers: {
        "x-goog-resource-state": "sync",
        "x-goog-channel-token": await webhookToken(env, a),
      },
    });
    expect(sync.status).toBe(200);
    expect(await alarmOf(a)).toBeNull();

    await exports.default.fetch(`${BASE}/webhooks/google?account=${a}`, {
      method: "POST",
      headers: {
        "x-goog-resource-state": "exists",
        "x-goog-channel-token": await webhookToken(env, a),
      },
    });
    expect(await alarmOf(a)).not.toBeNull();
  });
});

describe("watches", () => {
  it("subscribes to the calendars rules use, renews them, and stops unused ones", async () => {
    const { a } = await setup("watch");
    const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
    let expiry = Date.now() + 6 * 24 * 3_600_000;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: JSON.parse((init?.body as string) ?? "{}") });
      if (url.endsWith("/subscriptions") && method === "POST") {
        return Response.json({ id: "sub-1", expirationDateTime: new Date(expiry).toISOString() });
      }
      if (url.includes("/subscriptions/sub-1") && method === "PATCH") {
        return Response.json({ id: "sub-1", expirationDateTime: new Date(expiry).toISOString() });
      }
      if (url.includes("/subscriptions/sub-1") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const stub = env.ACCOUNT_SYNC.getByName(a);

    await stub.ensureWatches();
    const created = calls.find((call) => call.method === "POST");
    expect(created?.body).toMatchObject({
      resource: `me/calendars/${a}-remote/events`,
      notificationUrl: `https://slotmirror.example.workers.dev/webhooks/microsoft?account=${a}`,
      clientState: await webhookToken(env, a),
    });

    // A fresh watch is left alone.
    calls.length = 0;
    await stub.ensureWatches();
    expect(calls).toHaveLength(0);

    // One that expires within a day is renewed.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE subscriptions SET expires_at = ?", Date.now() + 3_600_000);
    });
    await stub.ensureWatches();
    expect(calls.map((call) => call.method)).toEqual(["PATCH"]);

    // Without a rule, the watch stops.
    calls.length = 0;
    await env.DB.prepare("DELETE FROM rules WHERE id = 'watch-rule'").run();
    await stub.ensureWatches();
    expect(calls.map((call) => call.method)).toEqual(["DELETE"]);
  });
});
