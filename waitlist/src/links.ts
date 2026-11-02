import { hashToken, TOKEN_PATTERN } from "./crypto";
import type { WaitlistEnv } from "./env";
import {
  actionPage,
  alreadyConfirmedPage,
  confirmedPage,
  errorPage,
  expiredPage,
  invalidPage,
  unsubscribeExpiredPage,
  unsubscribedPage,
  type LinkKind,
} from "./pages";

interface Row {
  id: number;
  confirmed_at: number | null;
  expires_at: number;
}

async function find(env: WaitlistEnv, kind: LinkKind, token: string | null): Promise<Row | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const column = kind === "confirm" ? "confirm" : "unsubscribe";
  return env.DB.prepare(
    `SELECT id, confirmed_at, ${column}_expires_at AS expires_at FROM subscribers
     WHERE ${column}_hash = ?`,
  )
    .bind(await hashToken(token))
    .first<Row>();
}

/**
 * GET shows a page with a button and changes nothing, so a mail scanner that opens the link
 * does not confirm or unsubscribe. POST does the work. A one-click unsubscribe (RFC 8058) posts
 * to the same URL, so the token stays in the query string.
 */
export async function handleLink(
  request: Request,
  env: WaitlistEnv,
  kind: LinkKind,
): Promise<Response> {
  try {
    return await link(request, env, kind);
  } catch {
    // The error text can hold bound values, and the URL holds a token. Log a fixed text only.
    console.error("waitlist storage error");
    return errorPage(env.SITE_URL);
  }
}

async function link(request: Request, env: WaitlistEnv, kind: LinkKind): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t");
  const row = await find(env, kind, token);
  if (!row || !token) return invalidPage(env.SITE_URL);
  const now = Date.now();
  const isPost = request.method === "POST";

  if (kind === "confirm") {
    if (row.confirmed_at) return alreadyConfirmedPage(env.SITE_URL);
    if (row.expires_at < now) return expiredPage(env.SITE_URL);
    if (!isPost) return actionPage(kind, token);
    await env.DB.prepare(
      "UPDATE subscribers SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL",
    )
      .bind(now, row.id)
      .run();
    return confirmedPage(env.SITE_URL);
  }

  if (row.expires_at < now) return unsubscribeExpiredPage(env.SITE_URL, env.DELETION_CONTACT);
  if (!isPost) return actionPage(kind, token);
  await env.DB.prepare("DELETE FROM subscribers WHERE id = ?").bind(row.id).run();
  return unsubscribedPage();
}
