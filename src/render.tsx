import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { I18nProvider, i18nFromContext } from "./i18n";

/** Render a page in the request's locale. */
export function render(c: Context, page: Child, status: ContentfulStatusCode = 200) {
  return c.html(<I18nProvider value={i18nFromContext(c)}>{page}</I18nProvider>, status);
}
