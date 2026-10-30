import type { WaitlistEnv } from "./env";

export type ProblemCode =
  | "invalid_request"
  | "invalid_email"
  | "origin_not_allowed"
  | "turnstile_failed"
  | "rate_limited"
  | "mail_unavailable"
  | "storage_unavailable"
  | "server_misconfigured";

const TITLES: Record<ProblemCode, string> = {
  invalid_request: "The request is not valid.",
  invalid_email: "The email address is not valid.",
  origin_not_allowed: "This origin may not use the waitlist.",
  turnstile_failed: "The human check failed. Try again.",
  rate_limited: "Too many attempts. Try again later.",
  mail_unavailable: "We cannot send the mail now. Try again later.",
  storage_unavailable: "The waitlist is not available now. Try again later.",
  server_misconfigured: "The waitlist is not set up.",
};

/** An RFC 9457 problem response with a stable `code`. */
export function problem(
  status: number,
  code: ProblemCode,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ type: `about:blank`, title: TITLES[code], status, code }), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

export function allowedOrigins(env: WaitlistEnv): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** The hosts Turnstile may report: the allowed origins and this Worker. */
export function allowedHostnames(env: WaitlistEnv): string[] {
  const hosts = [...allowedOrigins(env), env.PUBLIC_URL].flatMap((value) => {
    try {
      return [new URL(value).hostname];
    } catch {
      return [];
    }
  });
  return [...new Set(hosts)];
}

/** CORS headers for an allowed origin. A missing or unknown origin gets none. */
export function corsHeaders(request: Request, env: WaitlistEnv): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = { vary: "Origin" };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}
