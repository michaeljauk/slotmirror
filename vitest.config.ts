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
            ALLOWED_DOMAINS: "",
            ALLOWED_TENANT_IDS: "",
            ADMIN_EMAILS: "admin@example.com",
            SESSION_SECRET: "test-session-secret-at-least-32-characters",
            TOKEN_ENCRYPTION_KEY: btoa("x".repeat(32)),
            MICROSOFT_CLIENT_ID: "test-client-id",
            MICROSOFT_CLIENT_SECRET: "test-client-secret",
            GOOGLE_CLIENT_ID: "",
            GOOGLE_CLIENT_SECRET: "",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
