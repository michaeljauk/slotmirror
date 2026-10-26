import type { Provider } from "./config";
import { accountSync } from "./durable";

/**
 * Push notifications from Microsoft and Google. A change in a calendar starts a sync within
 * seconds instead of at the next cron run. The cron run stays as a fallback for missed
 * notifications.
 *
 * Each subscription carries a token that only this deployment can compute: an HMAC of the account
 * ID with SESSION_SECRET. A notification without the right token changes nothing.
 */

/** The address providers call for one account. Null without PUBLIC_URL: then only the cron syncs. */
export function webhookUrl(env: Env, provider: Provider, accountId: string): string | null {
  const base = (env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!base.startsWith("https://")) return null;
  return `${base}/webhooks/${provider}?account=${encodeURIComponent(accountId)}`;
}

export async function webhookToken(env: Env, accountId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`webhook:${accountId}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Constant-time comparison of a received token with the expected one. */
export async function isValidToken(
  env: Env,
  accountId: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  const expected = new TextEncoder().encode(await webhookToken(env, accountId));
  const received = new TextEncoder().encode(token);
  if (expected.length !== received.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i]! ^ received[i]!;
  return difference === 0;
}

/** Some accounts did not take a sync request. */
export class SyncRequestError extends Error {
  constructor(
    readonly accountIds: string[],
    options: ErrorOptions,
  ) {
    super(`Requesting a sync failed in ${accountIds.length} account(s)`, options);
  }
}

/**
 * A calendar of the account changed. Its own rules run again (a block there may have been moved or
 * deleted), and so do the rules that read from it, in their target accounts.
 */
export async function notifyChange(env: Env, accountId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT tc.account_id AS accountId FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id = ? AND r.enabled = 1`,
  )
    .bind(accountId)
    .all<{ accountId: string }>();
  await requestSyncs(env, [...new Set([accountId, ...results.map((row) => row.accountId)])]);
}

/**
 * Ask each account for a sync. A failed account does not skip the others; the error afterwards
 * names every account that failed.
 */
export async function requestSyncs(env: Env, accountIds: string[]): Promise<void> {
  const failed: string[] = [];
  let cause: unknown;
  for (const id of accountIds) {
    try {
      await accountSync(env, id).requestSync();
    } catch (error) {
      failed.push(id);
      cause ??= error;
    }
  }
  if (failed.length > 0) throw new SyncRequestError(failed, { cause });
}
