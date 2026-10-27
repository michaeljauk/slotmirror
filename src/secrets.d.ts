/**
 * Worker secrets. `wrangler types` only sees secrets that exist in a local `.dev.vars`, so they are
 * declared here; the generated types then do not depend on a developer's local files.
 */
interface WorkerSecrets {
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Optional. Bearer token for SCIM provisioning from Entra; without it /scim/v2 does not exist. */
  SCIM_TOKEN?: string;
  /**
   * Optional. Incoming webhook (Slack-compatible JSON `{"text": ...}`) that hears once when an
   * account needs to be connected again.
   */
  ALERT_WEBHOOK_URL?: string;
  /** Local load tests only, set with `wrangler dev --var`: "1" turns on simulated calendars. */
  DEV_FAKE_CALENDARS?: string;
  /** Local load tests only: simulated network time per provider call, in milliseconds. */
  DEV_FAKE_LATENCY_MS?: string;
  /** Tests only: delay before a requested sync starts, in milliseconds. Default 5000. */
  SYNC_DEBOUNCE_MS?: string;
  /** Tests only: delay between two alarm runs, in milliseconds. Default 1000. */
  SYNC_NEXT_RUN_MS?: string;
}

interface Env extends WorkerSecrets {}

declare namespace Cloudflare {
  interface Env extends WorkerSecrets {}
}
