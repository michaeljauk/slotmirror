/** Fixed test values, so that tests do not depend on a local .dev.vars file. */
export const TEST_BINDINGS = {
  ORG_NAME: "Example",
  ALLOWED_EMAILS: "owner@example.com,other@elsewhere.org",
  ALLOWED_DOMAINS: "org.example",
  ALLOWED_TENANT_IDS: "",
  ADMIN_EMAILS: "admin@example.com",
  SIGN_IN_PROVIDERS: "",
  SCIM_TOKEN: "test-scim-token",
  PUBLIC_URL: "https://slotmirror.example.workers.dev",
  ALERT_WEBHOOK_URL: "https://alerts.example.com/hook",
  // Alarms fire by themselves once due; long delays keep them under the tests' control.
  SYNC_DEBOUNCE_MS: "600000",
  SYNC_NEXT_RUN_MS: "600000",
  // Only accounts with the token "fake" use the simulated calendars.
  // The /dev routes and the simulated calendars. A real token never reaches them.
  DEV_FAKE_CALENDARS: "1",
  DEV_FAKE_FETCH_URL: "https://probe-sink.example/",
  DATA_JURISDICTION: "",
  MAX_DETAIL_TO_EXTERNAL: "title",
  MAX_DETAIL_FROM_EXTERNAL: "busy",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
  TOKEN_ENCRYPTION_KEY: btoa("x".repeat(32)),
  MICROSOFT_CLIENT_ID: "test-client-id",
  MICROSOFT_CLIENT_SECRET: "test-client-secret",
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
};
