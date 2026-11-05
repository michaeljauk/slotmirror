import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { AppEnv } from "./app-env";
import { mcpEnabled } from "./config";
import type { Messages } from "./i18n";
import { can, MCP_ACTIONS, type Action } from "./permissions";

/**
 * What a route needs:
 * - an action: a signed-in user must have it, see `can`;
 * - "public": no action. Such a route has no user, or checks its own credential (a webhook, an
 *   OAuth request, the sign-in), or only ends a session.
 */
export type RouteNeed = Action | "public";

/**
 * Every route of the app, as "METHOD path" with Hono's path pattern. A route that is missing here
 * answers 404 to everyone; a test fails for it. `/mcp` and `/oauth/token` run before the session,
 * so this table only names their action: `src/mcp.ts` and `src/mcp-oauth.ts` check it.
 */
export const ROUTE_NEEDS: Readonly<Record<string, RouteNeed>> = {
  "GET /healthz": "public",
  "POST /webhooks/microsoft": "public",
  "POST /webhooks/google": "public",
  "POST /mcp": "mcp:read",
  "GET /.well-known/oauth-protected-resource": "public",
  "GET /.well-known/oauth-protected-resource/mcp": "public",
  "GET /.well-known/oauth-authorization-server": "public",
  "POST /oauth/register": "public",
  "POST /oauth/token": "apps:connect",
  "POST /oauth/revoke": "public",
  "GET /privacy": "public",
  "POST /auth/logout": "public",
  "GET /auth/:provider/login": "public",
  // The callback finishes a sign-in or a connect. A connect needs the signed state that
  // `/auth/:provider/connect` sets, and that route needs "accounts:write".
  "GET /auth/:provider/callback": "public",
  "GET /auth/:provider/connect": "accounts:write",
  "GET /": "accounts:read",
  "POST /accounts/:id/settings": "accounts:write",
  "POST /accounts/:id/name": "accounts:write",
  "GET /accounts/:id/disconnect": "accounts:write",
  "POST /accounts/:id/disconnect": "accounts:write",
  "GET /rules": "rules:read",
  "POST /rules/calendars/refresh": "rules:write",
  "POST /rules": "rules:write",
  "POST /rules/group/all": "rules:write",
  "POST /rules/group/:accountId": "rules:write",
  "POST /rules/direction": "rules:write",
  "POST /rules/choices": "rules:write",
  "POST /rules/direction/details": "rules:write",
  "POST /rules/direction/color": "rules:write",
  "POST /rules/direction/hours": "rules:write",
  "POST /rules/direction/buffer": "rules:write",
  "POST /rules/source/buffer": "rules:write",
  "POST /rules/direction/reset": "rules:write",
  "POST /rules/source-calendar/:calendarId": "rules:write",
  "POST /rules/settings": "rules:write",
  // Dry runs: they read the calendars and write nothing.
  "POST /rules/direction/check": "rules:read",
  "POST /rules/:id/preview": "rules:read",
  "POST /rules/:id/run": "rules:write",
  "POST /rules/:id/enable": "rules:write",
  "POST /rules/:id/pause": "rules:write",
  "POST /rules/:id/delete": "rules:write",
  "GET /activity": "activity:read",
  // An admin also sees the rest of other users there; the handler asks for "org:audit".
  "GET /cleanup": "activity:read",
  "GET /account/delete": "account:delete",
  "POST /account/delete": "account:delete",
  "GET /tokens": "tokens:read",
  "POST /tokens": "tokens:create",
  "POST /tokens/apps/:id/revoke": "tokens:revoke",
  "POST /tokens/:id/revoke": "tokens:revoke",
  "GET /oauth/authorize": "apps:connect",
  "POST /oauth/authorize": "apps:connect",
  "GET /admin": "users:read",
  "GET /admin/users/:id/delete": "users:manage",
  "POST /admin/users/:id/delete": "users:manage",
  "POST /admin/users/:id/reset-sign-in": "users:manage",
  "POST /admin/users/:id/revoke-tokens": "users:manage",
  "GET /admin/activity": "org:audit",
  "POST /admin/compare": "org:operate",
  "POST /admin/test-alert": "org:operate",
  "POST /admin/mcp-policy": "org:policy",
  "GET /dev/probe": "dev:tools",
  "GET /dev/rpc-budget": "dev:tools",
  "POST /dev/seed": "dev:tools",
  "POST /dev/burst": "dev:tools",
  "POST /dev/cycle": "dev:tools",
  "GET /dev/stats": "dev:tools",
};

/** Refusals that get a page instead of a 404, because a person follows a link to them. */
const REFUSAL_PAGES: Readonly<Record<string, (t: Messages) => string>> = {
  "GET /admin": (t) => t.admin.onlyAdmins,
  "GET /oauth/authorize": (t) => t.consent.mcpOff,
  "POST /oauth/authorize": (t) => t.consent.mcpOff,
};

/**
 * The route that answers a request: the first matched route that is not a middleware. Hono runs
 * the matched handlers in this order, and `use()` registers its middleware with method "ALL".
 */
export function answeringRoute(c: Context<AppEnv>): string | null {
  const route = matchedRoutes(c).find((candidate) => candidate.method !== "ALL");
  return route ? `${route.method} ${route.path}` : null;
}

/**
 * Check the action of the answering route before its handler runs. Without a user the handler
 * decides, as before: it sends the visitor to the sign-in. A request that matches no route in
 * `ROUTE_NEEDS` answers 404.
 */
export function routePermissions(
  refusalPage: (
    c: Context<AppEnv>,
    message: (t: Messages) => string,
  ) => Response | Promise<Response>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // No named route answers: a 404 anyway, unless an `all()` handler would run without a check.
    const route = answeringRoute(c);
    if (route === null) return c.notFound();
    const need = ROUTE_NEEDS[route];
    if (need === undefined) return c.notFound();
    if (need === "public") return next();
    if (MCP_ACTIONS.has(need) && !mcpEnabled(c.env)) return c.notFound();
    const user = c.get("user");
    if (!user) return next();
    if (can(user, need)) return next();
    const page = REFUSAL_PAGES[route];
    return page ? refusalPage(c, page) : c.notFound();
  };
}
