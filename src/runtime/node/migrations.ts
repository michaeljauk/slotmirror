/**
 * Applies the D1 migrations in `migrations/` to the registry database of the Node runtime, the way
 * `wrangler d1 migrations apply` does on Cloudflare:
 *
 * - The files run in name order, each one at most once.
 * - The table `d1_migrations` records each applied file, with the columns of wrangler. So a database
 *   exported from D1 keeps its migration state, and the runner applies only the files after it.
 * - Each file runs as a whole, in one transaction with its record in `d1_migrations`. The runner
 *   does not split a file at `;`: the triggers of 0019 and 0020 hold `;` inside `BEGIN … END`.
 *
 * If a file fails, nothing of it stays, and the error names the file. Files after it do not run.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** One migration file. */
export interface Migration {
  name: string;
  sql: string;
}

/** The migration table as wrangler creates it. */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

/** The `.sql` files of a folder, in name order, as wrangler lists them. */
export function readMigrations(dir: string): Migration[] {
  return (
    readdirSync(dir, { withFileTypes: true })
      // Like wrangler, skip hidden files such as the `._` files that macOS writes on some volumes.
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".sql") && !entry.name.startsWith("."),
      )
      .map((entry) => entry.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }))
  );
}

/** Applies the migrations that `d1_migrations` does not list yet. Returns their names. */
export function applyMigrations(db: DatabaseSync, migrations: readonly Migration[]): string[] {
  db.exec(MIGRATIONS_TABLE);
  const rows = db.prepare("SELECT name FROM d1_migrations").all() as { name: string }[];
  const done = new Set(rows.map((row) => row.name));
  const record = db.prepare("INSERT INTO d1_migrations (name) VALUES (?)");
  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      record.run(migration.name);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${migration.name} failed: ${message}`, { cause: error });
    }
    applied.push(migration.name);
  }
  return applied;
}
