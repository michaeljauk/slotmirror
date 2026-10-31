import { auditStatement, errorLogFields, recordAudit, type AuditEvent } from "./audit";
import { resolveAccountColorState, type AccountColor } from "./colors";
import { parseRuleOptions, ruleOptionsSchema, type Provider, type RuleOptions } from "./config";
import { detailLevelFor, type DetailLevel } from "./detail-policy";
import { accountSync } from "./durable";
import { displayTimeZone, isLocale, type Locale } from "./i18n";
import {
  ALL_WEEKDAYS,
  canonicalTimeZone,
  hasWorkingHours,
  workingHoursProblem,
  type WorkingHoursProblem,
} from "./sync/working-hours";
import type { CurrentUser } from "./users";

/**
 * The calendar editor shows one choice per direction between two accounts: from the source
 * calendars of one account into the main calendar of the other. A direction is one rule in D1 per
 * source calendar, all with the same choice, so the sync engine stays unaware of the editor. The
 * main calendar is a source until the user turns it off; other calendars, such as subscriptions,
 * are sources only once the user turns them on.
 *
 * Accounts in the block group see each other as busy. Those rules have origin "group". A choice
 * that differs from the group is a rule with origin "custom". "Off" between two group members is a
 * custom rule that is disabled, so that the group does not bring it back.
 */
export type Choice = "off" | "busy" | "title" | "full";

export const CHOICES: readonly Choice[] = ["off", "busy", "title", "full"];

export interface EditorAccount {
  id: string;
  provider: Provider;
  email: string;
  tenantId: string | null;
  inGroup: boolean;
  /** The provider refused the refresh token; nothing syncs until the user connects again. */
  needsReconnect: boolean;
  /** Display name: the one the user gave, or else the derived one. */
  name: string;
  /** Short name derived from the address. */
  derivedName: string;
  /** The name the user gave; null if the account uses the derived name. */
  customName: string | null;
  /** Colour in the pages: the stored one, or the next unused one. */
  color: AccountColor;
  /** True if the user chose the colour; false if it is automatic. */
  colorChosen: boolean;
  /** Main calendar; null until the calendars are loaded or if the account has none it can write. */
  calendar: { id: string; remoteId: string; canEdit: boolean } | null;
  /** Every calendar of the account, for the choice of sources. */
  calendars: { id: string; name: string; isMain: boolean; isSource: boolean }[];
  /** Working hours of the account (see `setAccountWorkHours`); null if it has none. */
  workHours: AccountWorkHours | null;
  /** Options of the account as a source (see `SourceOptions`); null if it never stored any. */
  sourceOptions: SourceOptions | null;
}

/** The rule of one source calendar within a direction; null if it has none yet. */
interface Slot {
  sourceCalendarId: string;
  rule: SlotRule | null;
}

interface SlotRule {
  id: string;
  enabled: boolean;
  origin: "group" | "custom";
  options: RuleOptions;
  /** The options as stored, so that a write can require that they did not change meanwhile. */
  optionsJson: string;
}

export interface EditorDirection {
  from: string;
  to: string;
  ruleId: string | null;
  choice: Choice;
  origin: "group" | "custom" | null;
  /** The level the rule runs with after the org caps, and whether a cap lowered it. */
  effective: Choice;
  capped: boolean;
  /** The highest choice the org caps allow. */
  maxChoice: Choice;
  options: RuleOptions | null;
  /** One entry per source calendar. ruleId, choice and options above come from the first rule. */
  slots: Slot[];
  /**
   * "Off" exceptions kept from calendars that are no longer sources (see `setSourceCalendar`), so
   * that the group does not replace them when a source comes back.
   */
  parked: SlotRule[];
  /** The source account has group rules into another calendar of the target, e.g. an old main. */
  elsewhere: boolean;
}

/** Settings for all rules of a user. The editor shows them once, not per direction. */
export type SyncSettings = Pick<
  RuleOptions,
  "daysAhead" | "skipAllDay" | "skipTentative" | "markPrivate" | "blockTitle" | "skipCategories"
>;

export interface EditorState {
  accounts: EditorAccount[];
  directions: EditorDirection[];
  settings: SyncSettings;
  /** Rules that do not run between two main calendars. The editor lists them, so none hides. */
  others: { ruleId: string; source: string; target: string; choice: Choice }[];
  /** Every rule of the user, with its source and target account, for changes per account. */
  rules: { from: string; to: string; rule: SlotRule }[];
}

const PUBLIC_PROVIDERS: Record<string, string> = {
  "gmail.com": "Gmail",
  "googlemail.com": "Gmail",
  "outlook.com": "Outlook",
  "hotmail.com": "Outlook",
  "live.com": "Outlook",
  "icloud.com": "iCloud",
  "me.com": "iCloud",
};

/**
 * Short names from the addresses: "Gmail" for gmail.com, the first label of the domain otherwise.
 * If two accounts get the same name, both add the part before the @.
 */
export function shortNames(emails: string[]): string[] {
  const base = emails.map((email) => {
    const [local = "", domain = ""] = email.toLowerCase().split("@");
    return { local, name: PUBLIC_PROVIDERS[domain] ?? domain.split(".")[0] ?? email };
  });
  return base.map(({ local, name }) =>
    base.filter((other) => other.name === name).length > 1 ? `${name} (${local})` : name,
  );
}

function choiceOf(options: RuleOptions, enabled: boolean): Choice {
  if (!enabled) return "off";
  // "title_location" is not offered in the editor; it shows as the nearest lower choice.
  return options.detailLevel === "title_location" ? "title" : options.detailLevel;
}

const RANK: Record<Choice, number> = { off: 0, busy: 1, title: 2, full: 3 };

function toChoice(level: DetailLevel): Choice {
  return level === "title_location" ? "title" : level;
}

interface AccountRow {
  id: string;
  provider: Provider;
  email: string;
  tenantId: string | null;
  inGroup: number;
  displayName: string | null;
  needsReconnect: number;
  color: string | null;
  workHours: string | null;
  sourceOptions: string | null;
}

interface CalendarRow {
  id: string;
  accountId: string;
  remoteId: string;
  name: string;
  canEdit: number;
  isMain: number;
  isSource: number;
}

interface RuleRow {
  id: string;
  sourceId: string;
  targetId: string;
  options: string;
  enabled: number;
  origin: "group" | "custom";
  sourceName: string;
  sourceAccountId: string;
  targetName: string;
  targetAccountId: string;
}

