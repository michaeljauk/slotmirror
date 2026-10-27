import type { Child } from "hono/jsx";
import { ACCOUNT_COLORS } from "../colors";
import { MAX_BUFFER_MINUTES } from "../config";
import {
  type AccountWorkHours,
  CHOICES,
  type Choice,
  type EditorAccount,
  type EditorDirection,
  type EditorState,
  MAX_CATEGORY_LENGTH,
  sourceBuffer,
} from "../editor";
import { useI18n, type Messages } from "../i18n";
import { ALL_WEEKDAYS, hasWorkingHours } from "../sync/working-hours";
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

/** The CSS variable that carries an account's colour into its elements. */
export function colorStyle(account: Pick<EditorAccount, "color">): string {
  return `--c:${ACCOUNT_COLORS[account.color]}`;
}

/** The fill of a Google event colour, or null if the direction writes no Google colour. */
function googleFill(target: EditorAccount, direction: EditorDirection): string | null {
  if (target.provider !== "google") return null;
  return GOOGLE_COLORS.find((color) => color.id === direction.options?.blockColor)?.hex ?? null;
}

/** How a sample event of the source looks in the target with a choice. */
function Example(props: {
  source: EditorAccount;
  target: EditorAccount;
  direction: EditorDirection;
  choice: Choice;
  /** Title of busy blocks from the settings, for a direction without rules. */
  settingsTitle: string;
}) {
  const { t } = useI18n();
  const choice = props.choice;
  if (choice === "off") return <span class="ev none">{t.editor.notThere}</span>;
  const sample = PRIVATE_DOMAINS.test(props.source.email)
    ? t.editor.samplePrivate
    : t.editor.sampleWork;
  const busyTitle = props.direction.options?.blockTitle ?? props.settingsTitle;
  // Google fills an event with its colour; the example does the same.
  const fill = googleFill(props.target, props.direction);
  return (
    <span
      class={fill ? "ev filled" : "ev"}
      style={fill ? `${colorStyle(props.source)};--fill:${fill}` : colorStyle(props.source)}
    >
      <b>{choice === "busy" ? busyTitle : sample.title}</b>
      {choice === "full" ? ` 10:00–11:00 · ${sample.detail}` : " 10:00–11:00"}
    </span>
  );
}

/** Name of an account with its colour mark and provider logo. */
function AccountName(props: { account: EditorAccount }) {
  return (
    <span class="account-name" style={colorStyle(props.account)}>
      <i class="mark" aria-hidden="true" />
      <ProviderIcon provider={props.account.provider} size={13} />
      {props.account.name}
    </span>
  );
}

/** A setting as a switch with a title and one sentence that explains it. */
function Switch(props: { name: string; checked: boolean; title: string; hint: string }) {
  return (
    <label class="switch-row">
      <span class="switch-text">
        <span class="switch-title">{props.title}</span>
        <span class="switch-hint">{props.hint}</span>
      </span>
      <input type="checkbox" role="switch" name={props.name} checked={props.checked} />
    </label>
  );
}

/** Google's event colours by ID, as Google Calendar shows them. */
export const GOOGLE_COLORS: readonly { id: string; hex: string }[] = [
  { id: "1", hex: "#7986cb" },
  { id: "2", hex: "#33b679" },
  { id: "3", hex: "#8e24aa" },
  { id: "4", hex: "#e67c73" },
  { id: "5", hex: "#f6bf26" },
  { id: "6", hex: "#f4511e" },
  { id: "7", hex: "#039be5" },
  { id: "8", hex: "#616161" },
  { id: "9", hex: "#3f51b5" },
  { id: "10", hex: "#0b8043" },
  { id: "11", hex: "#d50000" },
];

/**
 * A notice for every account whose connection the provider ended, with the way back. Nothing of
 * that account syncs until the user connects it again. Also shown on the accounts page.
 */
