/**
 * The registry database of the Node runtime: `SqlDatabase` (the part of D1 that the code uses) on
 * `node:sqlite`. The code calls it as `env.DB`, as on Cloudflare.
 *
 * The shim copies the D1 behavior that the code or its error handling depends on. The contract tests
 * in `test/registry-contract.ts` run against D1 and this file and pin each point:
 *
 * - A statement compiles when it runs, not in `prepare()`. A syntax error rejects the call.
 * - `bind()` takes string, number, null, boolean (stored as 1 or 0) and binary data, also as an
 *   array of bytes. For other values it throws D1's `D1_TYPE_ERROR` at once. A value that is not a
 *   finite number is stored as NULL.
 * - A call with more or fewer values than the query has parameters fails.
 * - A BLOB comes back as an array of numbers. An integer above 2^53 comes back rounded.
 * - `meta.changes` counts every row the statement changed, also the rows of its triggers. It is 0
 *   for a statement that changed nothing, also for a `SELECT` after a write.
 * - `batch()` runs all statements in one transaction. A failed statement rolls back the batch.
 * - A query with several statements runs them in order and as one unit. Only the last statement
 *   takes bound values, and the result is the one of the last statement.
 * - SQL transaction statements (`BEGIN`, `SAVEPOINT` …) fail. `batch()` is the transaction.
 * - SQLite errors carry D1's `D1_ERROR:` prefix, which the audit log relies on (`safeMessage`).
 *
 * Parameters are `?` and `?NNN`, as in the code. Named parameters (`:name`) are not supported.
 *
 * The D1 side of each point was measured on the D1 of the Cloudflare test runner (Miniflare).
 * `node:sqlite` is synchronous. Each call runs to its end before it returns its promise, so no other
 * request runs inside a batch.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { SqlDatabase, SqlResult, SqlStatement } from "../types";

/** How long a connection waits for a lock that another connection holds. */
const BUSY_TIMEOUT_MS = 5000;

/** Compiled queries kept in memory. The code has a few hundred fixed queries. */
const STATEMENT_CACHE_LIMIT = 500;

/** The SQLite result code of a parameter index out of range. */
const SQLITE_RANGE = 25;

/** The keyword of a statement that starts or ends a transaction, at the start of the statement. */
const TRANSACTION_KEYWORD = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** D1's message for a transaction statement. */
const TRANSACTION_REFUSED =
  "D1_ERROR: To execute a transaction, please use the state.storage.transaction() or " +
  "state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT " +
  "statements. The JavaScript API is safer because it will automatically roll back on " +
  "exceptions, and because it interacts correctly with Durable Objects' automatic atomic write " +
  "coalescing.";

/**
 * Opens a SQLite file with the settings of the Node runtime:
 *
 * - WAL, so that a backup reads while the server writes. `synchronous = NORMAL` survives a crash
 *   of the process; a power cut can lose the last commits, but the file stays intact.
 * - Foreign keys on, as in D1.
 * - `secure_delete`, so that deleted rows (tokens, users) do not stay in free pages of the file.
 */
export function openSqlite(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA secure_delete = ON");
  return db;
}

/** One compiled statement of a query, and the text of the query after it. */
interface Compiled {
  statement: StatementSync;
  parameters: number;
  rest: string;
}

