import * as z from "zod/mini";
import { idTokenPayload, requestToken, type Identity, type TokenResponse } from "./oauth-token";

export { TokenError, type Identity, type TokenResponse } from "./oauth-token";

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
  /** Address to preselect, e.g. the account to connect again. URLSearchParams encodes it. */
  loginHint?: string;
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
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
  }).toString();
  return url.toString();
}

export interface ExchangeParams {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

export async function exchangeCode(params: ExchangeParams): Promise<TokenResponse> {
  return requestToken(`${AUTHORITY}/token`, {
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
  return requestToken(`${AUTHORITY}/token`, {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    scope: CONNECT_SCOPES.join(" "),
  });
}

const idTokenClaimsSchema = z.object({
  tid: z.string(),
  oid: z.string(),
  email: z.optional(z.string()),
  preferred_username: z.optional(z.string()),
  /** Optional claim: true if the user's own tenant verified the domain of `email`. */
  xms_edov: z.optional(z.unknown()),
});

/**
 * Read the identity from a Microsoft ID token.
 *
 * The `email` claim counts as verified only if `xms_edov` says so. App registrations send
 * `xms_edov` only if it is added as an optional claim. `preferred_username` is verified: for a
 * work account it is the UPN, whose domain the tenant `tid` must have verified.
 */
export function identityFromIdToken(idToken: string): Identity & { tenantId: string } {
  const claims = idTokenClaimsSchema.parse(idTokenPayload(idToken));
  const edov = claims.xms_edov;
  const edovTrue = edov === true || edov === "true" || edov === "1";
  const email = claims.email?.trim().toLowerCase() || undefined;
  const username = claims.preferred_username?.trim().toLowerCase() || undefined;
  const addresses = [
    ...new Set([...(edovTrue && email ? [email] : []), ...(username ? [username] : [])]),
  ];
  const [first] = addresses;
  if (!first) throw new Error("ID token carries no verified email and no preferred_username");
  return {
    provider: "microsoft",
    email: first,
    tenantId: claims.tid,
    subject: claims.oid,
    addresses,
    ...(email && !edovTrue ? { unverifiedEmail: email } : {}),
  };
}
