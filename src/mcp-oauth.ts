import { recordAudit } from "./audit";
import { base64url, signPayload, verifyPayload } from "./session";
import { can } from "./permissions";
import { loadUser, type SignedInUser } from "./users";

/**
 * OAuth 2.1 for the MCP endpoint, as the MCP authorization spec asks: protected resource metadata
 * (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591),
 * the code flow with PKCE S256, resource indicators (RFC 8707) and token revocation (RFC 7009).
 *
 * Storage is plain SQL on D1 and crypto is Web Crypto, so that a later hosting adapter can run this
 * on SQLite. Access tokens are signed, not stored: a request reads the grant and writes nothing.
 * Every query of this file lives in a function here; route handlers hold no SQL.
 */

export const OAUTH_SCOPE = "mcp:read";
export const ACCESS_TOKEN_SECONDS = 3600;
export const MAX_GRANTS_PER_USER = 10;
/** New clients per UTC day for the whole deployment. Registration needs no account. */
export const DAILY_CLIENT_REGISTRATIONS = 1000;
/** New clients per UTC day from one network address, so that one caller cannot use up the day. */
export const REGISTRATIONS_PER_ADDRESS = 30;

const REFRESH_DAYS = 30;
const GRANT_DAYS = 90;
const CODE_SECONDS = 300;
const CONSENT_SECONDS = 600;
const MAX_REDIRECT_URIS = 5;
const MAX_URI_LENGTH = 512;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_STATE_LENGTH = 1024;
/**
 * A client that never connected is deleted after this many days. An app keeps its client ID after
 * a denied consent too, so the registration must outlast a user who tries again weeks later.
 */
const UNUSED_CLIENT_DAYS = 30;
/**
 * A client that connected once keeps its registration this long after its last connection: an app
 * caches its client ID and comes back with it. Well above `GRANT_DAYS`, so that an app whose grant
 * ran out still finds its registration.
 */
const IDLE_CLIENT_DAYS = 180;
const DAY_MS = 86_400_000;

const AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"] as const;
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const UUID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PKCE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

const ACCESS_PREFIX = "sm_oat_";
const REFRESH_PREFIX = "sm_ort_";
const CODE_PREFIX = "sm_ac_";
const SECRET_PREFIX = "sm_cs_";
const CLIENT_PREFIX = "smc_";

export interface OAuthError {
  error: string;
  error_description?: string;
}

/** The deployment's issuer: the origin of PUBLIC_URL, or of the request. */
export function oauthIssuer(env: Env, requestUrl: string): string {
  const configured = env.PUBLIC_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // A malformed PUBLIC_URL falls back to the request's origin, as the token page does.
    }
  }
  return new URL(requestUrl).origin;
}

/** The MCP endpoint, the resource that tokens are for. */
export const resourceOf = (issuer: string) => `${issuer}/mcp`;

/**
 * Resource indicators that name this server. A client that read the metadata at the root takes the
 * origin as resource (RFC 9728 3.3); one that read it at `/mcp` takes the endpoint. Both get tokens
 * for the same server.
 */
export const resourcesOf = (issuer: string) => [resourceOf(issuer), issuer];

export const resourceMetadataUrl = (issuer: string) =>
  `${issuer}/.well-known/oauth-protected-resource/mcp`;

export function protectedResourceMetadata(issuer: string, resource: string) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "slotmirror",
  };
}

export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

/** A key of its own: an access token or a consent ticket never passes as a session cookie. */
const oauthSecret = (env: Env) => `${env.SESSION_SECRET}\u0000mcp-oauth`;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

const randomValue = (prefix: string, bytes = 32) =>
  prefix + base64url(crypto.getRandomValues(new Uint8Array(bytes)));

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Loopback hosts for native clients. `[::1]` is left out: a CSP `form-action` cannot name an IPv6
 * literal, so the browser would stop the redirect after the consent form.
 */
function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

/** HTTPS, or HTTP on a loopback address for a native client. No fragment, no user info. */
function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > MAX_URI_LENGTH || uri.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  // The redirect's origin goes into a CSP source on the consent page, which takes only plain host
  // names: letters, digits, dots and hyphens (international names arrive as punycode).
  if (!/^[a-z0-9.-]+$/.test(url.hostname)) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

