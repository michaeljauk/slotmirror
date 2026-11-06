import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_BINDINGS } from "./test/bindings.ts";

// The build sets the commit at deploy time; tests use a fixed value.
const BUILD_COMMIT = '"testcommit1234"';
// The waitlist Worker has its own config and tests, run by `pnpm waitlist:check`.
const EXCLUDE = ["**/node_modules/**", "waitlist/**", "website/**"];
// The default 5 s fails tests on a loaded machine, e.g. in the pre-push hook.
const TEST_TIMEOUT = 30_000;
// Tests that run only on Node, in any folder. The workers project skips them.
const NODE_TESTS = ["**/*.node.test.{ts,tsx}"];

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      projects: [
        {
          // workerd with the real `cloudflare:*` modules, as on Cloudflare.
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                // Tests reach no real host. These two hosts let a test use the real `fetch` of
                // workerd.
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
          define: { __BUILD_COMMIT__: BUILD_COMMIT, __TEST_RUNTIME__: '"workers"' },
          test: {
            name: "workers",
            exclude: [...EXCLUDE, ...NODE_TESTS],
            setupFiles: ["./test/apply-migrations.ts"],
            testTimeout: TEST_TIMEOUT,
          },
        },
        {
          // Node, for the Docker image. Only `*.node.test.{ts,tsx}` runs here until the Node runtime
          // provides `cloudflare:workers` and `cloudflare:test`.
          define: { __BUILD_COMMIT__: BUILD_COMMIT, __TEST_RUNTIME__: '"node"' },
          test: {
            name: "node",
            environment: "node",
            include: NODE_TESTS,
            exclude: EXCLUDE,
            testTimeout: TEST_TIMEOUT,
          },
        },
      ],
    },
  };
});
