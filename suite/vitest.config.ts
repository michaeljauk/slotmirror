import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_BINDINGS } from "../test/bindings.ts";
import { loadSuite } from "./lib/load.ts";
import { runStamp } from "./lib/stamp.ts";

/**
 * The local run of `pnpm suite`. Unlike the main test config, it keeps the real alarm delays and
 * sets no fetch target for the simulated calendars. The token endpoint refuses every refresh, which
 * the `refuse-token` control needs.
 */
export default defineConfig(async () => {
  const {
    SYNC_DEBOUNCE_MS: _debounce,
    SYNC_NEXT_RUN_MS: _nextRun,
    DEV_FAKE_FETCH_URL: _fetchTarget,
    ...bindings
  } = TEST_BINDINGS;
  const suiteDir = dirname(fileURLToPath(import.meta.url));
  const migrations = await readD1Migrations("./migrations");
  const input = {
    ...loadSuite(suiteDir),
    ...runStamp(suiteDir),
    scenarioId: process.env.SUITE_SCENARIO ?? "",
    runAt: new Date().toISOString(),
  };
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          async outboundService(request: Request) {
            if (new URL(request.url).hostname === "suite-result.test") {
              const file = process.env.SUITE_RESULT_FILE;
              if (file) writeFileSync(file, await request.text());
              return new Response("ok");
            }
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            ...bindings,
          },
        },
      }),
    ],
    define: { __BUILD_COMMIT__: '"suite"', __SUITE_INPUT__: JSON.stringify(input) },
    test: {
      include: ["suite/drivers/local.run.ts", "suite/proof/*.run.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      testTimeout: 900_000,
    },
  };
});
