import { base64url, signPayload, verifyPayload } from "./session";
import type { Provider } from "./config";

export const OAUTH_COOKIE = "slotmirror_oauth";
const OAUTH_TTL_SECONDS = 10 * 60;

/** `sign-in` creates a session; `connect` adds a calendar account for a signed-in owner. */
export type OAuthPurpose = "sign-in" | "connect";

/** Kept in a signed cookie between the redirect to the provider and the callback. */
export interface OAuthState {
  provider: Provider;
  purpose: OAuthPurpose;
  state: string;
  codeVerifier: string;
  exp: number;
}

export async function createOAuthState(
  provider: Provider,
  purpose: OAuthPurpose,
  secret: string,
): Promise<{ cookie: string; state: string; codeChallenge: string }> {
  const payload: OAuthState = {
    provider,
    purpose,
    state: randomToken(),
    codeVerifier: randomToken(),
    exp: Math.floor(Date.now() / 1000) + OAUTH_TTL_SECONDS,
  };
  return {
    cookie: await signPayload(payload, secret),
    state: payload.state,
    codeChallenge: await codeChallenge(payload.codeVerifier),
  };
}

/** Return the stored state if the cookie is valid and matches the callback, otherwise null. */
export async function checkOAuthState(
  cookie: string | undefined,
  provider: Provider,
  returnedState: string | undefined,
  secret: string,
): Promise<OAuthState | null> {
  const stored = await verifyPayload<OAuthState>(cookie, secret);
  if (!stored || stored.provider !== provider || !returnedState) return null;
  return timingSafeEqual(stored.state, returnedState) ? stored : null;
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
