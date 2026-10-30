import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_ITEMS, providerPage } from "../scripts/probe-sink/pages";
import { calendarClient } from "../src/providers/calendar-client";
import {
  FakeCalendar,
  fakePages,
  parseFakePage,
  readFakeStats,
  seedFakeEvents,
  shiftFakeEvents,
} from "../src/providers/fake-calendar";
import app from "../src/index";
import { BASE, signIn } from "./helpers";

const DAY = 86_400_000;

/** The admin of the test bindings, without simulated accounts, rules or audit rows. */
async function admin() {
  const { user, cookie } = await signIn("admin@example.com");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rules WHERE user_id = ?").bind(user.id),
    env.DB.prepare(
      "DELETE FROM calendars WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ?)",
    ).bind(user.id),
    env.DB.prepare("DELETE FROM accounts WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM audit_events WHERE user_id = ?").bind(user.id),
    env.DB.prepare("UPDATE users SET sync_settings = '{}' WHERE id = ?").bind(user.id),
  ]);
  return { user, cookie };
}

const request = (method: string, path: string, cookie: string) =>
  exports.default.fetch(`${BASE}${path}`, { method, headers: { cookie } });

const json = async <T>(response: Response) => (await response.json()) as T;

const pages = { microsoft: providerPage("microsoft"), google: providerPage("google") };

/** The fetch target: a page in real size below `pages/`, a small file elsewhere. */
function sink(url: string): Response {
  if (url.endsWith("pages/microsoft.json")) return new Response(pages.microsoft);
  if (url.endsWith("pages/google.json")) return new Response(pages.google);
  return new Response("ok");
}

function stubFetch(answer: (url: string) => Response = sink) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input) => Promise.resolve(answer(String(input as string))));
}

/** As the runtime on the Free plan: it refuses each fetch after the first `limit`. */
function stubLimit(limit: number) {
  let count = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    count += 1;
    if (count > limit) {
      count = 0;
      return Promise.reject(new Error("Too many subrequests."));
    }
    return Promise.resolve(sink(String(input as string)));
  });
}

/** Run the alarms of the accounts until none is left. */
async function drain(accounts: string[]): Promise<void> {
  for (let round = 0; round < 300; round++) {
    let ran = false;
    for (const id of accounts) {
      if (await runDurableObjectAlarm(env.ACCOUNT_SYNC.getByName(id))) ran = true;
    }
    if (!ran) return;
  }
  throw new Error("The alarms did not end");
}

interface Stats {
  accounts: number;
  rules: number;
  ruleDays: { min: number; max: number };
  calls: Record<string, number>;
  blocks: number;
  rowsWritten: number;
  runs: number;
  writes: number | null;
  failedRuns: number;
  startedSteps: number;
  storedBlocks: number[] | null;
  lastRuns: { ruleId: string; failed: number; remaining: number }[];
}

afterEach(async () => {
  vi.restoreAllMocks();
  const ids = await listDurableObjectIds(env.ACCOUNT_SYNC);
  await Promise.all(
    ids.map((id) =>
      runInDurableObject(env.ACCOUNT_SYNC.get(id), (_instance, state) =>
        state.storage.deleteAlarm(),
      ),
    ),
  );
});

describe("/dev access", () => {
  it("answers 404 without the variable", async () => {
    const { cookie } = await admin();
    const off = { ...env, DEV_FAKE_CALENDARS: undefined };
    for (const [method, path] of [
      ["GET", "/dev/probe"],
      ["GET", "/dev/rpc-budget"],
      ["POST", "/dev/seed"],
      ["POST", "/dev/burst"],
      ["POST", "/dev/cycle"],
      ["GET", "/dev/stats"],
    ] as const) {
      const response = await app.fetch(
        new Request(`${BASE}${path}`, { method, headers: { cookie } }),
        off,
      );
      expect(response.status).toBe(404);
    }
  });

  it("answers 404 for a user who is no admin, and without a session", async () => {
    const { cookie } = await signIn("member@org.example");
    expect((await request("GET", "/dev/probe", cookie)).status).toBe(404);
    expect((await request("POST", "/dev/seed", cookie)).status).toBe(404);
    expect((await request("GET", "/dev/probe", "")).status).toBe(404);
  });
});

