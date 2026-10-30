// Cloudflare Worker in front of the static website. It does one job: it forwards the PostHog
// ingestion path /ingest/* to PostHog EU, so the browser only talks to the own domain.
// Every other request goes to the static assets (see "run_worker_first" in wrangler.jsonc).

const API_HOST = "eu.i.posthog.com";
const ASSET_HOST = "eu-assets.i.posthog.com";
const PREFIX = "/ingest";

interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
      return env.ASSETS.fetch(request);
    }

    const path = url.pathname.slice(PREFIX.length) || "/";
    if (path.startsWith("/static/") || path.startsWith("/array/")) {
      const cached = await caches.default.match(request);
      if (cached) return cached;
      const response = await fetch(`https://${ASSET_HOST}${path}${url.search}`);
      if (response.ok) ctx.waitUntil(caches.default.put(request, response.clone()));
      return response;
    }

    const headers = new Headers(request.headers);
    // PostHog needs the visitor IP to build the daily cookieless visitor hash. Without it, every
    // visitor looks like one Cloudflare address. The project setting "Discard client IP data"
    // makes PostHog drop the IP after it has built the hash.
    headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? "");
    for (const name of ["cookie", "cf-connecting-ip", "cf-ray", "cf-ipcountry"]) {
      headers.delete(name);
    }
    // The browser sends no credentials. Keep only the project token form, drop anything else.
    if (!headers.get("authorization")?.startsWith("Bearer phc_")) headers.delete("authorization");

    return fetch(`https://${API_HOST}${path}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      redirect: "manual",
    });
  },
} satisfies ExportedHandler<Env>;