/**
 * True if the requested redirect is registered. A loopback redirect may use any port (RFC 8252
 * 7.3): a native client picks a free port at run time. Path and query must match.
 */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (!validRedirect(requested)) return false;
  if (registered.includes(requested)) return true;
  const url = new URL(requested);
  if (url.protocol !== "http:" || !isLoopback(url.hostname)) return false;
  return registered.some((entry) => {
    const known = new URL(entry);
    return (
      known.protocol === "http:" &&
      known.hostname === url.hostname &&
      known.pathname === url.pathname &&
      known.search === url.search
    );
  });
}

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  confidential: boolean;
}

export async function findClient(db: D1Database, clientId: string): Promise<OAuthClient | null> {
  if (!clientId.startsWith(CLIENT_PREFIX) || clientId.length > 64) return null;
  const row = await db
    .prepare(
      `SELECT id, name, redirect_uris AS redirectUris, secret_hash AS secretHash
       FROM oauth_clients WHERE id = ?`,
    )
    .bind(clientId)
    .first<{ id: string; name: string; redirectUris: string; secretHash: string | null }>();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    redirectUris: JSON.parse(row.redirectUris) as string[],
    confidential: row.secretHash !== null,
  };
}

/**
 * The counter key of a network address: a keyed hash, so that the table never holds an address.
 * The address comes from Cloudflare's `CF-Connecting-IP`; another hosting adapter passes its own.
 */
export async function addressKey(env: Env, address: string | undefined): Promise<string> {
  return `ip:${await sha256Hex(`${env.SESSION_SECRET}\u0000address\u0000${networkOf(address)}`)}`;
}

/**
 * The network an address counts for. An IPv6 user usually holds a whole /64, so the first four
 * groups count as one address; an IPv4 address counts alone.
 */
function networkOf(address: string | undefined): string {
  const value = (address ?? "").trim().toLowerCase();
  if (!value.includes(":")) return value || "unknown";
  const [head = "", tail] = value.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"),
          ...right,
        ];
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

type Registration =
  | { status: 201; body: Record<string, unknown> }
  | { status: 400 | 429; body: OAuthError };

/**
 * RFC 7591 registration. Anyone may register, so each address and the deployment have a daily
 * limit. A refused request reads two counter rows and writes nothing.
 */
