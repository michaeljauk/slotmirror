const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** A token of 128 random bits, base64url without padding: always 22 characters. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** The stored form of a token. Tokens have 128 random bits, so a plain hash is enough. */
export function hashToken(token: string): Promise<string> {
  return sha256Hex(`token:${token}`);
}

/**
 * Rate-limit key for an IP address. The pepper is a secret, so the small IPv4 space cannot be
 * enumerated to recover an address. IPv6 addresses count per /64 network.
 */
export function ipKey(ip: string, pepper: string): Promise<string> {
  return sha256Hex(`ip:${pepper}:${ipNetwork(ip)}`);
}

export function ipNetwork(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.toLowerCase().split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const fill =
    tail === undefined
      ? []
      : Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0");
  return [...headGroups, ...fill, ...tailGroups].slice(0, 4).join(":");
}
