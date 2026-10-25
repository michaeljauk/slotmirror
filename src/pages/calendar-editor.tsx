import type { Child } from "hono/jsx";
import {
  CHOICES,
  type Choice,
  type EditorAccount,
  type EditorDirection,
  type EditorState,
} from "../editor";
import { useI18n } from "../i18n";
import type { CurrentUser } from "../users";
import { ProviderIcon } from "./icons";
import { Layout } from "./layout";

export type Notice = { kind: "info" | "error"; text: string };

const DAYS_AHEAD = [30, 90, 180, 365] as const;

/** Addresses at consumer providers get the private example, all others the work example. */
const PRIVATE_DOMAINS = /@(gmail|googlemail|outlook|hotmail|live|icloud|me)\./i;

const RANK: Record<Choice, number> = { off: 0, busy: 1, title: 2, full: 3 };

function directionOf(state: EditorState, from: string, to: string): EditorDirection | undefined {
  return state.directions.find((d) => d.from === from && d.to === to);
}

/** How a sample event of the source looks in the target with a choice. */
function Example(props: { source: EditorAccount; direction: EditorDirection; choice: Choice }) {
  const { t } = useI18n();
  const choice = props.choice;
  if (choice === "off") return <span class="ev none">{t.editor.notThere}</span>;
  const sample = PRIVATE_DOMAINS.test(props.source.email)
    ? t.editor.samplePrivate
    : t.editor.sampleWork;
  const busyTitle = props.direction.options?.blockTitle ?? "Busy";
  return (
    <span class="ev">
      <b>{choice === "busy" ? busyTitle : sample.title}</b>
      {choice === "full" ? ` 10:00–11:00 · ${sample.detail}` : " 10:00–11:00"}
    </span>
  );
}

function AccountName(props: { account: EditorAccount }) {
  return (
    <span class="account-name">
      <ProviderIcon provider={props.account.provider} size={13} />
      {props.account.name}
    </span>
  );
}

/** Settings for all directions. With the editor script they join the page's unsaved changes. */
function SettingsCard(props: { state: EditorState }) {
  const { t } = useI18n();
  const { settings } = props.state;
  return (
    <form method="post" action="/rules/settings" class="card settings-card" id="settings">
      <div class="settings-head">
        <strong>{t.editor.settingsTitle}</strong>
        <span class="group-text">{t.editor.settingsLead}</span>
      </div>
      <div class="settings-row">
        <span class="settings-label">{t.editor.window}</span>
        <span class="choices">
          {DAYS_AHEAD.map((days) => (
            <label class="choice-radio">
              <input
                type="radio"
                name="daysAhead"
                value={String(days)}
                checked={settings.daysAhead === days}
              />
              <span class="choice">{t.editor.days(days)}</span>
            </label>
          ))}
        </span>
      </div>
      <label class="check-row">
        <input type="checkbox" name="skipAllDay" checked={settings.skipAllDay} />
        <span>{t.rules.skipAllDay}</span>
      </label>
      <label class="check-row">
        <input type="checkbox" name="skipTentative" checked={settings.skipTentative} />
        <span>{t.rules.skipTentative}</span>
      </label>
      <label class="check-row">
        <input type="checkbox" name="markPrivate" checked={settings.markPrivate} />
        <span>{t.rules.markPrivate}</span>
      </label>
      <button type="submit" class="button small nojs-only">
        {t.editor.save}
      </button>
    </form>
  );
}

function GroupCard(props: { state: EditorState }) {
  const { t } = useI18n();
  const members = props.state.accounts.filter((account) => account.inGroup).length;
  return (
    <div class="card group-card">
      <div class="group-row">
        <strong>{t.editor.groupTitle}</strong>
        {props.state.accounts.map((account) => (
          <form method="post" action={`/rules/group/${account.id}`}>
            <input type="hidden" name="inGroup" value={account.inGroup ? "0" : "1"} />
            <button
              type="submit"
              class={account.inGroup ? "member" : "member out"}
              title={account.inGroup ? t.editor.groupRemove : t.editor.groupAdd}
            >
              <AccountName account={account} />
            </button>
          </form>
        ))}
      </div>
      <p class="group-text">{members > 1 ? t.editor.groupText(members) : t.editor.groupTooFew}</p>
    </div>
  );
}

