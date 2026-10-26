import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSync } from "../src/account-sync";
import { notifyChange, webhookToken, webhookUrl } from "../src/webhooks";
import fixture from "./fixtures/graph/calendar-view.json";
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

/**
 * Make `requestSync` throw in the given accounts, at most `times` times. Returns the accounts in
 * the order of their failed calls.
 */
function failSyncRequests(accounts: string[], times = Infinity): string[] {
  const original = Object.getOwnPropertyDescriptor(AccountSync.prototype, "requestSync")!.value as (
    this: AccountSync,
  ) => Promise<void>;
  const failed: string[] = [];
  vi.spyOn(AccountSync.prototype, "requestSync").mockImplementation(async function (
    this: AccountSync,
  ) {
    const name = (this as unknown as { ctx: DurableObjectState }).ctx.id.name ?? "";
    if (accounts.includes(name) && failed.length < times) {
      failed.push(name);
      throw new Error("unavailable");
    }
    return original.call(this);
  });
  return failed;
}

/** Move the clock forward; alarms set from now on count from there. */
function advanceClock(ms: number): void {
  const now = Date.now() + ms;
  vi.spyOn(Date, "now").mockReturnValue(now);
}

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

  it("requests the sync in the other accounts if one of them fails", async () => {
    const { a, b } = await setup("hook-fail");
    // The changed account comes first; its failure must not skip the target of its rule.
    const failed = failSyncRequests([a]);
    await expect(notifyChange(env, a)).rejects.toThrow();
    expect(failed).toEqual([a]);
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

describe("cron ticks", () => {
  const queueOf = (id: string) =>
    runInDurableObject(env.ACCOUNT_SYNC.getByName(id), (_instance, state) =>
      state.storage.get<string[]>("ruleQueue"),
    );
  const setFullCycle = (id: string, at: number) =>
    runInDurableObject(env.ACCOUNT_SYNC.getByName(id), (_instance, state) =>
      state.storage.put("fullCycleAt", at),
    );

  it("polls only rules whose calendars have no active watch, and runs a full cycle hourly", async () => {
    const { a, b } = await setup("tick");
    const stub = env.ACCOUNT_SYNC.getByName(b);

    // No full cycle yet: the tick starts one.
    await stub.tick();
    expect(await alarmOf(b)).not.toBeNull();
    expect(await queueOf(b)).toBeUndefined();

    // After a recent full cycle, an unwatched source is polled.
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    await setFullCycle(b, Date.now());
    await stub.tick();
    expect(await queueOf(b)).toEqual(["tick-rule"]);

    // With both calendars watched, nothing is queued.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.delete("ruleQueue");
      await state.storage.deleteAlarm();
    });
    await env.DB.prepare("UPDATE calendars SET watched_until = ? WHERE account_id IN (?, ?)")
      .bind(Date.now() + 86_400_000, a, b)
      .run();
    await stub.tick();
    expect(await queueOf(b)).toBeUndefined();
    expect(await alarmOf(b)).toBeNull();

    // An hour later the check runs anyway.
    await setFullCycle(b, Date.now() - 61 * 60_000);
    await stub.tick();
    expect(await alarmOf(b)).not.toBeNull();
  });
});

