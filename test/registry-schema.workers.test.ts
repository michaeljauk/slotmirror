import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import expected from "./fixtures/registry-schema.json";
import { describeSchema } from "./registry-schema";

// src/runtime/node/registry.node.test.ts checks the schema of the Node runtime against the same file.
// After a new migration, update the file with `pnpm db:schema` and review its diff.
describe("the schema of D1 after all migrations", () => {
  it("matches test/fixtures/registry-schema.json", async () => {
    expect(await describeSchema(env.DB)).toEqual(expected);
  });
});
