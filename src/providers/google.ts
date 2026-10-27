import * as z from "zod/mini";
import { idTokenPayload, requestToken, type Identity, type TokenResponse } from "./oauth-token";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const SIGN_IN_SCOPES = ["openid", "email", "profile"];
export const CONNECT_SCOPES = [
  ...SIGN_IN_SCOPES,
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  /** Address to preselect, e.g. the account to connect again. URLSearchParams encodes it. */
  loginHint?: string;
  /** Connecting needs a refresh token; Google only returns one with offline access and consent. */
  offline: boolean;
}

export function authorizeUrl(params: AuthorizeParams): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: params.clientId,
    response_type: "code",
    redirect_uri: params.redirectUri,
    scope: params.scopes.join(" "),
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
    ...(params.offline
      ? { access_type: "offline", prompt: "consent" }
      : { prompt: "select_account" }),
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

export function exchangeCode(params: ExchangeParams): Promise<TokenResponse> {
  return requestToken(TOKEN_URL, {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
    code: params.code,
    code_verifier: params.codeVerifier,
  });
}

/** Google keeps the refresh token unless it is revoked; the response usually carries none. */
export function refreshToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  return requestToken(TOKEN_URL, {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  });
}

const idTokenClaimsSchema = z.object({
  sub: z.string(),
  email: z.string(),
  email_verified: z.optional(z.boolean()),
});

/** Read the identity from a Google ID token. Unverified addresses are refused. */
export function identityFromIdToken(idToken: string): Identity {
  const claims = idTokenClaimsSchema.parse(idTokenPayload(idToken));
  if (claims.email_verified !== true) throw new Error("Google address is not verified");
  return { email: claims.email.toLowerCase(), tenantId: null };
}