export function ReconnectNotice(props: {
  accounts: {
    id: string;
    provider: "microsoft" | "google";
    name: string;
    needsReconnect: boolean;
  }[];
}) {
  const { t } = useI18n();
  const broken = props.accounts.filter((account) => account.needsReconnect);
  if (broken.length === 0) return null;
  return (
    <div class="reconnect-notice" role="alert">
      {broken.map((account) => (
        <p>
          <span>{t.editor.reconnectText(account.name)}</span>
          <a class="button small primary" href={`/auth/${account.provider}/connect`}>
            {t.editor.reconnect(account.name)}
          </a>
        </p>
      ))}
    </div>
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
      {/* A save of other settings keeps each rule's window; see setSettings. */}
      <input type="hidden" name="daysAheadShown" value={String(settings.daysAhead)} />
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
      <label class="settings-field">
        <span class="switch-title">{t.editor.blockTitleLabel}</span>
        <span class="switch-hint">{t.editor.blockTitleHint}</span>
        <input
          type="text"
          name="blockTitle"
          maxlength={255}
          value={settings.blockTitle}
          placeholder={t.editor.defaultBlockTitle}
        />
      </label>
      <label class="settings-field">
        <span class="switch-title">{t.editor.skipCategoriesLabel}</span>
        <span class="switch-hint">{t.editor.skipCategoriesHint}</span>
        <input
          type="text"
          name="skipCategories"
          placeholder={t.editor.skipCategoriesPlaceholder}
          value={settings.skipCategories.filter((name) => !name.startsWith("color:")).join(", ")}
        />
      </label>
      <div class="settings-field">
        <span class="switch-title">{t.editor.skipColorsLabel}</span>
        <span class="color-row">
          {GOOGLE_COLORS.map((color) => (
            <label class="color-choice" title={t.editor.googleColor(color.id)}>
              <input
                type="checkbox"
                name="skipColor"
                value={`color:${color.id}`}
                checked={settings.skipCategories.includes(`color:${color.id}`)}
              />
              <span class="color-dot" style={`background:${color.hex}`} />
            </label>
          ))}
        </span>
      </div>
      <Switch
        name="skipAllDay"
        checked={settings.skipAllDay}
        title={t.editor.skipAllDayTitle}
        hint={t.editor.skipAllDayHint}
      />
      <Switch
        name="skipTentative"
        checked={settings.skipTentative}
        title={t.editor.skipTentativeTitle}
        hint={t.editor.skipTentativeHint}
      />
      <Switch
        name="markPrivate"
        checked={settings.markPrivate}
        title={t.editor.markPrivateTitle}
        hint={t.editor.markPrivateHint}
      />
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
              aria-pressed={account.inGroup ? "true" : "false"}
              title={account.inGroup ? t.editor.groupRemove : t.editor.groupAdd}
            >
              <AccountName account={account} />
            </button>
          </form>
        ))}
      </div>
      <p class="group-text">
        {members > 1
          ? t.editor.groupText(members, props.state.settings.markPrivate)
          : t.editor.groupTooFew}
      </p>
    </div>
  );
}

/**
 * Working hours in a few words: "Mo–Fr 08:00–18:00". Weekdays in a row join with a dash, other
 * days are listed. Without times the days stand alone; without a weekday filter, "every day".
 */
export function workHoursText(t: Messages, hours: AccountWorkHours): string {
  const days = [...hours.workDays].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const day of days) {
    const run = runs.at(-1);
    if (run && run.at(-1) === day - 1) run.push(day);
    else runs.push([day]);
  }
  const name = (day: number) => t.editor.weekdays[day - 1] ?? "";
  const dayText =
    days.length === ALL_WEEKDAYS.length
      ? t.editor.everyDay
      : runs
          .map((run) =>
            run.length > 2
              ? `${name(run[0] ?? 1)}–${name(run.at(-1) ?? 1)}`
              : run.map(name).join(", "),
          )
          .join(", ");
  const timeText = hours.workStart ? `${hours.workStart}–${hours.workEnd}` : t.editor.allDay;
  return `${dayText} ${timeText}`;
}

/** The ID of the form that holds the colour and working hours of a direction. */
function detailsFormId(source: EditorAccount, target: EditorAccount): string {
  return `details-${source.id}-${target.id}`;
}

/**
 * The colour of the blocks in the target. Google: one swatch that opens the palette, without a
 * script too. Outlook: a category name. The fields belong to the direction's details form.
 */
