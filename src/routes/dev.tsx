import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { accountSync } from "../durable";
import { setGroupMembership } from "../editor";

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

/** One request to the fetch target, so that a bad target stops the probe before it starts. */
async function fetchTargetState(url: string | undefined): Promise<"off" | "ok" | "failed"> {
  if (!url) return "off";
  try {
    const response = await fetch(url);
    await response.arrayBuffer();
    return response.ok ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Marker for the capacity probe: it refuses every instance that does not answer 200 here. An
 * account that is not simulated means that real calendars are in reach, so the instance answers
 * 409. The check covers all users of the instance.
 */
dev.get("/probe", async (c) => {
  const real = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM accounts WHERE id NOT GLOB 'sim-*'",
  ).first<{ n: number }>();
  const realAccounts = real?.n ?? 0;
  if (realAccounts > 0) {
    return c.json({ testInstance: false, fakeCalendars: true, realAccounts }, 409);
  }
  return c.json({
    testInstance: true,
    fakeCalendars: true,
    realAccounts: 0,
    simulatedFetch: await fetchTargetState(c.env.DEV_FAKE_FETCH_URL),
  });
});

/**
 * Create `accounts` simulated accounts with `events` meetings each, all in the block group.
 * `days` sets the window of the user and of the rules between simulated accounts, and the spread
 * of the meetings. `startedAt` is the database time before the seed: audit rows after it belong
 * to this seed. Invalid values change nothing.
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
  const clock = await c.env.DB.prepare(
    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now",
  ).first<{ now: string }>();
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
    startedAt: clock?.now ?? null,
  });
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
 * the last finished run of each rule. A step that a Worker limit stopped leaves no run here.
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
  for (const row of results) {
    const stats = await accountSync(c.env, row.id).fakeStats();
    for (const [operation, count] of Object.entries(stats.calls)) {
      calls[operation] = (calls[operation] ?? 0) + count;
    }
    blocks += stats.blocks;
    rowsWritten += stats.rowsWritten;
    rowsRead += stats.rowsRead;
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
    blocks,
    rowsWritten,
    rowsRead,
    ...runs,
    lastRuns,
    failedRuns: failedRuns?.n ?? 0,
  });
});
