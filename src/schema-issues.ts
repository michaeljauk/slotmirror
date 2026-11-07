import type * as z from "zod/mini";
import { schemaIssues } from "./error-fields";
import { log } from "./telemetry";

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
    log.warn("provider.item_skipped", { what, index, issues });
  });
  return parsed;
}