/** The editor state. One batch reads it, which counts as one D1 query per invocation. */
export async function loadEditorState(env: Env, userId: string): Promise<EditorState> {
  const [accountResult, calendarResult, ruleResult, settingsResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, provider, email, tenant_id AS tenantId, in_block_group AS inGroup,
              display_name AS displayName, needs_reconnect AS needsReconnect, color,
              work_hours AS workHours, source_options AS sourceOptions
       FROM accounts WHERE user_id = ? ORDER BY created_at, id`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT c.id, c.account_id AS accountId, c.remote_id AS remoteId, c.name,
              c.can_edit AS canEdit, c.is_default AS isMain, c.is_source AS isSource
       FROM calendars c JOIN accounts a ON a.id = c.account_id
       WHERE a.user_id = ? ORDER BY c.is_default DESC, c.name`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT r.id, r.source_calendar_id AS sourceId, r.target_calendar_id AS targetId, r.options,
              r.enabled, r.origin, sc.name AS sourceName, sc.account_id AS sourceAccountId,
              tc.name AS targetName, tc.account_id AS targetAccountId
       FROM rules r
       JOIN calendars sc ON sc.id = r.source_calendar_id
       JOIN calendars tc ON tc.id = r.target_calendar_id
       WHERE r.user_id = ?`,
    ).bind(userId),
    env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?").bind(userId),
  ]);
  const accountRows = (accountResult?.results ?? []) as AccountRow[];
  const calendarRows = (calendarResult?.results ?? []) as CalendarRow[];
  const ruleRows = (ruleResult?.results ?? []) as RuleRow[];
  const settingsRow = settingsResult?.results[0] as { json: string } | undefined;
  const calendarById = new Map(calendarRows.map((calendar) => [calendar.id, calendar]));
  // A disabled rule that `setSourceCalendar` marked, while its calendar is not a source.
  const isParked = (row: RuleRow) =>
    row.enabled === 0 &&
    isMarkedParked(row.options) &&
    calendarById.get(row.sourceId)?.isSource === 0;
  const names = shortNames(accountRows.map((row) => row.email));
  const colors = resolveAccountColorState(accountRows.map((row) => row.color));
  // Store assigned colours, so that they stay when another account gets a colour later.
  const assigned = accountRows.filter((row, index) => colors[index]?.stored !== row.color);
  if (assigned.length > 0) {
    await env.DB.batch(
      assigned.map((row) =>
        env.DB.prepare("UPDATE accounts SET color = ? WHERE id = ?").bind(
          colors[accountRows.indexOf(row)]?.stored ?? null,
          row.id,
        ),
      ),
    );
  }
  const accounts: EditorAccount[] = accountRows.map((row, index) => {
    const own = calendarRows.filter((calendar) => calendar.accountId === row.id);
    const main = own.find((calendar) => calendar.isMain === 1);
    const derivedName = names[index] ?? row.email;
    return {
      id: row.id,
      provider: row.provider,
      email: row.email,
      tenantId: row.tenantId,
      inGroup: row.inGroup === 1,
      needsReconnect: row.needsReconnect === 1,
      name: row.displayName ?? derivedName,
      derivedName,
      // A stored name equal to the derived one came from a form that sent the derived name back.
      customName: row.displayName === derivedName ? null : row.displayName,
      color: colors[index]?.color ?? "slate",
      colorChosen: colors[index]?.chosen ?? false,
      calendar: main ? { id: main.id, remoteId: main.remoteId, canEdit: main.canEdit === 1 } : null,
      calendars: own.map((calendar) => ({
        id: calendar.id,
        name: calendar.name,
        isMain: calendar.isMain === 1,
        isSource: calendar.isSource === 1,
      })),
      workHours: parseAccountHours(row.workHours),
      sourceOptions: parseSourceOptions(row.sourceOptions),
    };
  });

  const byPair = new Map(ruleRows.map((row) => [`${row.sourceId}>${row.targetId}`, row]));

  const directions: EditorDirection[] = [];
  for (const from of accounts) {
    const sources = from.calendars.filter((calendar) => calendar.isSource);
    for (const to of accounts) {
      if (from.id === to.id || sources.length === 0 || !to.calendar) continue;
      const slots: Slot[] = sources.map((source) => {
        const row = byPair.get(`${source.id}>${to.calendar?.id}`);
        return {
          sourceCalendarId: source.id,
          rule: row
            ? {
                id: row.id,
                enabled: row.enabled === 1,
                origin: row.origin,
                options: parseRuleOptions(row.options),
                optionsJson: row.options,
              }
            : null,
        };
      });
      const parkedRows = ruleRows.filter(
        (row) =>
          isParked(row) && row.sourceAccountId === from.id && row.targetId === to.calendar?.id,
      );
      const first = slots.find((slot) => slot.rule)?.rule ?? null;
      const choice = first ? choiceOf(first.options, first.enabled) : "off";
      const max = toChoice(detailLevelFor(env, "full", from, to).level);
      const effective = RANK[choice] > RANK[max] ? max : choice;
      directions.push({
        from: from.id,
        to: to.id,
        ruleId: first?.id ?? null,
        choice,
        origin: first?.origin ?? null,
        effective,
        capped: effective !== choice,
        maxChoice: max,
        options: first?.options ?? null,
        slots,
        parked: parkedRows.map((row) => ({
          id: row.id,
          enabled: false,
          origin: "custom" as const,
          options: parseRuleOptions(row.options),
          optionsJson: row.options,
        })),
        // Custom rules into another calendar, such as a manual rule, do not count: they are not
        // the group's blocks, and the group's rule into the main calendar does not repeat them.
        elsewhere: ruleRows.some(
          (row) =>
            row.origin === "group" &&
            row.sourceAccountId === from.id &&
            row.targetAccountId === to.id &&
            row.targetId !== to.calendar?.id,
        ),
      });
    }
  }
  // Every rule the directions above do not cover shows in its own list, so that none hides.
  // Parked exceptions write nothing and come back with their calendar, so they do not show.
  const covered = new Set([
    ...directions.flatMap((direction) => direction.slots.flatMap((slot) => slot.rule?.id ?? [])),
    ...ruleRows.filter(isParked).map((row) => row.id),
  ]);
  const nameOf = (accountId: string) =>
    accounts.find((account) => account.id === accountId)?.name ?? "?";
  const others = ruleRows
    .filter((row) => !covered.has(row.id))
    .map((row) => ({
      ruleId: row.id,
      source: `${nameOf(row.sourceAccountId)} · ${row.sourceName}`,
      target: `${nameOf(row.targetAccountId)} · ${row.targetName}`,
      choice: choiceOf(parseRuleOptions(row.options), row.enabled === 1),
    }));
  const json = settingsRow?.json ?? "{}";
  const ruleOptions = ruleRows.map((row) => parseRuleOptions(row.options));
  const daysAhead = shownDaysAhead(json, ruleOptions);
  const skipAllDay = shownSkipAllDay(json, ruleOptions);
  const rules = ruleRows.map((row) => ({
    from: row.sourceAccountId,
    to: row.targetAccountId,
    rule: {
      id: row.id,
      enabled: row.enabled === 1,
      origin: row.origin,
      options: parseRuleOptions(row.options),
      optionsJson: row.options,
    },
  }));
  const settings = { ...parseSettings(json), daysAhead, skipAllDay };
  return { accounts, directions, others, rules, settings };
}

/**
 * True if the rule is a parked "off" exception. The mark lives in the options JSON outside the
 * schema, so parsing drops it: a copy or a replacement of the rule is not parked.
 */
function isMarkedParked(optionsJson: string): boolean {
  return (JSON.parse(optionsJson) as { parked?: unknown }).parked === true;
}

function parseSettings(json: string): SyncSettings {
  const { daysAhead, skipAllDay, skipTentative, markPrivate, blockTitle, skipCategories } =
    parseRuleOptions(json);
  return { daysAhead, skipAllDay, skipTentative, markPrivate, blockTitle, skipCategories };
}

/**
 * The window the settings show: the stored one, or else the largest `daysAhead` of the user's
 * rules. Rules can be older than the stored settings; a default would shrink them on any save.
 */
function shownDaysAhead(json: string, rules: RuleOptions[]): number {
  const stored = (JSON.parse(json) as { daysAhead?: unknown }).daysAhead;
  if (stored !== undefined || rules.length === 0) return parseSettings(json).daysAhead;
  return Math.max(...rules.map((options) => options.daysAhead));
}

/**
 * The all-day switch the settings show: the stored one, or else on if any rule of the user skips
 * all-day events. Stored settings often lack it, and rules can be older than the default. New rules
 * take the switch, so the default alone would turn the skip off for them.
 */
function shownSkipAllDay(json: string, rules: RuleOptions[]): boolean {
  const stored = (JSON.parse(json) as { skipAllDay?: unknown }).skipAllDay;
  if (stored !== undefined || rules.length === 0) return parseSettings(json).skipAllDay;
  return rules.some((options) => options.skipAllDay);
}

/** Settings from the form. The window can be missing, for example if no choice matched. */
export type SettingsForm = Omit<SyncSettings, "daysAhead"> & {
  daysAhead?: number;
  /** The window that the form showed. */
  daysAheadShown?: number;
  /** The all-day switch that the form showed. */
  skipAllDayShown?: boolean;
};

/** Options of a new rule: the user's settings with the given detail level. */
function newRuleOptions(settings: SyncSettings, detailLevel: Choice): RuleOptions {
  return ruleOptionsSchema.parse({
    ...settings,
    detailLevel: detailLevel === "off" ? "busy" : detailLevel,
  });
}

/**
 * Store the settings and apply them to every rule of the user. The detail level of each rule
 * stays; it is the choice per direction. The window applies only if the user changed it from the
 * one the form showed, and only in that direction: a higher window raises the rules below it, a
 * lower one lowers the rules above it. The other rules keep their own. A smaller window queues the
 * removal of the blocks beyond it, which no run reads any more. The all-day switch applies only if
 * the user changed it from the one the form showed; then every rule follows. Otherwise each rule
 * keeps its own value, because a rule that turns to skipping loses its all-day blocks. Throws
 * `EditorConflict` if a rule changed since the read; then nothing is stored.
 */
export async function setSettings(
  env: Env,
  user: CurrentUser,
  form: SettingsForm,
  syncs?: Set<string>,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.options, r.enabled, tc.can_edit AS canEdit, tc.account_id AS targetAccountId,
            tc.remote_id AS remoteCalendarId
     FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id WHERE r.user_id = ?`,
  )
    .bind(user.id)
    .all<{
      id: string;
      options: string;
      enabled: number;
      canEdit: number;
      targetAccountId: string;
      remoteCalendarId: string;
    }>();
  const stored = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ json: string }>();
  const json = stored?.json ?? "{}";
  const ruleOptions = results.map((row) => parseRuleOptions(row.options));
  const current = shownDaysAhead(json, ruleOptions);
  const currentSkipAllDay = shownSkipAllDay(json, ruleOptions);
  const { daysAhead: chosen, daysAheadShown, skipAllDayShown, skipAllDay, ...rest } = form;
  // A page from before `daysAheadShown` existed showed the stored window, or the default.
  const shown = daysAheadShown ?? parseSettings(json).daysAhead;
  const windowChanged = chosen !== undefined && chosen !== shown;
  // A page from before `skipAllDayShown` existed can show another default, so compare with now.
  const skipAllDayChanged = skipAllDay !== (skipAllDayShown ?? currentSkipAllDay);
  const settings: SyncSettings = {
    ...rest,
    daysAhead: windowChanged ? chosen : current,
    skipAllDay: skipAllDayChanged ? skipAllDay : currentSkipAllDay,
  };
  const windowOf = (previous: number) =>
    !windowChanged
      ? previous
      : settings.daysAhead > shown
        ? Math.max(previous, settings.daysAhead)
        : Math.min(previous, settings.daysAhead);
  // One batch, so that the save stores all changes or none, and stays within the D1 queries of one
  // invocation however many rules the user has.
  const updates: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE users SET sync_settings = ? WHERE id = ?").bind(
      JSON.stringify(settings),
      user.id,
    ),
  ];
  const trims = new Map<string, { ruleId: string; remoteCalendarId: string }[]>();
  for (const row of results) {
    const previous = parseRuleOptions(row.options);
    const options = ruleOptionsSchema.parse({
      ...previous,
      ...settings,
      daysAhead: windowOf(previous.daysAhead),
      skipAllDay: skipAllDayChanged ? settings.skipAllDay : previous.skipAllDay,
    });
    // A parked exception stays parked. A rule that changed since the read fails the batch.
    const stored = isMarkedParked(row.options) ? { ...options, parked: true } : options;
    updates.push(
      env.DB.prepare("UPDATE rules SET options = ? WHERE id = ? AND options = ?").bind(
        JSON.stringify(stored),
        row.id,
        row.options,
      ),
      requireChange(env),
    );
    // A disabled rule has its blocks removed already; a read-only calendar refuses the deletes.
    if (options.daysAhead < previous.daysAhead && row.enabled === 1 && row.canEdit === 1) {
      const queue = trims.get(row.targetAccountId) ?? [];
      queue.push({ ruleId: row.id, remoteCalendarId: row.remoteCalendarId });
      trims.set(row.targetAccountId, queue);
    }
  }
  await guardedBatch(env, updates);
  // One call per target account. Like every queueing, a failure is logged and does not fail the save.
  for (const [accountId, rules] of trims) {
    try {
      await accountSync(env, accountId).queueRemovals(rules, { trim: true });
    } catch (error) {
      console.error("Queueing the trims failed", accountId, ...errorLogFields(error));
    }
  }
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: "settings_changed",
    // The block title and category names are the user's own words; the log keeps counts only.
    detail: {
      daysAhead: settings.daysAhead,
      skipAllDay: settings.skipAllDay,
      skipTentative: settings.skipTentative,
      markPrivate: settings.markPrivate,
      skipCategories: settings.skipCategories.length,
    },
  });
  await requestSyncs(env, new Set(results.map((row) => row.targetAccountId)), syncs);
}

