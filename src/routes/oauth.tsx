import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import type { AppEnv } from "../app-env";
import { mcpEnabled, setupStatus } from "../config";
import { i18nFromContext } from "../i18n";
import {
  addressKey,
  authenticateClient,
  authorizationServerMetadata,
  checkAuthorizeRequest,
  clientRedirect,
  exchangeCode,
  findClient,
  issueCode,
  MAX_GRANTS_PER_USER,
  oauthIssuer,
  otherGrantCount,
  protectedResourceMetadata,
  refreshGrant,
  registerClient,
  resourceOf,
  RESUME_COOKIE,
  RESUME_SECONDS,
  revokeToken,
  signConsentTicket,
  signResume,
  verifyConsentTicket,
} from "../mcp-oauth";
import { ConsentPage } from "../pages/consent";
import { MessagePage } from "../pages/message";
import { render } from "../render";

const MAX_FORM_BYTES = 8 * 1024;

/**
 * The server-to-server part of OAuth: metadata, registration, token and revocation. It runs before
 * the language and session middleware and reads no cookie. Any origin may read the metadata
 * (CORS `*`); the other paths serve clients that run outside a browser.
 */
export const oauthApi = new Hono<AppEnv>();

const openCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"],
  maxAge: 86_400,
});

const API_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
];

for (const path of API_PATHS) {
  // CORS for the metadata only, and before the gate, so that a browser can read a refusal too.
  // `/mcp` refuses foreign origins, so a client in a browser tab has no use for the other paths.
  if (path.startsWith("/.well-known/")) oauthApi.use(path, openCors);
  oauthApi.use(path, async (c, next) => {
    if (!mcpEnabled(c.env)) return c.notFound();
    c.header("Cache-Control", "no-store");
    if (!setupStatus(c.env).ready) {
      return c.json({ error: "temporarily_unavailable" }, 503);
    }
    await next();
  });
}

const issuerOf = (c: Context<AppEnv>) => oauthIssuer(c.env, c.req.url);

// RFC 9728 3.3: each document names the resource whose URL the well-known path went into.
oauthApi.get("/.well-known/oauth-protected-resource", (c) =>
  c.json(protectedResourceMetadata(issuerOf(c), issuerOf(c))),
);
oauthApi.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  c.json(protectedResourceMetadata(issuerOf(c), resourceOf(issuerOf(c)))),
);

oauthApi.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(authorizationServerMetadata(issuerOf(c))),
);

const smallBody = bodyLimit({
  maxSize: MAX_FORM_BYTES,
  onError: (c) => c.json({ error: "invalid_request" }, 413),
});

oauthApi.post("/oauth/register", smallBody, async (c) => {
  // JSON only (RFC 7591 3.1). A browser sends JSON across sites only after a preflight, which this
  // endpoint does not answer, so a web page cannot register clients from its visitors' addresses.
  if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
    return c.json({ error: "invalid_client_metadata" }, 400);
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(await c.req.text());
  } catch {
    return c.json({ error: "invalid_client_metadata" }, 400);
  }
  const address = await addressKey(c.env, c.req.header("cf-connecting-ip"));
  const result = await registerClient(c.env.DB, metadata, address);
  return c.json(result.body, result.status);
});

/** The form fields of a token or revocation request, as strings. */
async function formOf(c: Context<AppEnv>): Promise<Record<string, string>> {
  const body = await c.req.parseBody().catch(() => ({}));
  return Object.fromEntries(
    Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

oauthApi.post("/oauth/token", smallBody, async (c) => {
  const form = await formOf(c);
  const grantType = form.grant_type;
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return c.json({ error: "unsupported_grant_type" }, 400);
  }
  const client = await authenticateClient(c.env.DB, form, c.req.header("authorization"));
  if (!client) {
    c.header("WWW-Authenticate", 'Basic realm="slotmirror"');
    return c.json({ error: "invalid_client" }, 401);
  }
  const result =
    grantType === "authorization_code"
      ? await exchangeCode(c.env, issuerOf(c), client, form)
      : await refreshGrant(c.env, issuerOf(c), client, form);
  return c.json(result.body, result.status);
});

oauthApi.post("/oauth/revoke", smallBody, async (c) => {
  const form = await formOf(c);
  const client = await authenticateClient(c.env.DB, form, c.req.header("authorization"));
  if (!client) {
    c.header("WWW-Authenticate", 'Basic realm="slotmirror"');
    return c.json({ error: "invalid_client" }, 401);
  }
  await revokeToken(c.env, issuerOf(c), client, form.token);
  return c.body(null, 200);
});

/** The browser part: the consent page and its decision. Runs after the session middleware. */
export const oauthPages = new Hono<AppEnv>();

oauthPages.use("/authorize", async (c, next) => {
  if (!mcpEnabled(c.env)) return c.notFound();
  c.header("Cache-Control", "no-store");
  await next();
});

function problem(c: Context<AppEnv>, status: 400 | 409, message: string) {
  const { t } = i18nFromContext(c);
  return render(
    c,
    <MessagePage title={t.consent.problemTitle} message={message} user={c.get("user")} />,
    status,
  );
}

oauthPages.get("/authorize", async (c) => {
  const { t } = i18nFromContext(c);
  const issuer = issuerOf(c);
  const check = await checkAuthorizeRequest(c.env.DB, issuer, c.req.query());
  if ("error" in check) {
    // Shown here, never redirected: anyone can register a client and its redirect.
    const message =
      check.error === "invalid_client"
        ? t.consent.unknownApp
        : check.error === "invalid_redirect_uri"
          ? t.consent.badRedirect
          : t.consent.badRequest(check.error);
    return problem(c, 400, message);
  }
  const user = c.get("user");
  if (!user) {
    // Sign in first, then come back to this request. The cookie holds only this path, signed.
    const url = new URL(c.req.url);
    const path = `${url.pathname}${url.search}`;
    // A browser drops a cookie over 4 KB. A longer request signs in and goes home instead.
    if (path.length > 2000) return c.redirect("/");
    setCookie(c, RESUME_COOKIE, await signResume(c.env, path), {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: RESUME_SECONDS,
    });
    return c.redirect("/");
  }
  const request = check.ok;
  if ((await otherGrantCount(c.env.DB, user.id, request.client.id)) >= MAX_GRANTS_PER_USER) {
    return problem(c, 409, t.consent.tooManyApps(MAX_GRANTS_PER_USER));
  }
  // The decision redirects to the client. `form-action` must admit that one origin, or the browser
  // stops the redirect after the form.
  c.set("formAction", new URL(request.redirectUri).origin);
  return render(
    c,
    <ConsentPage
      user={user}
      appName={request.client.name}
      returnsTo={new URL(request.redirectUri).host}
      ticket={await signConsentTicket(c.env, user.id, request)}
    />,
  );
});

oauthPages.post("/authorize", async (c) => {
  const { t } = i18nFromContext(c);
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const form = await c.req.parseBody();
  const ticket = await verifyConsentTicket(
    c.env,
    typeof form.ticket === "string" ? form.ticket : undefined,
    user.id,
  );
  if (!ticket || !(await findClient(c.env.DB, ticket.client))) {
    return problem(c, 400, t.consent.expired);
  }
  const issuer = issuerOf(c);
  if (form.decision !== "allow") {
    return c.redirect(
      clientRedirect(ticket.redirect, issuer, { error: "access_denied", state: ticket.state }),
    );
  }
  const code = await issueCode(c.env.DB, user, ticket);
  return c.redirect(clientRedirect(ticket.redirect, issuer, { code, state: ticket.state }));
});
