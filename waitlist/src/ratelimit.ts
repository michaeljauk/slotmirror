import { ipKey } from "./crypto";
import type { WaitlistEnv } from "./env";

const WINDOW_MS = 3_600_000;

/**
 * Count a sign-up attempt for the caller's IP address. The D1 counter always runs, so the limit
 * works on the Workers Free plan. The Rate Limiting binding is an optional second limit.
 * Returns false if the caller is over a limit.
 */
export async function allowAttempt(env: WaitlistEnv, ip: string, now: number): Promise<boolean> {
  const key = await ipKey(ip, env.HASH_PEPPER);
  if (env.RATE_LIMITER) {
    try {
      if (!(await env.RATE_LIMITER.limit({ key })).success) return false;
    } catch {
      // The binding is optional. If it fails, the D1 counter still decides.
    }
  }
  const limit = Number(env.SIGNUPS_PER_IP_PER_HOUR) || 5;
  const row = await env.DB.prepare(
    `INSERT INTO rate_hits (key_hash, window, hits) VALUES (?, ?, 1)
     ON CONFLICT (key_hash, window) DO UPDATE SET hits = hits + 1
     RETURNING hits`,
  )
    .bind(key, Math.floor(now / WINDOW_MS))
    .first<{ hits: number }>();
  return (row?.hits ?? 1) <= limit;
}

export const RATE_WINDOW_MS = WINDOW_MS;