/** Longest name an account can get. */
export const MAX_NAME_LENGTH = 40;

/**
 * Give an account a name, or go back to the derived one with an empty name. The derived name
 * itself counts as empty, so that the account keeps following its address. The log records a
 * rename only if the name on the pages changes.
 */
export async function renameAccount(
  env: Env,
  user: CurrentUser,
  accountId: string,
  name: string,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, email, display_name AS displayName FROM accounts WHERE user_id = ?
     ORDER BY created_at, id`,
  )
    .bind(user.id)
    .all<{ id: string; email: string; displayName: string | null }>();
  const index = results.findIndex((row) => row.id === accountId);
  const row = results[index];
  if (!row) return;
  const derived = shortNames(results.map((r) => r.email))[index] ?? row.email;
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  const stored = trimmed === "" || trimmed === derived ? null : trimmed;
  if (stored === row.displayName) return;
  await env.DB.prepare("UPDATE accounts SET display_name = ? WHERE id = ? AND user_id = ?")
    .bind(stored, accountId, user.id)
    .run();
  if ((stored ?? derived) === (row.displayName ?? derived)) return;
  // The name is the user's own label; the log records that it changed, not the name.
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId,
    kind: "account_renamed",
  });
}

/**
 * Give an account a colour, or make it automatic again with null. The colour only marks the
 * account in the pages, so the audit log does not record it.
 */
export async function setAccountColor(
  env: Env,
  user: CurrentUser,
  accountId: string,
  color: AccountColor | null,
): Promise<boolean> {
  const updated = await env.DB.prepare("UPDATE accounts SET color = ? WHERE id = ? AND user_id = ?")
    .bind(color, accountId, user.id)
    .run();
  return updated.meta.changes > 0;
}

/** Working hours as the rule options store them. A field that is missing keeps its value. */
export type WorkingHours = Partial<
  Pick<RuleOptions, "workDays" | "workStart" | "workEnd" | "workTimeZone">
>;

/** Working hours of an account, complete and valid, with a known zone. */
export type AccountWorkHours = Required<WorkingHours>;

/** Working hours that filter nothing: the defaults of every rule. */
export const NO_WORKING_HOURS: AccountWorkHours = {
  workDays: [...ALL_WEEKDAYS],
  workStart: "",
  workEnd: "",
  workTimeZone: "",
};

/** The stored working hours of an account, or null if it has none or the JSON is broken. */
function parseAccountHours(json: string | null): AccountWorkHours | null {
  if (!json) return null;
  let parsed;
  try {
    parsed = ruleOptionsSchema.safeParse(JSON.parse(json));
  } catch {
    return null;
  }
  if (!parsed.success || !hasWorkingHours(parsed.data)) return null;
  const { workDays, workStart, workEnd, workTimeZone } = parsed.data;
  return { workDays, workStart, workEnd, workTimeZone };
}

/** The hours of a rule as one comparable value. */
function hoursKey(hours: WorkingHours): string {
  return JSON.stringify([hours.workDays, hours.workStart, hours.workEnd, hours.workTimeZone]);
}

/**
 * Working hours as an account stores them, or a problem with them. Hours that filter nothing
 * become null. Without a zone the hours get the deployment's zone, so that they stay put if
 * TIME_ZONE changes later. A zone must be one Intl knows; it is stored by its canonical name.
 */
export function accountWorkHours(
  env: Env,
  hours: AccountWorkHours | null,
): { hours: AccountWorkHours | null } | { problem: WorkingHoursProblem } {
  if (!hours) return { hours: null };
  const input = {
    workDays: [...hours.workDays].sort((a, b) => a - b),
    workStart: hours.workStart.trim(),
    workEnd: hours.workEnd.trim(),
    workTimeZone: hours.workTimeZone.trim(),
  };
  const problem = workingHoursProblem(input);
  if (problem) return { problem };
  if (!hasWorkingHours(input)) return { hours: null };
  const zone = input.workTimeZone || displayTimeZone(env.TIME_ZONE);
  return { hours: { ...input, workTimeZone: canonicalTimeZone(zone) } };
}

/**
 * Set or clear the working hours of an account. Every rule into the account that uses working
 * hours gets the new ones, with null it loses them: the rules of the directions, parked rules and
 * rules into other calendars of the account. The account and its rules change in one batch.
 * Returns false if the account is not the user's. Throws `EditorConflict` if a rule changed since
 * the read.
 */
export async function setAccountWorkHours(
  env: Env,
  user: CurrentUser,
  accountId: string,
  hours: AccountWorkHours | null,
): Promise<boolean> {
  const state = await loadEditorState(env, user.id);
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return false;
  if (hoursKey(account.workHours ?? NO_WORKING_HOURS) === hoursKey(hours ?? NO_WORKING_HOURS)) {
    return true;
  }
  const patches = state.rules
    .filter(({ to, rule }) => to === accountId && hasWorkingHours(rule.options))
    .map(({ to, rule }) => ({ to, rule, patch: hours ?? NO_WORKING_HOURS }));
  await writePatches(env, user, patches, [
    env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = ? AND user_id = ?").bind(
      hours ? JSON.stringify(hours) : null,
      accountId,
      user.id,
    ),
  ]);
  return true;
}

/**
 * The origin of a rule for a choice: "group" for an enabled busy rule between two group members,
 * otherwise "custom". Details such as working hours, the colour or the buffer do not count: they
 * never change the origin, so that turning them on and off cannot make an exception a group rule.
 */
function groupOrigin(
  bothInGroup: boolean,
  enabled: boolean,
  options: RuleOptions,
): "group" | "custom" {
  return bothInGroup && choiceOf(options, enabled) === "busy" ? "group" : "custom";
}

/**
 * Store the block title of the user's language as the default, for a user who has neither chosen
 * a title nor has rules. Existing rules keep their title, so that no block is renamed.
 */
export async function setDefaultBlockTitle(env: Env, userId: string, title: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET sync_settings = json_set(sync_settings, '$.blockTitle', ?)
     WHERE id = ? AND json_type(sync_settings, '$.blockTitle') IS NULL
       AND NOT EXISTS (SELECT 1 FROM rules WHERE user_id = ?)`,
  )
    .bind(title, userId, userId)
    .run();
}

