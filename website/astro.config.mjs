// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const repo = "https://github.com/michaeljauk/slotmirror";

export default defineConfig({
  site: "https://michaeljauk.github.io",
  base: "/slotmirror",
  output: "static",
  integrations: [
    starlight({
      title: "slotmirror",
      description:
        "Keep Microsoft 365 and Google calendars in sync as busy blocks. Self-hosted on Cloudflare Workers, free plan.",
      logo: {
        light: "../design/logo/lockup-light-bg.svg",
        dark: "../design/logo/lockup-dark-bg.svg",
        alt: "slotmirror",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/website/` },
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Introduction", slug: "docs/introduction" },
            { label: "Quickstart", slug: "docs/quickstart" },
          ],
        },
        {
          label: "Set up",
          items: [
            { label: "Settings reference", slug: "docs/settings" },
            { label: "Microsoft Entra app", slug: "docs/entra-setup" },
            { label: "Google OAuth client", slug: "docs/google-setup" },
            { label: "Push notifications", slug: "docs/push-notifications" },
          ],
        },
        {
          label: "Teams and privacy",
          items: [
            { label: "Privacy and data location", slug: "docs/privacy" },
            { label: "Organisations", slug: "docs/organisations" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Limits", slug: "docs/limits" },
            { label: "FAQ", slug: "docs/faq" },
            { label: "Local development and load tests", slug: "docs/development" },
          ],
        },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Changelog", link: "/changelog/" },
      ],
    }),
  ],
});