function DestinationRow(props: {
  state: EditorState;
  source: EditorAccount;
  target: EditorAccount;
  direction: EditorDirection;
}) {
  const { t } = useI18n();
  const { direction, source, target } = props;
  const inGroup = source.inGroup && target.inGroup;
  const fromGroup = direction.origin === "group";
  const isException = inGroup && direction.origin === "custom";
  return (
    <div class="dest">
      <div class="dest-name">
        <span class="dest-to">{t.editor.to}</span>
        <AccountName account={target} />
      </div>
      <form method="post" action="/rules/direction" class="choices" data-to={target.id}>
        <input type="hidden" name="from" value={source.id} />
        <input type="hidden" name="to" value={target.id} />
        {CHOICES.map((choice) => (
          <button
            type="submit"
            name="choice"
            value={choice}
            class={choice === direction.effective ? "choice on" : "choice"}
            disabled={RANK[choice] > RANK[direction.maxChoice]}
          >
            {t.editor.choices[choice]}
          </button>
        ))}
      </form>
      <div class="dest-note">
        {`${t.editor.looksLike} `}
        {/* Every choice is rendered, so that the editor script can switch without a request. */}
        {CHOICES.map((choice) => (
          <span data-example={choice} hidden={choice !== direction.effective}>
            <Example source={source} direction={direction} choice={choice} />
          </span>
        ))}
      </div>
      {fromGroup ? <div class="dest-note faint">{t.editor.fromGroup}</div> : null}
      {isException ? (
        <form method="post" action="/rules/direction/reset" class="dest-note faint card-form">
          <input type="hidden" name="from" value={source.id} />
          <input type="hidden" name="to" value={target.id} />
          {`${t.editor.exception} · `}
          <button type="submit" class="link-button">
            {t.editor.reset}
          </button>
        </form>
      ) : null}
      {direction.ruleId && direction.effective !== "off" ? (
        <form
          method="post"
          action={`/rules/${direction.ruleId}/preview`}
          class="dest-note faint preview-form"
          data-loading={t.editor.checking}
        >
          <button type="submit" class="link-button">
            {t.editor.checkReal}
          </button>
          <span class="preview-result" role="status" />
        </form>
      ) : null}
      {direction.maxChoice !== "full" ? (
        <div class="cap-note">{t.editor.capNote(t.editor.choices[direction.maxChoice])}</div>
      ) : null}
    </div>
  );
}

export function SourceCard(props: { state: EditorState; source: EditorAccount; open: boolean }) {
  const { t } = useI18n();
  const { state, source } = props;
  const targets = state.accounts.filter((account) => account.id !== source.id && account.calendar);
  return (
    <details class="card source" id={`src-${source.id}`} open={props.open} data-source={source.id}>
      <summary class="source-head">
        <span class="provider-icon">
          <ProviderIcon provider={source.provider} size={16} />
        </span>
        <span class="source-main">
          <span class="source-title">{t.editor.sourceTitle(source.name)}</span>
          <SourcePills state={state} source={source} />
        </span>
        <span class="chevron">›</span>
      </summary>
      {targets.map((target) => {
        const direction = directionOf(state, source.id, target.id);
        return direction ? (
          <DestinationRow state={state} source={source} target={target} direction={direction} />
        ) : null;
      })}
    </details>
  );
}

/** One pill per target: "Gmail: all". Exceptions are tinted. Also used on the home page. */
export function SourcePills(props: { state: EditorState; source: EditorAccount }) {
  const { t } = useI18n();
  return (
    <span class="pills">
      {props.state.accounts
        .filter((account) => account.id !== props.source.id && account.calendar)
        .map((target) => {
          const direction = directionOf(props.state, props.source.id, target.id);
          if (!direction) return null;
          const exception = direction.origin === "custom" && props.source.inGroup && target.inGroup;
          return (
            <span
              class={exception ? "pill exception" : "pill"}
              data-key={`${props.source.id}>${target.id}`}
            >
              <span class="pill-arrow" aria-label={t.editor.to}>
                →
              </span>
              <AccountName account={target} />
              {": "}
              <b>{t.editor.short[direction.effective]}</b>
            </span>
          );
        })}
    </span>
  );
}

