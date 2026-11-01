/**
 * The free plan budget of a rewrite: a change of a rule option rewrites each block once, and the
 * alarms spread that work so that none exceeds the limits per invocation.
 */
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signIn } from "./helpers";

// Far in the future: the runtime fires a Durable Object alarm by real time, so an alarm that the
// fake clock sets must not lie in the real past.
const NOW = Date.UTC(2036, 10, 1);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const COPIES = 1200;
const TOKENS = { refreshToken: "r", accessToken: "a", accessExpiresAt: NOW + 30 * DAY };

function graphTime(ms: number) {
  return { dateTime: `${new Date(ms).toISOString().slice(0, 19)}.0000000`, timeZone: "UTC" };
}

/** Occurrences of a series, seven hours apart: all 1200 lie in the 365 days of the rule. */
function occurrences(): Record<string, unknown>[] {
  return Array.from({ length: COPIES }, (_, index) => {
    const start = NOW + DAY + index * 7 * HOUR;
    return {
      id: `occurrence-${index}`,
      type: "occurrence",
      seriesMasterId: "series",
      originalStart: new Date(start).toISOString().replace(".000Z", "Z"),
      start: graphTime(start),
      end: graphTime(start + HOUR),
      isAllDay: false,
      subject: "Secret plan",
      showAs: "busy",
      sensitivity: "normal",
      isCancelled: false,
    };
  });
}

/**
 * A fake Graph. The source calendar returns the events, the target calendar what the batches
 * wrote. `calendarView` pages by 500, as `$top` asks.
 */
function fakeGraph(source: Record<string, unknown>[]) {
  const blocks = new Map<string, Record<string, unknown>>();
  const fake = { blocks, fetches: 0, batches: 0, tokenCalls: 0 };
  let next = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    fake.fetches++;
    if (url.includes("/oauth2/v2.0/token")) {
      fake.tokenCalls++;
      return Response.json({ access_token: `a${fake.tokenCalls}`, expires_in: 60 });
    }
    const parsed = new URL(url);
    if (parsed.pathname.includes("/calendarView")) {
      const all = parsed.pathname.includes("budget-src-remote") ? source : [...blocks.values()];
      const skip = Number(parsed.searchParams.get("fakeSkip") ?? "0");
      const value = all.slice(skip, skip + 500);
      if (skip + 500 >= all.length) return Response.json({ value });
      parsed.searchParams.set("fakeSkip", String(skip + 500));
      return Response.json({ value, "@odata.nextLink": parsed.toString() });
    }
    if (url.endsWith("/$batch")) {
      fake.batches++;
      const { requests } = JSON.parse(init?.body as string) as {
        requests: { id: string; method: string; url: string; body?: Record<string, unknown> }[];
      };
      const responses = requests.map((request) => {
        if (request.method === "POST") {
          const id = `block-${next++}`;
          blocks.set(id, { ...request.body, id, type: "singleInstance" });
          return { id: request.id, status: 201, body: { id } };
        }
        const id = decodeURIComponent(request.url.split("/").pop()!);
        blocks.set(id, { ...blocks.get(id), ...request.body, id });
        return { id: request.id, status: 200, body: { id } };
      });
      return Response.json({ responses });
    }
    return new Response("unexpected", { status: 500 });
  });
  return fake;
}

/**
 * Count D1 queries and Durable Object stubs from now until `stop()`, through the prototypes, so
 * that calls inside the Durable Object count too. A D1 batch counts as one query.
 */
function countD1() {
  const counts = { d1: 0, durableObjects: 0 };
  type Method = (this: unknown, ...args: unknown[]) => unknown;
  const spy = (target: Record<string, Method>, method: string, key: keyof typeof counts) => {
    const original = target[method];
    if (!original) throw new Error(`No method ${method}`);
    return vi.spyOn(target, method).mockImplementation(function (this: unknown, ...args) {
      counts[key]++;
      return original.apply(this, args);
    });
  };
  const statement = Object.getPrototypeOf(env.DB.prepare("SELECT 1")) as Record<string, Method>;
  const spies = [
    ...["run", "all", "first", "raw"].map((method) => spy(statement, method, "d1")),
    spy(Object.getPrototypeOf(env.DB) as Record<string, Method>, "batch", "d1"),
    spy(
      Object.getPrototypeOf(env.ACCOUNT_SYNC) as Record<string, Method>,
      "getByName",
      "durableObjects",
    ),
  ];
  return {
    stop() {
      for (const item of spies) item.mockRestore();
      return counts;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("free plan budget", () => {
  it("spreads the rewrite of 1200 copies over alarms within 50 subrequests each", async () => {
    const fake = fakeGraph(occurrences());
    const { user } = await signIn("owner@example.com");
    // The source is another account, so each run reads it over RPC from its instance.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('budget', ?, 'microsoft', 'budget@work.example')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('budget-s', ?, 'microsoft', 'bs@work.example')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES ('budget-src', 'budget-s', 'budget-src-remote', 'Work', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES ('budget-dst', 'budget', 'budget-dst-remote', 'Blocks', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES ('budget-rule', ?, 'budget-src', 'budget-dst', ?)",
      ).bind(user.id, JSON.stringify({ daysAhead: 365 })),
    ]);
    const stub = env.ACCOUNT_SYNC.getByName("budget");
    // Expired access tokens: every alarm refreshes them, which costs a subrequest each.
    const expired = { ...TOKENS, accessExpiresAt: NOW - 1 };
    await stub.storeTokens("budget", expired, "microsoft");
    await env.ACCOUNT_SYNC.getByName("budget-s").storeTokens("budget-s", expired, "microsoft");

    /** Run alarms until the rule has no work left; returns the cost of each alarm. */
    async function alarms() {
      const counts = [];
      for (let i = 0; i < 10; i++) {
        // Past the source cache and the token lifetime: each alarm reads and refreshes anew.
        vi.setSystemTime(Date.now() + 61_000);
        const before = fake.fetches;
        const batchesBefore = fake.batches;
        const d1 = countD1();
        const ran = await runDurableObjectAlarm(stub);
        counts.push({
          fetches: fake.fetches - before,
          batches: fake.batches - batchesBefore,
          ...d1.stop(),
        });
        if (!ran) break;
      }
      return counts;
    }

    await stub.requestSync();
    await alarms();
    expect(fake.blocks.size).toBe(COPIES);

    await env.DB.prepare("UPDATE rules SET options = ? WHERE id = 'budget-rule'")
      .bind(JSON.stringify({ daysAhead: 365, blockTitle: "Away" }))
      .run();
    await stub.requestSync();
    const tokensBefore = fake.tokenCalls;
    const counts = await alarms();
    // 1200 PATCHes in batches of 20 need 60 batches; one alarm writes at most 25.
    expect(counts.map((count) => count.batches)).toEqual([25, 25, 10, 0]);
    expect(fake.tokenCalls - tokensBefore).toBeGreaterThanOrEqual(3);
    for (const count of counts) {
      // Subrequests: all provider calls, the source instance's included, and calls to other
      // Durable Objects. D1 has its own limit.
      expect(count.fetches + count.durableObjects).toBeLessThanOrEqual(50);
      expect(count.d1).toBeLessThanOrEqual(50);
    }
    expect([...fake.blocks.values()].every((block) => block.subject === "Away")).toBe(true);

    // The next cycle finds every copy unchanged.
    const batchesBefore = fake.batches;
    await stub.requestSync();
    await alarms();
    expect(fake.batches).toBe(batchesBefore);
  });
});