export async function registerClient(
  db: D1Database,
  metadata: unknown,
  address: string,
  now = Date.now(),
): Promise<Registration> {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return { status: 400, body: { error: "invalid_client_metadata" } };
  }
  const input = metadata as Record<string, unknown>;
  const uris = input.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > MAX_REDIRECT_URIS ||
    !uris.every(validRedirect)
  ) {
    return {
      status: 400,
      body: {
        error: "invalid_redirect_uri",
        error_description: "Use 1 to 5 HTTPS or loopback redirect URIs without a fragment.",
      },
    };
  }
  // RFC 7591 2: without a method the client means client_secret_basic.
  const method = input.token_endpoint_auth_method ?? "client_secret_basic";
  const grants = input.grant_types ?? ["authorization_code"];
  const responses = input.response_types ?? ["code"];
  if (
    !(AUTH_METHODS as readonly unknown[]).includes(method) ||
    !Array.isArray(grants) ||
    !grants.every((grant) => GRANT_TYPES.includes(grant as string)) ||
    !Array.isArray(responses) ||
    !responses.every((type) => type === "code")
  ) {
    return { status: 400, body: { error: "invalid_client_metadata" } };
  }
  const day = iso(now).slice(0, 10);
  const counts = await db
    .prepare(
      `SELECT (SELECT count FROM oauth_registrations WHERE key = 'all' AND day = ?1) AS total,
              (SELECT count FROM oauth_registrations WHERE key = ?2 AND day = ?1) AS mine`,
    )
    .bind(day, address)
    .first<{ total: number | null; mine: number | null }>();
  if (
    (counts?.total ?? 0) >= DAILY_CLIENT_REGISTRATIONS ||
    (counts?.mine ?? 0) >= REGISTRATIONS_PER_ADDRESS
  ) {
    return { status: 429, body: { error: "temporarily_unavailable" } };
  }
  const name =
    typeof input.client_name === "string"
      ? input.client_name
          // Control and direction characters could make the name read as something else.
          .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
          .trim()
          .slice(0, MAX_CLIENT_NAME_LENGTH)
      : "";
  const id = randomValue(CLIENT_PREFIX, 16);
  const secret = method === "none" ? null : randomValue(SECRET_PREFIX);
  const count = (key: string) =>
    db
      .prepare(
        `INSERT INTO oauth_registrations (key, day, count) VALUES (?1, ?2, 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN oauth_registrations.day = excluded.day
                        THEN oauth_registrations.count + 1 ELSE 1 END,
           day = excluded.day`,
      )
      .bind(key, day);
  // Parallel registrations can pass the check together; the limits are guards, not quotas.
  await db.batch([
    // Two deletes, each on the index (last_used_at, created_at): one condition with OR would read
    // every client, and anyone can add clients.
    db
      .prepare(
        `DELETE FROM oauth_clients
         WHERE last_used_at IS NULL AND created_at < ?
           AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)
           AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.client_id = oauth_clients.id)`,
      )
      .bind(iso(now - UNUSED_CLIENT_DAYS * DAY_MS)),
    db
      .prepare(
        `DELETE FROM oauth_clients
         WHERE last_used_at < ?
           AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)
           AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.client_id = oauth_clients.id)`,
      )
      .bind(iso(now - IDLE_CLIENT_DAYS * DAY_MS)),
    db.prepare("DELETE FROM oauth_registrations WHERE day < ?").bind(day),
    db
      .prepare(
        "INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris) VALUES (?, ?, ?, ?)",
      )
      .bind(id, secret ? await sha256Hex(secret) : null, name, JSON.stringify(uris)),
    count("all"),
    count(address),
  ]);
  return {
    status: 201,
    body: {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: grants,
      response_types: ["code"],
    },
  };
}

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  state: string | undefined;
}

/**
 * Check an authorization request. An error is shown on this site, never sent to the client's
 * redirect: anyone can register a client, so a redirect for an error would make this endpoint an
 * open redirect (RFC 9700 4.11.2). Only the user's own decision goes back to the client.
 */
export async function checkAuthorizeRequest(
  db: D1Database,
  issuer: string,
  query: Record<string, string | undefined>,
): Promise<{ ok: AuthorizeRequest } | { error: string }> {
  const client = query.client_id ? await findClient(db, query.client_id) : null;
  if (!client) return { error: "invalid_client" };
  const redirectUri =
    query.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
    return { error: "invalid_redirect_uri" };
  }
  if (query.response_type !== "code") return { error: "unsupported_response_type" };
  const state = query.state;
  if (state !== undefined && state.length > MAX_STATE_LENGTH) return { error: "invalid_request" };
  if (query.code_challenge_method !== "S256" || !PKCE_PATTERN.test(query.code_challenge ?? "")) {
    return { error: "invalid_request" };
  }
  const resource = query.resource ?? resourceOf(issuer);
  if (!resourcesOf(issuer).includes(resource)) return { error: "invalid_target" };
  return {
    ok: {
      client,
      redirectUri,
      codeChallenge: query.code_challenge as string,
      resource,
      state,
    },
  };
}

/** The URL that sends the user's decision back to the client, with `iss` (RFC 9207). */
export function clientRedirect(
  redirectUri: string,
  issuer: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", issuer);
  return url.toString();
}

interface ConsentTicket {
  typ: "consent";
  user: string;
  client: string;
  redirect: string;
  challenge: string;
  resource: string;
  state?: string;
  exp: number;
}

/**
 * The consent form carries the checked request as a signed ticket. The POST trusts nothing else:
 * no field can be changed, and the ticket works only for the user it was made for.
 */
export function signConsentTicket(
  env: Env,
  userId: string,
  request: AuthorizeRequest,
  now = Date.now(),
): Promise<string> {
  const ticket: ConsentTicket = {
    typ: "consent",
    user: userId,
    client: request.client.id,
    redirect: request.redirectUri,
    challenge: request.codeChallenge,
    resource: request.resource,
    ...(request.state !== undefined ? { state: request.state } : {}),
    exp: Math.floor(now / 1000) + CONSENT_SECONDS,
  };
  return signPayload(ticket, oauthSecret(env));
}

