import { describe, expect, it } from "vitest";
import { safeMessage } from "../src/error-fields";
import { EditorConflict, guardedBatch, requireChange } from "../src/editor";

/**
 * The D1 behavior that the code depends on, as tests. `test/registry.workers.test.ts` runs them
 * against D1, `src/runtime/node/registry.node.test.ts` against the Node runtime. A point that only
 * one of them passes is a difference between the runtimes.
 *
 * Each test creates its own tables, so the tests do not depend on the schema or on each other.
 * `D1Database` is the real D1 type on Cloudflare and `SqlDatabase` in the Node typecheck.
 */
export function registryContract(database: () => D1Database): void {
  let tables = 0;
  /** A new table name for one test. */
  const table = (name: string) => `contract_${name}_${++tables}`;

  describe("the registry database behaves like D1", () => {
    it("rolls back a whole batch if one statement fails", async () => {
      const db = database();
      const t = table("batch");
      await db.prepare(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, email TEXT UNIQUE)`).run();
      await db.prepare(`INSERT INTO ${t} (email) VALUES ('a@example.com')`).run();

      const error = await db
        .batch([
          db.prepare(`INSERT INTO ${t} (email) VALUES ('b@example.com')`),
          db.prepare(`INSERT INTO ${t} (email) VALUES ('a@example.com')`),
        ])
        .then(
          () => undefined,
          (failure: unknown) => failure as Error,
        );

      expect(error?.message).toMatch(
        /^D1_ERROR: UNIQUE constraint failed: contract_batch_\d+\.email/,
      );
      // The audit log keeps D1 messages that quote no bound value.
      expect(safeMessage(error!)).toBe(error!.message);
      const { results } = await db.prepare(`SELECT email FROM ${t} ORDER BY email`).all();
      expect(results).toEqual([{ email: "a@example.com" }]);
    });

    it("fails a guarded batch of the editor as a conflict and keeps nothing of it", async () => {
      const db = database();
      const env = { DB: db } as unknown as Env;
      const t = table("guard");
      await db.prepare(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, generation INTEGER)`).run();
      await db.prepare(`INSERT INTO ${t} VALUES ('r1', 1), ('r2', 1)`).run();

      await expect(
        guardedBatch(env, [
          db.prepare(`UPDATE ${t} SET generation = 2 WHERE id = 'r1'`),
          requireChange(env),
          db.prepare(`UPDATE ${t} SET generation = 2 WHERE id = 'r2' AND generation = 7`),
          requireChange(env),
        ]),
      ).rejects.toBeInstanceOf(EditorConflict);
      const stale = await db.prepare(`SELECT id, generation FROM ${t} ORDER BY id`).all();
      expect(stale.results).toEqual([
        { id: "r1", generation: 1 },
        { id: "r2", generation: 1 },
      ]);

      await guardedBatch(env, [
        db.prepare(`UPDATE ${t} SET generation = 2 WHERE id = 'r1' AND generation = 1`),
        requireChange(env),
      ]);
      expect(
        await db.prepare(`SELECT generation FROM ${t} WHERE id = 'r1'`).first("generation"),
      ).toBe(2);
    });

    it("lets changes() read the statement before it in a batch", async () => {
      const db = database();
      const t = table("changes");
      await db.prepare(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, n INTEGER)`).run();
      await db.prepare(`INSERT INTO ${t} (n) VALUES (1), (1), (2)`).run();

      const [update, read] = await db.batch<{ c: number }>([
        db.prepare(`UPDATE ${t} SET n = 3 WHERE n = 1`),
        db.prepare("SELECT changes() AS c"),
      ]);

      expect(update!.meta.changes).toBe(2);
      expect(read!.results).toEqual([{ c: 2 }]);
      expect(read!.meta.changes).toBe(0);
    });

    it("counts no change for a statement that changed nothing, also after a write", async () => {
      const db = database();
      const t = table("none");
      await db.prepare(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, generation INTEGER)`).run();
      const insert = await db.prepare(`INSERT INTO ${t} VALUES ('code', 1), ('other', 1)`).run();
      expect(insert.meta.changes).toBe(2);

      // The guard of OAuth codes: a second use of a code must see 0 changes.
      const used = db.prepare(`UPDATE ${t} SET generation = 2 WHERE id = ? AND generation = ?`);
      expect((await used.bind("code", 1).run()).meta.changes).toBe(1);
      expect((await used.bind("code", 1).run()).meta.changes).toBe(0);
      expect((await db.prepare(`SELECT * FROM ${t}`).all()).meta.changes).toBe(0);
      expect((await db.prepare(`DELETE FROM ${t} WHERE id = 'gone'`).run()).meta.changes).toBe(0);
    });

    it("counts the rows of RETURNING and the last row ID", async () => {
      const db = database();
      const t = table("returning");
      await db.prepare(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, n INTEGER)`).run();
      const insert = await db.prepare(`INSERT INTO ${t} (n) VALUES (?)`).bind(5).run();
      expect(insert.meta.last_row_id).toBe(1);
      await db.prepare(`INSERT INTO ${t} (n) VALUES (5), (6)`).run();

      const updated = await db
        .prepare(`UPDATE ${t} SET n = n + 1 WHERE n = 5 RETURNING id`)
        .all<{ id: number }>();

      expect(updated.results.map((row) => row.id).sort((a, b) => a - b)).toEqual([1, 2]);
      expect(updated.meta.changes).toBe(2);
    });

    it("counts the rows of a statement and of its triggers", async () => {
      const db = database();
      const t = table("trigger");
      const log = table("trigger_log");
      await db.prepare(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, enabled INTEGER)`).run();
      await db.prepare(`CREATE TABLE ${log} (id INTEGER)`).run();
      await db
        .prepare(
          `CREATE TRIGGER ${t}_off AFTER UPDATE OF enabled ON ${t} WHEN NEW.enabled = 0
           BEGIN
             INSERT INTO ${log} VALUES (NEW.id);
             INSERT INTO ${log} VALUES (NEW.id);
           END`,
        )
        .run();
      await db.prepare(`INSERT INTO ${t} VALUES (1, 1), (2, 1)`).run();

      const off = await db.prepare(`UPDATE ${t} SET enabled = 0 WHERE id = 1`).run();

      expect(off.meta.changes).toBe(3);
      expect(await db.prepare(`SELECT count(*) AS n FROM ${log}`).first("n")).toBe(2);
    });

    it("counts the rows that a foreign key deletes with its parent", async () => {
      const db = database();
      const parent = table("cascade_parent");
      const child = table("cascade_child");
      await db.prepare(`CREATE TABLE ${parent} (id TEXT PRIMARY KEY)`).run();
      await db
        .prepare(
          `CREATE TABLE ${child} (id TEXT, parent TEXT REFERENCES ${parent} (id) ON DELETE CASCADE)`,
        )
        .run();
      await db.prepare(`INSERT INTO ${parent} VALUES ('p')`).run();
      await db.prepare(`INSERT INTO ${child} VALUES ('a', 'p'), ('b', 'p')`).run();

      const deleted = await db.prepare(`DELETE FROM ${parent} WHERE id = 'p'`).run();

      expect(deleted.meta.changes).toBe(3);
      expect(await db.prepare(`SELECT count(*) AS n FROM ${child}`).first("n")).toBe(0);
    });

    it("compiles a statement when it runs and prefixes errors with D1_ERROR", async () => {
      const db = database();
      const statement = db.prepare("SELEC 1");

      await expect(statement.all()).rejects.toThrow(/^D1_ERROR: near "SELEC": syntax error/);
      await expect(db.prepare("SELECT * FROM contract_missing").first()).rejects.toThrow(
        /^D1_ERROR: no such table: contract_missing/,
      );
    });

    it("stores binary data and returns it as an array of numbers", async () => {
      const db = database();
      const t = table("blob");
      await db.prepare(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, data BLOB)`).run();
      const insert = db.prepare(`INSERT INTO ${t} VALUES (?, ?)`);
      await insert.bind("buffer", new Uint8Array([1, 2, 255]).buffer).run();
      await insert.bind("view", new Uint8Array([0, 9, 8, 7]).subarray(1, 3)).run();

      const rows = await db
        .prepare(`SELECT id, data, typeof(data) AS type FROM ${t} ORDER BY id`)
        .all();

      expect(rows.results).toEqual([
        { id: "buffer", data: [1, 2, 255], type: "blob" },
        { id: "view", data: [9, 8], type: "blob" },
      ]);
    });

    it("stores booleans as 1 and 0", async () => {
      const db = database();
      const t = table("boolean");
      await db.prepare(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, flag INTEGER)`).run();
      await db.batch([
        db.prepare(`INSERT INTO ${t} VALUES (?, ?)`).bind("on", true),
        db.prepare(`INSERT INTO ${t} VALUES (?, ?)`).bind("off", false),
      ]);

      const rows = await db
        .prepare(`SELECT id, flag, typeof(flag) AS type FROM ${t} ORDER BY id`)
        .all();

      expect(rows.results).toEqual([
        { id: "off", flag: 0, type: "integer" },
        { id: "on", flag: 1, type: "integer" },
      ]);
    });

    it("throws in bind() for undefined, bigint and objects", () => {
      const select = database().prepare("SELECT ? AS value");

      for (const [value, type] of [
        [undefined, "undefined"],
        [5n, "bigint"],
        [{}, "object"],
      ] as const) {
        expect(() => select.bind(value)).toThrow(
          new RegExp(`^D1_TYPE_ERROR: Type '${type}' not supported for value`),
        );
      }
    });

    it("enforces foreign keys", async () => {
      const db = database();
      const parent = table("parent");
      const child = table("child");
      await db.prepare(`CREATE TABLE ${parent} (id TEXT PRIMARY KEY)`).run();
      await db
        .prepare(`CREATE TABLE ${child} (id TEXT, parent TEXT REFERENCES ${parent} (id))`)
        .run();

      await expect(db.prepare(`INSERT INTO ${child} VALUES ('c', 'none')`).run()).rejects.toThrow(
        /^D1_ERROR: FOREIGN KEY constraint failed/,
      );
    });

    it("rejects an empty batch", async () => {
      await expect(database().batch([])).rejects.toThrow("D1_ERROR: No SQL statements detected.");
    });

    it("returns the first row, one of its columns, or null", async () => {
      const db = database();
      const t = table("first");
      await db.prepare(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, name TEXT)`).run();
      await db.prepare(`INSERT INTO ${t} (name) VALUES ('a'), ('b')`).run();
      const query = db.prepare(`SELECT id, name FROM ${t} ORDER BY id`);

      expect(await query.first()).toEqual({ id: 1, name: "a" });
      expect(await query.first("name")).toBe("a");
      expect(await db.prepare(`SELECT name FROM ${t} WHERE 0`).first()).toBeNull();
      expect(await db.prepare(`SELECT name FROM ${t} WHERE 0`).first("name")).toBeNull();
      await expect(query.first("missing")).rejects.toThrow(
        "D1_COLUMN_NOTFOUND: Column not found (missing)",
      );
    });

    it("returns rows as arrays from raw()", async () => {
      const db = database();
      const t = table("raw");
      await db.prepare(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, name TEXT)`).run();
      await db.prepare(`INSERT INTO ${t} (name) VALUES ('a'), ('b')`).run();

      // Two columns with one name stay two values.
      expect(await db.prepare(`SELECT id, name, name FROM ${t} ORDER BY id`).raw()).toEqual([
        [1, "a", "a"],
        [2, "b", "b"],
      ]);
    });

    it("runs the statements of one query in order, as one unit, with values for the last", async () => {
      const db = database();
      const t = table("multi");

      // The second statement uses the table that the first one creates.
      await db
        .prepare(`CREATE TABLE ${t} (name TEXT UNIQUE); INSERT INTO ${t} VALUES ('a');`)
        .run();
      expect((await db.prepare(`SELECT name FROM ${t}`).all()).results).toEqual([{ name: "a" }]);

      // A failed statement takes back the statements before it.
      await expect(
        db.prepare(`INSERT INTO ${t} VALUES ('b'); INSERT INTO ${t} VALUES ('a')`).run(),
      ).rejects.toThrow(/^D1_ERROR: UNIQUE constraint failed/);
      expect((await db.prepare(`SELECT name FROM ${t}`).all()).results).toEqual([{ name: "a" }]);

      // Only the last statement takes values, and its rows are the result.
      const last = await db
        .prepare(`INSERT INTO ${t} VALUES ('c'); SELECT name FROM ${t} WHERE name = ?`)
        .bind("c")
        .all();
      expect(last.results).toEqual([{ name: "c" }]);
    });

    it("fails a call with more or fewer values than parameters", async () => {
      const db = database();
      const t = table("parameters");
      await db.prepare(`CREATE TABLE ${t} (a, b)`).run();
      const insert = db.prepare(`INSERT INTO ${t} VALUES (?, ?)`);
      const wrong = "D1_ERROR: Wrong number of parameter bindings for SQL query.";

      await expect(insert.bind(1).run()).rejects.toThrow(wrong);
      await expect(insert.bind(1, 2, 3).run()).rejects.toThrow(wrong);
      await expect(insert.run()).rejects.toThrow(wrong);
      expect(await db.prepare(`SELECT count(*) AS n FROM ${t}`).first("n")).toBe(0);
      // Numbered parameters count up to the highest number.
      expect(await db.prepare("SELECT ?1 AS a, ?3 AS c").bind(1, 2, 3).first()).toEqual({
        a: 1,
        c: 3,
      });
    });

    it("refuses SQL transaction statements", async () => {
      const db = database();

      const t = table("transaction");
      await db.prepare(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY)`).run();
      const refused =
        /^D1_ERROR: To execute a transaction, please use the state\.storage\.transaction\(\)/;

      for (const sql of ["BEGIN", "SAVEPOINT s", "-- a comment\nBEGIN TRANSACTION", ";BEGIN"]) {
        await expect(db.prepare(sql).run()).rejects.toThrow(refused);
      }
      // A COMMIT after another statement ends neither the query nor the batch around it.
      await expect(db.prepare(`INSERT INTO ${t} VALUES (1);;COMMIT`).run()).rejects.toThrow(
        refused,
      );
      await expect(
        db.batch([
          db.prepare(`INSERT INTO ${t} VALUES (2)`),
          db.prepare("SELECT 1; ; COMMIT"),
          db.prepare(`INSERT INTO ${t} VALUES (2)`),
        ]),
      ).rejects.toThrow(refused);
      expect(await db.prepare(`SELECT count(*) AS n FROM ${t}`).first("n")).toBe(0);
      // No transaction stays open: a batch still works.
      await db.batch([db.prepare(`INSERT INTO ${t} VALUES (3)`)]);
      expect(await db.prepare(`SELECT count(*) AS n FROM ${t}`).first("n")).toBe(1);
    });

    it("rejects a query without a statement", async () => {
      const db = database();

      await expect(db.prepare("").run()).rejects.toThrow("D1_ERROR: No SQL statements detected.");
      await expect(db.prepare("-- nothing").run()).rejects.toThrow(
        "D1_ERROR: SQL code did not contain a statement.",
      );
    });

    it("binds an array of bytes as binary data and refuses other arrays", async () => {
      const db = database();
      const t = table("bytes");
      await db.prepare(`CREATE TABLE ${t} (data BLOB)`).run();

      await db.prepare(`INSERT INTO ${t} VALUES (?)`).bind([1, 2, 255]).run();

      expect(await db.prepare(`SELECT data, typeof(data) AS type FROM ${t}`).first()).toEqual({
        data: [1, 2, 255],
        type: "blob",
      });
      expect(() => db.prepare("SELECT ? AS v").bind([1, 300])).toThrow(
        "D1_TYPE_ERROR: Type 'object' not supported for value '1,300'",
      );
    });

    it("stores Infinity and NaN as NULL", async () => {
      const result = await database()
        .prepare("SELECT ? AS a, typeof(?) AS b, ? AS c")
        .bind(Infinity, -Infinity, NaN)
        .first();

      expect(result).toEqual({ a: null, b: "null", c: null });
    });

    it("rounds an integer above 2^53 instead of failing, also a row ID", async () => {
      const db = database();
      const t = table("big");
      await db.prepare(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, v TEXT)`).run();

      expect(await db.prepare("SELECT 9007199254740993 AS v").first("v")).toBe(9007199254740992);
      const insert = await db.prepare(`INSERT INTO ${t} VALUES (9007199254740993, 'big')`).run();
      expect(insert.meta.last_row_id).toBe(9007199254740992);
      // The next call still works.
      expect(await db.prepare("SELECT 1 AS one").first("one")).toBe(1);
    });

    it("binds numbers as REAL", async () => {
      expect(await database().prepare("SELECT typeof(?) AS t").bind(1).first("t")).toBe("real");
    });

    it("keeps a column named __proto__", async () => {
      expect(await database().prepare("SELECT 1 AS __proto__").all()).toMatchObject({
        results: [Object.fromEntries([["__proto__", 1]])],
      });
      const [row] = (await database().prepare("SELECT 1 AS __proto__").all()).results;
      expect(Object.hasOwn(row as object, "__proto__")).toBe(true);
    });

    it("reads comments the way SQLite does", async () => {
      const db = database();

      // An END after a later comment is part of a CASE, not a transaction statement.
      expect(
        await db.prepare("/* n */ SELECT CASE WHEN 1 THEN 2 /* c */ END AS v").first("v"),
      ).toBe(2);
      // "--" inside a block comment starts no line comment, so SELECT 2 still runs.
      expect(
        await db.prepare("SELECT 1 AS a; /* a\n-- */\nSELECT 2 AS b /* z */").all(),
      ).toMatchObject({ results: [{ b: 2 }] });
    });

    it("rejects a character after the last statement that SQLite does not read as space", async () => {
      await expect(database().prepare("SELECT 1 AS a;\u00a0").all()).rejects.toThrow(/^D1_ERROR: /);
    });

    it("rejects an unterminated comment after the last statement", async () => {
      await expect(database().prepare("SELECT 1 AS a; /* trailing").first()).rejects.toThrow(
        "D1_ERROR: SQL code did not contain a statement.",
      );
    });

    it("rolls back a query with several statements inside a batch", async () => {
      const db = database();
      const t = table("multi_batch");
      await db.prepare(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY)`).run();

      await expect(
        db.batch([
          db.prepare(`INSERT INTO ${t} VALUES (1)`),
          db.prepare(`INSERT INTO ${t} VALUES (2); INSERT INTO ${t} VALUES (2)`),
        ]),
      ).rejects.toThrow(/^D1_ERROR: UNIQUE constraint failed/);
      expect(await db.prepare(`SELECT count(*) AS n FROM ${t}`).first("n")).toBe(0);
      await db.batch([db.prepare(`INSERT INTO ${t} VALUES (3)`)]);
      expect(await db.prepare(`SELECT count(*) AS n FROM ${t}`).first("n")).toBe(1);
    });
  });
}
