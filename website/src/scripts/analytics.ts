// Privacy-first product analytics for the website only. PostHog EU, no cookies, no autocapture,
// no session replay. The project key comes from the build variable PUBLIC_POSTHOG_KEY. Without
// the key this file does nothing and the site works as before.
//
// Exactly three custom events exist. Each one hangs on an element with a data-track attribute:
//   deploy_click          the "Deploy to Cloudflare" buttons
//   waitlist_submit       the waitlist form (submit)
//   suite_to_quickstart   the quickstart link on the test-suite page
// Plus the standard $pageview, which replaces Cloudflare Web Analytics.

const EVENTS = ["deploy_click", "waitlist_submit", "suite_to_quickstart"] as const;
type TrackedEvent = (typeof EVENTS)[number];

const key = import.meta.env.PUBLIC_POSTHOG_KEY as string | undefined;
// A path on the own domain. The Worker in website/worker.ts forwards it to PostHog EU.
const host = (import.meta.env.PUBLIC_POSTHOG_HOST as string | undefined) || "/ingest";

type Properties = Record<string, unknown>;

// Query strings and fragments can carry tokens. They never leave the browser.
function stripUrl(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value, location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/)[0];
  }
}

function isTracked(name: string | undefined): name is TrackedEvent {
  return EVENTS.includes(name as TrackedEvent);
}

async function start(projectKey: string) {
  const { default: posthog } = await import("posthog-js");
  posthog.init(projectKey, {
    api_host: host,
    ui_host: "https://eu.posthog.com",
    defaults: "2026-01-30",
    cookieless_mode: "always",
    persistence: "memory",
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_exceptions: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    person_profiles: "identified_only",
    respect_dnt: true,
    before_send: (event) => {
      if (!event) return event;
      const properties: Properties = event.properties ?? {};
      for (const name of ["$current_url", "$referrer", "$initial_referrer"]) {
        if (name in properties) properties[name] = stripUrl(properties[name]);
      }
      delete properties.$search;
      event.properties = properties;
      return event;
    },
  });

  const send = (name: TrackedEvent) => posthog.capture(name, { path: location.pathname });

  document.addEventListener("click", (event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>(
      '[data-track], a[href^="https://deploy.workers.cloudflare.com/"]',
    );
    if (!target || target.tagName === "FORM") return;
    // Deploy links in the docs are plain Markdown links, so they carry no data-track attribute.
    const name = target.dataset.track ?? "deploy_click";
    if (isTracked(name)) send(name);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target as HTMLElement | null;
    if (form?.tagName === "FORM" && isTracked(form.dataset.track)) send(form.dataset.track);
  });
}

if (key && typeof window !== "undefined") {
  const run = () => void start(key).catch(() => {});
  if ("requestIdleCallback" in window) requestIdleCallback(run);
  else setTimeout(run, 1);
}
