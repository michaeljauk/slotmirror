/**
 * The part of the Cloudflare runtime that slotmirror uses, as plain types.
 *
 * The code keeps the Cloudflare names (`D1Database`, `DurableObject`, `env.ACCOUNT_SYNC`). On
 * Cloudflare they are the real objects. The Node runtime replaces `cloudflare:workers` with a shim
 * that implements only what this file describes. Two checks in `pnpm typecheck` hold this:
 *
 * - `tsconfig.node.json` checks the core against this file, so the core uses nothing the shim lacks.
 * - `test/runtime-types.workers.test.ts` checks that the real Cloudflare types fit this file, so code
 *   written against it also runs on Cloudflare.
 *
 * If the core needs a Cloudflare API that is not here, add it here first and implement it in the
 * Node runtime. This file imports nothing from `cloudflare:*` or `node:*`.
 */
import type { AccountSync } from "../account-sync";

/** The part of `D1Database` that the code uses. */
export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]>;
}

/** The part of `D1PreparedStatement` that the code uses. */
export interface SqlStatement {
  /**
   * Binds values like D1: string, number, null, boolean (stored as 0 or 1) and binary data
   * (ArrayBuffer, a typed array or an array of bytes). For other values it throws at once, on D1
   * and on the Node runtime.
   */
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

/** The part of `D1Result` that the code reads. Only D1 counts `rows_read`. */
export interface SqlResult<T = unknown> {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number; rows_read?: number };
}

/** Values that the SQL storage of a Durable Object stores. */
export type ActorSqlValue = string | number | null | ArrayBuffer;

/** The cursor that `ActorSql.exec` returns. */
export interface ActorSqlCursor<T> {
  [Symbol.iterator](): Iterator<T>;
  toArray(): T[];
  one(): T;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/** The part of `SqlStorage` that the code uses. */
export interface ActorSql {
  exec<T extends Record<string, ActorSqlValue>>(
    query: string,
    ...bindings: ActorSqlValue[]
  ): ActorSqlCursor<T>;
}

/** The part of `DurableObjectStorage` that the code uses. */
export interface ActorStorage {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
  transaction<T>(closure: (txn: ActorTransaction) => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  /** Also deletes the alarm. */
  deleteAll(): Promise<void>;
  sync(): Promise<void>;
  readonly sql: ActorSql;
}

/** The storage calls that the code makes inside `ActorStorage.transaction`. */
export type ActorTransaction = Pick<ActorStorage, "get" | "put" | "delete">;

/** The part of `DurableObjectState` that the code uses. */
export interface ActorState {
  readonly id: { readonly name?: string; toString(): string };
  readonly storage: ActorStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

/** The public methods of `AccountSync`, which other code calls through a stub. */
export type AccountSyncMethod = {
  [K in keyof AccountSync]-?: AccountSync[K] extends (...args: never[]) => unknown ? K : never;
}[keyof AccountSync];

/** A stub of one account: every public method of `AccountSync`, called as a promise. */
export type AccountSyncStub = {
  [K in Exclude<AccountSyncMethod, "alarm" | "fetch">]: AccountSync[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * The part of the `ACCOUNT_SYNC` binding that the code uses. The code calls `getByName` and
 * `jurisdiction`. Tests also call `get` with IDs from `listDurableObjectIds`.
 */
export interface AccountNamespace {
  getByName(name: string): AccountSyncStub;
  jurisdiction(name: "eu" | "fedramp"): AccountNamespace;
  get(id: { toString(): string }): AccountSyncStub;
}

/** The bindings that the app, the cron and `AccountSync` read. */
export interface AppBindings extends WorkerSecrets, WorkerSettings {
  DB: SqlDatabase;
  ACCOUNT_SYNC: AccountNamespace;
}
