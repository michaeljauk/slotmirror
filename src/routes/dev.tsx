import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { accountSync } from "../durable";
import { setGroupMembership } from "../editor";

/**
 * Local load tests with simulated calendars, only with DEV_FAKE_CALENDARS=1 and for admins.
 * Without the variable every route answers 404, so a deployment never exposes them.
 */
export const dev = new Hono<AppEnv>();

dev.use("*", async (c, next) => {
  const user = c.get("user");
  if (c.env.DEV_FAKE_CALENDARS !== "1" || user?.role !== "admin") return c.notFound();
  await next();
});

const DAY = 86_400_000;

/** Marker for the capacity probe: it refuses every instance that does not answer here. */
dev.get("/probe", (c) => c.json({ testInstance: true, fakeCalendars: true }));

/**
 * Create `accounts` simulated accounts with `events` meetings each, all in the block group.
 * `days` sets the window of the user and the spread of the meetings.
 */
dev.post("/seed", async (c) => {
  const user = c.get("user");
  if (!user) return c.notFound();
  const accounts = Math.min(Number(c.req.query("accounts") ?? 10), 20);
  const events = Math.min(Number(c.req.query("events") ?? 200), 10_000);
  const days = Math.min(Math.max(Math.floor(Number(c.req.query("days") ?? 90)), 1), 365);
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
    await stub.seedFake(days === 90 ? i : days * 1000 + i, events);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE user_id = ? AND id LIKE 'sim-%'",
  )
    .bind(user.id)
    .all<{ id: string }>();
  for (const row of results) await setGroupMembership(c.env, user, row.id, true);
  return c.json({ accounts: results.length, eventsPerAccount: events, days });
});

/** Start one sync cycle for every simulated account, as the cron does. */
dev.post("/cycle", async (c) => {
  const user = c.get("user");
  if (!user) return c.notFound();
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE user_id = ? AND id LIKE 'sim-%'",
  )
    .bind(user.id)
    .all<{ id: string }>();
  for (const row of results) await accountSync(c.env, row.id).requestSync();
  return c.json({ started: results.length });
});

/** Simulated provider calls per account, and sync runs since `since` (ISO time). */
dev.get("/stats", async (c) => {
  const user = c.get("user");
  if (!user) return c.notFound();
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE user_id = ? AND id LIKE 'sim-%' ORDER BY id",
  )
    .bind(user.id)
    .all<{ id: string }>();
  const calls: Record<string, number> = {};
  for (const row of results) {
    for (const [operation, count] of Object.entries(await accountSync(c.env, row.id).fakeStats())) {
      calls[operation] = (calls[operation] ?? 0) + count;
    }
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
  const failedRuns = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND kind = 'sync_failed' AND created_at > ?",
  )
    .bind(user.id, since)
    .first<{ n: number }>();
  const rules = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM rules WHERE user_id = ?")
    .bind(user.id)
    .first<{ n: number }>();
  return c.json({
    accounts: results.length,
    rules: rules?.n ?? 0,
    calls,
    ...runs,
    failedRuns: failedRuns?.n ?? 0,
  });
});