export async function verifyConsentTicket(
  env: Env,
  value: string | undefined,
  userId: string,
  now = Date.now(),
): Promise<ConsentTicket | null> {
  const ticket = await verifyPayload<ConsentTicket>(value, oauthSecret(env), now);
  return ticket?.typ === "consent" && ticket.user === userId ? ticket : null;
}

/** Holds the authorization request that a visitor must sign in for first. */
export const RESUME_COOKIE = "slotmirror_resume";
export const RESUME_SECONDS = 600;
const RESUME_PREFIX = "/oauth/authorize?";
const resumeSecret = (env: Env) => `${env.SESSION_SECRET}\u0000resume`;

export function signResume(env: Env, path: string, now = Date.now()): Promise<string> {
  const payload: { path: string; exp: number } = {
    path,
    exp: Math.floor(now / 1000) + RESUME_SECONDS,
  };
  return signPayload(payload, resumeSecret(env));
}

/**
 * The path to return to after sign-in, or null. Only a signed path of the authorization endpoint
 * passes, so that the cookie cannot send a user to another site or page.
 */
export async function resumeTarget(
  env: Env,
  value: string | undefined,
  now = Date.now(),
): Promise<string | null> {
  const payload = await verifyPayload<{ path?: unknown; exp: number }>(
    value,
    resumeSecret(env),
    now,
  );
  return resumePath(payload?.path);
}

/**
 * The value if it is a path of the authorization endpoint, else null. A control character would
 * make the Location header throw, and a path over 2000 characters would not fit the cookie.
 */
export function resumePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(RESUME_PREFIX)) return null;
  if (value.length > 2000 || /\p{Cc}/u.test(value)) return null;
  return value;
}

/**
 * A grant is dead once its refresh token or the grant itself expired. Nothing deletes such rows on
 * a timer, so each place that counts or lists grants first removes the user's dead ones.
 */
