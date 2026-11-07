import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { BrandMark, Layout } from "./layout";

/** A check mark in front of what the app may read. */
function Check() {
  return (
    <svg
      class="consent-check"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/**
 * The question whether an app may read the user's slotmirror data. The app named itself when it
 * registered, so the page says that the name is unchecked and shows where the answer goes. It is
 * a step outside the app, so it has no navigation, like the sign-in page.
 */
export function ConsentPage(props: {
  user: CurrentUser;
  appName: string;
  returnsTo: string;
  /** This request's path. "Not you?" signs out and opens it again, so it waits for the sign-in. */
  resume: string;
  ticket: string;
}) {
  const { t } = useI18n();
  const name = props.appName || t.consent.unnamed;
  // The first letter or digit, never a symbol or emoji: the name is unchecked, so the tile must not
  // look like a verified badge.
  const initial = (props.appName.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  const buttons = (held: boolean) => (
    <>
      <button type="submit" name="decision" value="allow" class="button primary" disabled={held}>
        {t.consent.allow}
      </button>
      <button type="submit" name="decision" value="deny" class="button" disabled={held}>
        {t.consent.deny}
      </button>
    </>
  );
  return (
    <Layout title={t.consent.title} user={props.user} focused>
      <div class="center wide consent">
        <div class="card">
          <div class="consent-pair" aria-hidden="true">
            <span class="consent-tile app">{initial}</span>
            <span class="consent-link" />
            <span class="consent-tile">
              <BrandMark hatchId="consent-hatch" />
            </span>
          </div>
          <h1>{t.consent.title}</h1>
          <p class="lead">{t.consent.asks(name)}</p>
          <div class="consent-body">
            <div class="consent-label">
              {t.consent.readsLabel} <span class="badge">{t.consent.readOnly}</span>
            </div>
            <ul class="consent-checks">
              {t.consent.can.map((line) => (
                <li>
                  <Check />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <p class="notice info">{t.consent.unchecked}</p>
            <div class="consent-meta">
              <form method="post" action="/auth/logout" class="consent-account">
                <input type="hidden" name="resume" value={props.resume} />
                <span>{t.consent.signedInAs(props.user.email)}</span>{" "}
                <span class="consent-switch">
                  {t.consent.notYou}{" "}
                  <button type="submit" class="link-button">
                    {t.nav.signOut}
                  </button>
                </span>
              </form>
              <span>{t.consent.returnsTo(props.returnsTo)}</span>
            </div>
          </div>
          {/* Served off: the script turns the buttons on once the page was seen, so that a click
              meant for another window lands on nothing. Without a script, the noscript form
              decides, and a style hides the held one. */}
          <form method="post" action="/oauth/authorize" class="consent-actions" data-hold>
            <input type="hidden" name="ticket" value={props.ticket} />
            {buttons(true)}
          </form>
          <noscript>
            <style>{"form[data-hold] { display: none; }"}</style>
            <form method="post" action="/oauth/authorize" class="consent-actions">
              <input type="hidden" name="ticket" value={props.ticket} />
              {buttons(false)}
            </form>
          </noscript>
        </div>
      </div>
    </Layout>
  );
}
