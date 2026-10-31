import type { Child } from "hono/jsx";
import { APP_NAME } from "../brand";
import { LOCALE_NAMES, LOCALES, useI18n, useLanguageHref, type Locale } from "../i18n";
import type { CurrentUser } from "../users";
import { buildVersionLabel } from "../version";

export type NavItem = "accounts" | "rules" | "activity" | "admin";

/** A stroke icon for the navigation. The label next to it carries the meaning. */
function NavIcon(props: { children: Child }) {
  return (
    <svg
      class="nav-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

/**
 * The pages of the navigation, in order. A new page needs one entry here and its label in `nav`
 * of the message catalogs. The sidebar and the phone bar both grow with this list.
 */
const NAV: readonly {
  id: NavItem;
  href: string;
  adminOnly?: boolean;
  icon: () => Child;
}[] = [
  {
    id: "accounts",
    href: "/",
    icon: () => (
      <NavIcon>
        <rect x="3" y="5" width="18" height="16" rx="2.5" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </NavIcon>
    ),
  },
  {
    id: "rules",
    href: "/rules",
    icon: () => (
      <NavIcon>
        <path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4" />
      </NavIcon>
    ),
  },
  {
    id: "activity",
    href: "/activity",
    icon: () => (
      <NavIcon>
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </NavIcon>
    ),
  },
  {
    id: "admin",
    href: "/admin",
    adminOnly: true,
    icon: () => (
      <NavIcon>
        <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      </NavIcon>
    ),
  },
];

/** The logo mark: two calendars, the event mirrored as a hatched busy block. */
function BrandMark() {
  return (
    <svg class="brand-mark" width="28" height="28" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <pattern
          id="brand-hatch"
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="2.4" height="5" fill="currentColor" />
        </pattern>
      </defs>
      <g fill="none" stroke="currentColor" stroke-width="4">
        <rect x="5" y="7" width="23" height="50" rx="6" />
        <rect x="36" y="7" width="23" height="50" rx="6" />
      </g>
      <rect x="10.5" y="22" width="12" height="18" rx="3" fill="var(--accent)" />
      <rect x="41.5" y="22" width="12" height="18" rx="3" fill="url(#brand-hatch)" />
    </svg>
  );
}

function initials(email: string): string {
  const name = email.split("@")[0] ?? "";
  const parts = name.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

function LanguageLink(props: { code: Locale }) {
  return (
    <a
      class="segment"
      href={useLanguageHref(props.code)}
      hreflang={props.code}
      title={LOCALE_NAMES[props.code]}
    >
      {props.code.toUpperCase()}
    </a>
  );
}

/** Segmented control that switches the language; the detector stores the choice in a cookie. */
export function LanguageSwitch() {
  const { locale, t } = useI18n();
  return (
    <span class="segmented" role="group" aria-label={t.nav.language}>
      {LOCALES.map((code) =>
        code === locale ? (
          <span class="segment active" aria-current="true" title={LOCALE_NAMES[code]}>
            {code.toUpperCase()}
          </span>
        ) : (
          <LanguageLink code={code} />
        ),
      )}
    </span>
  );
}

export function Layout(props: {
  title: string;
  user?: CurrentUser | null;
  active?: NavItem;
  children: Child;
}) {
  const { user } = props;
  const { locale, t } = useI18n();
  const version = buildVersionLabel();
  const footer = (
    <footer class="footer">
      <span class="footer-name">{APP_NAME}</span>
      <span class="footer-dot" aria-hidden="true">
        ·
      </span>
      <a href="/privacy">{t.nav.privacy}</a>
      {version ? (
        <>
          <span aria-hidden="true">·</span>
          <span class="version" title={t.nav.version}>
            {version}
          </span>
        </>
      ) : null}
    </footer>
  );
  const brand = (
    <a href="/" class="brand">
      <BrandMark />
      <span class="brand-name">{APP_NAME}</span>
    </a>
  );
  return (
    <html lang={locale}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${props.title} · ${APP_NAME}`}</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/style.css" />
        <script src="/editor.js" defer />
      </head>
      {user ? (
        <body class="has-sidebar">
          <aside class="sidebar">
            {brand}
            {/* On a phone the same links form a row under the logo: one tap to each page. */}
            <nav class="nav" aria-label={t.nav.main}>
              {NAV.filter((item) => !item.adminOnly || user.role === "admin").map((item) => (
                <a href={item.href} aria-current={props.active === item.id ? "page" : undefined}>
                  {item.icon()}
                  <span>{t.nav[item.id]}</span>
                </a>
              ))}
            </nav>
            {/* Native popover: opens on click, closes on outside click and Escape, no script. */}
            <button
              type="button"
              class="user-button"
              popovertarget="user-menu"
              aria-label={t.nav.accountMenu}
            >
              <span class="avatar">{initials(user.email)}</span>
              <span class="user-email">{user.email}</span>
              <span class="chevron" aria-hidden="true">
                ▾
              </span>
            </button>
            <div id="user-menu" class="menu" popover="auto">
              <div class="menu-head">
                <div class="menu-email">{user.email}</div>
                <span class={user.role === "admin" ? "badge admin" : "badge"}>
                  {t.roles[user.role]}
                </span>
              </div>
              <div class="menu-row">
                <span class="muted">{t.nav.language}</span>
                <LanguageSwitch />
              </div>
              <div class="menu-separator" />
              <a class="menu-item" href="/account/delete">
                {t.nav.deleteMyData}
              </a>
              <form method="post" action="/auth/logout">
                <button type="submit" class="menu-item">
                  {t.nav.signOut}
                </button>
              </form>
            </div>
          </aside>
          <main>{props.children}</main>
          {footer}
        </body>
      ) : (
        <body>
          <header class="topbar">
            <div class="topbar-inner">{brand}</div>
          </header>
          <main>{props.children}</main>
          {footer}
        </body>
      )}
    </html>
  );
}