/** Longest Outlook category name for blocks. */
export const MAX_CATEGORY_LENGTH = 100;

/** Why a block colour is not valid for a target provider, or null if it is valid. */
export function blockColorProblem(
  provider: Provider,
  value: string,
): "comma" | "tooLong" | "invalid" | null {
  if (blockColorFor(provider, value) !== null) return null;
  if (provider === "microsoft" && value.includes(",")) return "comma";
  if (provider === "microsoft" && value.trim().length > MAX_CATEGORY_LENGTH) return "tooLong";
  return "invalid";
}

/**
 * The block colour as stored for a target provider, or null if the value is not valid there:
 * a Google event colour "1" to "11", or an Outlook category name. Empty means no colour. Graph
 * takes categories as a list, but classic Outlook keeps them as one comma-separated string and
 * splits a name at its comma, so a name with a comma is refused.
 */
export function blockColorFor(provider: Provider, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (provider === "google") return /^(?:[1-9]|1[01])$/.test(trimmed) ? trimmed : null;
  return trimmed.length <= MAX_CATEGORY_LENGTH && !trimmed.includes(",") ? trimmed : null;
}

/**
 * Options that belong to a source account, not to a direction: every rule from the account shares
 * them. The account stores them, so that they stay while the account has no rules, and new rules
 * from it take them. Another such option needs its key here and a field in the editor.
 */
export const SOURCE_OPTION_KEYS = ["bufferBefore", "bufferAfter"] as const;

export type SourceOptionKey = (typeof SOURCE_OPTION_KEYS)[number];

export type SourceOptions = Pick<RuleOptions, SourceOptionKey>;

/** Buffers in minutes. A buffer that is missing keeps its value. */
export type BlockBuffer = Partial<Pick<RuleOptions, "bufferBefore" | "bufferAfter">>;

function pickSourceOptions(options: RuleOptions): SourceOptions {
  return Object.fromEntries(SOURCE_OPTION_KEYS.map((key) => [key, options[key]])) as SourceOptions;
}

/** The stored source options of an account, or null if it has none or the JSON is broken. */
function parseSourceOptions(json: string | null): SourceOptions | null {
  if (!json) return null;
  let parsed;
  try {
    parsed = ruleOptionsSchema.safeParse(JSON.parse(json));
  } catch {
    return null;
  }
  return parsed.success ? pickSourceOptions(parsed.data) : null;
}

/**
 * The source options of an account as the editor shows them: the stored ones, or else those of
 * its first rule, or else the defaults. `mixed` names the options in which a rule from the account
 * differs, such as rules from before the account stored its options. Null for an unknown account.
 */
export function sourceOptionsOf(
  state: EditorState,
  accountId: string,
): { options: SourceOptions; mixed: SourceOptionKey[] } | null {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return null;
  const rules = state.rules.filter(({ from }) => from === accountId);
  const first = rules[0]?.rule.options;
  const options = account.sourceOptions ?? pickSourceOptions(first ?? ruleOptionsSchema.parse({}));
  const mixed = SOURCE_OPTION_KEYS.filter((key) =>
    rules.some(({ rule }) => rule.options[key] !== options[key]),
  );
  return { options, mixed };
}

/**
 * The source options for a new rule from an account: the stored ones, or else those that all its
 * rules share. Options in which its rules differ keep the value of the new rule's model.
 */
function newRuleSource(state: EditorState, accountId: string): Partial<SourceOptions> {
  const account = state.accounts.find((a) => a.id === accountId);
  if (account?.sourceOptions) return account.sourceOptions;
  const current = sourceOptionsOf(state, accountId);
  if (!current) return {};
  return Object.fromEntries(
    SOURCE_OPTION_KEYS.filter((key) => !current.mixed.includes(key)).map((key) => [
      key,
      current.options[key],
    ]),
  );
}

/**
 * The buffer of a source account, which all rules from it share: "mixed" if its rules differ,
 * null for an unknown account. The editor shows and writes one buffer per source.
 */
export function sourceBuffer(
  state: EditorState,
  accountId: string,
): Required<BlockBuffer> | "mixed" | null {
  const current = sourceOptionsOf(state, accountId);
  if (!current) return null;
  if (current.mixed.includes("bufferBefore") || current.mixed.includes("bufferAfter")) {
    return "mixed";
  }
  const { bufferBefore, bufferAfter } = current.options;
  return { bufferBefore, bufferAfter };
}

/**
 * Changes of the editor that only touch rule options, so that one batch can store all of them:
 * - `colors`: the block colour of one direction.
 * - `workHours`: per direction, true copies the target account's working hours into the rules,
 *   false clears them.
 * - `sources`: per source account, options for the account and every rule from it.
 */
export interface RuleDetails {
  colors?: { from: string; to: string; value: string }[];
  workHours?: { from: string; to: string; on: boolean }[];
  sources?: { from: string; options: Partial<SourceOptions> }[];
}

/** Why rule details cannot be stored, or null if they can. */
export type RuleDetailsProblem =
  | { kind: "color"; problem: "comma" | "tooLong" | "invalid" }
  | { kind: "source" }
  | { kind: "noWorkHours"; account: string }
  /** The direction is not the user's, or no longer exists. */
  | { kind: "direction"; field: "color" | "workHours" };

/**
 * Check rule details against a state before anything is written, so that an invalid detail
 * refuses the whole save. Working hours can be turned on only for an account that has them.
 */
export function ruleDetailsProblem(
  state: EditorState,
  details: RuleDetails,
): RuleDetailsProblem | null {
  for (const { from, to, value } of details.colors ?? []) {
    const target = state.accounts.find((account) => account.id === to);
    const known = state.directions.some((d) => d.from === from && d.to === to);
    if (!target || !known) return { kind: "direction", field: "color" };
    const problem = blockColorProblem(target.provider, value);
    if (problem) return { kind: "color", problem };
  }
  for (const { from, options } of details.sources ?? []) {
    const known = state.accounts.some((account) => account.id === from);
    if (!known || !ruleOptionsSchema.safeParse(options).success) return { kind: "source" };
  }
  for (const { from, to, on } of details.workHours ?? []) {
    const target = state.accounts.find((account) => account.id === to);
    const direction = state.directions.find((d) => d.from === from && d.to === to);
    if (!target || !direction) return { kind: "direction", field: "workHours" };
    // Rules that kept hours from before the account had any keep them; see `setRuleDetails`.
    const has = direction.options !== null && hasWorkingHours(direction.options);
    if (on && !target.workHours && !has) return { kind: "noWorkHours", account: target.name };
  }
  return null;
}

/**
 * Store rule details (see `RuleDetails`) in one batch, with one audit event per changed rule.
 * Call it after the choices and source calendars of the same save, so that it reaches their new
 * rules. A direction without rules, for example one that lost its last source in the same save,
 * has nothing to change and is skipped. So is the copy of working hours from an account that has
 * none any more; its rules keep theirs. Source options are stored on the account even if it has
 * no rules. Returns false for details that `ruleDetailsProblem` refuses against the current state.
 * Throws `EditorConflict` if a rule changed since the read; then nothing is stored.
 */
export async function setRuleDetails(
  env: Env,
  user: CurrentUser,
  details: RuleDetails,
  syncs?: Set<string>,
): Promise<boolean> {
  const state = await loadEditorState(env, user.id);
  const problem = ruleDetailsProblem(state, details);
  if (problem && problem.kind !== "direction" && problem.kind !== "noWorkHours") return false;
  const patches: RulePatch[] = [];
  const accounts: D1PreparedStatement[] = [];
  const forDirection = (direction: EditorDirection, patch: Partial<RuleOptions>) => {
    for (const { rule } of direction.slots) {
      if (rule) patches.push({ to: direction.to, rule, patch });
    }
  };
  for (const { from, to, value } of details.colors ?? []) {
    const target = state.accounts.find((account) => account.id === to);
    const direction = state.directions.find((d) => d.from === from && d.to === to);
    const blockColor = target ? blockColorFor(target.provider, value) : null;
    if (direction && blockColor !== null) forDirection(direction, { blockColor });
  }
  for (const { from, options } of details.sources ?? []) {
    const current = sourceOptionsOf(state, from);
    if (!current) continue;
    // Every rule from the account: those of its directions, parked ones and manual ones.
    for (const entry of state.rules) {
      if (entry.from === from) patches.push({ to: entry.to, rule: entry.rule, patch: options });
    }
    // json_patch merges into what the account has, so that a concurrent save of another source
    // option keeps its value. An account without stored options, or with broken ones, starts from
    // what the page showed.
    accounts.push(
      env.DB.prepare(
        `UPDATE accounts SET source_options = json_patch(
           CASE WHEN json_valid(source_options) THEN source_options ELSE ? END, ?)
         WHERE id = ? AND user_id = ?`,
      ).bind(JSON.stringify(current.options), JSON.stringify(options), from, user.id),
    );
  }
  for (const { from, to, on } of details.workHours ?? []) {
    const target = state.accounts.find((account) => account.id === to);
    const direction = state.directions.find((d) => d.from === from && d.to === to);
    if (!target || !direction) continue;
    if (!on) forDirection(direction, NO_WORKING_HOURS);
    else if (target.workHours) forDirection(direction, target.workHours);
  }
  await writePatches(env, user, patches, accounts, syncs);
  return true;
}

