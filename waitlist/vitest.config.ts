import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Fixed test values, so that tests do not depend on local files.
          bindings: {
            TEST_MIGRATIONS: migrations,
            RESEND_API_KEY: "re_test_key",
            TURNSTILE_SECRET: "test-turnstile-secret",
            HASH_PEPPER: "test-pepper-at-least-32-characters-long",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      testTimeout: 30_000,
    },
  };
});