function deadGrants(db: D1Database, userId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM oauth_grants
       WHERE user_id = ?1 AND (refresh_expires_at <= ?2 OR expires_at <= ?2)`,
    )
    .bind(userId, iso(now));
}

/** Number of apps the user has connected, without the one that asks now. */
export async function otherGrantCount(
  db: D1Database,
  userId: string,
  clientId: string,
  now = Date.now(),
): Promise<number> {
  const [, counted] = await db.batch<{ n: number }>([
    deadGrants(db, userId, now),
    db
      .prepare("SELECT COUNT(*) AS n FROM oauth_grants WHERE user_id = ? AND client_id <> ?")
      .bind(userId, clientId),
  ]);
  return counted?.results[0]?.n ?? 0;
}

/**
 * Store a code for an allowed request and return it. Expired codes go first, and so does an earlier
 * code of the same request: a repeated decision leaves one live code.
 */
export async function issueCode(
  db: D1Database,
  user: SignedInUser,
  ticket: ConsentTicket,
  now = Date.now(),
): Promise<string> {
  const code = randomValue(CODE_PREFIX);
  await db.batch([
    db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").bind(iso(now)),
    db
      .prepare("DELETE FROM oauth_codes WHERE user_id = ? AND client_id = ? AND code_challenge = ?")
      .bind(user.id, ticket.client, ticket.challenge),
    db
      .prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge,
                                  resource, session_version, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await sha256Hex(code),
        ticket.client,
        user.id,
        ticket.redirect,
        ticket.challenge,
        ticket.resource,
        user.sessionVersion,
        iso(now + CODE_SECONDS * 1000),
      ),
  ]);
  return code;
}

export interface AccessTokenClaims {
  grantId: string;
  generation: number;
  audience: string;
  /** Unix ms. */
  expiresAt: number;
}

interface AccessPayload {
  typ: "access";
  grant: string;
  gen: number;
  aud: string;
  exp: number;
}

export async function signAccessToken(env: Env, claims: AccessTokenClaims): Promise<string> {
  const payload: AccessPayload = {
    typ: "access",
    grant: claims.grantId,
    gen: claims.generation,
    aud: claims.audience,
    exp: Math.floor(claims.expiresAt / 1000),
  };
  return ACCESS_PREFIX + (await signPayload(payload, oauthSecret(env)));
}

/** True if the bearer value has the form of an OAuth access token of this server. */
export const isAccessToken = (token: string) => token.startsWith(ACCESS_PREFIX);

async function accessPayload(
  env: Env,
  token: string,
  issuer: string,
  now: number,
): Promise<AccessPayload | null> {
  if (!isAccessToken(token) || token.length > 1024) return null;
  const payload = await verifyPayload<AccessPayload>(
    token.slice(ACCESS_PREFIX.length),
    oauthSecret(env),
    now,
  );
  return payload?.typ === "access" &&
    typeof payload.grant === "string" &&
    resourcesOf(issuer).includes(payload.aud)
    ? payload
    : null;
}

/**
 * The user of an access token, or null. The token must be signed by this deployment, unexpired,
 * meant for this server, and its grant must still exist. `loadUser` checks the policy and the
 * session version, as for personal tokens.
 */
export async function authenticateAccessToken(
  env: Env,
  token: string,
  issuer: string,
  now = Date.now(),
): Promise<SignedInUser | null> {
  const payload = await accessPayload(env, token, issuer, now);
  if (!payload) return null;
  const grant = await env.DB.prepare(
    `SELECT user_id AS userId, session_version AS sessionVersion, generation,
            expires_at AS expiresAt
     FROM oauth_grants WHERE id = ?`,
  )
    .bind(payload.grant)
    .first<{ userId: string; sessionVersion: number; generation: number; expiresAt: string }>();
  // The generation is not checked: another instance of the same app may hold the access token of
  // an earlier refresh, and it lasts one hour. Ending the grant ends every token at once.
  if (!grant || Date.parse(grant.expiresAt) <= now) return null;
  return loadUser(env, grant.userId, grant.sessionVersion);
}

type TokenResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 401; body: OAuthError };

const fail = (error: string, status: 400 | 401 = 400): TokenResult => ({ status, body: { error } });

/** A value of the Basic header: form-encoded, so `+` is a space (RFC 6749 2.3.1). */
function formDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return null;
  }
}

/**
 * The client of a token or revocation request. A confidential client must show its secret, in
 * the Basic header or in the form. A public client names itself with `client_id`.
 */
export async function authenticateClient(
  db: D1Database,
  form: Record<string, string>,
  authorization: string | undefined,
): Promise<OAuthClient | null> {
  let id = form.client_id;
  let secret = form.client_secret;
  const basic = /^basic +(\S+)$/i.exec(authorization ?? "")?.[1];
  if (basic) {
    let decoded: string;
    try {
      decoded = atob(basic);
    } catch {
      return null;
    }
    const split = decoded.indexOf(":");
    if (split < 0) return null;
    const basicId = formDecode(decoded.slice(0, split));
    const basicSecret = formDecode(decoded.slice(split + 1));
    if (basicId === null || basicSecret === null) return null;
    if (id !== undefined && id !== basicId) return null;
    id = basicId;
    secret = basicSecret;
  }
  if (!id) return null;
  const client = await findClient(db, id);
  if (!client) return null;
  if (!client.confidential) return client;
  if (!secret) return null;
  const row = await db
    .prepare("SELECT 1 AS ok FROM oauth_clients WHERE id = ? AND secret_hash = ?")
    .bind(client.id, await sha256Hex(secret))
    .first();
  return row ? client : null;
}

async function tokenResponse(
  env: Env,
  grant: { id: string; generation: number; resource: string },
  refreshToken: string,
  now: number,
): Promise<TokenResult> {
  return {
    status: 200,
    body: {
      access_token: await signAccessToken(env, {
        grantId: grant.id,
        generation: grant.generation,
        audience: grant.resource,
        expiresAt: now + ACCESS_TOKEN_SECONDS * 1000,
      }),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
      scope: OAUTH_SCOPE,
    },
  };
}

/**
 * Grant type `authorization_code`. A code works once: a failed attempt uses it up too. A code that
 * comes back after its exchange was copied, so the grant it gave ends (RFC 6749 4.1.2).
 */
export async function exchangeCode(
  env: Env,
  issuer: string,
  client: OAuthClient,
  form: Record<string, string>,
  now = Date.now(),
): Promise<TokenResult> {
  // OAuth 2.1 lets a client leave out redirect_uri if it registered only one.
  const redirectUri =
    form.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!form.code || !redirectUri || !form.code_verifier) return fail("invalid_request");
  if (form.resource !== undefined && !resourcesOf(issuer).includes(form.resource)) {
    return fail("invalid_target");
  }
  const codeHash = await sha256Hex(form.code);
  const row = await env.DB.prepare(
    `DELETE FROM oauth_codes WHERE code_hash = ?
     RETURNING client_id AS clientId, user_id AS userId, redirect_uri AS redirectUri,
               code_challenge AS challenge, resource, session_version AS sessionVersion,
               expires_at AS expiresAt`,
  )
    .bind(codeHash)
    .first<{
      clientId: string;
      userId: string;
      redirectUri: string;
      challenge: string;
      resource: string;
      sessionVersion: number;
      expiresAt: string;
    }>();
  if (!row) {
    const ended = await env.DB.prepare(
      "DELETE FROM oauth_grants WHERE code_hash = ? RETURNING id, user_id AS userId",
    )
      .bind(codeHash)
      .first<{ id: string; userId: string }>();
    if (ended) await auditEnded(env.DB, ended.userId, { grantId: ended.id, reason: "code_reuse" });
    return fail("invalid_grant");
  }
  if (
    row.clientId !== client.id ||
    Date.parse(row.expiresAt) <= now ||
    row.redirectUri !== redirectUri ||
    (form.resource !== undefined && form.resource !== row.resource) ||
    !PKCE_PATTERN.test(form.code_verifier) ||
    (await sha256Base64url(form.code_verifier)) !== row.challenge
  ) {
    return fail("invalid_grant");
  }
  // The org may have turned MCP off for members since the consent.
  const user = await loadUser(env, row.userId, row.sessionVersion);
  if (!user || !can(user, "apps:connect")) return fail("invalid_grant");

  const grantId = crypto.randomUUID();
  const refreshExpires = now + REFRESH_DAYS * DAY_MS;
  const refreshToken = await signRefreshToken(env, grantId, 0, refreshExpires);
  // One grant per user and client: a new authorization replaces the old one. The insert checks
  // the session version and the number of live grants in the same statement.
  const [, replaced, inserted] = await env.DB.batch([
    deadGrants(env.DB, user.id, now),
    // The old grant of this app goes only if the new one fits, so a refused insert leaves it.
    env.DB.prepare(
      `DELETE FROM oauth_grants WHERE user_id = ?1 AND client_id = ?2
         AND (SELECT COUNT(*) FROM oauth_grants g WHERE g.user_id = ?1 AND g.client_id <> ?2) < ?3`,
    ).bind(user.id, client.id, MAX_GRANTS_PER_USER),
    env.DB.prepare(
      `INSERT INTO oauth_grants (id, client_id, user_id, scope, resource, session_version,
                                 refresh_hash, code_hash, refresh_expires_at, expires_at)
       SELECT ?, ?, u.id, ?, ?, u.session_version, ?, ?, ?, ? FROM users u
       WHERE u.id = ? AND u.session_version = ?
         AND (SELECT COUNT(*) FROM oauth_grants g WHERE g.user_id = u.id) < ?`,
    ).bind(
      grantId,
      client.id,
      OAUTH_SCOPE,
      row.resource,
      await sha256Hex(refreshToken),
      codeHash,
      iso(refreshExpires),
      iso(now + GRANT_DAYS * DAY_MS),
      user.id,
      row.sessionVersion,
      MAX_GRANTS_PER_USER,
    ),
    // The app counts as used only if its grant was made: `changes()` is the insert's count.
    env.DB.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE id = ? AND changes() > 0").bind(
      iso(now),
      client.id,
    ),
  ]);
  if (!inserted?.meta.changes) return fail("invalid_grant");
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: "mcp_app_connected",
    detail: { grantId, replaced: (replaced?.meta.changes ?? 0) > 0 },
  });
  return tokenResponse(
    env,
    { id: grantId, generation: 0, resource: row.resource },
    refreshToken,
    now,
  );
}

async function auditEnded(
  db: D1Database,
  userId: string,
  detail: Record<string, string | number>,
): Promise<void> {
  const user = await db
    .prepare("SELECT org_id AS orgId FROM users WHERE id = ?")
    .bind(userId)
    .first<{ orgId: string }>();
  if (!user) return;
  await recordAudit(db, { orgId: user.orgId, userId, kind: "mcp_app_disconnected", detail });
}

interface RefreshPayload {
  typ: "refresh";
  grant: string;
  gen: number;
  nonce: string;
  exp: number;
}

/**
 * A refresh token names its grant and generation, signed. So any older token of a grant, not only
 * the one before the current, shows that someone copied it, and a forged token can name no grant.
 */
async function signRefreshToken(
  env: Env,
  grantId: string,
  generation: number,
  expiresAt: number,
): Promise<string> {
  const payload: RefreshPayload = {
    typ: "refresh",
    grant: grantId,
    gen: generation,
    nonce: base64url(crypto.getRandomValues(new Uint8Array(16))),
    exp: Math.floor(expiresAt / 1000),
  };
  return REFRESH_PREFIX + (await signPayload(payload, oauthSecret(env)));
}

async function refreshPayload(
  env: Env,
  token: string,
  now: number,
): Promise<RefreshPayload | null> {
  if (!token.startsWith(REFRESH_PREFIX) || token.length > 1024) return null;
  const payload = await verifyPayload<RefreshPayload>(
    token.slice(REFRESH_PREFIX.length),
    oauthSecret(env),
    now,
  );
  return payload?.typ === "refresh" &&
    typeof payload.grant === "string" &&
    typeof payload.gen === "number"
    ? payload
    : null;
}

/** Two refreshes with the same token can race; the loser's token is not a copy within this time. */
const REFRESH_RACE_MS = 30_000;

/**
 * Grant type `refresh_token`, with rotation. An older refresh token of the grant was copied: the
 * whole grant ends (OAuth 2.0 Security BCP, RFC 9700 4.14). Only the token just before the current
 * one gets 30 seconds of grace, for two refreshes that raced. A client whose answer to a refresh
 * got lost for longer must connect again.
 */
export async function refreshGrant(
  env: Env,
  issuer: string,
  client: OAuthClient,
  form: Record<string, string>,
  now = Date.now(),
): Promise<TokenResult> {
  if (!form.refresh_token) return fail("invalid_request");
  if (form.resource !== undefined && !resourcesOf(issuer).includes(form.resource)) {
    return fail("invalid_target");
  }
  const payload = await refreshPayload(env, form.refresh_token, now);
  if (!payload) return fail("invalid_grant");
  const grant = await env.DB.prepare(
    `SELECT id, client_id AS clientId, user_id AS userId, session_version AS sessionVersion,
            generation, resource, refresh_hash AS refreshHash, refreshed_at AS refreshedAt,
            refresh_expires_at AS refreshExpiresAt, expires_at AS expiresAt
     FROM oauth_grants WHERE id = ?`,
  )
    .bind(payload.grant)
    .first<{
      id: string;
      clientId: string;
      userId: string;
      sessionVersion: number;
      generation: number;
      resource: string;
      refreshHash: string;
      refreshedAt: string | null;
      refreshExpiresAt: string;
      expiresAt: string;
    }>();
  // A token of another client proves nothing about the grant, so it ends nothing.
  if (!grant || grant.clientId !== client.id) return fail("invalid_grant");
  const current =
    payload.gen === grant.generation && (await sha256Hex(form.refresh_token)) === grant.refreshHash;
  if (!current) {
    const raced =
      payload.gen === grant.generation - 1 &&
      grant.refreshedAt !== null &&
      now - Date.parse(grant.refreshedAt) < REFRESH_RACE_MS;
    if (payload.gen < grant.generation && !raced) {
      await env.DB.prepare("DELETE FROM oauth_grants WHERE id = ?").bind(grant.id).run();
      await auditEnded(env.DB, grant.userId, { grantId: grant.id, reason: "refresh_reuse" });
    }
    return fail("invalid_grant");
  }
  if (Date.parse(grant.refreshExpiresAt) <= now || Date.parse(grant.expiresAt) <= now) {
    await env.DB.prepare("DELETE FROM oauth_grants WHERE id = ?").bind(grant.id).run();
    return fail("invalid_grant");
  }
  // While the policy or the org's MCP setting does not admit the user, the grant stops but stays,
  // as a personal token does.
  const user = await loadUser(env, grant.userId, grant.sessionVersion);
  if (!user || !can(user, "apps:connect")) return fail("invalid_grant");
  const refreshExpires = Math.min(now + REFRESH_DAYS * DAY_MS, Date.parse(grant.expiresAt));
  const refreshToken = await signRefreshToken(env, grant.id, grant.generation + 1, refreshExpires);
  const rotated = await env.DB.prepare(
    `UPDATE oauth_grants
     SET refresh_hash = ?, generation = generation + 1, refreshed_at = ?, refresh_expires_at = ?
     WHERE id = ? AND generation = ?`,
  )
    .bind(await sha256Hex(refreshToken), iso(now), iso(refreshExpires), grant.id, grant.generation)
    .run();
  // Two refreshes with the same token raced; the other one won.
  if (!rotated.meta.changes) return fail("invalid_grant");
  return tokenResponse(
    env,
    { id: grant.id, generation: grant.generation + 1, resource: grant.resource },
    refreshToken,
    now,
  );
}

/**
 * RFC 7009 revocation of a refresh or access token of the client. The answer is the same whether
 * the token was known or not, so that it tells a caller nothing.
 */
export async function revokeToken(
  env: Env,
  issuer: string,
  client: OAuthClient,
  token: string | undefined,
  now = Date.now(),
): Promise<void> {
  if (!token || token.length > 1024) return;
  let grantId: string | undefined;
  if (isAccessToken(token)) {
    grantId = (await accessPayload(env, token, issuer, now))?.grant;
  } else {
    grantId = (await refreshPayload(env, token, now))?.grant;
  }
  if (!grantId) return;
  const ended = await env.DB.prepare(
    "DELETE FROM oauth_grants WHERE id = ? AND client_id = ? RETURNING user_id AS userId",
  )
    .bind(grantId, client.id)
    .first<{ userId: string }>();
  if (ended) await auditEnded(env.DB, ended.userId, { grantId, by: "client" });
}

export interface ConnectedApp {
  id: string;
  name: string;
  createdAt: string;
  refreshedAt: string | null;
}

export async function listConnectedApps(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<ConnectedApp[]> {
  const [, listed] = await db.batch<ConnectedApp>([
    deadGrants(db, userId, now),
    db
      .prepare(
        `SELECT g.id, c.name, g.created_at AS createdAt, g.refreshed_at AS refreshedAt
         FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
         WHERE g.user_id = ? ORDER BY g.created_at DESC LIMIT ?`,
      )
      .bind(userId, MAX_GRANTS_PER_USER),
  ]);
  return listed?.results ?? [];
}

/** End one connection of the user. Return false if the user has no such grant. */
export async function disconnectApp(
  env: Env,
  user: { id: string; orgId: string },
  grantId: string,
): Promise<boolean> {
  // The ID comes from the URL. Only a real ID may reach the audit log.
  if (!UUID_PATTERN.test(grantId)) return false;
  const deleted = await env.DB.prepare("DELETE FROM oauth_grants WHERE id = ? AND user_id = ?")
    .bind(grantId, user.id)
    .run();
  if (!deleted.meta.changes) return false;
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: "mcp_app_disconnected",
    detail: { grantId },
  });
  return true;
}

/** End every connection of a user, with its codes. Returns the number of grants ended. */
export async function disconnectUserApps(db: D1Database, userId: string): Promise<number> {
  const [grants] = await db.batch([
    db.prepare("DELETE FROM oauth_grants WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM oauth_codes WHERE user_id = ?").bind(userId),
  ]);
  return grants?.meta.changes ?? 0;
}