/** Set the block colour of one direction. See `setRuleDetails`. */
export async function setBlockColor(
  env: Env,
  user: CurrentUser,
  fromId: string,
  toId: string,
  value: string,
  syncs?: Set<string>,
): Promise<boolean> {
  return setRuleDetails(env, user, { colors: [{ from: fromId, to: toId, value }] }, syncs);
}

/** A change of the options of one rule into account `to`. Patches of a rule apply in order. */
interface RulePatch {
  to: string;
  rule: SlotRule;
  patch: Partial<RuleOptions>;
}

/**
 * A save of the editor found rules that another request changed after this one read them, for
 * example in another tab. Nothing of the batch that found it was stored.
 */
export class EditorConflict extends Error {
  constructor() {
    super("Rules changed since they were read");
    this.name = "EditorConflict";
  }
}

/** Text in the error of `requireChange`, so that no other failure counts as a conflict. */
const UNCHANGED_ROW = "slotmirror-unchanged-row";

/**
 * A statement that fails its batch, and so rolls back every write of the batch, if the statement
 * before it changed no row. SQLite has no RAISE outside triggers; json_extract() with an invalid
 * path fails instead, and its error names the path. The path depends on changes(), so SQLite
 * cannot evaluate it ahead of time.
 */
function requireChange(env: Env): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT json_extract('{}', CASE WHEN changes() > 0 THEN '$' ELSE '${UNCHANGED_ROW}' END)`,
  );
}

/** True for the failure of `requireChange`. */
function isRequiredChangeMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes(UNCHANGED_ROW);
}

/** Run a batch with `requireChange` guards; a failed guard throws `EditorConflict`. */
async function guardedBatch(env: Env, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await env.DB.batch(statements);
  } catch (error) {
    if (isRequiredChangeMissing(error)) throw new EditorConflict();
    throw error;
  }
}

/**
 * Write option patches and `before` in one D1 batch, with one audit event per changed rule, then
 * ask each target account with a changed enabled rule to sync, or add it to `syncs`. Each rule is
 * written only if its options are still the ones that were read; otherwise the whole batch fails
 * and this throws `EditorConflict`. The origin of a rule stays, and a parked rule stays parked.
 */
async function writePatches(
  env: Env,
  user: CurrentUser,
  patches: RulePatch[],
  before: D1PreparedStatement[] = [],
  syncs?: Set<string>,
): Promise<void> {
  const merged = new Map<string, RulePatch>();
  for (const entry of patches) {
    const known = merged.get(entry.rule.id);
    merged.set(
      entry.rule.id,
      known ? { ...known, patch: { ...known.patch, ...entry.patch } } : entry,
    );
  }
  const statements = [...before];
  const targets = new Set<string>();
  for (const { to, rule, patch } of merged.values()) {
    const parsed = ruleOptionsSchema.safeParse({ ...rule.options, ...patch });
    if (!parsed.success) continue;
    const options = parsed.data;
    const old = rule.options;
    const detail: Record<string, string> = {};
    // The category name is the user's own word; the log records that the colour changed.
    if (options.blockColor !== old.blockColor) detail.blockColor = "changed";
    if (options.bufferBefore !== old.bufferBefore || options.bufferAfter !== old.bufferAfter) {
      detail.bufferBefore = String(options.bufferBefore);
      detail.bufferAfter = String(options.bufferAfter);
    }
    if (hoursKey(options) !== hoursKey(old)) {
      detail.workDays = options.workDays.join(",");
      detail.workStart = options.workStart;
      detail.workEnd = options.workEnd;
      detail.workTimeZone = options.workTimeZone;
    }
    if (Object.keys(detail).length === 0) continue;
    const stored = isMarkedParked(rule.optionsJson) ? { ...options, parked: true } : options;
    statements.push(
      env.DB.prepare(
        "UPDATE rules SET options = ? WHERE id = ? AND user_id = ? AND options = ?",
      ).bind(JSON.stringify(stored), rule.id, user.id, rule.optionsJson),
      requireChange(env),
      auditStatement(env.DB, {
        orgId: user.orgId,
        userId: user.id,
        accountId: to,
        ruleId: rule.id,
        kind: "rule_updated",
        detail,
      }),
    );
    // A disabled rule writes no blocks, so its target has nothing to sync.
    if (rule.enabled) targets.add(to);
  }
  if (statements.length === 0) return;
  await guardedBatch(env, statements);
  await requestSyncs(env, targets, syncs);
}

/** The origin note of the blocks from one source; see `showOrigin` and `linkOrigin`. */
export interface OriginNoteForm {
  showOrigin: boolean;
  linkOrigin: boolean;
}

/**
 * Turn the origin note on or off for every rule from the calendars of one source account, in the
 * user's current language. The link needs the note. Invalid input, or an account that is not the
 * user's, returns false and writes nothing. All rules change in one batch with the audit event,
 * so that a save changes all or none. Each changed block is written again once, in the alarm's
 * pace; see `MAX_BATCHES_PER_RUN`.
 */
export async function setOriginNote(
  env: Env,
  user: CurrentUser,
  sourceAccountId: string,
  form: OriginNoteForm,
  locale: Locale,
): Promise<boolean> {
  const { showOrigin, linkOrigin } = form;
  if (typeof showOrigin !== "boolean" || typeof linkOrigin !== "boolean") return false;
  if (linkOrigin && !showOrigin) return false;
  if (!isLocale(locale)) return false;
  const account = await env.DB.prepare(
    "SELECT 1 AS found FROM accounts WHERE id = ? AND user_id = ?",
  )
    .bind(sourceAccountId, user.id)
    .first<{ found: number }>();
  if (!account) return false;
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.options, r.enabled, tc.account_id AS targetAccountId
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ? AND sc.account_id = ?`,
  )
    .bind(user.id, sourceAccountId)
    .all<{ id: string; options: string; enabled: number; targetAccountId: string }>();
  const changed = results.filter((row) => {
    const options = parseRuleOptions(row.options);
    return (
      options.showOrigin !== showOrigin ||
      options.linkOrigin !== linkOrigin ||
      (showOrigin && options.originLocale !== locale)
    );
  });
  if (changed.length === 0) return true;
  // json_set changes only these keys, so that a concurrent save of other options is kept.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE rules SET options = json_set(options, '$.showOrigin', json(?), '$.linkOrigin', json(?),
         '$.originLocale', ?)
       WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`,
    ).bind(
      String(showOrigin),
      String(linkOrigin),
      locale,
      user.id,
      JSON.stringify(changed.map((row) => row.id)),
    ),
    auditStatement(env.DB, {
      orgId: user.orgId,
      userId: user.id,
      accountId: sourceAccountId,
      kind: "rule_updated",
      detail: { showOrigin, linkOrigin, rules: changed.length },
    }),
  ]);
  await requestSyncs(
    env,
    new Set(changed.filter((row) => row.enabled === 1).map((row) => row.targetAccountId)),
  );
  return true;
}

/** Delete a rule and the blocks it wrote. A failed cleanup is recorded, the rule goes anyway. */
export async function deleteRuleWithBlocks(
  env: Env,
  user: CurrentUser,
  ruleId: string,
): Promise<boolean> {
  const target = await env.DB.prepare(
    `SELECT tc.account_id AS accountId, tc.remote_id AS remoteCalendarId FROM rules r
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.id = ? AND r.user_id = ?`,
  )
    .bind(ruleId, user.id)
    .first<{ accountId: string; remoteCalendarId: string }>();
  if (!target) return false;

  const queued = await queueRemoval(env, ruleId, target);
  await env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?")
    .bind(ruleId, user.id)
    .run();
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId: target.accountId,
    ruleId,
    kind: "rule_deleted",
    detail: queued ? { cleanup: "queued" } : { cleanupFailed: true },
  });
  return true;
}

/**
 * Hand the removal of a rule's blocks to the target account's Durable Object, which runs it in an
 * alarm. The blocks carry the rule's tag, so the rule can change or go right away.
 */
async function queueRemoval(
  env: Env,
  ruleId: string,
  target: { accountId: string; remoteCalendarId: string },
  options: { trim?: boolean } = {},
): Promise<boolean> {
  try {
    await accountSync(env, target.accountId).queueRemoval(ruleId, target.remoteCalendarId, options);
    return true;
  } catch (error) {
    console.error("Queueing the removal failed", ruleId, ...errorLogFields(error));
    return false;
  }
}

/**
 * Set one direction. "busy" between two group members becomes a group rule again; every other
 * choice is a custom rule. "off" removes the blocks; between group members it keeps a disabled
 * custom rule, so that the group does not recreate it. See `setDirections`.
 */
export async function setDirection(
  env: Env,
  user: CurrentUser,
  fromId: string,
  toId: string,
  choice: Choice,
  syncs?: Set<string>,
): Promise<void> {
  await setDirections(env, user, [{ from: fromId, to: toId, choice }], syncs);
}

/** What happens after the write batch of `setDirections` for one of its statements. */
type DirectionFollowUp =
  /** An upsert: a new rule, or the rule of a concurrent request for the same pair. */
  | { kind: "upsert"; index: number; id: string; to: string; target: RemovalTarget; choice: Choice }
  /** A rule disabled or changed in place. */
  | { kind: "updated"; ruleId: string; to: string; choice: Choice; remove?: RemovalTarget }
  /** A rule deleted: its blocks go too. */
  | { kind: "deleted"; index: number; ruleId: string; to: string; remove: RemovalTarget }
  /** A parked exception that another choice replaced. */
  | { kind: "unparked"; index: number; ruleId: string; to: string };

interface RemovalTarget {
  accountId: string;
  remoteCalendarId: string;
}

/**
 * Set several directions with one read and one write batch, so that a page save with many
 * directions stays within the D1 queries of one invocation. See `setDirection` for each choice.
 * A rule changes only if its options are still the ones that were read; otherwise the batch fails
 * as a whole and this throws `EditorConflict`. After the batch, the removals of blocks go to each
 * target account in one call, and the audit events follow in a second batch.
 */
export async function setDirections(
  env: Env,
  user: CurrentUser,
  changes: { from: string; to: string; choice: Choice }[],
  syncs?: Set<string>,
): Promise<void> {
  // A pair given twice counts once, with its last choice.
  const latest = new Map(changes.map((change) => [`${change.from}>${change.to}`, change]));
  if (latest.size === 0) return;
  const state = await loadEditorState(env, user.id);
  const statements: D1PreparedStatement[] = [];
  const followUps: DirectionFollowUp[] = [];
  const targets = new Set<string>();
  const push = (...added: D1PreparedStatement[]) => {
    statements.push(...added);
    return statements.length - added.length;
  };
  const upsert = (rule: {
    id: string;
    sourceCalendarId: string;
    targetCalendarId: string;
    options: RuleOptions;
    origin: "group" | "custom";
    enabled: boolean;
  }) => push(upsertStatement(env, user, rule));

  for (const change of latest.values()) {
    const to = state.accounts.find((account) => account.id === change.to);
    const from = state.accounts.find((account) => account.id === change.from);
    const direction = state.directions.find((d) => d.from === change.from && d.to === change.to);
    if (!from || !to?.calendar || !direction) continue;
    let choice = change.choice;
    // "Off" needs no write access, so that a rule never keeps writing into a read-only calendar.
    if (choice !== "off" && !to.calendar.canEdit) continue;
    const target = { accountId: to.id, remoteCalendarId: to.calendar.remoteId };
    const bothInGroup = from.inGroup && to.inGroup;
    // The sync applies the caps anyway; storing the capped value keeps the page honest.
    if (RANK[choice] > RANK[direction.maxChoice]) choice = direction.maxChoice;

    // A parked rule stands for "off". Another choice replaces it, so that it cannot bring back an
    // old "off" when its calendar or the direction's last source comes back.
    if (choice !== "off") {
      for (const parked of direction.parked) {
        const index = push(
          env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ? AND enabled = 0").bind(
            parked.id,
            user.id,
          ),
        );
        followUps.push({ kind: "unparked", index, ruleId: parked.id, to: to.id });
      }
    }

    for (const slot of direction.slots) {
      const { rule } = slot;
      if (choice === "off") {
        if (!rule) {
          // Between group members, a disabled exception keeps the group from adding the rule.
          if (bothInGroup) {
            const id = crypto.randomUUID();
            const index = upsert({
              id,
              sourceCalendarId: slot.sourceCalendarId,
              targetCalendarId: to.calendar.id,
              options: {
                ...newRuleOptions(state.settings, "busy"),
                ...newRuleSource(state, from.id),
              },
              origin: "custom",
              enabled: false,
            });
            followUps.push({ kind: "upsert", index, id, to: to.id, target, choice });
          }
          continue;
        }
        if (!bothInGroup) {
          const index = push(
            env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?").bind(rule.id, user.id),
          );
          followUps.push({ kind: "deleted", index, ruleId: rule.id, to: to.id, remove: target });
          continue;
        }
        push(
          env.DB.prepare(
            `UPDATE rules SET enabled = 0, origin = 'custom'
             WHERE id = ? AND user_id = ? AND options = ?`,
          ).bind(rule.id, user.id, rule.optionsJson),
          requireChange(env),
        );
        followUps.push({ kind: "updated", ruleId: rule.id, to: to.id, choice, remove: target });
        continue;
      }

      // A new rule gets the options of its source, which all rules from the source share.
      const options = {
        ...(rule?.options ?? {
          ...(direction.options ?? newRuleOptions(state.settings, choice)),
          ...newRuleSource(state, from.id),
        }),
        detailLevel: choice,
      };
      const origin = groupOrigin(bothInGroup, true, options);
      if (rule) {
        push(
          env.DB.prepare(
            `UPDATE rules SET options = ?, enabled = 1, origin = ?
             WHERE id = ? AND user_id = ? AND options = ?`,
          ).bind(JSON.stringify(options), origin, rule.id, user.id, rule.optionsJson),
          requireChange(env),
        );
        followUps.push({ kind: "updated", ruleId: rule.id, to: to.id, choice });
      } else {
        const id = crypto.randomUUID();
        const index = upsert({
          id,
          sourceCalendarId: slot.sourceCalendarId,
          targetCalendarId: to.calendar.id,
          options,
          origin,
          enabled: true,
        });
        followUps.push({ kind: "upsert", index, id, to: to.id, target, choice });
      }
    }
    if (choice !== "off") targets.add(to.id);
  }
  if (statements.length === 0) return;
  const results = await guardedBatch(env, statements);

  const removals = new Map<string, { ruleId: string; remoteCalendarId: string }[]>();
  const remove = (ruleId: string, target: RemovalTarget) => {
    const queue = removals.get(target.accountId) ?? [];
    queue.push({ ruleId, remoteCalendarId: target.remoteCalendarId });
    removals.set(target.accountId, queue);
  };
  const audits: AuditEvent[] = [];
  const event = (
    to: string,
    ruleId: string,
    kind: AuditEvent["kind"],
    detail: NonNullable<AuditEvent["detail"]>,
  ) => audits.push({ orgId: user.orgId, userId: user.id, accountId: to, ruleId, kind, detail });
  const deleted: { ruleId: string; to: string; accountId: string }[] = [];
  for (const followUp of followUps) {
    switch (followUp.kind) {
      case "upsert": {
        const stored = results[followUp.index]?.results[0] as { id: string } | undefined;
        if (!stored) break;
        const created = stored.id === followUp.id;
        // A concurrent request created the rule, and it can have written blocks already.
        if (followUp.choice === "off") {
          if (created) break;
          remove(stored.id, followUp.target);
        }
        event(followUp.to, stored.id, created ? "rule_created" : "rule_updated", {
          choice: followUp.choice,
        });
        break;
      }
      case "updated":
        if (followUp.remove) remove(followUp.ruleId, followUp.remove);
        event(followUp.to, followUp.ruleId, "rule_updated", { choice: followUp.choice });
        break;
      case "deleted":
        // A concurrent request deleted the rule first; it queued the removal and wrote the audit.
        if ((results[followUp.index]?.meta.changes ?? 0) === 0) break;
        remove(followUp.ruleId, followUp.remove);
        deleted.push({ ruleId: followUp.ruleId, to: followUp.to, ...followUp.remove });
        break;
      case "unparked":
        // A parked exception writes no blocks, so there is nothing to remove.
        if ((results[followUp.index]?.meta.changes ?? 0) === 0) break;
        event(followUp.to, followUp.ruleId, "rule_deleted", { parked: "replaced" });
        break;
    }
  }
  // One call per target account. Like every queueing, a failure is logged and noted in the audit.
  const queued = new Map<string, boolean>();
  for (const [accountId, rules] of removals) {
    try {
      await accountSync(env, accountId).queueRemovals(rules);
      queued.set(accountId, true);
    } catch (error) {
      console.error("Queueing the removals failed", accountId, ...errorLogFields(error));
      queued.set(accountId, false);
    }
  }
  for (const { ruleId, to, accountId } of deleted) {
    event(
      to,
      ruleId,
      "rule_deleted",
      queued.get(accountId) ? { cleanup: "queued" } : { cleanupFailed: true },
    );
  }
  if (audits.length > 0) {
    // The change is done; like `recordAudit`, a broken log must not fail the request.
    try {
      await env.DB.batch(audits.map((audit) => auditStatement(env.DB, audit)));
    } catch (error) {
      console.error("Audit write failed", "rule_updated", ...errorLogFields(error));
    }
  }
  await requestSyncs(env, targets, syncs);
}

/**
 * Turn a calendar on or off as a source of its account. On: it gets a rule for every direction
 * of the account, with that direction's choice, or the group's rule between group members. Off:
 * its rules go, with their blocks. An "off" exception into a main calendar stays as a parked rule,
 * so that the group does not turn the direction on when the calendar comes back.
 */
export async function setSourceCalendar(
  env: Env,
  user: CurrentUser,
  calendarId: string,
  isSource: boolean,
  syncs?: Set<string>,
): Promise<void> {
  const updated = await env.DB.prepare(
    `UPDATE calendars SET is_source = ?
     WHERE id = ? AND is_source <> ?
       AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)`,
  )
    .bind(isSource ? 1 : 0, calendarId, isSource ? 1 : 0, user.id)
    .run();
  if (updated.meta.changes === 0) return;

  if (!isSource) {
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.enabled, r.origin, tc.is_default AS isMain, tc.account_id AS accountId,
              tc.remote_id AS remoteCalendarId
       FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id
       WHERE r.source_calendar_id = ? AND r.user_id = ?`,
    )
      .bind(calendarId, user.id)
      .all<{
        id: string;
        enabled: number;
        origin: string;
        isMain: number;
        accountId: string;
        remoteCalendarId: string;
      }>();
    for (const row of results) {
      if (row.enabled === 0 && row.origin === "custom" && row.isMain === 1) {
        await env.DB.prepare(
          "UPDATE rules SET options = json_set(options, '$.parked', json('true')) WHERE id = ?",
        )
          .bind(row.id)
          .run();
        // A paused rule can still have blocks; an exception has none, and the queue finds none.
        await queueRemoval(env, row.id, row);
      } else {
        await deleteRuleWithBlocks(env, user, row.id);
      }
    }
    return;
  }

  // A parked exception is current only if no other source calendar has a rule for the direction.
  // Otherwise the other calendar holds the choice, and the parked rule gives way to a copy of it.
  const state = await loadEditorState(env, user.id);
  const stale: { ruleId: string; accountId: string }[] = [];
  for (const direction of state.directions) {
    const own = direction.slots.find((slot) => slot.sourceCalendarId === calendarId);
    const other = direction.slots.some((slot) => slot !== own && slot.rule);
    if (own?.rule && isMarkedParked(own.rule.optionsJson) && other) {
      stale.push({ ruleId: own.rule.id, accountId: direction.to });
      own.rule = null;
    }
  }
  const results = await addMissingRules(
    env,
    user,
    state,
    [
      ...stale.map(({ ruleId }) =>
        env.DB.prepare(
          `DELETE FROM rules WHERE id = ? AND user_id = ? AND enabled = 0
           AND json_extract(options, '$.parked') = 1`,
        ).bind(ruleId, user.id),
      ),
      // The calendar is a source again: its rules that stay are no longer parked.
      env.DB.prepare(
        "UPDATE rules SET options = json_remove(options, '$.parked') WHERE source_calendar_id = ? AND user_id = ?",
      ).bind(calendarId, user.id),
    ],
    syncs,
  );
  const deleted = stale.filter((_, index) => (results[index]?.meta.changes ?? 0) > 0);
  for (const { ruleId, accountId } of deleted) {
    // An exception writes no blocks, so there is nothing to remove.
    await audit(env, user, accountId, ruleId, "rule_deleted", { parked: "replaced" });
  }
}

