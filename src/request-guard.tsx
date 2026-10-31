import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app-env";
import { i18nFromContext } from "./i18n";
import { MessagePage } from "./pages/message";
import { render } from "./render";

/**
 * The pages load one script and one stylesheet from this origin. Inline `style` attributes carry
 * account colours, so styles allow them; scripts allow no inline code. No page may be framed.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/** Headers for every response of the Worker. Static files come from the asset binding. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
};

/**
 * Endpoints that providers and Entra call server to server. They authenticate with their own
 * secret (a client state, a channel token or a bearer token), never with the session cookie.
 */
const SERVER_TO_SERVER = [/^\/webhooks\//, /^\/scim\/v2(\/|$)/];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True if a browser sent the request from this deployment's own pages.
 *
 * - With `Sec-Fetch-Site`, only "same-origin" and "none" pass. "none" is a request the user
 *   started, for example from a bookmark; a page on another site cannot send it.
 * - Without it, an `Origin` must equal the request's own origin or the one in PUBLIC_URL.
 * - Without both headers, the request passes. Every current browser sends at least one of them
 *   with a cross-origin POST, so such a request does not come from another site's page.
 */
export function sameOriginRequest(request: Request, publicUrl: string | undefined): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const allowed = [new URL(request.url).origin];
  const configured = publicUrl?.trim();
  if (configured) {
    try {
      allowed.push(new URL(configured).origin);
    } catch {
      // A malformed PUBLIC_URL admits no further origin.
    }
  }
  return allowed.includes(origin);
}

/**
 * Refuse a state-changing request that does not come from this deployment's own pages. Safe
 * methods and the server-to-server endpoints pass.
 */
export const crossSiteGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || SERVER_TO_SERVER.some((path) => path.test(c.req.path))) {
    return next();
  }
  if (sameOriginRequest(c.req.raw, c.env.PUBLIC_URL)) return next();
  const { t } = i18nFromContext(c);
  return render(
    c,
    <MessagePage title={t.messages.notAllowed} message={t.messages.crossSiteRequest} />,
    403,
  );
};
