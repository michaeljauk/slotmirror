import { recordAudit } from "./audit";
import { disconnectUserApps } from "./mcp-oauth";
import { base64url } from "./session";
import { loadUser, type SignedInUser } from "./users";

/** Lifetimes that the token page offers, in days. */
export const TOKEN_DAYS = [7, 30, 90] as const;
export const DEFAULT_TOKEN_DAYS = 30;
const MAX_TOKEN_DAYS = Math.max(...TOKEN_DAYS);
export const MAX_TOKENS_PER_USER = 5;
export const MAX_TOKEN_NAME_LENGTH = 64;

/**
 * Tool calls per user and UTC day. D1 stops every query of the deployment at its daily limit, also
 * those of the sync, so an agent in a loop must hit this limit first.
 */
export const DAILY_TOOL_CALLS = 1000;

/**
 * D1 rows that the tool calls of all users may read per UTC day: a fifth of D1's 5 million. A
 * budget of rows, not of calls, because one call reads 10 to about 5,000 rows, depending on the user's
 * rules and log. However many agents loop, the sync keeps four fifths.
 */
export const DEPLOYMENT_DAILY_ROWS = 1_000_000;

/**
 * D1 rows that one user's calls may read per UTC day: a fifth of the deployment's budget, so that
 * one agent in a loop, or calls that die before they settle, cannot close MCP for everyone.
 */
export const USER_DAILY_ROWS = 200_000;

/**
 * Tool calls of all users per UTC day. A call writes four rows: the user's and the deployment's
 * row, at the reservation and at the settlement. So this keeps MCP at a fifth of D1's 100,000 rows
 * written a day, however many users loop.
 */
export const DEPLOYMENT_DAILY_CALLS = 5000;

const TOKEN_PREFIX = "sm_pat_";
const TOKEN_PATTERN = /^sm_pat_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
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

/**
 * Create a token. Return it once, or null if the user has the maximum of active tokens or the
 * session is older than the user's session version: a reset that lands during this call must not
 * leave a token behind.
 */
export async function createApiToken(
  env: Env,
  user: { id: string; orgId: string; sessionVersion: number },
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
      `INSERT INTO api_tokens (token_hash, id, user_id, name, last_four, scope, session_version,
                               expires_at)
       SELECT ?, ?, u.id, ?, ?, 'read', u.session_version, ? FROM users u
       WHERE u.id = ? AND u.session_version = ?
         AND (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id) < ?`,
    ).bind(
      await hashToken(token),
      id,
      input.name,
      token.slice(-4),
      expiresAt,
      user.id,
      user.sessionVersion,
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
  // The ID comes from the URL. Only a real ID may reach the audit log, and only once.
  if (!UUID_PATTERN.test(tokenId)) return false;
  const deleted = await env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?")
    .bind(tokenId, user.id)
    .run();
  if (!deleted.meta.changes) return false;
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: "api_token_revoked",
    detail: { tokenId },
  });
  return true;
}

/**
 * End every token and connected app of a user. For an admin, who cannot see them one by one.
 */
export async function revokeUserTokens(
  env: Env,
  user: { id: string; orgId: string },
  by: "admin",
): Promise<void> {
  const deleted = await env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?")
    .bind(user.id)
    .run();
  if (deleted.meta.changes) {
    await recordAudit(env.DB, {
      orgId: user.orgId,
      userId: user.id,
      kind: "api_token_revoked",
      detail: { count: deleted.meta.changes, by },
    });
  }
  const apps = await disconnectUserApps(env.DB, user.id);
  if (apps) {
    await recordAudit(env.DB, {
      orgId: user.orgId,
      userId: user.id,
      kind: "mcp_app_disconnected",
      detail: { count: apps, by },
    });
  }
}

/**
 * The user of an `Authorization` header, or null. Accepts a token only in this header. `loadUser`
 * checks the org policy and the session version. A sign-in reset ends a token at the next request.
 * While the policy does not admit the user, the token stops; it works again if the policy admits
 * the user again. Signing out ends a session, not a token.
 */
