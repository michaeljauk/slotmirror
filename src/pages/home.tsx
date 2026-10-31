import type { AccountSyncStatus } from "../audit";
import { PROVIDER_LABEL, type Provider } from "../config";
import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { ProviderIcon } from "./icons";
import { LanguageSwitch, Layout } from "./layout";
import { OperatorNotice } from "./operator-notice";
import { MAX_NAME_LENGTH, type EditorAccount, type EditorState } from "../editor";
import { ACCOUNT_COLOR_KEYS, ACCOUNT_COLORS } from "../colors";
import { ALL_WEEKDAYS, isTimeZone } from "../sync/working-hours";
import {
  colorStyle,
  ReconnectNotice,
  reconnectUrl,
  SourcePills,
  type Notice,
} from "./calendar-editor";
import type { CalendarRow } from "../calendars";
import type { FeedSummary } from "../feeds";
import { FeedSection } from "./feeds";

export interface AccountRow {
  id: string;
  provider: Provider;
  email: string;
  tenantId: string | null;
  createdAt: string;
  /** 1 if the provider refused the refresh token; the account has to be connected again. */
  needsReconnect: number;
}

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
          {props.providers.google ? (
            <p class="notice-lines">
              {t.signIn.googleNotice}
              <br />
              {t.signIn.googleNoticeSteps}
            </p>
          ) : null}
        </div>
        <p class="fineprint">{t.signIn.fineprint}</p>
        <p class="fineprint">
          <LanguageSwitch />
        </p>
      </div>
    </Layout>
  );
}

/** What the user typed into the settings of an account, shown again after a refused save. */
export interface AccountSettingsDraft {
  accountId: string;
  name: string;
  color: string;
  hours: {
    workDays: number[];
    workStart: string;
    workEnd: string;
    untilMidnight: boolean;
    workTimeZone: string;
  } | null;
}

/**
 * The working hours of an account: weekdays, a time range and its time zone. Without a stored
 * zone the field shows the deployment's zone; the page script puts in the browser's. A draft
 * shows what the user typed instead.
 */
function AccountHours(props: { account: EditorAccount; draft?: AccountSettingsDraft["hours"] }) {
  const { t, timeZone } = useI18n();
  const hours = props.account.workHours;
  const draft = props.draft;
  // Without hours no day is ticked, so that saving the name does not set hours by accident.
  const days = new Set<number>(draft?.workDays ?? hours?.workDays ?? []);
  const untilMidnight = draft ? draft.untilMidnight : hours?.workEnd === "24:00";
  const start = draft ? draft.workStart : (hours?.workStart ?? "");
  const end = draft ? draft.workEnd : untilMidnight ? "" : (hours?.workEnd ?? "");
  const storedZone = hours?.workTimeZone ?? "";
  const zone = draft ? draft.workTimeZone : storedZone || timeZone;
  return (
    <fieldset class="account-hours">
      <legend>{t.accounts.workHoursLabel}</legend>
      <input type="hidden" name="workHoursShown" value="1" />
      <span class="weekday-row" role="group" aria-label={t.accounts.workHoursLabel}>
        {ALL_WEEKDAYS.map((day) => (
          <label class="weekday" title={t.editor.weekdayNames[day - 1]}>
            <input
              type="checkbox"
              name="workDays"
              value={String(day)}
              checked={days.has(day)}
              aria-label={t.editor.weekdayNames[day - 1]}
            />
            <span>{t.editor.weekdays[day - 1]}</span>
          </label>
        ))}
      </span>
      <span class="work-time">
        <input
          type="time"
          name="workStart"
          value={start}
          aria-label={t.editor.workStart}
          title={t.editor.workStart}
        />
        {"–"}
        {/* A time field cannot hold 24:00; "until midnight" stands for it. The page script disables
            the field then; without the script the server ignores it. */}
        <input
          type="time"
          name="workEnd"
          value={end}
          aria-label={t.editor.workEnd}
          title={t.editor.workEnd}
        />
        <label class="work-midnight">
          <input type="checkbox" name="workUntilMidnight" value="1" checked={untilMidnight} />
          {t.editor.workUntilMidnight}
        </label>
      </span>
      <input
        type="text"
        name="workTimeZone"
        class="work-zone"
        maxlength={64}
        value={zone}
        data-browser-zone={draft || storedZone ? undefined : "1"}
        aria-label={t.editor.workTimeZone}
        title={t.editor.workTimeZone}
        autocomplete="off"
      />
      {storedZone !== "" && !isTimeZone(storedZone) ? (
        <p class="fineprint work-zone-unknown">{t.editor.workZoneUnknown(storedZone)}</p>
      ) : null}
      <p class="fineprint" title={t.accounts.workHoursTitle}>
        {t.accounts.workHoursHint}
      </p>
    </fieldset>
  );
}

