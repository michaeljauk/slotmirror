import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { I18nProvider, i18nFor } from "../src/i18n";
import { LanguageSwitch } from "../src/pages/layout";

/** The language links that the switch renders for a page. */
async function linksFor(page: string): Promise<string[]> {
  const app = new Hono();
  app.get("/", (c) =>
    c.html(
      <I18nProvider value={i18nFor("en")} languagePage={page}>
        <LanguageSwitch />
      </I18nProvider>,
    ),
  );
  const html = await (await app.request("/")).text();
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "");
}

describe("language links", () => {
  it("keeps a local page and its query", async () => {
    expect(await linksFor("/rules?open=a")).toEqual(["/rules?open=a&amp;lang=de"]);
  });

  it("never links to another host, and never throws", async () => {
    for (const page of ["//evil.example/x", "/\\evil.example", "/.//evil.example", "/\t/%5C"]) {
      expect(await linksFor(page)).toEqual(["/?lang=de"]);
    }
  });
});