/** `SqlDatabase` on one `node:sqlite` connection. */
export class NodeSqlDatabase implements SqlDatabase {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, Compiled[]>();
  readonly #counters: StatementSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#counters = db.prepare("SELECT total_changes() AS total, last_insert_rowid() AS rowid");
    // A row ID above 2^53 comes back rounded, as from D1, instead of failing every later call.
    this.#counters.setReadBigInts(true);
  }

  prepare(query: string): SqlStatement {
    return new NodeSqlStatement(this, query, []);
  }

  async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    if (statements.length === 0) throw new Error("D1_ERROR: No SQL statements detected.");
    const own = statements.map((statement) => {
      if (!(statement instanceof NodeSqlStatement) || statement.database !== this) {
        throw new TypeError("batch() takes only statements of the same database");
      }
      return statement;
    });
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      const results = own.map((statement) =>
        this.execute<T>(statement.query, statement.values, "rows"),
      );
      this.#db.exec("COMMIT");
      return results;
    } catch (error) {
      if (this.#db.isOpen && this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw d1Error(error);
    }
  }

  /** Runs a query and returns its rows as objects (`rows`) or as arrays (`raw`). */
  execute<T>(query: string, values: SQLInputValue[], shape: "rows" | "raw"): SqlResult<T> {
    try {
      if (query.trim() === "") throw new Error("D1_ERROR: No SQL statements detected.");
      if (isEmptySql(query)) throw new Error("D1_ERROR: SQL code did not contain a statement.");
      const before = this.#count().total;
      const rows = this.#runQuery(query, values, shape);
      const after = this.#count();
      return {
        results: rows.map((row) => fromSqliteRow(row)) as T[],
        success: true,
        // As in D1: the rows of the statement and of its triggers. SQLite's changes() would hold
        // the count of the last write after a statement that changed nothing.
        meta: { changes: after.total - before, last_row_id: after.rowid },
      };
    } catch (error) {
      throw d1Error(error);
    }
  }

  #count(): { total: number; rowid: number } {
    const { total, rowid } = this.#counters.get() as { total: bigint; rowid: bigint };
    return { total: Number(total), rowid: Number(rowid) };
  }

  /**
   * Runs every statement of a query and returns the rows of the last one. `node:sqlite` compiles
   * only the first statement of a text and drops the rest without an error. So each statement
   * compiles after the one before it ran, as in D1, where a statement can use a table that the
   * statement before it created.
   */
  #runQuery(query: string, values: SQLInputValue[], shape: "rows" | "raw"): unknown[] {
    const cached = this.#statements.get(query);
    const first = cached?.[0] ?? compile(this.#db, query);
    if (isEmptySql(first.rest)) {
      this.#remember(query, [first]);
      return runCompiled(first, values, shape);
    }
    this.#db.exec("SAVEPOINT d1_query");
    try {
      const compiled = [first];
      let current = first;
      let rows: unknown[];
      for (;;) {
        const last = isEmptySql(current.rest);
        rows = runCompiled(current, last ? values : [], shape);
        if (last) break;
        current = cached?.[compiled.length] ?? compile(this.#db, current.rest);
        compiled.push(current);
      }
      this.#db.exec("RELEASE d1_query");
      this.#remember(query, compiled);
      return rows;
    } catch (error) {
      // Some errors end the transaction in SQLite itself; then no savepoint is left.
      if (this.#db.isTransaction) {
        this.#db.exec("ROLLBACK TO d1_query");
        this.#db.exec("RELEASE d1_query");
      }
      throw error;
    }
  }

  #remember(query: string, compiled: Compiled[]): void {
    if (this.#statements.has(query)) return;
    if (this.#statements.size >= STATEMENT_CACHE_LIMIT) this.#statements.clear();
    this.#statements.set(query, compiled);
  }
}

/** Compiles the first statement of a SQL text. */
function compile(db: DatabaseSync, sql: string): Compiled {
  let statement: StatementSync;
  let source: string;
  try {
    statement = db.prepare(sql);
    source = statement.sourceSQL;
  } catch (error) {
    // A text without a statement, for example an unterminated comment after the last statement.
    // Node 24.22 fails in prepare(); Node 24.16 returns a finalized statement that fails on use.
    const code = (error as { code?: unknown }).code;
    if (code === "ERR_INVALID_ARG_VALUE" || code === "ERR_INVALID_STATE") {
      throw new Error("D1_ERROR: SQL code did not contain a statement.", { cause: error });
    }
    throw error;
  }
  // Read integers as BigInt, so that one above 2^53 comes back rounded, as from D1, and does not
  // fail the query.
  statement.setReadBigInts(true);
  // `sourceSQL` keeps the whitespace, comments and semicolons before the statement.
  if (TRANSACTION_KEYWORD.test(source.slice(skipFiller(source)))) {
    throw new Error(TRANSACTION_REFUSED);
  }
  const end = sql.indexOf(source);
  if (end < 0) throw new Error("D1_ERROR: The query could not be split into statements.");
  return {
    statement,
    parameters: countParameters(statement),
    rest: sql.slice(end + source.length),
  };
}

/** Runs one compiled statement. Fails, as D1 does, if the number of values does not fit. */
function runCompiled(
  compiled: Compiled,
  values: SQLInputValue[],
  shape: "rows" | "raw",
): unknown[] {
  if (values.length !== compiled.parameters) {
    throw new Error("D1_ERROR: Wrong number of parameter bindings for SQL query.");
  }
  compiled.statement.setReturnArrays(shape === "raw");
  try {
    return compiled.statement.all(...values);
  } finally {
    compiled.statement.setReturnArrays(false);
  }
}

/**
 * The number of parameters of a statement. `node:sqlite` has no call for it and binds a missing
 * value as NULL. `iterate()` binds without running the statement and fails if there are more
 * values than parameters, so the count is the largest number of values it takes.
 */
function countParameters(statement: StatementSync): number {
  const fits = (count: number): boolean => {
    try {
      statement.iterate(...Array.from({ length: count }, () => null)).return?.();
      return true;
    } catch (error) {
      if ((error as { errcode?: unknown }).errcode === SQLITE_RANGE) return false;
      throw error;
    }
  };
  let high = 1;
  while (fits(high)) high *= 2;
  let low = high / 2 >= 1 ? high / 2 : 0;
  // `low` fits, `high` does not.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/** A statement and its bound values. Like D1, it checks values in `bind()` and compiles later. */
class NodeSqlStatement implements SqlStatement {
  readonly database: NodeSqlDatabase;
  readonly query: string;
  /** The bound values as `node:sqlite` takes them. */
  readonly values: SQLInputValue[];

  constructor(database: NodeSqlDatabase, query: string, values: SQLInputValue[]) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values: unknown[]): SqlStatement {
    return new NodeSqlStatement(
      this.database,
      this.query,
      values.map((value) => toSqliteValue(value)),
    );
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const [row] = this.database.execute<Record<string, unknown>>(
      this.query,
      this.values,
      "rows",
    ).results;
    if (row === undefined) return null;
    if (column === undefined) return row as T;
    if (!Object.hasOwn(row, column)) {
      throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    }
    return row[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.database.execute<T>(this.query, this.values, "rows");
  }

  async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.database.execute<T>(this.query, this.values, "rows");
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return this.database.execute<T>(this.query, this.values, "raw").results;
  }
}

/**
 * A bound value as `node:sqlite` takes it. Binary data goes in as `Uint8Array`: before Node
 * 24.21.0, `node:sqlite` stores an `ArrayBuffer` as NULL without an error. Booleans go in as 1 or
 * 0, which Node rejects before 24.21.0.
 */
function toSqliteValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string") return value;
  // The D1 of the test runner sends values as JSON, so Infinity and NaN arrive as NULL.
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every(isByte)) return Uint8Array.from(value as number[]);
  throw new Error(
    `D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${quoted(value)}'`,
  );
}