/**
 * Undo an exception: back to the group's busy, or no rule outside the group. The block colour
 * and the working hours go back to none too, so that the direction is the plain default again.
 * The buffer stays: it belongs to the source, not to the direction. A group direction can still
 * get a colour later; that does not make it an exception. A read-only target stays as it is:
 * `can_edit` can be wrong, so a reset must not remove blocks there. "Off" is the explicit way.
 */
export async function resetDirection(
  env: Env,
  user: CurrentUser,
  fromId: string,
  toId: string,
): Promise<void> {
  const state = await loadEditorState(env, user.id);
  const from = state.accounts.find((account) => account.id === fromId);
  const to = state.accounts.find((account) => account.id === toId);
  if (!from || !to?.calendar?.canEdit) return;
  // The hours go first; outside the group the rules go anyway. One sync request at the end, also
  // after a conflict: the steps before it stay written.
  const syncs = new Set<string>();
  try {
    await setRuleDetails(env, user, { workHours: [{ from: fromId, to: toId, on: false }] }, syncs);
    const choice = from.inGroup && to.inGroup ? "busy" : "off";
    await setDirection(env, user, fromId, toId, choice, syncs);
    await setBlockColor(env, user, fromId, toId, "", syncs);
  } finally {
    await requestSyncs(env, syncs);
  }
}

