/**
 * The Cloudflare globals that the core uses, declared as the runtime subset for the Node
 * typecheck (`tsconfig.node.json`). The core keeps its Cloudflare names. Here they mean only what
 * `src/runtime/types.ts` describes, so a call outside the subset fails the Node typecheck.
 *
 * On Cloudflare, `worker-configuration.d.ts` declares these names with the real types instead.
 *
 * This is a `.ts` file on purpose. The typecheck does not report errors in a declaration file, so
 * a name here that no longer resolved would switch off part of the check without a message.
 */
import type { webcrypto } from "node:crypto";
import type {
  ActorSql,
  ActorSqlValue,
  ActorState,
  AppBindings,
  SqlDatabase,
  SqlResult,
  SqlStatement,
} from "../types";

declare global {
  type D1Database = SqlDatabase;
  type D1PreparedStatement = SqlStatement;
  type D1Result<T = unknown> = SqlResult<T>;
  type SqlStorage = ActorSql;
  type SqlStorageValue = ActorSqlValue;
  type DurableObjectState = ActorState;
  // Web Crypto exists in Node, but @types/node declares `CryptoKey` only as a value.
  type CryptoKey = webcrypto.CryptoKey;
  interface Env extends AppBindings {}
}
