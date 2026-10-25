import type { AccountSyncStatus, RuleOutcome } from "../audit";
import type { CalendarRow } from "../calendars";
import type { Provider } from "../config";
import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { ProviderIcon } from "./icons";
import { LanguageSwitch, Layout } from "./layout";
import { calendarLabel, RuleLastRun } from "./rule-summary";
import type { RuleRow } from "./rules";

export interface AccountRow {
  id: string;
  provider: Provider;
  email: string;
  tenantId: string | null;
  createdAt: string;
}

/** Product names stay untranslated. */
export const PROVIDER_LABEL: Record<Provider, string> = {
  microsoft: "Microsoft 365",
  google: "Google",
};

/** Tenant ID that Entra uses for all personal Microsoft accounts. */
const PERSONAL_MICROSOFT_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

function enabledProviders(providers: Record<Provider, boolean>): Provider[] {
  return (Object.keys(PROVIDER_LABEL) as Provider[]).filter((provider) => providers[provider]);
}

export function SignInPage(props: { providers: Record<Provider, boolean> }) {
  const { t } = useI18n();
  return (
    <Layout title={t.signIn.title}>
      <div class="center">
        <div class="card">
          <h1>{t.signIn.title}</h1>
          <p class="lead">{t.signIn.lead}</p>
          <div class="actions">
            {enabledProviders(props.providers).map((provider) => (
              <a class="button" href={`/auth/${provider}/login`}>
                <ProviderIcon provider={provider} />
                {t.signIn.withProvider(PROVIDER_LABEL[provider])}
              </a>
            ))}
          </div>
        </div>
        <p class="fineprint">{t.signIn.fineprint}</p>
        <p class="fineprint">
          <LanguageSwitch />
        </p>
      </div>
    </Layout>
  );
}

export function HomePage(props: {
  user: CurrentUser;
  accounts: AccountRow[];
  providers: Record<Provider, boolean>;
  /** Sync status per account ID; accounts without an entry were never synced. */
  statuses: Map<string, AccountSyncStatus>;
  rules: RuleRow[];
  calendars: CalendarRow[];
  /** Latest finished run or failure per rule ID. */
  outcomes: Map<string, RuleOutcome>;
}) {
  const { t, formatDate, formatTimestamp, formatRelative } = useI18n();
  const calendarsById = new Map(props.calendars.map((calendar) => [calendar.id, calendar]));

  function syncStatus(status: AccountSyncStatus | undefined) {
    if (!status) return <span class="status">{t.accounts.notSynced}</span>;
    const time = formatRelative(status.at);
    const title = formatTimestamp(status.at);
    if (status.state === "ok") {
      return (
        <span class="status ok" title={title}>
          {t.accounts.inSync(time)}
        </span>
      );
    }
    if (status.state === "partial") {
      return (
        <span class="status" title={title}>
          {t.accounts.partlySynced(time)}
        </span>
      );
    }
    const reason = status.code
      ? t.accounts.syncFailed(status.code)
      : t.accounts.changesFailed(status.failed ?? 0);
    return (
      <span class="status error" title={title}>
        {`${reason} · ${time}`}
      </span>
    );
  }

  function accountKind(account: AccountRow): string {
    if (account.provider === "google") return t.accounts.kindGoogle;
    return account.tenantId === PERSONAL_MICROSOFT_TENANT
      ? t.accounts.kindMicrosoftPersonal
      : t.accounts.kindMicrosoftWork;
  }

  return (
    <Layout title={t.accounts.title} user={props.user} active="accounts">
      <section class="section">
        <div class="section-head">
          <div>
            <h1>{t.accounts.title}</h1>
            <p class="lead">{t.accounts.lead}</p>
          </div>
        </div>

        <div class="card">
          {props.accounts.length === 0 ? (
            <div class="empty">
              <strong>{t.accounts.emptyTitle}</strong>
              {t.accounts.emptyText}
            </div>
          ) : (
            <ul class="list">
              {props.accounts.map((account) => (
                <li>
                  <span class="provider-icon">
                    <ProviderIcon provider={account.provider} size={18} />
                  </span>
                  <div class="item-main">
                    <div class="item-title">{account.email}</div>
                    <div
                      class="item-meta"
                      title={t.accounts.connectedOn(formatDate(account.createdAt))}
                    >
                      {accountKind(account)}
                    </div>
                  </div>
                  {syncStatus(props.statuses.get(account.id))}
                  <a class="link-button quiet" href={`/accounts/${account.id}/disconnect`}>
                    {t.accounts.disconnect}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div class="actions">
          {enabledProviders(props.providers).map((provider) => (
            <a class="button" href={`/auth/${provider}/connect`}>
              <ProviderIcon provider={provider} />
              {t.accounts.connect(PROVIDER_LABEL[provider])}
            </a>
          ))}
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>{t.rules.title}</h2>
            <p class="lead">{t.rules.lead}</p>
          </div>
          <a class="button" href="/rules">
            {t.rules.manage}
          </a>
        </div>

        <div class="card">
          {props.rules.length === 0 ? (
            <div class="empty">{t.rules.overviewEmpty}</div>
          ) : (
            <ul class="list">
              {props.rules.map((rule) => (
                <li>
                  <div class="item-main">
                    <div class="item-title">
                      {`${calendarLabel(calendarsById.get(rule.sourceCalendarId))} → ${calendarLabel(calendarsById.get(rule.targetCalendarId))}`}
                    </div>
                    <div class="item-meta">{t.rules.detailLevels[rule.options.detailLevel]}</div>
                    {rule.enabled ? <RuleLastRun outcome={props.outcomes.get(rule.id)} /> : null}
                  </div>
                  <span class={rule.enabled ? "badge ok" : "badge"}>
                    {rule.enabled ? t.rules.active : t.rules.pausedShort}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </Layout>
  );
}
