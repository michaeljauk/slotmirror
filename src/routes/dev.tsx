import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { accountSync } from "../durable";
import { setGroupMembership } from "../editor";
import type { Provider } from "../config";
import { fakePagePath, measureFetchBudget } from "../providers/fake-calendar";

/**
 * Load tests with simulated calendars, on a local server or on a separate test deployment. Only
 * with DEV_FAKE_CALENDARS=1 and for admins. Without the variable every route answers 404, so a
 * normal deployment never exposes them.
 */
export const dev = new Hono<AppEnv>();

dev.use("*", async (c, next) => {
  const user = c.get("user");
  if (c.env.DEV_FAKE_CALENDARS !== "1" || user?.role !== "admin") return c.notFound();
  await next();
});

const DAY = 86_400_000;

/** An integer query value in a range, the fallback if it is absent, or null if it is invalid. */
function intParam(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}

/** Accounts outside the simulation. Any of them means that real calendars are in reach. */
async function realAccountCount(env: Env): Promise<number> {
  const real = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM accounts WHERE id NOT GLOB 'sim-*'",
  ).first<{ n: number }>();
  return real?.n ?? 0;
}

/** The database time as an ISO string: audit rows after it belong to the work that follows. */
async function databaseTime(env: Env): Promise<string | null> {
  const clock = await env.DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").first<{
    now: string;
  }>();
  return clock?.now ?? null;
}

/** Fetches of the limit check: one more than the Free plan allows per invocation. */
const LIMIT_CHECK_FETCHES = 51;
const PROVIDERS: readonly Provider[] = ["microsoft", "google"];
/** A page below this size is not a calendar page. The route does not parse: that costs its CPU. */
const MIN_PAGE_BYTES = 100_000;
/** Calls to another instance in the RPC check. The limit must leave room for them and a fetch. */
const RPC_CHECK_CALLS = 25;

