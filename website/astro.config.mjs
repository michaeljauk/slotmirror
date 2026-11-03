// @ts-check
import { readdirSync } from "node:fs";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { previewAlt, previewHeight, previewWidth, repo } from "./src/site.ts";

// The only place that sets where the site lives. Pages build links from these two values.
const site = "https://slotmirror.com";
const base = "";

const previewImage = `${site}${base}/social-preview.png`;

/** @type {import("@astrojs/starlight/types").StarlightUserConfig["head"]} */
const head = [
  { tag: "meta", attrs: { property: "og:image", content: previewImage } },
  { tag: "meta", attrs: { property: "og:image:width", content: previewWidth } },
  { tag: "meta", attrs: { property: "og:image:height", content: previewHeight } },
  { tag: "meta", attrs: { property: "og:image:alt", content: previewAlt } },
  { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
  { tag: "meta", attrs: { name: "twitter:image", content: previewImage } },
  { tag: "meta", attrs: { name: "twitter:image:alt", content: previewAlt } },
];

// English lives at the root. For another locale, only the pages under src/content/docs/<locale>/
// are translated. For every other page, Starlight builds an English fallback under /<locale>/;
// src/route-data.ts marks those noindex, and the sitemap leaves them out.
const locales = {
  root: { label: "English", lang: "en" },
  de: { label: "Deutsch", lang: "de" },
};
const translations = Object.keys(locales).filter((locale) => locale !== "root");
const translated = new Set(
  translations.flatMap((locale) =>
    readdirSync(new URL(`./src/content/docs/${locale}/`, import.meta.url), { recursive: true })
      .map(String)
      .filter((file) => /\.mdx?$/.test(file))
      .map((file) =>
        file
          .replaceAll("\\", "/")
          .replace(/\.mdx?$/, "")
          .replace(/(^|\/)index$/, ""),
      )
      .map((page) => (page ? `${locale}/${page}` : locale)),
  ),
);

export default defineConfig({
  site,
  base,
  output: "static",
  integrations: [
    // Starlight adds this integration itself unless the config has it. It is here for the filter.
    sitemap({
      filter: (page) => {
        const path = new URL(page).pathname.slice(base.length).replace(/^\/|\/$/g, "");
        const locale = translations.find((code) => path === code || path.startsWith(`${code}/`));
        return !locale || translated.has(path);
      },
    }),
    starlight({
      title: "slotmirror",
      defaultLocale: "root",
      locales,
      description:
        "Stop getting double-booked across Microsoft 365 and Google calendars. By default only Busy leaves a calendar. Self-hosted on Cloudflare Workers, free plan.",
      logo: {
        light: "../design/logo/lockup-light-bg.svg",
        dark: "../design/logo/lockup-dark-bg.svg",
        alt: "slotmirror",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      head,
      components: { Head: "./src/components/Head.astro" },
      routeMiddleware: "./src/route-data.ts",
      social: [{ icon: "github", label: "GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/website/` },
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Start here",
          translations: { de: "Erste Schritte" },
          items: [
            { label: "Introduction", slug: "docs/introduction" },
            { label: "Quickstart", slug: "docs/quickstart" },
          ],
        },
        {
          label: "Set up",
          translations: { de: "Einrichten" },
          items: [
            { label: "Settings reference", slug: "docs/settings" },
            { label: "Microsoft Entra app", slug: "docs/entra-setup" },
            { label: "Google OAuth client", slug: "docs/google-setup" },
            { label: "Push notifications", slug: "docs/push-notifications" },
            { label: "MCP server", slug: "docs/mcp" },
            { label: "Updating your deployment", slug: "docs/updating" },
          ],
        },
        {
          label: "Teams and privacy",
          translations: { de: "Teams und Datenschutz" },
          items: [
            { label: "Privacy and data location", slug: "docs/privacy" },
            { label: "Organisations", slug: "docs/organisations" },
          ],
        },
        {
          label: "Reference",
          translations: { de: "Referenz" },
          items: [
            { label: "Limits", slug: "docs/limits" },
            { label: "Troubleshooting", slug: "docs/troubleshooting" },
            { label: "FAQ", slug: "docs/faq" },
            { label: "Local development and load tests", slug: "docs/development" },
          ],
        },
        {
          label: "Guides",
          translations: { de: "Anleitungen" },
          items: [{ autogenerate: { directory: "guides" } }],
        },
        { label: "Changelog", link: "/changelog/" },
      ],
    }),
  ],
});
