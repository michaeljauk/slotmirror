import { allowedHostnames } from "./http";
import type { WaitlistEnv } from "./env";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Turnstile token. Every sign-up needs a fresh token. The reported hostname must be one
 * of the allowed hosts, because the form on slotmirror.com posts to slotmirror.app. A missing
 * hostname fails. Only local development with TURNSTILE_ALLOW_LOCALHOST=true accepts a missing
 * hostname or "localhost", which the Turnstile test keys report.
 */
export async function verifyTurnstile(
  env: WaitlistEnv,
  token: unknown,
  ip: string | null,
): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip) body.set("remoteip", ip);
  try {
    const response = await fetch(VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: boolean; hostname?: string };
    if (result.success !== true) return false;
    if (!result.hostname) return env.TURNSTILE_ALLOW_LOCALHOST === "true";
    if (env.TURNSTILE_ALLOW_LOCALHOST === "true" && result.hostname === "localhost") return true;
    return allowedHostnames(env).includes(result.hostname);
  } catch {
    return false;
  }
}