/** True if the fetch target serves a page in real size per provider. */
async function servesPages(url: string): Promise<boolean> {
  try {
    for (const provider of PROVIDERS) {
      const response = await fetch(new URL(fakePagePath(provider), url).href);
      const page = await response.arrayBuffer();
      if (!response.ok || page.byteLength < MIN_PAGE_BYTES) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * What the fetch target tells about the plan of this instance. On the Free plan the runtime refuses
 * the 51st fetch of an invocation; on the Paid plan it succeeds.
 */
async function subrequestState(url: string | undefined) {
  if (!url) return { simulatedFetch: "off", subrequestLimit: "unknown", fetches: 0 } as const;
  if (!(await servesPages(url))) {
    return { simulatedFetch: "failed", subrequestLimit: "unknown", fetches: 0 } as const;
  }
  const budget = await measureFetchBudget(url, LIMIT_CHECK_FETCHES - PROVIDERS.length);
  const fetches = budget.fetches + PROVIDERS.length;
  if (budget.state === "failed") {
    return { simulatedFetch: "failed", subrequestLimit: "unknown", fetches } as const;
  }
  const subrequestLimit = budget.state === "limited" ? "enforced" : "absent";
  return { simulatedFetch: "ok", subrequestLimit, fetches } as const;
}

/**
 * Marker for the capacity probe: it refuses every instance that does not answer 200 here. An
 * account that is not simulated means that real calendars are in reach, so the instance answers
 * 409. The check covers all users of the instance.
 */
dev.get("/probe", async (c) => {
  const realAccounts = await realAccountCount(c.env);
  if (realAccounts > 0) {
    return c.json({ testInstance: false, fakeCalendars: true, realAccounts }, 409);
  }
  return c.json({
    testInstance: true,
    fakeCalendars: true,
    realAccounts: 0,
    ...(await subrequestState(c.env.DEV_FAKE_FETCH_URL)),
  });
});

/**
 * Does Durable Object RPC count as a subrequest? One instance measures its fetches alone, then
 * after calls to another instance. If RPC counts, the second number drops by the number of calls.
 * It runs in an instance, because the sync makes these calls there.
 */
dev.get("/rpc-budget", async (c) => {
  if (!c.env.DEV_FAKE_FETCH_URL) return c.json({ error: "DEV_FAKE_FETCH_URL is not set" }, 400);
  const stub = accountSync(c.env, "sim-rpc-budget");
  const peer = "sim-rpc-budget-peer";
  const baseline = await stub.fakeFetchBudget(peer, 0, LIMIT_CHECK_FETCHES);
  const mixed = await stub.fakeFetchBudget(peer, RPC_CHECK_CALLS, LIMIT_CHECK_FETCHES);
  return c.json({ rpcCalls: RPC_CHECK_CALLS, baseline, mixed });
});

/**
 * Create `accounts` simulated accounts with `events` meetings each, all in the block group.
 * `days` sets the window of the user and of the rules between simulated accounts, and the spread
 * of the meetings. `startedAt` is the database time before the seed: audit rows after it belong
 * to this seed. Invalid values change nothing, and an instance with real accounts answers 409.
 */
dev.post("/seed", async (c) => {
  const user = c.get("user");
  if (!user) return c.notFound();
  const accounts = intParam(c.req.query("accounts"), 10, 20);
  const events = intParam(c.req.query("events"), 200, 10_000);
  const days = intParam(c.req.query("days"), 90, 365);
  if (accounts === null || events === null || days === null) {
    return c.json({ error: "accounts: 1-20, events: 1-10000, days: 1-365" }, 400);
  }
  const realAccounts = await realAccountCount(c.env);
  if (realAccounts > 0) return c.json({ testInstance: false, realAccounts }, 409);
  const startedAt = await databaseTime(c.env);
  await c.env.DB.prepare(
    "UPDATE users SET sync_settings = json_set(sync_settings, '$.daysAhead', ?) WHERE id = ?",
  )
    .bind(days, user.id)
    .run();
  for (let i = 1; i <= accounts; i++) {
    const id = `sim-${user.id}-${i}`;
    const provider = i % 2 === 0 ? "google" : "microsoft";
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO accounts (id, user_id, provider, email, display_name)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(id, user.id, provider, `account${i}@sim${i}.example`, `Konto ${i}`),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source)
         VALUES (?, ?, 'main', 'Calendar', 1, 1, 1)`,
      ).bind(`${id}-main`, id),
    ]);
    const stub = accountSync(c.env, id);
    await stub.storeTokens(
      id,
      { refreshToken: "fake", accessToken: "fake", accessExpiresAt: Date.now() + 365 * DAY },
      provider,
    );
    await stub.seedFake({ account: i, accounts, days }, events);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE user_id = ? AND id GLOB 'sim-*'",
  )
    .bind(user.id)
    .all<{ id: string }>();
  for (const row of results) await setGroupMembership(c.env, user, row.id, true);
  // Rules keep their own window, and the group rules may exist from an earlier seed. The calendars
  // start empty, so that nothing is left to trim.
  await c.env.DB.prepare(
    `UPDATE rules SET options = json_set(options, '$.daysAhead', ?)
     WHERE user_id = ? AND source_calendar_id GLOB 'sim-*' AND target_calendar_id GLOB 'sim-*'`,
  )
    .bind(days, user.id)
    .run();
  return c.json({
    accounts: results.length,
    eventsPerAccount: events,
    days,
    startedAt,
  });
});

/**
 * A burst of changes: `events` meetings of the first simulated account move. `startedAt` works as
 * in `/dev/seed`. The next cycle must update their mirrors.
 */
dev.post("/burst", async (c) => {
  const user = c.get("user");
  if (!user) return c.notFound();
  const events = intParam(c.req.query("events"), 50, 10_000);
  if (events === null) return c.json({ error: "events: 1-10000" }, 400);
  const startedAt = await databaseTime(c.env);
  await accountSync(c.env, `sim-${user.id}-1`).shiftFake(events);
  return c.json({ events, startedAt });
});

/** Start one sync cycle for every simulated account, as the cron does. */
dev.post("/cycle", async (c) => {
  const user = c.get("user");
  if (!user) return c.notFound();
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE user_id = ? AND id GLOB 'sim-*'",
  )
    .bind(user.id)
    .all<{ id: string }>();
  for (const row of results) await accountSync(c.env, row.id).requestSync();
  return c.json({ started: results.length });
});

/**
 * What the simulated accounts did since `since` (ISO time): provider calls, blocks, sync runs, and
 * the last finished run of each rule. A step that a Worker limit stopped leaves no run here, so
 * compare `startedSteps` with the runs. `count=1` also counts the stored blocks per calendar; that
 * bills every row, so call it at the end of a stage, not in a poll.
 */
dev.get("/stats", async (c) => {
  const user = c.get("user");
  if (!user) return c.notFound();
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE user_id = ? AND id GLOB 'sim-*' ORDER BY id",
  )
    .bind(user.id)
    .all<{ id: string }>();
  const calls: Record<string, number> = {};
  let blocks = 0;
  let rowsWritten = 0;
  let rowsRead = 0;
  let startedSteps = 0;
  const countBlocks = c.req.query("count") === "1";
  const storedBlocks: number[] = [];
  for (const row of results) {
    const stats = await accountSync(c.env, row.id).fakeStats(countBlocks);
    for (const [operation, count] of Object.entries(stats.calls)) {
      calls[operation] = (calls[operation] ?? 0) + count;
    }
    blocks += stats.blocks;
    rowsWritten += stats.rowsWritten;
    rowsRead += stats.rowsRead;
    startedSteps += stats.startedSteps;
    storedBlocks.push(...(stats.storedBlocks ?? []));
  }
  const since = c.req.query("since") ?? "1970-01-01";
  const runs = await c.env.DB.prepare(
    `SELECT COUNT(*) AS runs,
            SUM(json_extract(detail, '$.applied')) AS writes,
            SUM(json_extract(detail, '$.failed')) AS failedWrites,
            SUM(json_extract(detail, '$.throttled')) AS throttledWrites,
            SUM(json_extract(detail, '$.durationMs')) AS sumStepMs,
            MAX(json_extract(detail, '$.durationMs')) AS maxStepMs,
            MAX(created_at) AS lastRunAt
     FROM audit_events WHERE user_id = ? AND kind = 'sync_run' AND created_at > ?`,
  )
    .bind(user.id, since)
    .first<{
      runs: number;
      writes: number | null;
      failedWrites: number | null;
      throttledWrites: number | null;
      sumStepMs: number | null;
      maxStepMs: number | null;
      lastRunAt: string | null;
    }>();
  const { results: lastRuns } = await c.env.DB.prepare(
    `SELECT rule_id AS ruleId, json_extract(detail, '$.failed') AS failed,
            json_extract(detail, '$.remaining') AS remaining
     FROM (SELECT rule_id, detail,
                  ROW_NUMBER() OVER (PARTITION BY rule_id ORDER BY id DESC) AS position
           FROM audit_events
           WHERE user_id = ? AND kind = 'sync_run' AND created_at > ?
             AND json_extract(detail, '$.dryRun') = 0)
     WHERE position = 1`,
  )
    .bind(user.id, since)
    .all<{ ruleId: string; failed: number; remaining: number }>();
  const failedRuns = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND kind = 'sync_failed' AND created_at > ?",
  )
    .bind(user.id, since)
    .first<{ n: number }>();
  const rules = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n,
            MIN(COALESCE(json_extract(options, '$.daysAhead'), 90)) AS minDays,
            MAX(COALESCE(json_extract(options, '$.daysAhead'), 90)) AS maxDays
     FROM rules WHERE user_id = ? AND enabled = 1`,
  )
    .bind(user.id)
    .first<{ n: number; minDays: number | null; maxDays: number | null }>();
  return c.json({
    accounts: results.length,
    rules: rules?.n ?? 0,
    ruleDays: { min: rules?.minDays ?? null, max: rules?.maxDays ?? null },
    calls,
    startedSteps,
    storedBlocks: countBlocks ? storedBlocks : null,
    blocks,
    rowsWritten,
    rowsRead,
    ...runs,
    lastRuns,
    failedRuns: failedRuns?.n ?? 0,
  });
});
