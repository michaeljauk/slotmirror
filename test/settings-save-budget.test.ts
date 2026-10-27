import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEditorState, setAccountWorkHours, setRuleDetails, setSettings } from "../src/editor";
import { signIn } from "./helpers";

/** "Today" lies far in the future, so that no alarm fires while a test runs. */
const NOW = new Date("2036-10-22T10:00:00Z");

const SETTINGS = {
  skipAllDay: false,
  skipTentative: false,
  markPrivate: false,
  blockTitle: "Busy",
  skipCategories: [] as string[],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Counts what one invocation spends: D1 queries (a `batch()` counts as one) and Durable Object
 * RPC calls. The statements of a batch are counted separately.
 */
function countingEnv() {
  const counts = { d1: 0, batchStatements: 0, durable: [] as string[] };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        if (key === "run" || key === "all" || key === "first" || key === "raw") {
          return (...args: unknown[]) => {
            counts.d1 += 1;
            return (target[key] as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(proxy, statement);
    return proxy;
  };
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch") {
        return (statements: D1PreparedStatement[]) => {
          counts.d1 += 1;
          counts.batchStatements += statements.length;
          return target.batch(statements.map((statement) => real.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ACCOUNT_SYNC = new Proxy(env.ACCOUNT_SYNC, {
    get(target, key) {
      if (key === "getByName") {
        return (name: string) =>
          new Proxy(target.getByName(name), {
            get(stub, method) {
              if (typeof method !== "string") return Reflect.get(stub, method) as unknown;
              // An RPC property is callable but has no `apply`, so call it as a method.
              return (...args: unknown[]) => {
                counts.durable.push(`${name}:${method}`);
                return (stub as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(
                  ...args,
                );
              };
            },
          });
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { counts, env: { ...env, DB, ACCOUNT_SYNC } as Env };
}

interface RuleSpec {
  id: string;
  source: string;
  target: string;
  daysAhead: number;
  enabled?: boolean;
}

/** One user with accounts and calendars (`[id, accountId, canEdit]`), and the given rules. */
async function setup(prefix: string, calendars: [string, string, number][], rules: RuleSpec[]) {
  const { user } = await signIn(`${prefix}@org.example`);
  const accountIds = [...new Set(calendars.map(([, accountId]) => accountId))];
  await env.DB.batch([
    ...accountIds.map((id) =>
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
      ).bind(id, user.id, `${id}@work.example`),
    ),
    ...calendars.map(([id, accountId, canEdit]) =>
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES (?, ?, ?, 'C', ?)",
      ).bind(id, accountId, `remote-${id}`, canEdit),
    ),
  ]);
  await env.DB.batch(
    rules.map((rule) =>
      env.DB.prepare(
        `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        rule.id,
        user.id,
        rule.source,
        rule.target,
        JSON.stringify({ daysAhead: rule.daysAhead }),
        rule.enabled === false ? 0 : 1,
      ),
    ),
  );
  return user;
}

type QueuedRemoval = {
  ruleId: string;
  remoteCalendarId: string;
  attempts: number;
  trim?: boolean;
};

const removalsOf = (accountId: string) =>
  runInDurableObject(env.ACCOUNT_SYNC.getByName(accountId), (_instance, state) =>
    state.storage.get<QueuedRemoval[]>("removalQueue"),
  );

describe("saving settings with many rules", () => {
  it("stays within the D1 and Durable Object budget of one invocation", async () => {
    // 30 source calendars on one account, two target accounts: 60 rules, all above 30 days.
    const sources = Array.from({ length: 30 }, (_, i) => `many-src-${i}`);
    const user = await setup(
      "many",
      [
        ...sources.map((id): [string, string, number] => [id, "many-s", 1]),
        ["many-t1", "many-a1", 1],
        ["many-t2", "many-a2", 1],
      ],
      sources.flatMap((source) =>
        ["many-t1", "many-t2"].map((target) => ({
          id: `many-${source}-${target}`,
          source,
          target,
          daysAhead: 365,
        })),
      ),
    );
    const counted = countingEnv();

    await setSettings(counted.env, user, { ...SETTINGS, daysAhead: 30, daysAheadShown: 365 });

    // The 60 rule updates and the settings row go in one batch.
    expect(counted.counts.batchStatements).toBe(61);
    expect(counted.counts.d1).toBeLessThanOrEqual(6);
    // One removal call and one sync request per target account, not one per rule.
    const removalCalls = counted.counts.durable.filter((call) => /:queueRemoval/.test(call));
    expect(removalCalls.sort()).toEqual(["many-a1:queueRemovals", "many-a2:queueRemovals"]);
    expect(counted.counts.durable.length).toBeLessThanOrEqual(4);

    // All 60 rules carry the new window, and every trim is queued.
    const { results } = await env.DB.prepare(
      "SELECT json_extract(options, '$.daysAhead') AS days FROM rules WHERE user_id = ?",
    )
      .bind(user.id)
      .all<{ days: number }>();
    expect(results).toHaveLength(60);
    expect(new Set(results.map((row) => row.days))).toEqual(new Set([30]));
    expect(await removalsOf("many-a1")).toHaveLength(30);
    expect(await removalsOf("many-a2")).toHaveLength(30);
  });

  it("stores nothing and queues no trim if the batch fails", async () => {
    const user = await setup(
      "atomic",
      [
        ["atomic-s1", "atomic-s", 1],
        ["atomic-t", "atomic-a", 1],
      ],
      [{ id: "atomic-r", source: "atomic-s1", target: "atomic-t", daysAhead: 365 }],
    );
    const failing = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, key) {
          if (key === "batch") return () => Promise.reject(new Error("D1 down"));
          const value = Reflect.get(target, key) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;

    await expect(
      setSettings(failing, user, { ...SETTINGS, daysAhead: 30, daysAheadShown: 365 }),
    ).rejects.toThrow("D1 down");

    expect(await removalsOf("atomic-a")).toBeUndefined();
    const rule = await env.DB.prepare("SELECT options FROM rules WHERE id = 'atomic-r'").first<{
      options: string;
    }>();
    expect(JSON.parse(rule?.options ?? "{}")).toEqual({ daysAhead: 365 });
  });
});

describe("saving rule details with many rules", () => {
  it("writes the buffer, colour and working hours of 60 rules in one batch", async () => {
    // 30 source calendars on one account, two target accounts: 60 rules in two directions.
    const sources = Array.from({ length: 30 }, (_, i) => `det-src-${i}`);
    const user = await setup(
      "det",
      [
        ...sources.map((id): [string, string, number] => [id, "det-s", 1]),
        ["det-t1", "det-a1", 1],
        ["det-t2", "det-a2", 1],
      ],
      sources.flatMap((source) =>
        ["det-t1", "det-t2"].map((target) => ({
          id: `det-${source}-${target}`,
          source,
          target,
          daysAhead: 90,
        })),
      ),
    );
    await env.DB.batch([
      env.DB.prepare("UPDATE calendars SET is_source = 1 WHERE account_id = 'det-s'"),
      env.DB.prepare(
        "UPDATE calendars SET is_default = 1 WHERE account_id IN ('det-a1', 'det-a2')",
      ),
    ]);
    const office = {
      workDays: [1, 2, 3, 4, 5],
      workStart: "08:00",
      workEnd: "18:00",
      workTimeZone: "Europe/Vienna",
    };
    await setAccountWorkHours(env, user, "det-a1", office);
    // The first load stores the account colours; count the saves only.
    await loadEditorState(env, user.id);

    const details = countingEnv();
    expect(
      await setRuleDetails(details.env, user, {
        buffers: [{ from: "det-s", buffer: { bufferBefore: 30, bufferAfter: 30 } }],
        colors: [{ from: "det-s", to: "det-a1", value: "Focus" }],
        workHours: [{ from: "det-s", to: "det-a1", on: true }],
      }),
    ).toBe(true);
    // One batch reads the state, one writes 60 rules with their audit events.
    expect(details.counts.d1).toBe(2);
    expect(details.counts.batchStatements).toBe(4 + 120);
    expect(details.counts.durable.sort()).toEqual(["det-a1:requestSync", "det-a2:requestSync"]);

    const late = { ...office, workDays: [6, 7] };
    const hours = countingEnv();
    expect(await setAccountWorkHours(hours.env, user, "det-a1", late)).toBe(true);
    // The account row and 30 rules with their audit events in one batch.
    expect(hours.counts.d1).toBe(2);
    expect(hours.counts.batchStatements).toBe(4 + 1 + 60);
    expect(hours.counts.durable).toEqual(["det-a1:requestSync"]);

    const { results } = await env.DB.prepare(
      `SELECT r.target_calendar_id AS target, r.options FROM rules r WHERE r.user_id = ?`,
    )
      .bind(user.id)
      .all<{ target: string; options: string }>();
    expect(results).toHaveLength(60);
    for (const row of results) {
      const options = JSON.parse(row.options) as Record<string, unknown>;
      expect(options).toMatchObject({ bufferBefore: 30, bufferAfter: 30 });
      if (row.target === "det-t1") {
        expect(options).toMatchObject({ blockColor: "Focus", workDays: [6, 7] });
      } else {
        expect(options).toMatchObject({ blockColor: "", workDays: [1, 2, 3, 4, 5, 6, 7] });
      }
    }
  });
});

describe("trimming after a lower window", () => {
  it("queues a trim only for enabled rules with a writable target whose window went down", async () => {
    const user = await setup(
      "trimsel",
      [
        ["trimsel-s1", "trimsel-s", 1],
        ["trimsel-s2", "trimsel-s", 1],
        ["trimsel-s3", "trimsel-s", 1],
        ["trimsel-s4", "trimsel-s", 1],
        ["trimsel-w", "trimsel-a1", 1],
        ["trimsel-ro", "trimsel-a2", 0],
      ],
      [
        { id: "lowered-1", source: "trimsel-s1", target: "trimsel-w", daysAhead: 365 },
        { id: "lowered-2", source: "trimsel-s2", target: "trimsel-w", daysAhead: 180 },
        // Already at the new window: nothing lies beyond it.
        { id: "same", source: "trimsel-s3", target: "trimsel-w", daysAhead: 30 },
        // Off: its own removal took the blocks.
        { id: "off", source: "trimsel-s4", target: "trimsel-w", daysAhead: 365, enabled: false },
        // The target refuses deletes.
        { id: "read-only", source: "trimsel-s1", target: "trimsel-ro", daysAhead: 365 },
      ],
    );

    await setSettings(env, user, { ...SETTINGS, daysAhead: 30, daysAheadShown: 365 });

    expect(await removalsOf("trimsel-a1")).toEqual([
      { ruleId: "lowered-1", remoteCalendarId: "remote-trimsel-w", attempts: 0, trim: true },
      { ruleId: "lowered-2", remoteCalendarId: "remote-trimsel-w", attempts: 0, trim: true },
    ]);
    expect(await removalsOf("trimsel-a2")).toBeUndefined();
  });

  it("queues no trim if the window goes up", async () => {
    const user = await setup(
      "trimup",
      [
        ["trimup-s", "trimup-a", 1],
        ["trimup-t", "trimup-a", 1],
      ],
      [{ id: "up-1", source: "trimup-s", target: "trimup-t", daysAhead: 30 }],
    );
    await setSettings(env, user, { ...SETTINGS, daysAhead: 365, daysAheadShown: 30 });
    expect(await removalsOf("trimup-a")).toBeUndefined();
  });
});

describe("AccountSync.queueRemovals", () => {
  it("queues several rules in one call without duplicates", async () => {
    const stub = env.ACCOUNT_SYNC.getByName("qr-acc");
    await stub.queueRemoval("r1", "cal", { trim: true });
    await stub.queueRemovals(
      [
        { ruleId: "r1", remoteCalendarId: "cal" },
        { ruleId: "r2", remoteCalendarId: "cal" },
        { ruleId: "r2", remoteCalendarId: "cal" },
      ],
      { trim: true },
    );
    expect(await removalsOf("qr-acc")).toEqual([
      { ruleId: "r1", remoteCalendarId: "cal", attempts: 0, trim: true },
      { ruleId: "r2", remoteCalendarId: "cal", attempts: 0, trim: true },
    ]);
  });
});
