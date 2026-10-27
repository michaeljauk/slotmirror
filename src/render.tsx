import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { I18nProvider, i18nFromContext, languagePage } from "./i18n";

/**
 * Render a page in the request's locale. The doctype keeps browsers in standards mode; without it
 * they use quirks mode, which adds margins below forms and changes fonts in form controls.
 */

export function render(c: Context, page: Child, status: ContentfulStatusCode = 200) {
  return c.html(
    <>
      {raw("<!doctype html>")}
      <I18nProvider value={i18nFromContext(c)} languagePage={languagePage(c)}>
        {page}
      </I18nProvider>
    </>,
    status,
  );
}
