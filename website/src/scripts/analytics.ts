// Privacy-first product analytics for the website only. PostHog EU, no cookies, no autocapture,
// no session replay. The project key comes from the build variable PUBLIC_POSTHOG_KEY. Without
// the key this file does nothing and the site works as before.
//
// Three events are sent today:
//   deploy_click          the "Deploy to Cloudflare" buttons and links
//   waitlist_submit       a sign-up sent from the waitlist form on the home page, if the build
//                         shows it. The event carries the path only: never the address, a token or the answer.
//   $pageview             the standard page view, which replaces Cloudflare Web Analytics
// The constants below also list suite_to_quickstart. No element sends it yet. It stays so that a
// future data-track attribute works without a code change.

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

// Properties that hold a full URL. PostHog adds the "$initial_" and "$session_entry_" forms to
// $set_once and to the event itself. $pathname holds only the path: posthog-js builds it from
// URL.pathname, which never contains a query string.
const URL_PROPERTIES = new Set([
  "$current_url",
  "$referrer",
  "$initial_current_url",
  "$initial_referrer",
  "$session_entry_url",
  "$session_entry_referrer",
  "$external_click_url",
]);
// Values that posthog-js copies out of the query string.
const QUERY_PROPERTY =
  /^(\$initial_)?(utm_|gclid$|gclsrc$|dclid$|gbraid$|wbraid$|fbclid$|msclkid$)/;

function cleanProperties(properties: Properties | undefined): void {
  if (!properties) return;
  for (const name of Object.keys(properties)) {
    if (URL_PROPERTIES.has(name)) properties[name] = stripUrl(properties[name]);
    else if (QUERY_PROPERTY.test(name)) delete properties[name];
  }
  delete properties.$search;
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
      event.properties = event.properties ?? {};
      cleanProperties(event.properties);
      cleanProperties(event.$set);
      cleanProperties(event.$set_once);
      cleanProperties(event.properties.$set as Properties | undefined);
      cleanProperties(event.properties.$set_once as Properties | undefined);
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
  // The waitlist script fires this event only when it sends a sign-up, not on every submit event.
  document.addEventListener("slotmirror:waitlist-submit", () => send("waitlist_submit"));
}

if (key && typeof window !== "undefined") {
  const run = () => void start(key).catch(() => {});
  if ("requestIdleCallback" in window) requestIdleCallback(run);
  else setTimeout(run, 1);
}
