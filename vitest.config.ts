import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_BINDINGS } from "./test/bindings.ts";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Tests reach no real host. These two hosts let a test use the real `fetch` of workerd.
          outboundService(request: Request) {
            const { hostname } = new URL(request.url);
            if (hostname === "hook-accepts.test") return new Response("ok");
            if (hostname === "hook-redirects.test") {
              const headers = { location: "https://hook-accepts.test/second" };
              return new Response(null, { status: 302, headers });
            }
            return new Response("no network in tests", { status: 502 });
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            ...TEST_BINDINGS,
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
