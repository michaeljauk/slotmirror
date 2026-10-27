import type { Provider } from "../config";
import * as google from "./google";
import * as microsoft from "./microsoft";
import type { Identity, TokenResponse } from "./oauth-token";

/** One OAuth adapter per provider, so that routes and the Durable Object stay provider-neutral. */
export interface OAuthClient {
  authorizeUrl(params: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    purpose: "sign-in" | "connect";
    loginHint?: string;
  }): string;
  exchangeCode(params: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  }): Promise<TokenResponse>;
  refreshToken(params: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<TokenResponse>;
  identity(tokens: TokenResponse): Identity;
}

const CLIENTS: Record<Provider, OAuthClient> = {
  microsoft: {
    authorizeUrl: ({ purpose, ...params }) =>
      microsoft.authorizeUrl({
        ...params,
        scopes: purpose === "sign-in" ? microsoft.SIGN_IN_SCOPES : microsoft.CONNECT_SCOPES,
      }),
    exchangeCode: microsoft.exchangeCode,
    refreshToken: microsoft.refreshToken,
    identity: (tokens) => microsoft.identityFromIdToken(requireIdToken(tokens)),
  },
  google: {
    authorizeUrl: ({ purpose, ...params }) =>
      google.authorizeUrl({
        ...params,
        scopes: purpose === "sign-in" ? google.SIGN_IN_SCOPES : google.CONNECT_SCOPES,
        offline: purpose === "connect",
      }),
    exchangeCode: google.exchangeCode,
    refreshToken: google.refreshToken,
    identity: (tokens) => google.identityFromIdToken(requireIdToken(tokens)),
  },
};

export function oauthClient(provider: Provider): OAuthClient {
  return CLIENTS[provider];
}

/** Client ID and secret of the deployment's app registration for a provider. */
export function clientCredentials(env: Env, provider: Provider) {
  return provider === "microsoft"
    ? { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET }
    : { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

function requireIdToken(tokens: TokenResponse): string {
  if (!tokens.id_token) throw new Error("Token response carries no ID token");
  return tokens.id_token;
}