/** The same choices as a matrix. It stays next to the list, so that the whole setup is in view. */
export function Overview(props: { state: EditorState }) {
  const { t } = useI18n();
  const accounts = props.state.accounts.filter((account) => account.calendar);
  return (
    <aside class="card overview" id="overview">
      <h2 class="overview-title">{t.editor.viewMatrix}</h2>
      <table class="matrix">
        <thead>
          <tr>
            <th>{t.editor.matrixCorner}</th>
            {accounts.map((account) => (
              <th class="col">
                <AccountName account={account} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {accounts.map((from) => (
            <tr>
              <th>
                <AccountName account={from} />
              </th>
              {accounts.map((to) => {
                if (from.id === to.id) return <td class="cell self" />;
                const direction = directionOf(props.state, from.id, to.id);
                const choice = direction?.effective ?? "off";
                const label =
                  direction?.origin === "group"
                    ? t.editor.cellGroup
                    : direction?.origin === "custom" && from.inGroup && to.inGroup
                      ? t.editor.cellException
                      : "";
                return (
                  <td class={`cell level-${choice}`} data-key={`${from.id}>${to.id}`}>
                    <a href={`/rules?open=${from.id}#src-${from.id}`} data-open={from.id}>
                      {t.editor.short[choice]}
                      <small>{label}</small>
                    </a>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p class="matrix-hint">{t.editor.matrixHint}</p>
    </aside>
  );
}

export function CalendarEditorPage(props: {
  user: CurrentUser;
  state: EditorState;
  /** Source accounts whose cards start open. */
  open: string[];
  notice?: Notice;
  status?: Child;
}) {
  const { t } = useI18n();
  const ready = props.state.accounts.filter((account) => account.calendar);
  return (
    <Layout title={t.editor.title} user={props.user} active="rules">
      <section class="section">
        <div class="section-head">
          <div>
            <h1>{t.editor.title}</h1>
            <p class="lead">{t.editor.lead}</p>
          </div>
        </div>

        {props.notice ? <p class={`notice ${props.notice.kind}`}>{props.notice.text}</p> : null}

        {ready.length < 2 ? (
          <div class="card">
            <div class="empty">{t.editor.needTwo}</div>
          </div>
        ) : (
          <>
            <div class="editor-grid">
              <div class="editor-main">
                <GroupCard state={props.state} />
                {ready.map((source) => (
                  <SourceCard
                    state={props.state}
                    source={source}
                    open={props.open.includes(source.id)}
                  />
                ))}
                <SettingsCard state={props.state} />
              </div>
              <Overview state={props.state} />
            </div>
            <div
              class="page-bar"
              id="page-bar"
              hidden
              data-one={t.editor.changes(1)}
              data-many={t.editor.changes(0).replace("0", "{n}")}
              data-failed={t.editor.saveFailed}
              data-changed={t.editor.cellChanged}
              data-short={JSON.stringify(t.editor.short)}
            >
              <span class="edit-count" />
              <button type="button" class="link-button edit-cancel">
                {t.editor.discard}
              </button>
              <button type="button" class="button primary edit-save">
                {t.editor.save}
              </button>
            </div>
          </>
        )}

        {props.state.others.length > 0 ? (
          <div class="card others">
            <h2>{t.editor.othersTitle}</h2>
            <p class="lead">{t.editor.othersLead}</p>
            <ul class="list">
              {props.state.others.map((other) => (
                <li>
                  <div class="item-main">
                    <div class="item-title">{`${other.source} → ${other.target}`}</div>
                    <div class="item-meta">{t.editor.choices[other.choice]}</div>
                  </div>
                  <form method="post" action={`/rules/${other.ruleId}/delete`}>
                    <button type="submit" class="link-button danger">
                      {t.rules.delete}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div class="editor-foot">
          {props.status}
          <form method="post" action="/rules/calendars/refresh">
            <button type="submit" class="link-button">
              {t.rules.refreshCalendars}
            </button>
          </form>
        </div>
      </section>
    </Layout>
  );
}
