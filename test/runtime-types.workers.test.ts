import { env } from "cloudflare:workers";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AccountNamespace,
  ActorSql,
  ActorState,
  ActorStorage,
  AppBindings,
  SqlDatabase,
  SqlResult,
  SqlStatement,
} from "../src/runtime/types";
import { runtime } from "./runtime";

// These checks run at compile time in `pnpm typecheck`. If Cloudflare changes a type so that it no
// longer fits the subset, or the subset asks for more than Cloudflare offers, the typecheck fails.
describe("the Cloudflare runtime fits the runtime subset", () => {
  it("runs on workerd", () => {
    expect(runtime).toBe("workers");
  });

  it("fits D1", () => {
    expectTypeOf<D1Database>().toExtend<SqlDatabase>();
    expectTypeOf<D1PreparedStatement>().toExtend<SqlStatement>();
    expectTypeOf<D1Result<{ id: string }>>().toExtend<SqlResult<{ id: string }>>();
    expect(env.DB).toBeDefined();
  });

  it("fits the storage of a Durable Object", () => {
    expectTypeOf<SqlStorage>().toExtend<ActorSql>();
    expectTypeOf<DurableObjectStorage>().toExtend<ActorStorage>();
    expectTypeOf<DurableObjectState>().toExtend<ActorState>();
  });

  it("fits the bindings", () => {
    expectTypeOf(env.ACCOUNT_SYNC).toExtend<AccountNamespace>();
    expectTypeOf<Env>().toExtend<AppBindings>();
    expect(env.ACCOUNT_SYNC).toBeDefined();
  });
});
