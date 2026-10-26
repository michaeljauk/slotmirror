import type { Child } from "hono/jsx";
import { APP_NAME } from "../brand";
import { LOCALE_NAMES, LOCALES, useI18n } from "../i18n";
import type { CurrentUser } from "../users";

export type NavItem = "accounts" | "rules" | "activity" | "admin";

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
          <a class="segment" href={`?lang=${code}`} hreflang={code} title={LOCALE_NAMES[code]}>
            {code.toUpperCase()}
          </a>
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
      <body>
        <header class="topbar">
          <div class="topbar-inner">
            <a href="/" class="brand">
              <BrandMark />
              <span class="brand-name">{APP_NAME}</span>
            </a>
            {user ? (
              <>
                <nav class="nav">
                  <a href="/" aria-current={props.active === "accounts" ? "page" : undefined}>
                    {t.nav.accounts}
                  </a>
                  <a href="/rules" aria-current={props.active === "rules" ? "page" : undefined}>
                    {t.nav.rules}
                  </a>
                  <a
                    href="/activity"
                    aria-current={props.active === "activity" ? "page" : undefined}
                  >
                    {t.nav.activity}
                  </a>
                  {user.role === "admin" ? (
                    <a href="/admin" aria-current={props.active === "admin" ? "page" : undefined}>
                      {t.nav.admin}
                    </a>
                  ) : null}
                </nav>
                {/* Native popover: opens on click, closes on outside click and Escape, no script. */}
                <button
                  type="button"
                  class="user-button"
                  popovertarget="user-menu"
                  aria-label={t.nav.accountMenu}
                >
                  <span class="avatar">{initials(user.email)}</span>
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
              </>
            ) : null}
          </div>
        </header>
        <main>{props.children}</main>
        <footer class="footer">
          <span>{APP_NAME}</span>
          <span aria-hidden="true">·</span>
          <a href="/privacy">{t.nav.privacy}</a>
        </footer>
      </body>
    </html>
  );
}
