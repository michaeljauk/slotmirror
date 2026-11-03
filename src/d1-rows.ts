/**
 * A view of a D1 database that adds up the rows its queries read, from D1's `meta.rows_read`.
 * The MCP endpoint charges these rows to the deployment's daily budget. A hosting adapter on
 * SQLite would count rows its own way; this file is the only place that knows the D1 field.
 */
export function countingRows(db: D1Database): { db: D1Database; rows: () => number } {
  let rows = 0;
  const count = (meta: { rows_read?: number } | undefined, fallback: number) => {
    rows += typeof meta?.rows_read === "number" ? meta.rows_read : fallback;
  };
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values));
        }
        if (key === "all" || key === "run") {
          return async () => {
            const result: D1Result = key === "all" ? await target.all() : await target.run();
            count(result.meta, result.results?.length ?? 1);
            return result;
          };
        }
        if (key === "first" || key === "raw") {
          // These calls return no meta. Count one row each, so that no query goes uncharged.
          return async (...args: unknown[]) => {
            count(undefined, 1);
            return (target[key] as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      // `batch` is left out on purpose: D1 may refuse statements that are proxies, and the read
      // model sends no batch. A test fails if it ever does.
      if (key === "prepare") return (sql: string) => wrapStatement(target.prepare(sql));
      if (key === "batch") throw new Error("countingRows does not support batch");
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted, rows: () => rows };
}
