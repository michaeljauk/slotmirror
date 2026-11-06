import type { SqlDatabase } from "../src/runtime/types";

/**
 * The schema of the registry database, in a form that is the same on D1 and on the Node runtime if
 * the migrations had the same effect: every table with its columns, keys, indexes and triggers.
 *
 * The SQL text of each object is part of it, without comments and whitespace. SQLite rewrites the
 * text on `ALTER TABLE … DROP COLUMN`, so it also shows whether 0020 and 0021 had the same effect.
 * `test/fixtures/registry-schema.json` holds the expected value. D1's own tables (`_cf_*`) and
 * SQLite's (`sqlite_*`) are left out.
 */
export async function describeSchema(db: SqlDatabase): Promise<RegistrySchema> {
  const { results: objects } = await db
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
    .all<{ type: string; name: string; tableName: string; sql: string | null }>();
  const tables: RegistrySchema["tables"] = {};
  for (const object of objects.filter((o) => o.type === "table")) {
    const name = object.name;
    const columns = await db
      .prepare(
        `SELECT name, type, "notnull" AS not_null, dflt_value AS default_value, pk AS primary_key,
                hidden
         FROM pragma_table_xinfo(?) ORDER BY cid`,
      )
      .bind(name)
      .all();
    const foreignKeys = await db
      .prepare(
        `SELECT "table", "from", "to", on_update, on_delete
         FROM pragma_foreign_key_list(?) ORDER BY id, seq`,
      )
      .bind(name)
      .all();
    const indexes = await db
      .prepare(
        `SELECT l.name, l."unique", l.origin, l.partial,
                (SELECT group_concat(coalesce(i.name, '<expr>'), ',')
                 FROM pragma_index_info(l.name) AS i) AS columns
         FROM pragma_index_list(?) AS l ORDER BY l.name`,
      )
      .bind(name)
      .all<{ name: string }>();
    const sqlOf = (indexName: string) =>
      normalizeSql(objects.find((o) => o.name === indexName)?.sql ?? null);
    tables[name] = {
      sql: normalizeSql(object.sql),
      columns: columns.results,
      foreignKeys: foreignKeys.results,
      indexes: indexes.results.map((index) => ({ ...index, sql: sqlOf(index.name) })),
    };
  }
  const others = objects
    .filter((o) => o.type !== "table" && o.type !== "index")
    .map((o) => ({ type: o.type, name: o.name, tableName: o.tableName, sql: normalizeSql(o.sql) }));
  return { tables, others };
}

export interface RegistrySchema {
  tables: Record<
    string,
    { sql: string | null; columns: unknown[]; foreignKeys: unknown[]; indexes: unknown[] }
  >;
  /** Triggers and views. */
  others: { type: string; name: string; tableName: string; sql: string | null }[];
}

/**
 * SQL text without comments and with one form of whitespace. The migration table of wrangler and
 * the one of the Cloudflare test runner differ only in spacing.
 */
function normalizeSql(sql: string | null): string | null {
  if (sql === null) return null;
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/ ?([(),]) ?/g, "$1")
    .trim();
}
