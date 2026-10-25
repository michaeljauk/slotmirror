import * as z from "zod/mini";
import { fromBase64url } from "../session";

/** `common` accepts work accounts from any tenant and personal Microsoft accounts. */
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";

export const SIGN_IN_SCOPES = ["openid", "email", "profile"];
export const CONNECT_SCOPES = [
  ...SIGN_IN_SCOPES,
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
];

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}

export function authorizeUrl(params: AuthorizeParams): string {
  const url = new URL(`${AUTHORITY}/authorize`);
  url.search = new URLSearchParams({
    client_id: params.clientId,
    response_type: "code",
    redirect_uri: params.redirectUri,
    response_mode: "query",
    scope: params.scopes.join(" "),
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  id_token: z.optional(z.string()),
  refresh_token: z.optional(z.string()),
  scope: z.optional(z.string()),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.optional(z.string()),
});

export class TokenError extends Error {
  constructor(
    readonly code: string,
    description: string | undefined,
  ) {
    super(description ? `${code}: ${description}` : code);
  }
}

export interface ExchangeParams {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

export async function exchangeCode(params: ExchangeParams): Promise<TokenResponse> {
  return requestToken({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
    code: params.code,
    code_verifier: params.codeVerifier,
  });
}

export interface RefreshParams {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Get a new access token. Microsoft returns a new refresh token, which the caller must store. */
export async function refreshToken(params: RefreshParams): Promise<TokenResponse> {
  return requestToken({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    scope: CONNECT_SCOPES.join(" "),
  });
}

async function requestToken(form: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = tokenErrorSchema.safeParse(body);
    throw error.success
      ? new TokenError(error.data.error, error.data.error_description)
      : new TokenError(`http_${response.status}`, undefined);
  }
  return tokenResponseSchema.parse(body);
}

const idTokenClaimsSchema = z.object({
  tid: z.string(),
  oid: z.string(),
  email: z.optional(z.string()),
  preferred_username: z.optional(z.string()),
});

export interface Identity {
  email: string;
  tenantId: string;
  objectId: string;
}

/**
 * Read the identity from an ID token.
 *
 * The signature is not checked: the token comes straight from the token endpoint over TLS in
 * exchange for our client secret (OpenID Connect Core 1.0, section 3.1.3.7).
 */
export function identityFromIdToken(idToken: string): Identity {
  const [, payload] = idToken.split(".");
  if (!payload) throw new Error("Malformed ID token");
  const claims = idTokenClaimsSchema.parse(
    JSON.parse(new TextDecoder().decode(fromBase64url(payload))),
  );
  // Work accounts often have no `email` claim; `preferred_username` holds the sign-in name.
  const email = (claims.email ?? claims.preferred_username ?? "").toLowerCase();
  if (!email) throw new Error("ID token carries no email or preferred_username");
  return { email, tenantId: claims.tid, objectId: claims.oid };
}
