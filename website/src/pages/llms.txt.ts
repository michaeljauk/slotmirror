import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { repo } from "../site";

// A plain-text index of the site for language models, in the llms.txt format (llmstxt.org).
// The page list comes from the docs collection, so a new or renamed page appears here without an
// edit.
const summary =
  'slotmirror mirrors busy blocks between Microsoft 365 (Outlook) and Google calendars. By default only "Busy" crosses from one calendar to another. You deploy it yourself: it runs in your own Cloudflare account, today on the Workers Free plan.';

// Pages of a translation have ids with a locale prefix, such as "de/guides/…". They do not match
// these prefixes, so this file stays in English.
const sections = [
  { prefix: "guides/", heading: "Guides" },
  { prefix: "docs/", heading: "Docs" },
];

export const GET: APIRoute = async ({ site }) => {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const url = (path: string) => new URL(`${base}/${path}`, site).href;
  const entries = await getCollection("docs", ({ data }) => !data.draft);

  const lines = ["# slotmirror", "", `> ${summary}`, ""];
  for (const { prefix, heading } of sections) {
    const pages = entries
      .filter((entry) => entry.id.startsWith(prefix))
      // Guides have a sidebar order; docs pages do not and follow by id.
      .sort(
        (a, b) =>
          (a.data.sidebar.order ?? Number.MAX_SAFE_INTEGER) -
            (b.data.sidebar.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
      );
    lines.push(`## ${heading}`, "");
    for (const page of pages) {
      const description = page.data.description ? `: ${page.data.description}` : "";
      lines.push(`- [${page.data.title}](${url(`${page.id}/`)})${description}`);
    }
    lines.push("");
  }
  lines.push(
    "## Optional",
    "",
    `- [Changelog](${url("changelog/")}): Releases of slotmirror.`,
    `- [Source code](${repo}): The repository on GitHub.`,
    "",
  );

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
