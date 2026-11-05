import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { Layout } from "./layout";

/**
 * The question whether an app may read the user's slotmirror data. The app named itself when it
 * registered, so the page says that the name is unchecked and shows where the answer goes.
 */
export function ConsentPage(props: {
  user: CurrentUser;
  appName: string;
  returnsTo: string;
  ticket: string;
}) {
  const { t } = useI18n();
  const name = props.appName || t.consent.unnamed;
  return (
    <Layout title={t.consent.title} user={props.user}>
      <section class="section consent">
        <div class="card">
          <h1>{t.consent.title}</h1>
          <p class="lead">{t.consent.asks(name)}</p>
          <ul class="consent-list">
            {t.consent.can.map((line) => (
              <li>{line}</li>
            ))}
          </ul>
          <p class="notice info">{t.consent.unchecked}</p>
          <p class="muted">{t.consent.returnsTo(props.returnsTo)}</p>
          {/* Served off: the script turns the buttons on once the page was seen, so that a click
              meant for another window lands on nothing. Without a script, the noscript form
              decides, and a style hides the held one. */}
          <form method="post" action="/oauth/authorize" class="consent-actions" data-hold>
            <input type="hidden" name="ticket" value={props.ticket} />
            <button type="submit" name="decision" value="allow" class="button primary" disabled>
              {t.consent.allow}
            </button>
            <button type="submit" name="decision" value="deny" class="button" disabled>
              {t.consent.deny}
            </button>
          </form>
          <noscript>
            <style>{"form[data-hold] { display: none; }"}</style>
            <form method="post" action="/oauth/authorize" class="consent-actions">
              <input type="hidden" name="ticket" value={props.ticket} />
              <button type="submit" name="decision" value="allow" class="button primary">
                {t.consent.allow}
              </button>
              <button type="submit" name="decision" value="deny" class="button">
                {t.consent.deny}
              </button>
            </form>
          </noscript>
        </div>
      </section>
    </Layout>
  );
}