function BlockColor(props: { source: EditorAccount; target: EditorAccount; value: string }) {
  const { t } = useI18n();
  const { source, target, value } = props;
  const form = detailsFormId(source, target);
  if (target.provider !== "google") {
    return (
      <input
        type="text"
        class="category-field"
        name="blockColor"
        form={form}
        maxlength={MAX_CATEGORY_LENGTH}
        value={value}
        placeholder={t.editor.blockCategoryPlaceholder}
        aria-label={t.editor.blockCategoryLabel}
        title={t.editor.blockCategoryHint}
      />
    );
  }
  const chosen = GOOGLE_COLORS.find((color) => color.id === value);
  return (
    <details class="swatch">
      <summary class="swatch-button" title={t.editor.blockColorLabel}>
        <span
          class={chosen ? "swatch-dot" : "swatch-dot none"}
          style={chosen ? `background:${chosen.hex}` : undefined}
        />
        <span class="swatch-name">
          {chosen ? t.editor.googleColor(chosen.id) : t.editor.blockColorNone}
        </span>
      </summary>
      <span class="palette color-row pick" role="radiogroup" aria-label={t.editor.blockColorLabel}>
        <label class="color-choice" title={t.editor.blockColorNone}>
          <input
            type="radio"
            name="blockColor"
            form={form}
            value=""
            checked={value === ""}
            aria-label={t.editor.blockColorNone}
            data-name={t.editor.blockColorNone}
          />
          <span class="color-dot none" />
        </label>
        {GOOGLE_COLORS.map((color) => (
          <label class="color-choice" title={t.editor.googleColor(color.id)}>
            <input
              type="radio"
              name="blockColor"
              form={form}
              value={color.id}
              checked={value === color.id}
              aria-label={t.editor.googleColor(color.id)}
              data-name={t.editor.googleColor(color.id)}
            />
            <span class="color-dot" style={`background:${color.hex}`} data-fill={color.hex} />
          </label>
        ))}
      </span>
    </details>
  );
}

/**
 * The working hours of a direction: a checkbox that limits the copies to the working hours of
 * the target account, or a link to set them if the account has none.
 */