export async function authenticateToken(
  env: Env,
  header: string | undefined,
  now = Date.now(),
): Promise<SignedInUser | null> {
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
 * Rows reserved for one call before it reads. Measured worst cases: about 3,000 rows for the status
 * of 200 rules with 1,000 audit rows, about 5,000 for 100 accounts with 50 calendars each. After
 * the call the reservation is settled to the rows actually read. If the invocation dies first, the
 * reservation stays: the budget errs toward the sync.
 */
export const RESERVED_ROWS = 6000;

/**
 * Reserve one tool call: one call of the user's daily limit, and one call and `RESERVED_ROWS` of
 * the deployment's daily budget. The batch is one transaction. The user's row counts only below
 * both limits; the deployment's row counts only if the user's row did (`changes()`). So parallel
 * calls cannot pass a check before they are counted, and at a limit nothing is written. The check
 * reads the deployment's one row for the day, however many users call.
 */
export async function reserveToolCall(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<{ outcome: "ok" | "user" | "userRows" | "deployment" | "day"; day: string }> {
  const day = new Date(now).toISOString().slice(0, 10);
  // A row moves only forward in time: a call from before midnight that arrives after one from
  // after it is refused, rather than resetting the new day's count.
  const [user] = await db.batch<{ calls: number }>([
    db
      .prepare(
        `INSERT INTO api_usage (user_id, day, calls, rows_read)
         SELECT ?1, ?2, 1, ?5
         WHERE NOT EXISTS (
           SELECT 1 FROM api_usage_total
           WHERE day = ?2 AND (rows_read >= ?4 OR calls >= ?6)
         )
         ON CONFLICT (user_id) DO UPDATE SET
           calls = CASE WHEN api_usage.day = excluded.day THEN api_usage.calls + 1 ELSE 1 END,
           rows_read = CASE WHEN api_usage.day = excluded.day
                            THEN api_usage.rows_read + excluded.rows_read ELSE excluded.rows_read END,
           day = excluded.day
         WHERE api_usage.day < excluded.day
            OR (api_usage.day = excluded.day AND api_usage.calls < ?3 AND api_usage.rows_read < ?7)
         RETURNING calls`,
      )
      .bind(
        userId,
        day,
        DAILY_TOOL_CALLS,
        DEPLOYMENT_DAILY_ROWS,
        RESERVED_ROWS,
        DEPLOYMENT_DAILY_CALLS,
        USER_DAILY_ROWS,
      ),
    db
      .prepare(
        `INSERT INTO api_usage_total (day, calls, rows_read)
         SELECT ?1, 1, ?2 WHERE changes() > 0
         ON CONFLICT (day) DO UPDATE SET
           calls = api_usage_total.calls + 1,
           rows_read = api_usage_total.rows_read + excluded.rows_read`,
      )
      .bind(day, RESERVED_ROWS),
  ]);
  if (user?.results.length) return { outcome: "ok", day };
  // Refused. Say which limit, so that the agent can tell the user what happened.
  const mine = await db
    .prepare("SELECT day, calls, rows_read AS rowsRead FROM api_usage WHERE user_id = ?")
    .bind(userId)
    .first<{ day: string; calls: number; rowsRead: number }>();
  if (mine && mine.day > day) return { outcome: "day", day };
  if (mine?.day === day && mine.calls >= DAILY_TOOL_CALLS) return { outcome: "user", day };
  if (mine?.day === day && mine.rowsRead >= USER_DAILY_ROWS) return { outcome: "userRows", day };
  return { outcome: "deployment", day };
}

/**
 * Replace the reservation of a finished call with the rows it read, in the user's and the
 * deployment's row. `day` is the day of the reservation: after midnight the user's row may belong
 * to the next day, and stays untouched.
 */
export async function settleToolCall(
  db: D1Database,
  userId: string,
  day: string,
  rowsRead: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE api_usage SET rows_read = MAX(0, rows_read - ?3 + ?4)
         WHERE user_id = ?1 AND day = ?2`,
      )
      .bind(userId, day, RESERVED_ROWS, rowsRead),
    db
      .prepare("UPDATE api_usage_total SET rows_read = MAX(0, rows_read - ?2 + ?3) WHERE day = ?1")
      .bind(day, RESERVED_ROWS, rowsRead),
  ]);
}