function isByte(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255;
}

/** A value as D1 quotes it in a type error: '1,300' for an array, '[object Object]' for an object. */
function quoted(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => quoted(item)).join(",");
  if (typeof value === "object" || typeof value === "function") {
    return Object.prototype.toString.call(value);
  }
  return String(value as bigint | symbol | undefined);
}

/** A result row as D1 returns it: a plain object, with a BLOB as an array of numbers. */
function fromSqliteRow(row: unknown): unknown {
  if (Array.isArray(row)) return row.map((value: unknown) => fromSqliteValue(value));
  // Object.fromEntries keeps a column named __proto__ as a value.
  return Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([key, value]) => [
      key,
      fromSqliteValue(value),
    ]),
  );
}

function fromSqliteValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  return value instanceof Uint8Array ? Array.from(value) : value;
}

/** The characters that SQLite reads as space. JavaScript's `\s` holds more, for example U+00A0. */
const SQLITE_SPACE = /[ \t\n\f\r\uFEFF]/;

/** True if the rest of a query holds only whitespace, comments and semicolons. */
function isEmptySql(sql: string): boolean {
  return skipFiller(sql) === sql.length;
}

/**
 * The index of the first character after the whitespace, semicolons and comments at the start of
 * a SQL text, read as SQLite reads it: "--" inside a block comment starts no line comment, and a
 * block comment ends at its first "*\/". An unterminated block comment counts as text, so that the
 * query fails as in D1.
 */
function skipFiller(sql: string): number {
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    if (char === ";" || SQLITE_SPACE.test(char)) {
      i += 1;
    } else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return i;
      i = end + 2;
    } else {
      return i;
    }
  }
  return i;
}

/** SQLite result code names, by primary code. */
const PRIMARY_CODES: Record<number, string> = {
  1: "SQLITE_ERROR",
  2: "SQLITE_INTERNAL",
  3: "SQLITE_PERM",
  4: "SQLITE_ABORT",
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  7: "SQLITE_NOMEM",
  8: "SQLITE_READONLY",
  9: "SQLITE_INTERRUPT",
  10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT",
  13: "SQLITE_FULL",
  14: "SQLITE_CANTOPEN",
  17: "SQLITE_SCHEMA",
  18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE",
  23: "SQLITE_AUTH",
  25: "SQLITE_RANGE",
  26: "SQLITE_NOTADB",
};

/** Extended names of constraint errors, the ones the code can cause. */
const EXTENDED_CODES: Record<number, string> = {
  275: "SQLITE_CONSTRAINT_CHECK",
  787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1299: "SQLITE_CONSTRAINT_NOTNULL",
  1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
  1811: "SQLITE_CONSTRAINT_TRIGGER",
  2067: "SQLITE_CONSTRAINT_UNIQUE",
  2579: "SQLITE_CONSTRAINT_ROWID",
};

/**
 * An error in D1's form: "D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT
 * (extended: SQLITE_CONSTRAINT_UNIQUE)". The original error is the `cause`, as in D1.
 */
function d1Error(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(`D1_ERROR: ${String(error)}`);
  if (/^D1_[A-Z_]+: /.test(error.message)) return error;
  const code = (error as { errcode?: unknown }).errcode;
  let suffix = "";
  if (typeof code === "number") {
    const primary = PRIMARY_CODES[code & 0xff];
    const extended = EXTENDED_CODES[code];
    if (primary) suffix = `: ${primary}`;
    if (primary && extended) suffix += ` (extended: ${extended})`;
  }
  return new Error(`D1_ERROR: ${error.message}${suffix}`, { cause: error });
}