function WorkHoursToggle(props: {
  source: EditorAccount;
  target: EditorAccount;
  direction: EditorDirection;
}) {
  const { t } = useI18n();
  const { source, target, direction } = props;
  const on = direction.options !== null && hasWorkingHours(direction.options);
  // Rules can keep hours from before the account had any; the label then shows the rule's own.
  const hours = target.workHours ?? (on && direction.options ? direction.options : null);
  if (!hours) {
    return (
      <a
        class="quiet-link"
        href={`/?settings=${encodeURIComponent(target.id)}#account-${target.id}`}
      >
        {t.editor.setWorkHours}
      </a>
    );
  }
  const form = detailsFormId(source, target);
  return (
    <label class="hours-check" title={t.editor.onlyWorkHoursHint}>
      <input type="hidden" name="workHoursShown" value="1" form={form} />
      <input type="checkbox" name="workHours" value="1" form={form} checked={on} />
      {t.editor.onlyWorkHours(target.name, workHoursText(t, hours))}
    </label>
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
  const canEdit = target.calendar?.canEdit === true;
  const active = direction.ruleId !== null && direction.effective !== "off";
  const key = `${source.id}>${target.id}`;
  return (
    <div class="dest" data-key={key}>
      <div class="dest-name">
        <span class="dest-to" aria-label={t.editor.to}>
          →
        </span>
        <AccountName account={target} />
        {fromGroup ? (
          <span class="dest-tag" title={t.editor.fromGroup}>
            {t.editor.cellGroup}
          </span>
        ) : null}
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
            aria-pressed={choice === direction.effective ? "true" : "false"}
            disabled={
              RANK[choice] > RANK[direction.maxChoice] ||
              (!canEdit && choice !== "off" && choice !== direction.effective)
            }
          >
            {t.editor.choices[choice]}
          </button>
        ))}
      </form>
      <div class="dest-color">
        {active ? (
          <BlockColor source={source} target={target} value={direction.options?.blockColor ?? ""} />
        ) : null}
      </div>
      <div class="dest-extra">
        <div class="dest-line">
          <span class="dest-preview">
            {`${t.editor.looksLike} `}
            {/* Every choice is rendered, so that the editor script can switch without a request. */}
            {CHOICES.map((choice) => (
              <span data-example={choice} hidden={choice !== direction.effective}>
                <Example
                  source={source}
                  target={target}
                  direction={direction}
                  choice={choice}
                  settingsTitle={props.state.settings.blockTitle}
                />
              </span>
            ))}
          </span>
          {active ? (
            <form
              method="post"
              action="/rules/direction/check"
              class="preview-form"
              data-loading={t.editor.checking}
              data-failed={t.editor.checkFailed}
            >
              <input type="hidden" name="from" value={source.id} />
              <input type="hidden" name="to" value={target.id} />
              <button type="submit" class="link-button">
                {t.editor.checkReal}
              </button>
              <span class="preview-result" role="status" />
            </form>
          ) : null}
        </div>
        {active ? (
          <div class="dest-line">
            <WorkHoursToggle source={source} target={target} direction={direction} />
          </div>
        ) : null}
        {isException && canEdit ? (
          <form method="post" action="/rules/direction/reset" class="dest-line faint">
            <input type="hidden" name="from" value={source.id} />
            <input type="hidden" name="to" value={target.id} />
            {`${t.editor.exception} · `}
            <button type="submit" class="link-button">
              {t.editor.reset}
            </button>
          </form>
        ) : null}
        {canEdit ? null : (
          <div class="cap-note">
            {direction.effective === "off" ? t.editor.readOnly : t.editor.readOnlyTurnOff}
          </div>
        )}
        {direction.maxChoice !== "full" ? (
          <div class="cap-note">{t.editor.capNote(t.editor.choices[direction.maxChoice])}</div>
        ) : null}
        {active ? (
          /* Colour and working hours of the direction; their fields sit in the row above. */
          <form
            method="post"
            action="/rules/direction/details"
            class="dest-details"
            id={detailsFormId(source, target)}
            data-key={key}
          >
            <input type="hidden" name="from" value={source.id} />
            <input type="hidden" name="to" value={target.id} />
            <button type="submit" class="button small nojs-only">
              {t.editor.save}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The buffer of a source: one value for every rule from it, collapsed into a summary line. With
 * the editor script a change joins the page's unsaved changes.
 */
function SourceBuffer(props: { state: EditorState; source: EditorAccount }) {
  const { t } = useI18n();
  const { state, source } = props;
  const buffer = sourceBuffer(state, source.id);
  if (buffer === null) return null;
  const mixed = buffer === "mixed";
  const summary = mixed
    ? t.editor.bufferMixed
    : buffer.bufferBefore === 0 && buffer.bufferAfter === 0
      ? t.editor.bufferNone
      : t.editor.bufferSummary(buffer.bufferBefore, buffer.bufferAfter);
  const field = (name: "bufferBefore" | "bufferAfter") => (
    <label class="buffer-field">
      <input
        type="number"
        name={name}
        min={0}
        max={MAX_BUFFER_MINUTES}
        step={1}
        inputmode="numeric"
        required={mixed}
        value={mixed ? "" : String(buffer[name])}
      />
      <span>{t.editor[name]}</span>
    </label>
  );
  return (
    <form
      method="post"
      action="/rules/source/buffer"
      class="src-row source-buffer"
      data-source={source.id}
    >
      <input type="hidden" name="from" value={source.id} />
      <span class="src-key">{t.editor.bufferLabel}</span>
      <details class="buffer-edit">
        <summary>
          <span class="buffer-summary">{summary}</span>
          <span class="edit-link">{t.editor.change}</span>
        </summary>
        <div class="buffer-fields">
          {field("bufferBefore")}
          {field("bufferAfter")}
        </div>
        <p class="src-hint">{mixed ? t.editor.bufferMixedHint : t.editor.bufferHint}</p>
        <button type="submit" class="button small nojs-only">
          {t.editor.save}
        </button>
      </details>
    </form>
  );
}

export function SourceCard(props: { state: EditorState; source: EditorAccount; open: boolean }) {
  const { t } = useI18n();
  const { state, source } = props;
  const targets = state.accounts.filter((account) => account.id !== source.id && account.calendar);
  return (
    <details
      class="card source"
      id={`src-${source.id}`}
      open={props.open}
      data-source={source.id}
      style={colorStyle(source)}
    >
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
      <div class="src-row">
        <span class="src-key">{t.editor.calendarsLabel}</span>
        <span class="cal-chips">
          {source.calendars.map((calendar) => (
            <form method="post" action={`/rules/source-calendar/${calendar.id}`}>
              <input type="hidden" name="isSource" value={calendar.isSource ? "0" : "1"} />
              <button
                type="submit"
                class={calendar.isSource ? "member cal-chip" : "member cal-chip out"}
                aria-pressed={calendar.isSource ? "true" : "false"}
                data-calendar={calendar.id}
              >
                {calendar.isMain ? t.editor.mainCalendar : calendar.name}
              </button>
            </form>
          ))}
        </span>
      </div>
      <SourceBuffer state={state} source={source} />
      {targets.length > 0 && !source.calendars.some((calendar) => calendar.isSource) ? (
        <div class="src-row faint none-chosen">{t.editor.noSource}</div>
      ) : null}
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
  const items = props.state.accounts
    .filter((account) => account.id !== props.source.id && account.calendar)
    .flatMap((target) => {
      const direction = directionOf(props.state, props.source.id, target.id);
      if (!direction) return [];
      const exception = direction.origin === "custom" && props.source.inGroup && target.inGroup;
      return [{ target, choice: direction.effective, exception }];
    });
  // With many targets, plain choices shared by three or more targets collapse into one pill.
  // Exceptions always stay visible. The editor script expands the pills once a choice changes.
  const counts = new Map<Choice, number>();
  for (const item of items) {
    if (!item.exception) counts.set(item.choice, (counts.get(item.choice) ?? 0) + 1);
  }
  const collapse = items.length > 4;
  const grouped = new Set(
    [...counts].filter(([, count]) => collapse && count >= 3).map(([choice]) => choice),
  );
  return (
    <span class={grouped.size > 0 ? "pills collapsed" : "pills"}>
      {items.map((item) => (
        <span
          class={[
            "pill",
            item.exception ? "exception" : "",
            !item.exception && grouped.has(item.choice) ? "grouped" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-key={`${props.source.id}>${item.target.id}`}
        >
          <span class="pill-arrow" aria-label={t.editor.to}>
            →
          </span>
          <AccountName account={item.target} />
          {": "}
          <b>{t.editor.short[item.choice]}</b>
        </span>
      ))}
      {[...grouped].map((choice) => (
        <span class="pill summary">
          <span class="pill-arrow">→</span>
          {t.editor.manyTargets(counts.get(choice) ?? 0)}
          {": "}
          <b>{t.editor.short[choice]}</b>
        </span>
      ))}
    </span>
  );
}

/** The same choices as a matrix. It stays next to the list, so that the whole setup is in view. */
export function Overview(props: { state: EditorState }) {
  const { t } = useI18n();
  const accounts = props.state.accounts.filter((account) => account.calendar);
  // With more than four accounts the cells show colour only; the text moves into the tooltip.
  const compact = accounts.length > 4;
  return (
    <aside class="card overview" id="overview">
      <h2 class="overview-title">{t.editor.viewMatrix}</h2>
      <div class="matrix-scroll">
        <table class={compact ? "matrix compact" : "matrix"}>
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
                  const exception = direction?.origin === "custom" && from.inGroup && to.inGroup;
                  return (
                    <td
                      class={`cell level-${choice}${exception ? " exception" : ""}`}
                      data-key={`${from.id}>${to.id}`}
                    >
                      <a
                        href={`/rules?open=${from.id}#src-${from.id}`}
                        data-open={from.id}
                        title={`${from.name} → ${to.name}: ${t.editor.choices[choice]}${label ? ` (${label})` : ""}`}
                      >
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
      </div>
      {compact ? (
        <p class="matrix-legend">
          {CHOICES.map((choice) => (
            <span>
              <i class={`level-${choice}`} />
              {t.editor.choices[choice]}
            </span>
          ))}
          <span>
            <i class="legend-exception" />
            {t.editor.cellException}
          </span>
        </p>
      ) : null}
      <p class="matrix-hint">{t.editor.matrixHint}</p>
    </aside>
  );
}

/** Before two accounts are connected: what to do, with the buttons to do it. */
function FirstSteps(props: {
  connected: number;
  providers: Record<"microsoft" | "google", boolean>;
}) {
  const { t } = useI18n();
  const providers = (["microsoft", "google"] as const).filter((p) => props.providers[p]);
  return (
    <div class="card first-steps">
      <h2>{t.editor.firstStepsTitle}</h2>
      <ol>
        <li class={props.connected >= 1 ? "done" : ""}>{t.editor.stepConnectFirst}</li>
        <li class={props.connected >= 2 ? "done" : ""}>{t.editor.stepConnectSecond}</li>
        <li>{t.editor.stepChoose}</li>
      </ol>
      <div class="actions">
        {providers.map((provider) => (
          <a class="button" href={`/auth/${provider}/connect`}>
            <ProviderIcon provider={provider} />
            {t.accounts.connect(provider === "microsoft" ? "Microsoft 365" : "Google")}
          </a>
        ))}
      </div>
    </div>
  );
}

/** With two or more accounts and no rule yet: one click for the common setup. */
function QuickStart(props: { count: number }) {
  const { t } = useI18n();
  return (
    <form method="post" action="/rules/group/all" class="card quick-start">
      <div>
        <strong>{t.editor.quickStartTitle}</strong>
        <p class="group-text">{t.editor.quickStartText(props.count)}</p>
      </div>
      <button type="submit" class="button primary">
        {t.editor.quickStartButton}
      </button>
    </form>
  );
}

export function CalendarEditorPage(props: {
  /** Providers that can be connected, for the first steps. */
  providers: Record<"microsoft" | "google", boolean>;
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
        <ReconnectNotice accounts={props.state.accounts} />

        {ready.length < 2 ? (
          <FirstSteps connected={ready.length} providers={props.providers} />
        ) : (
          <>
            <div class="editor-grid">
              <div class="editor-main">
                {props.state.directions.every((d) => !d.ruleId) &&
                !props.state.accounts.some((account) => account.inGroup) ? (
                  <QuickStart count={ready.length} />
                ) : null}
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
