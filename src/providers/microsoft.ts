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
});

/** Read the identity from a Microsoft ID token. */
export function identityFromIdToken(idToken: string): Identity & { tenantId: string } {
  const claims = idTokenClaimsSchema.parse(idTokenPayload(idToken));
  // Work accounts often have no `email` claim; `preferred_username` holds the sign-in name.
  const email = (claims.email ?? claims.preferred_username ?? "").toLowerCase();
  if (!email) throw new Error("ID token carries no email or preferred_username");
  return { email, tenantId: claims.tid };
}