export function HomePage(props: {
  user: CurrentUser;
  accounts: AccountRow[];
  providers: Record<Provider, boolean>;
  /** The operator's notice, shown before the connect buttons. Empty: none. */
  operatorNotice?: string;
  /** Sync status per account ID; accounts without an entry were never synced. */
  statuses: Map<string, AccountSyncStatus>;
  editor: EditorState;
  feeds: FeedSummary[];
  /** Calendars the user can put into a feed: those of their own accounts. */
  calendars: CalendarRow[];
  notice?: Notice;
  /** The account whose settings start open. */
  openSettings?: string;
  /** What the user typed into the settings that start open. */
  draft?: AccountSettingsDraft;
}) {
  const { t, formatDate, formatTimestamp, formatRelative } = useI18n();

  function syncStatus(status: AccountSyncStatus | undefined) {
    if (!status) return <span class="status">{t.accounts.notSynced}</span>;
    const time = formatRelative(status.at);
    const title = formatTimestamp(status.at);
    if (status.state === "paused") {
      return (
        <span class="status" title={title}>
          {`${t.accounts.syncPaused} · ${t.accounts.lastRunAt(time)}`}
        </span>
      );
    }
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
        <ReconnectNotice accounts={props.editor.accounts} operatorNotice={props.operatorNotice} />

        <div class="section-head">
          <div>
            <h1>{t.accounts.title}</h1>
            <p class="lead">{t.accounts.lead}</p>
          </div>
        </div>

        {props.notice ? <p class={`notice ${props.notice.kind}`}>{props.notice.text}</p> : null}

        <div class="card">
          {props.accounts.length === 0 ? (
            <div class="empty">
              <strong>{t.accounts.emptyTitle}</strong>
              {t.accounts.emptyText}
            </div>
          ) : (
            <ul class="list">
              {props.accounts.map((account) => {
                const editor = props.editor.accounts.find((a) => a.id === account.id);
                const draft = props.draft?.accountId === account.id ? props.draft : undefined;
                // The colour the form shows: the typed one after a refused save, else the stored.
                const shownColor = draft
                  ? draft.color
                  : editor?.colorChosen
                    ? editor.color
                    : "auto";
                return (
                  <li id={`account-${account.id}`}>
                    <span
                      class="provider-icon tinted"
                      style={editor ? colorStyle(editor) : undefined}
                    >
                      <ProviderIcon provider={account.provider} size={18} />
                    </span>
                    <div class="item-main">
                      <div class="item-title">
                        {editor?.name ?? account.email}
                        <span class="muted account-email">{account.email}</span>
                      </div>
                      <div
                        class="item-meta"
                        title={t.accounts.connectedOn(formatDate(account.createdAt))}
                      >
                        {accountKind(account)}
                      </div>
                    </div>
                    {account.needsReconnect ? (
                      <a
                        class="status error"
                        href={reconnectUrl(account)}
                        title={t.editor.reconnectText}
                      >
                        {t.editor.reconnectShort}
                      </a>
                    ) : (
                      syncStatus(props.statuses.get(account.id))
                    )}
                    <details class="rename" open={props.openSettings === account.id}>
                      <summary class="link-button quiet">{t.accounts.rename}</summary>
                      <form
                        method="post"
                        action={`/accounts/${account.id}/settings`}
                        class="rename-form"
                      >
                        <label>
                          <span>{t.accounts.nameLabel}</span>
                          <input
                            type="text"
                            name="name"
                            maxlength={MAX_NAME_LENGTH}
                            value={draft ? draft.name : (editor?.customName ?? "")}
                            placeholder={editor?.derivedName}
                          />
                        </label>
                        <p class="fineprint">{t.accounts.nameHint}</p>
                        <fieldset class="account-colors">
                          <legend>{t.accounts.colorLabel}</legend>
                          <span class="color-row pick">
                            <label class="color-choice auto" title={t.accounts.colorAuto}>
                              <input
                                type="radio"
                                name="color"
                                value="auto"
                                checked={shownColor === "auto"}
                              />
                              <span class="color-dot">{t.accounts.colorAuto}</span>
                            </label>
                            {ACCOUNT_COLOR_KEYS.map((key) => (
                              <label class="color-choice" title={t.accounts.colorNames[key]}>
                                <input
                                  type="radio"
                                  name="color"
                                  value={key}
                                  checked={shownColor === key}
                                  aria-label={t.accounts.colorNames[key]}
                                />
                                <span
                                  class="color-dot"
                                  style={`background:${ACCOUNT_COLORS[key]}`}
                                />
                              </label>
                            ))}
                          </span>
                          <p class="fineprint">{t.accounts.colorHint}</p>
                        </fieldset>
                        {editor ? <AccountHours account={editor} draft={draft?.hours} /> : null}
                        {/* Enter submits with the first submit button, so Save comes first. */}
                        <div class="rename-actions">
                          <button type="submit" class="button small">
                            {t.accounts.save}
                          </button>
                          {editor?.workHours ? (
                            <button
                              type="submit"
                              name="workHours"
                              value="none"
                              class="link-button quiet"
                            >
                              {t.accounts.workHoursNone}
                            </button>
                          ) : null}
                        </div>
                      </form>
                    </details>
                    <a class="link-button quiet" href={`/accounts/${account.id}/disconnect`}>
                      {t.accounts.disconnect}
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {props.editor.accounts.some((a) => a.needsReconnect) ? null : (
          <OperatorNotice text={props.operatorNotice} />
        )}

        <div class="actions">
          {enabledProviders(props.providers).map((provider) => (
            <a class="button" href={`/auth/${provider}/connect`}>
              <ProviderIcon provider={provider} />
              {t.accounts.connect(PROVIDER_LABEL[provider])}
            </a>
          ))}
        </div>
        {props.providers.google ? (
          <p class="notice-lines">
            {t.accounts.googleNotice} {t.accounts.googleNoticeSteps}
          </p>
        ) : null}
      </section>

      <section class="section">
        <div class="section-head">
          <div>
            <h2>{t.editor.title}</h2>
            <p class="lead">{t.editor.lead}</p>
          </div>
          <a class="button" href="/rules">
            {t.editor.manage}
          </a>
        </div>

        <div class="card">
          {props.editor.directions.every((direction) => direction.effective === "off") ? (
            <div class="empty">{t.rules.overviewEmpty}</div>
          ) : (
            <ul class="list">
              {props.editor.accounts
                .filter((account) => account.calendar)
                .map((account) => (
                  <li>
                    <div class="item-main">
                      <a
                        class="item-title plain-link"
                        href={`/rules?open=${account.id}#src-${account.id}`}
                      >
                        {t.editor.sourceTitle(account.name)}
                      </a>
                      <SourcePills state={props.editor} source={account} />
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </section>

      <FeedSection feeds={props.feeds} calendars={props.calendars} />
    </Layout>
  );
}
