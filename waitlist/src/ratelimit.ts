import { ipKey, sha256Hex } from "./crypto";
import type { WaitlistEnv } from "./env";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Count a sign-up attempt for the caller's IP address, per hour and per UTC day. The D1 counters
 * always run, so the limits work on the Workers Free plan. The Rate Limiting binding is an
 * optional extra limit. Returns false if the caller is over a limit.
 *
 * The daily row uses the hour number of the day start as its window. The cleanup keeps rows for
 * 24 hours, so a daily row stays until its day is over.
 */
export async function allowAttempt(env: WaitlistEnv, ip: string, now: number): Promise<boolean> {
  const key = await ipKey(ip, env.HASH_PEPPER);
  if (env.RATE_LIMITER) {
    try {
      if (!(await env.RATE_LIMITER.limit({ key })).success) return false;
    } catch {
      // The binding is optional. If it fails, the D1 counters still decide.
    }
  }
  const dayKey = await sha256Hex(`day:${key}`);
  const hourLimit = Number(env.SIGNUPS_PER_IP_PER_HOUR) || 5;
  const dayLimit = Number(env.SIGNUPS_PER_IP_PER_DAY) || 10;
  const count = env.DB.prepare(
    `INSERT INTO rate_hits (key_hash, window, hits) VALUES (?, ?, 1)
     ON CONFLICT (key_hash, window) DO UPDATE SET hits = hits + 1
     RETURNING hits`,
  );
  const [hour, day] = await env.DB.batch<{ hits: number }>([
    count.bind(key, Math.floor(now / HOUR_MS)),
    count.bind(dayKey, Math.floor(now / DAY_MS) * 24),
  ]);
  return (hour?.results[0]?.hits ?? 1) <= hourLimit && (day?.results[0]?.hits ?? 1) <= dayLimit;
}

/** Counter rows older than this many hours are deleted. */
export const RATE_RETENTION_HOURS = 24;
export const RATE_WINDOW_MS = HOUR_MS;
