import { auditStatement, recordAudit } from "./audit";
import { base64url } from "./session";
import { loadUser, type CurrentUser } from "./users";

/** Lifetimes that the token page offers, in days. */
export const TOKEN_DAYS = [7, 30, 90] as const;
export const DEFAULT_TOKEN_DAYS = 30;
const MAX_TOKEN_DAYS = 90;
export const MAX_TOKENS_PER_USER = 5;
export const MAX_TOKEN_NAME_LENGTH = 64;

/**
 * Tool calls per user and UTC day. D1 stops every query of the deployment at its daily limit, also
 * those of the sync, so an agent in a loop must hit this limit first.
 */
export const DAILY_TOOL_CALLS = 1000;

const TOKEN_PREFIX = "sm_pat_";
const TOKEN_PATTERN = /^sm_pat_[A-Za-z0-9_-]{43}$/;
const LAST_USED_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface ApiToken {
  id: string;
  name: string;
  lastFour: string;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Hex SHA-256. A token holds 256 random bits, so a slow hash would add only CPU time. */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Create a token. Return it once, or null if the user has the maximum of active tokens. */
export async function createApiToken(
  env: Env,
  user: { id: string; orgId: string },
  input: { name: string; days: number },
  now = Date.now(),
): Promise<{ token: string } | null> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_TOKEN_DAYS) {
    throw new RangeError("Token lifetime out of range");
  }
  const token = TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = crypto.randomUUID();
  const expiresAt = new Date(now + input.days * DAY_MS).toISOString();
  const [, inserted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ? AND expires_at <= ?").bind(
      user.id,
      new Date(now).toISOString(),
    ),
    env.DB.prepare(
      `INSERT INTO api_tokens (token_hash, id, user_id, name, last_four, session_version, expires_at)
       SELECT ?, ?, u.id, ?, ?, u.session_version, ? FROM users u
       WHERE u.id = ? AND (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id) < ?`,
    ).bind(
      await hashToken(token),
      id,
      input.name,
      token.slice(-4),
      expiresAt,
      user.id,
      MAX_TOKENS_PER_USER,
    ),
  ]);
  if (!inserted?.meta.changes) return null;
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: "api_token_created",
    detail: { tokenId: id, days: input.days },
  });
  return { token };
}

export async function listApiTokens(db: D1Database, userId: string): Promise<ApiToken[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, last_four AS lastFour, expires_at AS expiresAt, created_at AS createdAt,
              last_used_at AS lastUsedAt
       FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id`,
    )
    .bind(userId)
    .all<ApiToken>();
  return results;
}

/** End one token of the user. Return false if the user has no such token. */
export async function revokeApiToken(
  env: Env,
  user: { id: string; orgId: string },
  tokenId: string,
): Promise<boolean> {
  const event = { orgId: user.orgId, userId: user.id, kind: "api_token_revoked" } as const;
  const [deleted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").bind(tokenId, user.id),
    auditStatement(env.DB, { ...event, detail: { tokenId } }),
  ]);
  return (deleted?.meta.changes ?? 0) > 0;
}

/** End every token of a user. For an admin, who cannot see the user's tokens one by one. */
export async function revokeUserTokens(
  env: Env,
  user: { id: string; orgId: string },
): Promise<void> {
  const event = { orgId: user.orgId, userId: user.id, kind: "api_token_revoked" } as const;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(user.id),
    auditStatement(env.DB, { ...event, detail: { all: true } }),
  ]);
}

/**
 * The user of an `Authorization` header, or null. Accepts a token only in this header. `loadUser`
 * checks the org policy and the session version, so that leaving the policy or a sign-in reset ends
 * a token at the next request. Signing out ends a session, not a token.
 */
export async function authenticateToken(
  env: Env,
  header: string | undefined,
  now = Date.now(),
): Promise<CurrentUser | null> {
  const token = /^bearer +(\S+)$/i.exec(header ?? "")?.[1];
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const hash = await hashToken(token);
  const row = await env.DB.prepare(
    `SELECT user_id AS userId, session_version AS sessionVersion, expires_at AS expiresAt,
            last_used_at AS lastUsedAt
     FROM api_tokens WHERE token_hash = ?`,
  )
    .bind(hash)
    .first<{
      userId: string;
      sessionVersion: number;
      expiresAt: string;
      lastUsedAt: string | null;
    }>();
  if (!row || Date.parse(row.expiresAt) <= now) return null;
  const user = await loadUser(env, row.userId, row.sessionVersion);
  if (!user) return null;
  if (!row.lastUsedAt || now - Date.parse(row.lastUsedAt) >= LAST_USED_INTERVAL_MS) {
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?")
      .bind(new Date(now).toISOString(), hash)
      .run();
  }
  return user;
}

/**
 * Count one tool call. Return false at the daily limit. At the limit the statement writes no row,
 * so that a client in a loop cannot use up the deployment's daily D1 writes.
 */
export async function takeToolCall(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await db
    .prepare(
      `INSERT INTO api_usage (user_id, day, calls) VALUES (?1, ?2, 1)
       ON CONFLICT (user_id) DO UPDATE
         SET calls = CASE WHEN api_usage.day = excluded.day THEN api_usage.calls + 1 ELSE 1 END,
             day = excluded.day
         WHERE api_usage.day <> excluded.day OR api_usage.calls < ?3
       RETURNING calls`,
    )
    .bind(userId, day, DAILY_TOOL_CALLS)
    .first<{ calls: number }>();
  return row !== null;
}

/** Seconds until the daily limit starts again. */
export function secondsToNextDay(now = Date.now()): number {
  return Math.ceil((DAY_MS - (now % DAY_MS)) / 1000);
}