/** A rule that a direction lacks, with the choice for the audit log. */
interface MissingRule {
  id: string;
  sourceCalendarId: string;
  targetCalendarId: string;
  targetAccountId: string;
  options: RuleOptions;
  origin: "group" | "custom";
  enabled: boolean;
  choice: Choice;
}

/**
 * The rules that make every direction complete:
 * - A direction with a rule gets a copy of it for each source calendar without one, so that all
 *   its rules have the same choice. A parked "off" exception counts as such a rule.
 * - A direction without rules between two group members gets a group rule ("busy") for each
 *   source calendar.
 *
 * A source calendar that has a rule keeps it, so an exception, also a disabled one, wins over the
 * group. A read-only target gets nothing, because turning a direction on needs write access. A
 * direction with rules into another calendar of the target account, such as the main calendar
 * before it changed, gets nothing either: a second set of rules would write every block twice.
 */
function missingRules(state: EditorState): MissingRule[] {
  const missing: MissingRule[] = [];
  for (const direction of state.directions) {
    const from = state.accounts.find((account) => account.id === direction.from);
    const to = state.accounts.find((account) => account.id === direction.to);
    if (!from || !to?.calendar?.canEdit || direction.elsewhere) continue;
    const model = direction.slots.find((slot) => slot.rule)?.rule ?? direction.parked[0];
    if (!model && !(from.inGroup && to.inGroup)) continue;
    // A copy takes the current options of its source and the current hours of its target: a
    // parked model can be older than both.
    const hours = model && hasWorkingHours(model.options) ? (to.workHours ?? NO_WORKING_HOURS) : {};
    const options = {
      ...(model?.options ?? newRuleOptions(state.settings, "busy")),
      ...newRuleSource(state, from.id),
      ...hours,
    };
    for (const slot of direction.slots) {
      if (slot.rule) continue;
      missing.push({
        id: crypto.randomUUID(),
        sourceCalendarId: slot.sourceCalendarId,
        targetCalendarId: to.calendar.id,
        targetAccountId: to.id,
        options,
        origin: model?.origin ?? "group",
        enabled: model?.enabled ?? true,
        choice: model ? choiceOf(model.options, model.enabled) : "busy",
      });
    }
  }
  return missing;
}

/**
 * Statements that insert the missing rules, each with its audit event. A concurrent request can
 * insert the same pair first; the insert then does nothing, and its audit event is not written.
 */
