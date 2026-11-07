import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { applyMigrations, readMigrations, type Migration } from "./migrations";
import { openSqlite } from "./sql-database";

const MIGRATIONS = fileURLToPath(new URL("../../../migrations", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "slotmirror-migrations-"));
let files = 0;

function database(): DatabaseSync {
  return openSqlite(join(dir, `db-${++files}.sqlite`));
}

function names(sqlite: DatabaseSync): string[] {
  const rows = sqlite.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
  return rows.map((row) => String(row.name));
}

function tables(sqlite: DatabaseSync): string[] {
  const rows = sqlite
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'm\\_%' ESCAPE '\\'",
    )
    .all();
  return rows.map((row) => String(row.name)).sort();
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the migration runner of the Node runtime", () => {
  it("applies every file of migrations/ once, in name order", () => {
    const all = readMigrations(MIGRATIONS);
    const sqlite = database();

    expect(all.length).toBeGreaterThan(20);
    expect(all.map((m) => m.name)).toEqual(all.map((m) => m.name).sort());
    expect(applyMigrations(sqlite, all)).toEqual(all.map((m) => m.name));
    expect(names(sqlite)).toEqual(all.map((m) => m.name));
    expect(applyMigrations(sqlite, all)).toEqual([]);
    expect(names(sqlite)).toEqual(all.map((m) => m.name));
    sqlite.close();
  });

  it("applies only the files after the last applied one, as for a database exported from D1", () => {
    const all = readMigrations(MIGRATIONS);
    const sqlite = database();
    applyMigrations(sqlite, all.slice(0, 10));

    expect(applyMigrations(sqlite, all)).toEqual(all.slice(10).map((m) => m.name));
    expect(names(sqlite)).toEqual(all.map((m) => m.name));
    sqlite.close();
  });

  it("runs a file as a whole, with triggers that hold semicolons", () => {
    const sqlite = database();
    applyMigrations(sqlite, [
      {
        name: "0001_trigger.sql",
        sql: `CREATE TABLE m_rules (id TEXT PRIMARY KEY, enabled INTEGER);
              CREATE TABLE m_holds (rule_id TEXT);
              CREATE TRIGGER m_end AFTER UPDATE OF enabled ON m_rules WHEN NEW.enabled = 1
              BEGIN
                DELETE FROM m_holds WHERE rule_id = NEW.id;
                DELETE FROM m_holds WHERE rule_id = 'all';
              END;
              -- a comment after the last statement`,
      },
    ]);
    sqlite.exec("INSERT INTO m_rules VALUES ('r', 0); INSERT INTO m_holds VALUES ('r'), ('all')");
    sqlite.exec("UPDATE m_rules SET enabled = 1");

    expect(sqlite.prepare("SELECT count(*) AS n FROM m_holds").get()).toEqual({ n: 0 });
    sqlite.close();
  });

  it("keeps nothing of a failed file, names it, and stops before the next one", () => {
    const sqlite = database();
    const first: Migration = { name: "0001_a.sql", sql: "CREATE TABLE m_a (id INTEGER);" };
    const broken: Migration = {
      name: "0002_b.sql",
      sql: "CREATE TABLE m_b (id INTEGER); INSERT INTO m_missing VALUES (1);",
    };
    const last: Migration = { name: "0003_c.sql", sql: "CREATE TABLE m_c (id INTEGER);" };

    expect(() => applyMigrations(sqlite, [first, broken, last])).toThrow(
      "Migration 0002_b.sql failed: no such table: m_missing",
    );
    expect(tables(sqlite)).toEqual(["m_a"]);
    expect(names(sqlite)).toEqual(["0001_a.sql"]);

    const fixed = { ...broken, sql: "CREATE TABLE m_b (id INTEGER);" };
    expect(applyMigrations(sqlite, [first, fixed, last])).toEqual(["0002_b.sql", "0003_c.sql"]);
    expect(tables(sqlite)).toEqual(["m_a", "m_b", "m_c"]);
    sqlite.close();
  });

  it("reads only visible .sql files, sorted by name", () => {
    const folder = mkdtempSync(join(dir, "folder-"));
    writeFileSync(join(folder, "0002_b.sql"), "SELECT 2;");
    writeFileSync(join(folder, "0010_c.sql"), "SELECT 3;");
    writeFileSync(join(folder, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(folder, "README.md"), "not a migration");
    writeFileSync(join(folder, "._0003_x.sql"), "not a migration either");

    expect(readMigrations(folder)).toEqual([
      { name: "0001_a.sql", sql: "SELECT 1;" },
      { name: "0002_b.sql", sql: "SELECT 2;" },
      { name: "0010_c.sql", sql: "SELECT 3;" },
    ]);
  });
});
