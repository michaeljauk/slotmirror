import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { registryContract } from "../../../test/registry-contract";
import { describeSchema } from "../../../test/registry-schema";
import { applyMigrations, readMigrations } from "./migrations";
import { NodeSqlDatabase, openSqlite } from "./sql-database";

const MIGRATIONS = fileURLToPath(new URL("../../../migrations", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "slotmirror-registry-"));
const open: DatabaseSync[] = [];

/** A registry file in the temp folder, with all migrations, as the image opens it. */
function registry(name: string): { file: string; sqlite: DatabaseSync; db: NodeSqlDatabase } {
  const file = join(dir, `${name}.sqlite`);
  const sqlite = openSqlite(file);
  open.push(sqlite);
  applyMigrations(sqlite, readMigrations(MIGRATIONS));
  return { file, sqlite, db: new NodeSqlDatabase(sqlite) };
}

afterAll(() => {
  for (const sqlite of open) if (sqlite.isOpen) sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

// The same contract runs on D1 in test/registry.workers.test.ts.
const contract = registry("contract");
registryContract(() => contract.db);

describe("the schema of the Node runtime after all migrations", () => {
  it("matches test/fixtures/registry-schema.json, as D1 does", async () => {
    const schema = await describeSchema(registry("schema").db);
    // `pnpm db:schema` rewrites the file. test/registry-schema.workers.test.ts holds D1 to it.
    await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(
      "../../../test/fixtures/registry-schema.json",
    );
  });
});

describe("a registry file of the Node runtime", () => {
  it("opens with WAL, foreign keys, a busy timeout and secure_delete", () => {
    const { sqlite } = registry("pragmas");
    const pragma = (name: string) => Object.values(sqlite.prepare(`PRAGMA ${name}`).get()!)[0];

    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("synchronous")).toBe(1); // NORMAL
    expect(pragma("foreign_keys")).toBe(1);
    expect(pragma("busy_timeout")).toBe(5000);
    expect(pragma("secure_delete")).toBe(1);
  });

  it("keeps no deleted value in the file", () => {
    const secret = `refresh-token-${crypto.randomUUID()}`;
    /** Writes and deletes the secret, then returns whether the file still holds it. */
    const leftInFile = (sqlite: DatabaseSync, file: string) => {
      sqlite.exec("CREATE TABLE secrets (value TEXT)");
      sqlite.prepare("INSERT INTO secrets VALUES (?)").run(secret);
      sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      sqlite.exec("DELETE FROM secrets");
      sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      sqlite.close();
      return readFileSync(file).includes(secret);
    };

    const file = join(dir, "secure.sqlite");
    expect(leftInFile(openSqlite(file), file)).toBe(false);

    // Control: without secure_delete, SQLite leaves the value in a free page.
    const controlFile = join(dir, "control.sqlite");
    const control = openSqlite(controlFile);
    control.exec("PRAGMA secure_delete = OFF");
    expect(leftInFile(control, controlFile)).toBe(true);
  });
});
