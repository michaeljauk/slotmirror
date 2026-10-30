import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Fixed test values, so that tests do not depend on a local .dev.vars file.
          bindings: {
            TEST_MIGRATIONS: migrations,
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
            DATA_JURISDICTION: "",
            MAX_DETAIL_TO_EXTERNAL: "title",
            MAX_DETAIL_FROM_EXTERNAL: "busy",
            SESSION_SECRET: "test-session-secret-at-least-32-characters",
            TOKEN_ENCRYPTION_KEY: btoa("x".repeat(32)),
            MICROSOFT_CLIENT_ID: "test-client-id",
            MICROSOFT_CLIENT_SECRET: "test-client-secret",
            GOOGLE_CLIENT_ID: "test-google-client-id",
            GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          },
        },
      }),
    ],
    // The build sets the commit at deploy time; tests use a fixed value.
    define: { __BUILD_COMMIT__: '"testcommit1234"' },
    test: {
      // The waitlist Worker has its own config and tests, run by `pnpm waitlist:check`.
      exclude: ["**/node_modules/**", "waitlist/**", "website/**"],
      setupFiles: ["./test/apply-migrations.ts"],
      // The default 5 s fails tests on a loaded machine, e.g. in the pre-push hook.
      testTimeout: 30_000,
    },
  };
});
