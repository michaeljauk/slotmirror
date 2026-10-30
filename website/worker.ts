// Cloudflare Worker in front of the static website. It does one job: it forwards the PostHog
// event path /ingest/e/ to PostHog EU, so the browser only talks to the own domain.
// Every other request goes to the static assets (see "run_worker_first" in wrangler.jsonc).
// worker.ts is not part of the Astro type check: the Cloudflare types are not installed in the
// website package. Wrangler bundles it with esbuild, which does not check types.

const API_HOST = "eu.i.posthog.com";
const PREFIX = "/ingest";
// The only call posthog-js makes with the settings in src/scripts/analytics.ts: POST /e/.
// Feature flags, session replay, surveys and external scripts are off.
const ALLOWED_PATHS = new Set(["/e/"]);
// Headers sent to PostHog. PostHog reads the body type, and the User-Agent goes into the daily
// visitor hash. Everything else, including cookies and authorisation, is dropped.
const FORWARDED_HEADERS = ["content-type", "content-encoding", "user-agent"];

interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
      return env.ASSETS.fetch(request);
    }

    const path = url.pathname.slice(PREFIX.length) || "/";
    if (request.method !== "POST" || !ALLOWED_PATHS.has(path)) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    // PostHog needs the visitor IP to build the daily cookieless visitor hash. Without it, every
    // visitor looks like one Cloudflare address. The project setting "Discard client IP data"
    // makes PostHog drop the IP after it has built the hash.
    headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? "");

    return fetch(`https://${API_HOST}${path}${url.search}`, {
      method: "POST",
      headers,
      body: request.body,
      redirect: "manual",
    });
  },
} satisfies ExportedHandler<Env>;
