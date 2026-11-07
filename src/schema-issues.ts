import type * as z from "zod/mini";

const ISSUE_CODE = /^[a-z_]{1,40}$/;
/** A field name. No "@", "." or "-", so an email address or a title cannot pass as one. */
const PATH_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/**
 * Fields that hold a record: the key after them comes from the data, not from the schema. Google
 * extended properties ("private", "shared") and Graph batch response headers.
 */
const RECORD_FIELDS = new Set(["private", "shared", "headers"]);
const MAX_ISSUES = 5;

/**
 * A schema error as "schema <code>@<path> ...", for example "schema invalid_type@value.1.owner".
 * A Zod error that crossed a Durable Object boundary keeps only its message, the JSON list of its
 * issues, so the issues come from the error itself or from that message. Only the code and the
 * path go into the log: never the expected or received values, and never Zod's text.
 */
export function schemaIssues(error: Error): string | undefined {
  let issues: unknown = (error as { issues?: unknown }).issues;
  if (issues === undefined) {
    if (!error.message.startsWith("[")) return undefined;
    try {
      issues = JSON.parse(error.message);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const parts: string[] = [];
  for (const issue of issues.slice(0, MAX_ISSUES)) {
    const { code, path } = (issue ?? {}) as { code?: unknown; path?: unknown };
    if (typeof code !== "string" || !ISSUE_CODE.test(code) || !Array.isArray(path)) {
      return undefined;
    }
    const keys = path.map((key: unknown, index) => {
      if (typeof key === "number") return key;
      const parent: unknown = index > 0 ? path[index - 1] : undefined;
      if (typeof parent === "string" && RECORD_FIELDS.has(parent)) return "?";
      return typeof key === "string" && PATH_KEY.test(key) ? key : "?";
    });
    parts.push(`${code}@${keys.join(".")}`);
  }
  return `schema ${parts.join(" ")}`;
}

/**
 * The items that fit the schema, in their order. A provider can send one item in a form that the
 * schema does not know, as Graph did with `"owner": null`. That item is skipped and logged with its
 * index and its schema issues, so that the other items still load.
 */
export function parseEach<T>(items: unknown[], schema: z.ZodMiniType<T>, what: string): T[] {
  const parsed: T[] = [];
  items.forEach((item, index) => {
    const result = schema.safeParse(item);
    if (result.success) {
      parsed.push(result.data);
      return;
    }
    // Only the issue codes and paths, never the item: it holds names and addresses.
    const issues = schemaIssues(result.error) ?? "schema";
    console.warn(`Skipped a ${what} that does not fit the schema`, index, issues);
  });
  return parsed;
}
