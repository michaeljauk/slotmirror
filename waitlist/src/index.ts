import { corsHeaders } from "./http";
import type { WaitlistEnv } from "./env";
import { handleLink } from "./links";
import { RATE_RETENTION_HOURS, RATE_WINDOW_MS } from "./ratelimit";
import { handleSignup } from "./signup";

export async function handle(request: Request, env: WaitlistEnv): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/signup") {
    if (request.method === "OPTIONS") {
      const cors = corsHeaders(request, env);
      if (!cors["access-control-allow-origin"]) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    return handleSignup(request, env);
  }

  if (pathname === "/confirm" || pathname === "/unsubscribe") {
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    return handleLink(request, env, pathname === "/confirm" ? "confirm" : "unsubscribe");
  }

  return new Response("Not found", { status: 404 });
}

/** Daily cleanup: expired unconfirmed entries, old counters, and entries past the retention date. */
export async function cleanup(env: WaitlistEnv, now = Date.now()): Promise<void> {
  const statements = [
    env.DB.prepare(
      "DELETE FROM subscribers WHERE confirmed_at IS NULL AND confirm_expires_at < ?",
    ).bind(now),
    env.DB.prepare("DELETE FROM rate_hits WHERE window < ?").bind(
      Math.floor(now / RATE_WINDOW_MS) - RATE_RETENTION_HOURS,
    ),
    env.DB.prepare("DELETE FROM mail_counter WHERE day < ?").bind(
      new Date(now - 30 * 86_400_000).toISOString().slice(0, 10),
    ),
  ];
  const until = env.RETENTION_UNTIL;
  if (until && new Date(now).toISOString().slice(0, 10) > until) {
    statements.push(env.DB.prepare("DELETE FROM subscribers"));
  }
  await env.DB.batch(statements);
}

export default {
  fetch: (request: Request, env: WaitlistEnv) => handle(request, env),
  scheduled: (_controller: ScheduledController, env: WaitlistEnv, ctx: ExecutionContext) => {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<WaitlistEnv>;
