import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import type { StarlightRouteData } from "@astrojs/starlight/route-data";
import { getCollection } from "astro:content";

type HeadTag = StarlightRouteData["head"][number];
type SidebarEntry = StarlightRouteData["sidebar"][number];

const isCanonical = (tag: HeadTag) =>
  tag.attrs?.rel === "canonical" || tag.attrs?.property === "og:url";
const isAlternate = (tag: HeadTag) =>
  tag.tag === "link" && tag.attrs?.rel === "alternate" && "hreflang" in (tag.attrs ?? {});

// The ids of all docs pages. A translation has a locale prefix, such as "de/guides/…".
let ids: Promise<Set<string>> | undefined;
const pageIds = () =>
  (ids ??= getCollection("docs").then((entries) => new Set(entries.map((entry) => entry.id))));

// The page id that an address in the site points to: "https://…/de/guides/x/" gives "de/guides/x",
// and the root gives "index". Pages outside the docs collection, such as /changelog/, match no id.
const base = import.meta.env.BASE_URL.replace(/\/$/, "");
const idOf = (href: string) =>
  new URL(href).pathname.slice(base.length).replace(/^\/|\/$/g, "") || "index";

// Pages that exist only in English. Starlight gives their links the locale prefix on translated
// pages, so these links would lead to a 404.
const englishOnly = ["changelog/"];

function unprefix(entries: SidebarEntry[], prefix: string) {
  for (const entry of entries) {
    if (entry.type === "group") unprefix(entry.entries, prefix);
    else {
      const path = englishOnly.find(
        (page) => entry.href.replace(/\/?$/, "/") === `${prefix}/${page}`,
      );
      if (path) entry.href = `${base}/${path}`;
    }
  }
}

export const onRequest = defineRouteMiddleware(async (context) => {
  const route = context.locals.starlightRoute;

  // On a translated page, the logo leads to the home page, which exists only in English. The
  // sidebar and the page links lead to the English-only pages.
  if (route.locale) {
    const prefix = `${base}/${route.locale}`;
    route.siteTitleHref = `${base}/`;
    unprefix(route.sidebar, prefix);
    for (const link of [route.pagination.prev, route.pagination.next]) {
      if (link) unprefix([link], prefix);
    }
  }

  // The 404 page and the fallbacks must not be indexed. Starlight gives its 404 route the id "404"
  // in every locale. A fallback shows the English text under the address of a locale, so search
  // engines index the English page instead. Neither has a canonical address.
  if (route.id === "404" || route.isFallback) {
    route.head = route.head.filter((tag) => !isCanonical(tag) && !isAlternate(tag));
    route.head.push({ tag: "meta", attrs: { name: "robots", content: "noindex" } });
    // A fallback shows English text, so its language is English.
    if (route.isFallback) {
      route.lang = "en";
      for (const tag of route.head) {
        if (tag.attrs?.property === "og:locale") tag.attrs.content = "en";
      }
    }
    return;
  }

  // Starlight links every page to its address in all locales. Keep a link only if a page exists
  // there. If no other language is left, the page has no translation, so it needs no links.
  const existing = await pageIds();
  const alternates = route.head.filter(
    (tag) => isAlternate(tag) && existing.has(idOf(String(tag.attrs?.href))),
  );
  const languages = new Set(
    alternates.map((tag) => tag.attrs?.hreflang).filter((lang) => lang !== "x-default"),
  );
  route.head = route.head.filter(
    (tag) => !isAlternate(tag) || (languages.size > 1 && alternates.includes(tag)),
  );
});