describe("echo filter", () => {
  /** A Graph notification about the given events in one account. */
  const notifyGraph = async (accountId: string, ...ids: string[]) => {
    const clientState = await webhookToken(env, accountId);
    return exports.default.fetch(`${BASE}/webhooks/microsoft?account=${accountId}`, {
      method: "POST",
      body: JSON.stringify({ value: ids.map((id) => ({ clientState, resourceData: { id } })) }),
    });
  };

  it("skips a Graph notification about blocks this deployment just wrote", async () => {
    const { a, b } = await setup("echo");
    const stub = env.ACCOUNT_SYNC.getByName(a);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("recentWrites", { "block-1": Date.now() }),
    );

    // The webhook only notes the IDs; an alarm checks them.
    await notifyGraph(a, "block-1");
    expect(await alarmOf(b)).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmOf(a)).toBeNull();
    expect(await alarmOf(b)).toBeNull();

    await notifyGraph(a, "someone-elses-meeting");
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(a)).not.toBeNull();
    expect(await alarmOf(b)).not.toBeNull();
  });

  it("checks a burst of Graph notifications in one alarm", async () => {
    const { a, b } = await setup("eburst");
    const stub = env.ACCOUNT_SYNC.getByName(a);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("recentWrites", { "block-1": Date.now(), "block-2": Date.now() }),
    );
    await Promise.all([notifyGraph(a, "block-1"), notifyGraph(a, "block-1", "block-2")]);
    await runDurableObjectAlarm(stub);
    // No second check and no sync.
    expect(await alarmOf(a)).toBeNull();
    expect(await alarmOf(b)).toBeNull();
  });

  it("skips a Graph notification that arrives before its write is remembered", async () => {
    const { a, b } = await setup("erace");
    // The first account also reads the second, so that a sync there would reach it.
    const { results } = await env.DB.prepare(
      "SELECT user_id FROM rules WHERE id = 'erace-rule'",
    ).all<{
      user_id: string;
    }>();
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES ('erace-back', ?, ?, ?)",
    )
      .bind(results[0]!.user_id, `${b}-cal`, `${a}-cal`)
      .run();
    const target = env.ACCOUNT_SYNC.getByName(b);
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (url.includes(`/calendars/${a}-remote/calendarView`)) {
        return Response.json({ value: [fixture.value[0]] });
      }
      if (url.includes(`/calendars/${b}-remote/calendarView`)) return Response.json({ value: [] });
      if (url.endsWith("/$batch")) {
        const { requests } = JSON.parse(init?.body as string) as { requests: { id: string }[] };
        // Graph reports the new block before it answers the batch.
        await notifyGraph(b, ...requests.map((request) => `created-${request.id}`));
        return Response.json({
          responses: requests.map((request) => ({
            id: request.id,
            status: 201,
            body: { id: `created-${request.id}` },
          })),
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    await runInDurableObject(target, async (_instance, state) => {
      await state.storage.put("ruleQueue", ["erace-rule"]);
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(target)).toBe(true);
    expect(urls.filter((url) => url.endsWith("/$batch"))).toHaveLength(1);
    // The next alarm checks the notification and finds the block it wrote.
    urls.length = 0;
    expect(await runDurableObjectAlarm(target)).toBe(true);
    expect(urls).toEqual([]);
    expect(await alarmOf(a)).toBeNull();
    expect(await alarmOf(b)).toBeNull();
  });

  it("recognises its own write when Retry-After delays the check", async () => {
    const { a, b } = await setup("edelay");
    const stub = env.ACCOUNT_SYNC.getByName(a);
    const writtenAt = Date.now();
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("recentWrites", { "block-1": writtenAt }),
    );
    await notifyGraph(a, "block-1");
    // A throttled rule run moved the alarm by the longest Retry-After.
    vi.spyOn(Date, "now").mockReturnValue(writtenAt + 5 * 60_000);
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(a)).toBeNull();
    expect(await alarmOf(b)).toBeNull();
  });

  it("runs queued rules in the same alarm when the check finds only its own writes", async () => {
    const { a, b } = await setup("enext");
    const target = env.ACCOUNT_SYNC.getByName(b);
    await runInDurableObject(target, async (_instance, state) => {
      await state.storage.put("recentWrites", { "block-1": Date.now() });
      await state.storage.put("ruleQueue", ["enext-rule"]);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await notifyGraph(b, "block-1");
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      return Response.json({ value: [] });
    });
    await runDurableObjectAlarm(target);
    expect(urls.some((url) => url.includes(`/calendars/${a}-remote/calendarView`))).toBe(true);
    expect(
      await runInDurableObject(target, (_instance, state) => state.storage.get("ruleQueue")),
    ).toBeUndefined();
    expect(await alarmOf(a)).toBeNull();
  });

  /**
   * The first account as a Google account with a watched calendar, a stored sync token and one
   * block written just now. The feed answers each events.list with the next of `pages`.
   */
  async function setupGoogle(prefix: string, pages: (() => Response)[]) {
    const { a, b } = await setup(prefix);
    const stub = env.ACCOUNT_SYNC.getByName(a);
    await stub.storeTokens(
      a,
      { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + 3_600_000 },
      "google",
    );
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO subscriptions (remote_id, calendar_id, resource_id, expires_at) VALUES (?, ?, ?, ?)",
        "channel-1",
        `${a}-remote`,
        "resource-1",
        Date.now() + 86_400_000,
      );
      await state.storage.put(`syncToken:${a}-remote`, "token-1");
      await state.storage.put("recentWrites", { "block-1": Date.now() });
    });
    const urls: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(new URL(input instanceof Request ? input.url : String(input)));
      const page = pages.shift();
      return page ? page() : new Response("unexpected", { status: 500 });
    });
    const notify = async (channel = "channel-1") =>
      exports.default.fetch(`${BASE}/webhooks/google?account=${a}`, {
        method: "POST",
        headers: {
          "x-goog-resource-state": "exists",
          "x-goog-channel-id": channel,
          "x-goog-channel-token": await webhookToken(env, a),
        },
      });
    const storedToken = () =>
      runInDurableObject(stub, (_instance, state) =>
        state.storage.get<string>(`syncToken:${a}-remote`),
      );
    return { a, b, stub, urls, notify, storedToken };
  }

  const feed = (ids: string[], nextSyncToken: string) => () =>
    Response.json({ items: ids.map((id) => ({ id })), nextSyncToken });

  it("skips a Google notification if the feed shows only blocks this deployment just wrote", async () => {
    const { a, b, stub, urls, notify, storedToken } = await setupGoogle("gecho", [
      feed(["block-1"], "token-2"),
    ]);
    // The webhook only notes the calendar; an alarm reads the feed.
    expect((await notify()).status).toBe(200);
    expect(urls).toHaveLength(0);
    expect(await alarmOf(b)).toBeNull();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(urls[0]?.searchParams.get("syncToken")).toBe("token-1");
    expect(urls[0]?.searchParams.get("fields")).toBe("nextPageToken,nextSyncToken,items(id)");
    expect(await storedToken()).toBe("token-2");
    // Neither a cycle here nor in the account that reads the calendar.
    expect(await alarmOf(a)).toBeNull();
    expect(await alarmOf(b)).toBeNull();
  });

  it("syncs both accounts if the feed shows another change", async () => {
    const { a, b, stub, notify, storedToken } = await setupGoogle("gother", [
      feed(["block-1", "users-meeting"], "token-2"),
    ]);
    await notify();
    await runDurableObjectAlarm(stub);
    expect(await storedToken()).toBe("token-2");
    expect(await alarmOf(a)).not.toBeNull();
    expect(await alarmOf(b)).not.toBeNull();
  });

  it("reads the feed once for a burst of notifications", async () => {
    const { stub, urls, notify } = await setupGoogle("gburst", [feed(["block-1"], "token-2")]);
    await Promise.all([notify(), notify(), notify()]);
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.get<{ calendarId: string }[]>("changedCalendars"),
      ),
    ).toEqual([expect.objectContaining({ calendarId: "gburst-a-remote" })]);
    await runDurableObjectAlarm(stub);
    expect(urls).toHaveLength(1);
  });

  it("keeps a sync that was requested after the notification", async () => {
    const { a, stub, notify } = await setupGoogle("gafter", [feed(["block-1"], "token-2")]);
    await notify();
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(a)).not.toBeNull();
  });

  it("queues the calendar again if a notification arrives while its feed is read", async () => {
    const { a, b, stub } = await setupGoogle("gduring", []);
    await runInDurableObject(stub, async (instance: AccountSync, state) => {
      await instance.googleChanged("channel-1");
      vi.mocked(globalThis.fetch).mockImplementation(async () => {
        // The user changes an event after Google listed the feed.
        await instance.googleChanged("channel-1");
        return feed(["block-1"], "token-2")();
      });
      await instance.alarm();
      expect(await state.storage.get("changedCalendars")).toEqual([
        expect.objectContaining({ calendarId: `${a}-remote` }),
      ]);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(await alarmOf(b)).toBeNull();
  });

  it("keeps a sync that was requested before the notification", async () => {
    const { a, stub, notify } = await setupGoogle("gpending", [feed(["block-1"], "token-2")]);
    await stub.requestSync();
    await notify();
    await runDurableObjectAlarm(stub);
    // The echo needs no sync, but the requested cycle still follows in the next alarm.
    expect(await alarmOf(a)).not.toBeNull();
  });

  it("syncs and starts a new feed from the start of the day if Google expired the token", async () => {
    const { b, stub, urls, notify, storedToken } = await setupGoogle("ggone", [
      () => Response.json({ error: { code: 410 } }, { status: 410 }),
      feed(["future-event"], "token-new"),
    ]);
    await notify();
    await runDurableObjectAlarm(stub);
    expect(urls[1]?.searchParams.has("syncToken")).toBe(false);
    expect(urls[1]?.searchParams.get("timeMin")).toMatch(/T00:00:00\.000Z$/);
    expect(await storedToken()).toBe("token-new");
    expect(await alarmOf(b)).not.toBeNull();
  });

  it("waits for Retry-After if the feed read is throttled, then reads again", async () => {
    const { a, b, stub, urls, notify, storedToken } = await setupGoogle("gthrottle", [
      () =>
        Response.json(
          { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } },
          { status: 403, headers: { "Retry-After": "30" } },
        ),
      feed(["block-1"], "token-2"),
    ]);
    await notify();
    const before = Date.now();
    await runDurableObjectAlarm(stub);
    expect(await storedToken()).toBe("token-1");
    expect(await alarmOf(b)).toBeNull();
    expect(await alarmOf(a)).toBeGreaterThanOrEqual(before + 30_000);

    await runDurableObjectAlarm(stub);
    expect(urls).toHaveLength(2);
    expect(await storedToken()).toBe("token-2");
    expect(await alarmOf(b)).toBeNull();
  });

  it("syncs if the feed cannot be read, and keeps the token", async () => {
    const { b, stub, notify, storedToken } = await setupGoogle("gfail", [
      () => new Response("broken", { status: 500 }),
    ]);
    await notify();
    await runDurableObjectAlarm(stub);
    expect(await storedToken()).toBe("token-1");
    expect(await alarmOf(b)).not.toBeNull();
  });

  it("recognises the feed entries of blocks a rule just wrote as echoes", async () => {
    const { a, b, stub, urls, notify } = await setupGoogle("gwrite", []);
    // A second calendar of the Google account mirrors into the watched one.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'second-remote', 'Second', 1, 0, 1)",
      ).bind(`${a}-second`, a),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) SELECT 'gwrite-inner', user_id, ?, ? FROM rules WHERE id = 'gwrite-rule'",
      ).bind(`${a}-second`, `${a}-cal`),
    ]);
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 3_600_000);
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      urls.push(url);
      if (url.pathname.startsWith("/batch/")) {
        return new Response(
          [
            "--r",
            "Content-ID: <response-item0>",
            "",
            "HTTP/1.1 200 OK",
            "Content-Type: application/json",
            "",
            '{"id":"written-1"}',
            "--r--",
          ].join("\r\n"),
          { headers: { "content-type": "multipart/mixed; boundary=r" } },
        );
      }
      if (url.searchParams.has("syncToken")) return feed(["written-1"], "token-2")();
      if (url.pathname.includes("/calendars/second-remote/events")) {
        return Response.json({
          items: [
            {
              id: "meeting-1",
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
            },
          ],
        });
      }
      return Response.json({ items: [] });
    });

    const result = await stub.runRule("gwrite-inner");
    expect(result.applied).toBe(1);
    await notify();
    await runDurableObjectAlarm(stub);
    expect(urls.some((url) => url.searchParams.get("syncToken") === "token-1")).toBe(true);
    expect(await alarmOf(a)).toBeNull();
    expect(await alarmOf(b)).toBeNull();
  });

  it("keeps the rest of a throttled rule run that follows a notification", async () => {
    const { a, stub, notify } = await setupGoogle("gthrottled-run", []);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'second-remote', 'Second', 1, 0, 1)",
      ).bind(`${a}-second`, a),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) SELECT 'gthrottled-run-inner', user_id, ?, ? FROM rules WHERE id = 'gthrottled-run-rule'",
      ).bind(`${a}-second`, `${a}-cal`),
    ]);
    const start = new Date(Date.now() + 86_400_000);
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.startsWith("/batch/")) {
        return new Response(
          [
            "--r",
            "Content-ID: <response-item0>",
            "",
            "HTTP/1.1 403 Forbidden",
            "Content-Type: application/json",
            "",
            '{"error":{"code":403,"errors":[{"reason":"rateLimitExceeded"}]}}',
            "--r--",
          ].join("\r\n"),
          { headers: { "content-type": "multipart/mixed; boundary=r" } },
        );
      }
      if (url.searchParams.has("syncToken")) return feed([], "token-2")();
      if (url.pathname.includes("/calendars/second-remote/events")) {
        return Response.json({
          items: [
            {
              id: "meeting-1",
              start: { dateTime: start.toISOString() },
              end: { dateTime: new Date(start.getTime() + 3_600_000).toISOString() },
            },
          ],
        });
      }
      return Response.json({ items: [] });
    });

    // The notification sets an alarm for the feed only; the run started by hand then needs it too.
    await notify();
    const result = await stub.runRule("gthrottled-run-inner");
    expect(result.remaining).toBe(1);
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(a)).not.toBeNull();
  });

  it("syncs on a notification from an unknown channel without reading the feed", async () => {
    const { b, urls, notify } = await setupGoogle("gchannel", []);
    await notify("channel-unknown");
    expect(urls).toHaveLength(0);
    expect(await alarmOf(b)).not.toBeNull();
  });

  it("recognises its own Google write when Retry-After delays the check", async () => {
    const { a, b, stub, notify } = await setupGoogle("gdelay", [feed(["block-1"], "token-2")]);
    await notify();
    // A throttled rule run moved the alarm by the longest Retry-After.
    advanceClock(5 * 60_000);
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(a)).toBeNull();
    expect(await alarmOf(b)).toBeNull();
  });

  it("syncs a later change to a block it wrote, reported by a later notification", async () => {
    const { a, b, stub, notify } = await setupGoogle("glater", [feed(["block-1"], "token-2")]);
    await notify();
    // The user moves the block three minutes after it was written; the check waits for Retry-After.
    advanceClock(3 * 60_000);
    await notify();
    advanceClock(2 * 60_000);
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(a)).not.toBeNull();
    expect(await alarmOf(b)).not.toBeNull();
  });

  it("retries a failed sync request after a Graph notification in a later alarm", async () => {
    const { a, b } = await setup("gr-retry");
    const stub = env.ACCOUNT_SYNC.getByName(a);
    failSyncRequests([b], 1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await notifyGraph(a, "someone-elses-meeting");
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(b)).toBeNull();

    advanceClock(60_000);
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(b)).not.toBeNull();
  });

  it("retries a failed sync request after a Google notification without reading the feed again", async () => {
    const { b, stub, urls, notify, storedToken } = await setupGoogle("g-retry", [
      feed(["users-meeting"], "token-2"),
    ]);
    failSyncRequests([b], 1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await notify();
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(b)).toBeNull();
    // The retry holds the change, so the feed moves on.
    expect(await storedToken()).toBe("token-2");

    advanceClock(60_000);
    await runDurableObjectAlarm(stub);
    expect(urls).toHaveLength(1);
    expect(await alarmOf(b)).not.toBeNull();
  });

  it("gives up on a failing sync request after a few attempts, and runs the rules meanwhile", async () => {
    const { a, b } = await setup("g-giveup");
    // A rule into the first account, so that its full cycle has work.
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) SELECT 'g-giveup-back', user_id, ?, ? FROM rules WHERE id = 'g-giveup-rule'",
    )
      .bind(`${b}-cal`, `${a}-cal`)
      .run();
    const stub = env.ACCOUNT_SYNC.getByName(a);
    const failed = failSyncRequests([b]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Response.json({ value: [] });
    });

    await notifyGraph(a, "someone-elses-meeting");
    await runDurableObjectAlarm(stub);
    expect(failed).toEqual([b]);
    // The retry is not due yet; the next alarm runs the rule.
    await runDurableObjectAlarm(stub);
    expect(urls.some((url) => url.includes(`/calendars/${b}-remote/calendarView`))).toBe(true);

    // Each due alarm retries once, until the attempts are used up; then no alarm is left.
    for (let i = 0; i < 10 && (await alarmOf(a)) !== null; i++) {
      advanceClock(10 * 60_000);
      await runDurableObjectAlarm(stub);
    }
    expect(failed).toEqual([b, b, b, b]);
    expect(await alarmOf(a)).toBeNull();
  });

  it("lets a new notification move the alarm that waits for a retry", async () => {
    const { a, b } = await setup("g-first");
    const stub = env.ACCOUNT_SYNC.getByName(a);
    failSyncRequests([b], 1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    await notifyGraph(a, "someone-elses-meeting");
    await runDurableObjectAlarm(stub);
    // The cycle the change started in the first account; afterwards only the retry waits.
    await runDurableObjectAlarm(stub);
    const retryAt = await alarmOf(a);
    expect(retryAt).not.toBeNull();

    // The check gets its own alarm after the debounce delay. In production that delay is shorter
    // than the retry's; the tests use a longer one.
    await notifyGraph(a, "another-meeting");
    expect(await alarmOf(a)).not.toBe(retryAt);
  });
});