function insertStatements(
  env: Env,
  user: Pick<CurrentUser, "id" | "orgId">,
  rules: MissingRule[],
): D1PreparedStatement[] {
  return rules.flatMap((rule) => [
    env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_calendar_id, target_calendar_id) DO NOTHING`,
    ).bind(
      rule.id,
      user.id,
      rule.sourceCalendarId,
      rule.targetCalendarId,
      JSON.stringify(rule.options),
      rule.enabled ? 1 : 0,
      rule.origin,
    ),
    auditStatement(
      env.DB,
      {
        orgId: user.orgId,
        userId: user.id,
        accountId: rule.targetAccountId,
        ruleId: rule.id,
        kind: "rule_created",
        detail: { choice: rule.choice },
      },
      true,
    ),
  ]);
}

/** Target accounts that got an enabled rule from `insertStatements`, run at `offset` in a batch. */
function syncTargets(rules: MissingRule[], results: D1Result[], offset: number): Set<string> {
  const targets = new Set<string>();
  rules.forEach((rule, index) => {
    const inserted = (results[offset + 2 * index]?.meta.changes ?? 0) > 0;
    if (inserted && rule.enabled) targets.add(rule.targetAccountId);
  });
  return targets;
}

/**
 * Ask accounts to sync, or add them to `syncs`, so that a save with several steps asks each
 * account once, after its last write.
 */
export async function requestSyncs(
  env: Env,
  accountIds: Iterable<string>,
  syncs?: Set<string>,
): Promise<void> {
  for (const id of accountIds) {
    if (syncs) syncs.add(id);
    else await accountSync(env, id).requestSync();
  }
}

/**
 * Add the rules that the directions of a user lack (see `missingRules`). Call it after anything
 * that can make a rule possible: a source calendar turned on, calendars loaded or refreshed, a
 * target that became writable. A second call adds nothing. Cost: one read batch, and one write
 * batch only if a rule is missing.
 */
export async function reconcileRules(
  env: Env,
  user: Pick<CurrentUser, "id" | "orgId">,
): Promise<void> {
  await addMissingRules(env, user, await loadEditorState(env, user.id));
}

/** Run `before` and the inserts of the missing rules in one batch, then request the syncs. */
async function addMissingRules(
  env: Env,
  user: Pick<CurrentUser, "id" | "orgId">,
  state: EditorState,
  before: D1PreparedStatement[] = [],
  syncs?: Set<string>,
): Promise<D1Result[]> {
  const missing = missingRules(state);
  if (missing.length === 0 && before.length === 0) return [];
  const results = await env.DB.batch([...before, ...insertStatements(env, user, missing)]);
  await requestSyncs(env, syncTargets(missing, results, before.length), syncs);
  return results;
}

/** Add an account to the block group or remove it. See `setGroupMemberships`. */
export async function setGroupMembership(
  env: Env,
  user: CurrentUser,
  accountId: string,
  inGroup: boolean,
): Promise<void> {
  await setGroupMemberships(env, user, [accountId], inGroup);
}

/**
 * Add accounts to the block group or remove them. Joining creates a busy rule to and from every
 * other member, and adopts existing busy rules with default options. Leaving deletes the group
 * rules of the accounts with their blocks; custom rules stay. The writes go in batches, so that
 * the quick start for all accounts stays within the D1 queries of one invocation.
 */
export async function setGroupMemberships(
  env: Env,
  user: CurrentUser,
  accountIds: readonly string[],
  inGroup: boolean,
): Promise<void> {
  if (accountIds.length === 0) return;
  if (!inGroup) {
    await leaveGroup(env, user, accountIds);
    return;
  }
  const updates = await env.DB.batch(accountIds.map((id) => membershipUpdate(env, user, id, true)));
  const changed = new Set(accountIds.filter((_, i) => (updates[i]?.meta.changes ?? 0) > 0));
  if (changed.size === 0) return;
  const statements = [...changed].map((accountId) => groupChangedAudit(env, user, accountId, true));

  const state = await loadEditorState(env, user.id);
  for (const direction of state.directions) {
    if (!changed.has(direction.from) && !changed.has(direction.to)) continue;
    const from = state.accounts.find((account) => account.id === direction.from);
    const to = state.accounts.find((account) => account.id === direction.to);
    if (!from?.inGroup || !to?.inGroup || !to.calendar?.canEdit) continue;
    for (const { rule } of direction.slots) {
      if (
        rule?.origin === "custom" &&
        rule.enabled &&
        choiceOf(rule.options, true) === "busy" &&
        hasDefaultOptions(rule.options, state.settings, newRuleSource(state, direction.from))
      ) {
        // Only if the rule is unchanged: a concurrent request may have customised it.
        statements.push(
          env.DB.prepare(
            `UPDATE rules SET origin = 'group'
             WHERE id = ? AND enabled = 1 AND origin = 'custom' AND options = ?`,
          ).bind(rule.id, rule.optionsJson),
        );
        // Copies for other source calendars of the direction follow the adopted rule.
        rule.origin = "group";
      }
    }
  }
  await addMissingRules(env, user, state, statements);
}

/**
 * Leave the group: the membership and the deletion of the group rules commit together, and the
 * removal of the blocks is queued only after that. A call for an account that is out of the group
 * already still deletes group rules left over from an earlier failure.
 */
async function leaveGroup(
  env: Env,
  user: CurrentUser,
  accountIds: readonly string[],
): Promise<void> {
  // Every group rule from or to a leaving account, whatever calendar it targets: after a change of
  // the main calendar, group rules into the old one are outside the editor's directions.
  const { results: deletions } = await env.DB.prepare(
    `SELECT r.id AS ruleId, tc.account_id AS accountId, tc.remote_id AS remoteCalendarId
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ?1 AND r.origin = 'group'
       AND (sc.account_id IN (SELECT value FROM json_each(?2))
         OR tc.account_id IN (SELECT value FROM json_each(?2)))`,
  )
    .bind(user.id, JSON.stringify(accountIds))
    .all<{ ruleId: string; accountId: string; remoteCalendarId: string }>();
  const results = await env.DB.batch([
    ...accountIds.map((id) => membershipUpdate(env, user, id, false)),
    ...deletions.map(({ ruleId }) =>
      env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ? AND origin = 'group'").bind(
        ruleId,
        user.id,
      ),
    ),
  ]);
  const changed = (index: number) => (results[index]?.meta.changes ?? 0) > 0;
  const audits = accountIds.flatMap((accountId, index) =>
    changed(index) ? [groupChangedAudit(env, user, accountId, false)] : [],
  );
  for (const [index, deletion] of deletions.entries()) {
    // A concurrent request deleted the rule first; it queued the removal and wrote the audit.
    if (!changed(accountIds.length + index)) continue;
    const queued = await queueRemoval(env, deletion.ruleId, deletion);
    audits.push(
      auditStatement(env.DB, {
        orgId: user.orgId,
        userId: user.id,
        accountId: deletion.accountId,
        ruleId: deletion.ruleId,
        kind: "rule_deleted",
        detail: queued ? { cleanup: "queued" } : { cleanupFailed: true },
      }),
    );
  }
  if (audits.length === 0) return;
  // The change is done; like `recordAudit`, a broken log must not fail the request.
  try {
    await env.DB.batch(audits);
  } catch (error) {
    console.error("Audit write failed", "group_changed", ...errorLogFields(error));
  }
}

function membershipUpdate(env: Env, user: CurrentUser, accountId: string, inGroup: boolean) {
  const value = inGroup ? 1 : 0;
  return env.DB.prepare(
    "UPDATE accounts SET in_block_group = ? WHERE id = ? AND user_id = ? AND in_block_group <> ?",
  ).bind(value, accountId, user.id, value);
}

function groupChangedAudit(env: Env, user: CurrentUser, accountId: string, inGroup: boolean) {
  return auditStatement(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId,
    kind: "group_changed",
    detail: { inGroup },
  });
}

/** True if a rule has the options of a new group rule: the settings and its source's options. */
function hasDefaultOptions(
  options: RuleOptions | null,
  settings: SyncSettings,
  source: Partial<SourceOptions>,
): boolean {
  if (!options) return false;
  const { detailLevel: _level, ...rest } = options;
  const { detailLevel: _default, ...defaults } = { ...newRuleOptions(settings, "busy"), ...source };
  return JSON.stringify(rest) === JSON.stringify(defaults);
}

/**
 * Insert a rule, or write this request's choice into the rule of the same pair. Two requests can
 * add the same pair at once, for example after a double click or from two tabs; the UNIQUE
 * constraint on the pair would refuse the second insert. Here the later request wins, as if it
 * came second. The statement returns the ID of the stored rule; it is this rule's ID if the
 * statement created it.
 */
function upsertStatement(
  env: Env,
  user: CurrentUser,
  rule: {
    id: string;
    sourceCalendarId: string;
    targetCalendarId: string;
    options: RuleOptions;
    origin: "group" | "custom";
    enabled: boolean;
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_calendar_id, target_calendar_id) DO UPDATE SET
       options = excluded.options, enabled = excluded.enabled, origin = excluded.origin
     WHERE rules.user_id = excluded.user_id
     RETURNING id`,
  ).bind(
    rule.id,
    user.id,
    rule.sourceCalendarId,
    rule.targetCalendarId,
    JSON.stringify(rule.options),
    rule.enabled ? 1 : 0,
    rule.origin,
  );
}

async function audit(
  env: Env,
  user: CurrentUser,
  accountId: string,
  ruleId: string,
  kind: "rule_created" | "rule_updated" | "rule_deleted",
  detail: Record<string, string>,
): Promise<void> {
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId,
    ruleId,
    kind,
    detail,
  });
}
