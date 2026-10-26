/**
 * Signed cookies: `base64url(payload).base64url(hmac)`. No server-side store.
 * Used for the session and for the short-lived OAuth state.
 */

export const SESSION_COOKIE = "slotmirror_session";
/** Twelve hours: a working day. Signing in again is one click with the provider. */
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

export interface Session {
  userId: string;
  /** Expiry as Unix seconds. */
  exp: number;
}

export function signSession(session: Session, secret: string): Promise<string> {
  return signPayload(session, secret);
}

/** Return the session if the signature is valid and it has not expired, otherwise null. */
export async function verifySession(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<Session | null> {
  const session = await verifyPayload<Session>(token, secret, now);
  return session && typeof session.userId === "string" ? session : null;
}

/** Sign any JSON payload that carries an `exp` in Unix seconds. */
export async function signPayload(payload: { exp: number }, secret: string): Promise<string> {
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

/** Return the payload if the signature is valid and `exp` lies in the future, otherwise null. */
export async function verifyPayload<T extends { exp: number }>(
  token: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<T | null> {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64url(signature),
      new TextEncoder().encode(body),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T;
    return typeof payload.exp === "number" && payload.exp * 1000 > now ? payload : null;
  } catch {
    return null;
  }
}

/** Imported keys per secret. Importing on every request costs CPU on the Free plan's 10 ms budget. */
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    hmacKeys.set(secret, key);
  }
  return key;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