describe("GET /dev/probe", () => {
  it("refuses as soon as an account is not simulated", async () => {
    const fetchSpy = stubFetch();
    const { user, cookie } = await admin();
    const ok = await request("GET", "/dev/probe", cookie);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ testInstance: true, simulatedFetch: "ok" });
    expect(fetchSpy).toHaveBeenCalledWith("https://probe-sink.example/");

    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES ('real-1', ?, 'microsoft', 'a@b.example')",
    )
      .bind(user.id)
      .run();
    const refused = await request("GET", "/dev/probe", cookie);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ testInstance: false, realAccounts: 1 });
    await env.DB.prepare("DELETE FROM accounts WHERE id = 'real-1'").run();
  });

  it("reports a fetch target that fails", async () => {
    stubFetch(() => new Response("no", { status: 403 }));
    const { cookie } = await admin();
    expect(await (await request("GET", "/dev/probe", cookie)).json()).toMatchObject({
      simulatedFetch: "failed",
      subrequestLimit: "unknown",
    });
  });

  it("reports a fetch target without pages in real size", async () => {
    stubFetch(() => new Response("ok"));
    const { cookie } = await admin();
    expect(await (await request("GET", "/dev/probe", cookie)).json()).toMatchObject({
      simulatedFetch: "failed",
    });
  });

  it("reports the limit if the runtime refuses the 51st fetch", async () => {
    const fetchSpy = stubLimit(50);
    const { cookie } = await admin();
    expect(await (await request("GET", "/dev/probe", cookie)).json()).toMatchObject({
      simulatedFetch: "ok",
      subrequestLimit: "enforced",
      fetches: 50,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(51);
  });

  it("reports no limit if the 51st fetch succeeds", async () => {
    const fetchSpy = stubFetch();
    const { cookie } = await admin();
    expect(await (await request("GET", "/dev/probe", cookie)).json()).toMatchObject({
      simulatedFetch: "ok",
      subrequestLimit: "absent",
      fetches: 51,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(51);
  });

  it("does not take another error for the limit", async () => {
    let count = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      ++count > 10
        ? Promise.reject(new Error("network connection lost"))
        : Promise.resolve(sink(String(input as string))),
    );
    const { cookie } = await admin();
    expect(await (await request("GET", "/dev/probe", cookie)).json()).toMatchObject({
      simulatedFetch: "failed",
      subrequestLimit: "unknown",
    });
  });

  it("makes no fetch without a target", async () => {
    const fetchSpy = stubFetch();
    const { cookie } = await admin();
    const response = await app.fetch(new Request(`${BASE}/dev/probe`, { headers: { cookie } }), {
      ...env,
      DEV_FAKE_FETCH_URL: undefined,
    });
    expect(await response.json()).toMatchObject({
      simulatedFetch: "off",
      subrequestLimit: "unknown",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /dev/rpc-budget", () => {
  it("measures the fetches of an instance with and without RPC", async () => {
    stubLimit(50);
    const { cookie } = await admin();
    const response = await request("GET", "/dev/rpc-budget", cookie);
    expect(await response.json()).toEqual({
      rpcCalls: 25,
      baseline: { state: "limited", fetches: 50 },
      mixed: { state: "limited", fetches: 50 },
    });
  });

  it("answers 400 without a fetch target", async () => {
    const { cookie } = await admin();
    const response = await app.fetch(
      new Request(`${BASE}/dev/rpc-budget`, { headers: { cookie } }),
      { ...env, DEV_FAKE_FETCH_URL: undefined },
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /dev/seed", () => {
  it.each(["days=0", "days=366", "days=abc", "days=1.5", "accounts=0", "accounts=21", "events=0"])(
    "refuses %s and changes nothing",
    async (query) => {
      const { user, cookie } = await admin();
      const response = await request("POST", `/dev/seed?${query}`, cookie);
      expect(response.status).toBe(400);
      const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?")
        .bind(user.id)
        .first<{ n: number }>();
      expect(rows?.n).toBe(0);
      const settings = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
        .bind(user.id)
        .first<{ json: string }>();
      expect(settings?.json).not.toContain("daysAhead");
    },
  );

  it("takes the limits of days and answers the database time", async () => {
    const { cookie } = await admin();
    for (const days of [1, 365]) {
      const response = await request("POST", `/dev/seed?accounts=2&events=1&days=${days}`, cookie);
      expect(response.status).toBe(200);
      const body = await json<{ accounts: number; days: number; startedAt: string }>(response);
      expect(body).toMatchObject({ accounts: 2, days });
      expect(body.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("applies the window to rules that exist from an earlier seed", async () => {
    const { cookie } = await admin();
    await request("POST", "/dev/seed?accounts=3&events=5&days=90", cookie);
    const before = await json<Stats>(await request("GET", "/dev/stats", cookie));
    expect(before).toMatchObject({ accounts: 3, rules: 6, ruleDays: { min: 90, max: 90 } });

    await request("POST", "/dev/seed?accounts=3&events=5&days=365", cookie);
    const after = await json<Stats>(await request("GET", "/dev/stats", cookie));
    expect(after).toMatchObject({ rules: 6, ruleDays: { min: 365, max: 365 } });
  });

  it("refuses with 409 and changes nothing as soon as an account is not simulated", async () => {
    const { user, cookie } = await admin();
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES ('real-2', ?, 'microsoft', 'c@d.example')",
    )
      .bind(user.id)
      .run();
    const response = await request("POST", "/dev/seed?accounts=2&events=1&days=365", cookie);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ testInstance: false, realAccounts: 1 });
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?")
      .bind(user.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const settings = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ json: string }>();
    expect(settings?.json).not.toContain("daysAhead");
    await env.DB.prepare("DELETE FROM accounts WHERE id = 'real-2'").run();
  });
});

describe("a stage on simulated calendars", () => {
  it.each([90, 365])(
    "mirrors every event of a %i-day window into every other account",
    async (days) => {
      const fetchSpy = stubFetch();
      const { user, cookie } = await admin();
      // The first seed leaves 90-day rules; the second must carry the window over.
      await request("POST", "/dev/seed?accounts=3&events=1&days=90", cookie);
      const seed = await request("POST", `/dev/seed?accounts=3&events=40&days=${days}`, cookie);
      const { startedAt } = await json<{ startedAt: string }>(seed);
      await request("POST", "/dev/cycle", cookie);
      const accounts = [1, 2, 3].map((i) => `sim-${user.id}-${i}`);
      await drain(accounts);

      const stats = await json<Stats>(
        await request("GET", `/dev/stats?since=${encodeURIComponent(startedAt)}`, cookie),
      );
      expect(stats.blocks).toBe(240);
      expect(stats.lastRuns).toHaveLength(6);
      expect(stats.lastRuns.every((run) => run.failed === 0 && run.remaining === 0)).toBe(true);
      // One real fetch per simulated call, and the /dev routes make none of their own.
      const calls = Object.values(stats.calls).reduce((sum, n) => sum + n, 0);
      expect(fetchSpy).toHaveBeenCalledTimes(calls);
      expect(stats.rowsWritten).toBeGreaterThanOrEqual(240);
      expect(stats.rowsWritten).toBeLessThan(400);
      expect(stats.startedSteps).toBe(stats.runs + stats.failedRuns);
      expect(stats.storedBlocks).toBeNull();
    },
  );

  it("updates the mirrors of a burst of changes and counts the stored blocks", async () => {
    stubFetch();
    const { user, cookie } = await admin();
    const seed = await request("POST", "/dev/seed?accounts=3&events=40&days=90", cookie);
    const { startedAt } = await json<{ startedAt: string }>(seed);
    await request("POST", "/dev/cycle", cookie);
    const accounts = [1, 2, 3].map((i) => `sim-${user.id}-${i}`);
    await drain(accounts);

    const burst = await request("POST", "/dev/burst?events=5", cookie);
    expect(burst.status).toBe(200);
    const since = (await json<{ startedAt: string }>(burst)).startedAt;
    await request("POST", "/dev/cycle", cookie);
    await drain(accounts);

    const after = await json<Stats>(
      await request("GET", `/dev/stats?since=${encodeURIComponent(since)}`, cookie),
    );
    // Five events of one account, each with a mirror in the two other accounts.
    expect(after.writes).toBe(10);
    const stats = await json<Stats>(
      await request("GET", `/dev/stats?since=${encodeURIComponent(startedAt)}&count=1`, cookie),
    );
    expect(stats.blocks).toBe(240);
    expect(stats.storedBlocks).toEqual([80, 80, 80]);
    expect(stats.startedSteps).toBe(stats.runs + stats.failedRuns);
    expect(stats.lastRuns.every((run) => run.failed === 0 && run.remaining === 0)).toBe(true);
  });

  it("counts a step that ends without a run", async () => {
    stubFetch();
    const { user, cookie } = await admin();
    const { startedAt } = await json<{ startedAt: string }>(
      await request("POST", "/dev/seed?accounts=2&events=1&days=30", cookie),
    );
    await request("POST", "/dev/cycle", cookie);
    const stub = env.ACCOUNT_SYNC.getByName(`sim-${user.id}-1`);
    await runInDurableObject(stub, (instance) => {
      const internals = instance as unknown as { runRuleAfterOthers(id: string): Promise<never> };
      vi.spyOn(internals, "runRuleAfterOthers").mockRejectedValue(new Error("stopped"));
    });
    await runDurableObjectAlarm(stub);
    const stats = await json<Stats>(
      await request("GET", `/dev/stats?since=${encodeURIComponent(startedAt)}`, cookie),
    );
    expect(stats).toMatchObject({ startedSteps: 1, runs: 0, failedRuns: 0 });
  });

  it("fails a run whose simulated call fails, and writes nothing for it", async () => {
    let answers = 0;
    stubFetch((url) => {
      // Reads pass, the first batch fails.
      answers += 1;
      return answers > 2 ? new Response("no", { status: 500 }) : sink(url);
    });
    const { user, cookie } = await admin();
    const { startedAt } = await json<{ startedAt: string }>(
      await request("POST", "/dev/seed?accounts=2&events=3&days=30", cookie),
    );
    await request("POST", "/dev/cycle", cookie);
    await drain([`sim-${user.id}-1`, `sim-${user.id}-2`]);
    const stats = await json<Stats & { failedRuns: number }>(
      await request("GET", `/dev/stats?since=${encodeURIComponent(startedAt)}`, cookie),
    );
    expect(stats.blocks).toBe(0);
    expect(stats.failedRuns).toBeGreaterThan(0);
    expect(stats.startedSteps).toBe(stats.runs + stats.failedRuns);
  });
});

describe("FakeCalendar", () => {
  const window = (days: number) => ({
    start: new Date(Math.floor(Date.now() / DAY) * DAY),
    end: new Date(Math.floor(Date.now() / DAY) * DAY + days * DAY),
  });
  const block = (i: number) => ({
    kind: "create" as const,
    block: {
      marker: `m${i}`,
      contentHash: "h",
      dedupKey: `d${i}`,
      subject: "Busy",
      start: new Date(Date.now() + DAY + i * 60_000).toISOString(),
      end: new Date(Date.now() + DAY + (i + 30) * 60_000).toISOString(),
      allDay: false,
      showAs: "busy" as const,
      isPrivate: false,
      location: "",
      body: "",
    },
  });
  const inInstance = <T>(name: string, run: (sql: SqlStorage) => Promise<T>) =>
    runInDurableObject(env.ACCOUNT_SYNC.getByName(name), (_instance, state) =>
      run(state.storage.sql),
    );

  it("costs the pages of the plan: 30,000 events are 60 Graph reads", () => {
    expect(fakePages(30_000, "microsoft")).toBe(60);
    expect(fakePages(30_000, "google")).toBe(12);
    expect(fakePages(0, "microsoft")).toBe(1);
    expect(fakePages(500, "microsoft")).toBe(1);
    expect(fakePages(501, "microsoft")).toBe(2);
  });

  it("writes batches of the size of the real clients", async () => {
    await inInstance("fake-batches", (sql) => {
      for (const provider of ["microsoft", "google"] as const) {
        const real = calendarClient(provider, "token").batchLimit;
        expect(new FakeCalendar(sql, provider).batchLimit).toBe(real);
      }
      return Promise.resolve();
    });
  });

  it("serves pages with the real number of events, in the shape of the real clients", () => {
    for (const provider of ["microsoft", "google"] as const) {
      const body = pages[provider];
      expect(fakePages(PAGE_ITEMS[provider], provider)).toBe(1);
      expect(fakePages(PAGE_ITEMS[provider] + 1, provider)).toBe(2);
      expect(parseFakePage(provider, JSON.parse(body))).toBe(PAGE_ITEMS[provider]);
      // A size per event that a real page reaches. A body of a few bytes measures no parsing.
      expect(body.length / PAGE_ITEMS[provider]).toBeGreaterThan(300);
    }
  });

  it("refuses a body that is no calendar page", () => {
    expect(() => parseFakePage("microsoft", { items: [] })).toThrow("no calendar page");
    expect(() => parseFakePage("google", null)).toThrow("no calendar page");
    expect(() => parseFakePage("google", { items: [{ id: 1 }] })).toThrow();
  });

  it("fetches and parses the page of the provider, not the small file", async () => {
    const fetchSpy = stubFetch();
    await inInstance("fake-page-url", async (sql) => {
      seedFakeEvents(sql, { account: 1, accounts: 2, days: 90 }, 10);
      const client = new FakeCalendar(sql, "google", {
        DEV_FAKE_FETCH_URL: "https://sink.example/",
      });
      await client.sourceEvents("main", window(90));
      expect(fetchSpy).toHaveBeenCalledWith("https://sink.example/pages/google.json");
      await client.applyBatch("main", "tag", [block(0)]);
      expect(fetchSpy).toHaveBeenLastCalledWith("https://sink.example/");
    });
  });

  it("fails a read if the fetch target serves no page", async () => {
    stubFetch(() => new Response("ok"));
    await inInstance("fake-no-page", async (sql) => {
      seedFakeEvents(sql, { account: 1, accounts: 2, days: 90 }, 10);
      const client = new FakeCalendar(sql, "microsoft", {
        DEV_FAKE_FETCH_URL: "https://sink.example/",
      });
      await expect(client.sourceEvents("main", window(90))).rejects.toThrow();
      expect(readFakeStats(sql).calls).toEqual({});
    });
  });

  it("moves the first events of a burst and leaves the others", async () => {
    await inInstance("fake-burst", async (sql) => {
      seedFakeEvents(sql, { account: 1, accounts: 2, days: 90 }, 10);
      const client = new FakeCalendar(sql, "microsoft");
      const before = await client.sourceEvents("main", window(90));
      shiftFakeEvents(sql, 3);
      const after = await client.sourceEvents("main", window(90));
      const changed = before.filter((event, i) => event.end !== after[i]?.end);
      expect(changed.map((event) => event.occurrenceKey)).toEqual([
        "event:1-0",
        "event:1-1",
        "event:1-2",
      ]);
      expect(after.map((event) => event.start)).toEqual(before.map((event) => event.start));
    });
  });

  it("pages a read at each provider's page size, one fetch per page", async () => {
    const fetchSpy = stubFetch();
    await inInstance("fake-paging", async (sql) => {
      seedFakeEvents(sql, { account: 1, accounts: 2, days: 90 }, 1200);
      const graph = new FakeCalendar(sql, "microsoft", {
        DEV_FAKE_FETCH_URL: "https://sink.example/",
      });
      expect(await graph.sourceEvents("main", window(90))).toHaveLength(1200);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(readFakeStats(sql).calls).toEqual({ sourceEvents: 3 });

      fetchSpy.mockClear();
      const google = new FakeCalendar(sql, "google", {
        DEV_FAKE_FETCH_URL: "https://sink.example/",
      });
      await google.sourceEvents("main", window(90));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("makes a target read cost pages for native events, which it does not return", async () => {
    await inInstance("fake-target", async (sql) => {
      seedFakeEvents(sql, { account: 1, accounts: 2, days: 90 }, 1001);
      const client = new FakeCalendar(sql, "microsoft");
      expect(await client.existingBlocks("main", window(90), ["tag"])).toEqual([]);
      expect(readFakeStats(sql).calls).toEqual({ existingBlocks: 3 });
    });
  });

  it("fetches nothing without the variable", async () => {
    const fetchSpy = stubFetch();
    await inInstance("fake-silent", async (sql) => {
      seedFakeEvents(sql, { account: 1, accounts: 2, days: 90 }, 10);
      const client = new FakeCalendar(sql, "microsoft");
      await client.sourceEvents("main", window(90));
      await client.applyBatch("main", "tag", [block(0)]);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes on the error of a failed fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Too many subrequests."));
    await inInstance("fake-limit", async (sql) => {
      seedFakeEvents(sql, { account: 1, accounts: 2, days: 90 }, 10);
      const client = new FakeCalendar(sql, "microsoft", {
        DEV_FAKE_FETCH_URL: "https://sink.example/",
      });
      await expect(client.sourceEvents("main", window(90))).rejects.toThrow("Too many subrequests");
      await expect(client.applyBatch("main", "tag", [block(0)])).rejects.toThrow();
      expect(readFakeStats(sql).blocks).toBe(0);
    });
  });

  it("gives every event of all accounts its own time slot at the highest load", async () => {
    const seen = new Set<string>();
    for (const account of [1, 2, 3]) {
      await inInstance(`fake-slots-${account}`, async (sql) => {
        seedFakeEvents(sql, { account, accounts: 3, days: 90 }, 10_000);
        const client = new FakeCalendar(sql, "microsoft");
        const events = await client.sourceEvents("main", window(90));
        expect(events).toHaveLength(10_000);
        for (const event of events) seen.add(`${event.start}|${event.end}`);
      });
    }
    expect(seen.size).toBe(30_000);
  });

  it("keeps every event in the window across midnight UTC", async () => {
    await inInstance("fake-midnight", async (sql) => {
      seedFakeEvents(sql, { account: 2, accounts: 3, days: 30 }, 500);
      const client = new FakeCalendar(sql, "microsoft");
      const tomorrow = window(30);
      tomorrow.start = new Date(tomorrow.start.getTime() + DAY);
      tomorrow.end = new Date(tomorrow.end.getTime() + DAY);
      const events = await client.sourceEvents("main", tomorrow);
      expect(events).toHaveLength(500);
      expect(events.every((event) => Date.parse(event.start) < tomorrow.end.getTime() - DAY)).toBe(
        true,
      );
    });
  });

  it("bills one row per block and few rows per seed", async () => {
    await inInstance("fake-rows", async (sql) => {
      seedFakeEvents(sql, { account: 1, accounts: 2, days: 90 }, 10_000);
      const client = new FakeCalendar(sql, "microsoft");
      for (let batch = 0; batch < 10; batch++) {
        const actions = Array.from({ length: 20 }, (_, i) => block(batch * 20 + i));
        await client.applyBatch("main", "tag", actions);
      }
      expect(readFakeStats(sql)).toMatchObject({ blocks: 200, rowsWritten: 210 });

      const rows: number[] = [];
      for (const table of ["fake_blocks", "fake_calls"]) {
        const drop = sql.exec(`DROP TABLE ${table}`);
        drop.toArray();
        rows.push(drop.rowsWritten);
      }
      // A drop must not bill per stored row.
      expect(rows.reduce((sum, n) => sum + n, 0)).toBeLessThan(20);
    });
  });
});
