// The waitlist of the hosted version. The form and every link to it show only if both build
// variables are set. An address without https:// would make a relative endpoint, so it counts as
// unset.
const url = (import.meta.env.PUBLIC_WAITLIST_URL as string | undefined)?.trim().replace(/\/$/, "");
const siteKey = (import.meta.env.PUBLIC_TURNSTILE_SITE_KEY as string | undefined)?.trim();

export const waitlist =
  url?.startsWith("https://") && siteKey ? { endpoint: `${url}/api/signup`, siteKey } : null;
