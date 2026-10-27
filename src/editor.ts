import { auditStatement, recordAudit } from "./audit";
import { resolveAccountColorState, type AccountColor } from "./colors";
import { parseRuleOptions, ruleOptionsSchema, type Provider, type RuleOptions } from "./config";
import { detailLevelFor, type DetailLevel } from "./detail-policy";
import { accountSync } from "./durable";
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
  /** Short display name, derived from the address. */
  name: string;
  /** Colour in the pages: the stored one, or the next unused one. */
  color: AccountColor;
  /** True if the user chose the colour; false if it is automatic. */
  colorChosen: boolean;
  /** Main calendar; null until the calendars are loaded or if the account has none it can write. */
  calendar: { id: string; remoteId: string; canEdit: boolean } | null;
  /** Every calendar of the account, for the choice of sources. */
  calendars: { id: string; name: string; isMain: boolean; isSource: boolean }[];
}

/** The rule of one source calendar within a direction; null if it has none yet. */
interface Slot {
  sourceCalendarId: string;
  rule: { id: string; enabled: boolean; origin: "group" | "custom"; options: RuleOptions } | null;
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
              display_name AS displayName, needs_reconnect AS needsReconnect, color
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
    return {
      id: row.id,
      provider: row.provider,
      email: row.email,
      tenantId: row.tenantId,
      inGroup: row.inGroup === 1,
      needsReconnect: row.needsReconnect === 1,
      name: row.displayName ?? names[index] ?? row.email,
      color: colors[index]?.color ?? "slate",
      colorChosen: colors[index]?.chosen ?? false,
      calendar: main ? { id: main.id, remoteId: main.remoteId, canEdit: main.canEdit === 1 } : null,
      calendars: own.map((calendar) => ({
        id: calendar.id,
        name: calendar.name,
        isMain: calendar.isMain === 1,
        isSource: calendar.isSource === 1,
      })),
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
              }
            : null,
        };
      });
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
      });
    }
  }
  // Every rule the directions above do not cover shows in its own list, so that none hides.
  const covered = new Set(
    directions.flatMap((direction) => direction.slots.flatMap((slot) => slot.rule?.id ?? [])),
  );
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
  const daysAhead = shownDaysAhead(
    json,
    ruleRows.map((row) => parseRuleOptions(row.options)),
  );
  return { accounts, directions, others, settings: { ...parseSettings(json), daysAhead } };
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

/** Settings from the form. The window can be missing, for example if no choice matched. */
export type SettingsForm = Omit<SyncSettings, "daysAhead"> & {
  daysAhead?: number;
  /** The window that the form showed. */
  daysAheadShown?: number;
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
 * removal of the blocks beyond it, which no run reads any more.
 */
export async function setSettings(env: Env, user: CurrentUser, form: SettingsForm): Promise<void> {
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
  const current = shownDaysAhead(
    json,
    results.map((row) => parseRuleOptions(row.options)),
  );
  const { daysAhead: chosen, daysAheadShown, ...rest } = form;
  // A page from before `daysAheadShown` existed showed the stored window, or the default.
  const shown = daysAheadShown ?? parseSettings(json).daysAhead;
  const windowChanged = chosen !== undefined && chosen !== shown;
  const settings: SyncSettings = { ...rest, daysAhead: windowChanged ? chosen : current };
  const windowOf = (previous: number) =>
    !windowChanged
      ? previous
      : settings.daysAhead > shown
        ? Math.max(previous, settings.daysAhead)
        : Math.min(previous, settings.daysAhead);
  await env.DB.prepare("UPDATE users SET sync_settings = ? WHERE id = ?")
    .bind(JSON.stringify(settings), user.id)
    .run();
  const targets = new Set<string>();
  for (const row of results) {
    const previous = parseRuleOptions(row.options);
    const options = ruleOptionsSchema.parse({
      ...previous,
      ...settings,
      daysAhead: windowOf(previous.daysAhead),
    });
    await env.DB.prepare("UPDATE rules SET options = ? WHERE id = ?")
      .bind(JSON.stringify(options), row.id)
      .run();
    // A disabled rule has its blocks removed already; a read-only calendar refuses the deletes.
    if (options.daysAhead < previous.daysAhead && row.enabled === 1 && row.canEdit === 1) {
      const target = { accountId: row.targetAccountId, remoteCalendarId: row.remoteCalendarId };
      await queueRemoval(env, row.id, target, { trim: true });
    }
    targets.add(row.targetAccountId);
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
  for (const id of targets) await accountSync(env, id).requestSync();
}

/** Longest name an account can get. */
export const MAX_NAME_LENGTH = 40;

/** Give an account a name, or go back to the derived one with an empty name. */
export async function renameAccount(
  env: Env,
  user: CurrentUser,
  accountId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  const updated = await env.DB.prepare(
    "UPDATE accounts SET display_name = ? WHERE id = ? AND user_id = ?",
  )
    .bind(trimmed === "" ? null : trimmed, accountId, user.id)
    .run();
  if (updated.meta.changes === 0) return;
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

/** Longest Outlook category name for blocks. */
export const MAX_CATEGORY_LENGTH = 100;

/**
 * The block colour as stored for a target provider, or null if the value is not valid there:
 * a Google event colour "1" to "11", or an Outlook category name. Empty means no colour.
 */
export function blockColorFor(provider: Provider, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (provider === "google") return /^(?:[1-9]|1[01])$/.test(trimmed) ? trimmed : null;
  return trimmed.length <= MAX_CATEGORY_LENGTH && !trimmed.includes(",") ? trimmed : null;
}

/**
 * Set the colour of the blocks one direction writes, for every rule of the direction. A
 * direction without rules ("off") has no blocks, so nothing is stored. Returns false for a value
 * the target cannot show.
 */
export async function setBlockColor(
  env: Env,
  user: CurrentUser,
  fromId: string,
  toId: string,
  value: string,
): Promise<boolean> {
  const state = await loadEditorState(env, user.id);
  const to = state.accounts.find((account) => account.id === toId);
  const direction = state.directions.find((d) => d.from === fromId && d.to === toId);
  if (!to || !direction) return false;
  const blockColor = blockColorFor(to.provider, value);
  if (blockColor === null) return false;
  let changed = false;
  for (const { rule } of direction.slots) {
    if (!rule || rule.options.blockColor === blockColor) continue;
    await env.DB.prepare("UPDATE rules SET options = ? WHERE id = ? AND user_id = ?")
      .bind(JSON.stringify({ ...rule.options, blockColor }), rule.id, user.id)
      .run();
    // The category name is the user's own word; the log records that the colour changed.
    await audit(env, user, to.id, rule.id, "rule_updated", { blockColor: "changed" });
    changed = true;
  }
  if (changed) await accountSync(env, to.id).requestSync();
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
    console.error("Queueing the removal failed", ruleId, error);
    return false;
  }
}

/**
 * Set one direction. "busy" between two group members becomes a group rule again; every other
 * choice is a custom rule. "off" removes the blocks; between group members it keeps a disabled
 * custom rule, so that the group does not recreate it.
 */
export async function setDirection(
  env: Env,
  user: CurrentUser,
  fromId: string,
  toId: string,
  choice: Choice,
): Promise<void> {
  const state = await loadEditorState(env, user.id);
  const to = state.accounts.find((account) => account.id === toId);
  const from = state.accounts.find((account) => account.id === fromId);
  const direction = state.directions.find((d) => d.from === fromId && d.to === toId);
  if (!from || !to?.calendar || !direction) return;
  // "Off" needs no write access, so that a rule never keeps writing into a read-only calendar.
  if (choice !== "off" && !to.calendar.canEdit) return;
  const target = { accountId: to.id, remoteCalendarId: to.calendar.remoteId };
  const bothInGroup = from.inGroup && to.inGroup;
  // The sync applies the caps anyway; storing the capped value keeps the page honest.
  if (RANK[choice] > RANK[direction.maxChoice]) choice = direction.maxChoice;

  for (const slot of direction.slots) {
    const { rule } = slot;
    if (choice === "off") {
      if (!rule) {
        // Between group members, a disabled exception keeps the group from adding the rule.
        if (bothInGroup) {
          const stored = await upsertRule(env, user, {
            id: crypto.randomUUID(),
            sourceCalendarId: slot.sourceCalendarId,
            targetCalendarId: to.calendar.id,
            options: newRuleOptions(state.settings, "busy"),
            origin: "custom",
            enabled: false,
          });
          // A concurrent request created the rule, and it can have written blocks already.
          if (stored && !stored.created) {
            await queueRemoval(env, stored.id, target);
            await audit(env, user, to.id, stored.id, "rule_updated", { choice });
          }
        }
        continue;
      }
      if (!bothInGroup) {
        await deleteRuleWithBlocks(env, user, rule.id);
        continue;
      }
      await queueRemoval(env, rule.id, target);
      await env.DB.prepare(
        "UPDATE rules SET enabled = 0, origin = 'custom' WHERE id = ? AND user_id = ?",
      )
        .bind(rule.id, user.id)
        .run();
      await audit(env, user, to.id, rule.id, "rule_updated", { choice });
      continue;
    }

    const options = {
      ...(rule?.options ?? direction.options ?? newRuleOptions(state.settings, choice)),
      detailLevel: choice,
    };
    const origin = bothInGroup && choice === "busy" ? "group" : "custom";
    if (rule) {
      await env.DB.prepare(
        "UPDATE rules SET options = ?, enabled = 1, origin = ? WHERE id = ? AND user_id = ?",
      )
        .bind(JSON.stringify(options), origin, rule.id, user.id)
        .run();
      await audit(env, user, to.id, rule.id, "rule_updated", { choice });
    } else {
      const stored = await upsertRule(env, user, {
        id: crypto.randomUUID(),
        sourceCalendarId: slot.sourceCalendarId,
        targetCalendarId: to.calendar.id,
        options,
        origin,
        enabled: true,
      });
      if (stored) {
        const kind = stored.created ? "rule_created" : "rule_updated";
        await audit(env, user, to.id, stored.id, kind, { choice });
      }
    }
  }
  if (choice !== "off") await accountSync(env, to.id).requestSync();
}

/**
 * Turn a calendar on or off as a source of its account. On: it gets a rule for every direction
 * of the account, with that direction's choice, or the group's rule between group members. Off:
 * its rules go, with their blocks.
 */
export async function setSourceCalendar(
  env: Env,
  user: CurrentUser,
  calendarId: string,
  isSource: boolean,
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
      "SELECT id FROM rules WHERE source_calendar_id = ? AND user_id = ?",
    )
      .bind(calendarId, user.id)
      .all<{ id: string }>();
    for (const row of results) await deleteRuleWithBlocks(env, user, row.id);
    return;
  }
  await reconcileRules(env, user);
}

/**
 * Undo an exception: back to the group's busy, or no rule outside the group. The block colour
 * goes too, because the group writes blocks without a colour. A read-only target stays as it is:
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
  await setDirection(env, user, fromId, toId, from.inGroup && to.inGroup ? "busy" : "off");
  await setBlockColor(env, user, fromId, toId, "");
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
 *   its rules have the same choice.
 * - A direction without rules between two group members gets a group rule ("busy") for each
 *   source calendar.
 *
 * A source calendar that has a rule keeps it, so an exception, also a disabled one, wins over the
 * group. A read-only target gets nothing, because turning a direction on needs write access.
 */
function missingRules(state: EditorState): MissingRule[] {
  const missing: MissingRule[] = [];
  for (const direction of state.directions) {
    const from = state.accounts.find((account) => account.id === direction.from);
    const to = state.accounts.find((account) => account.id === direction.to);
    if (!from || !to?.calendar?.canEdit) continue;
    const model = direction.slots.find((slot) => slot.rule)?.rule;
    if (!model && !(from.inGroup && to.inGroup)) continue;
    for (const slot of direction.slots) {
      if (slot.rule) continue;
      missing.push({
        id: crypto.randomUUID(),
        sourceCalendarId: slot.sourceCalendarId,
        targetCalendarId: to.calendar.id,
        targetAccountId: to.id,
        options: model?.options ?? newRuleOptions(state.settings, "busy"),
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

async function requestSyncs(env: Env, accountIds: Iterable<string>): Promise<void> {
  for (const id of accountIds) await accountSync(env, id).requestSync();
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
  const missing = missingRules(await loadEditorState(env, user.id));
  if (missing.length === 0) return;
  const results = await env.DB.batch(insertStatements(env, user, missing));
  await requestSyncs(env, syncTargets(missing, results, 0));
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
  const value = inGroup ? 1 : 0;
  const updates = await env.DB.batch(
    accountIds.map((id) =>
      env.DB.prepare(
        "UPDATE accounts SET in_block_group = ? WHERE id = ? AND user_id = ? AND in_block_group <> ?",
      ).bind(value, id, user.id, value),
    ),
  );
  const changed = new Set(accountIds.filter((_, i) => (updates[i]?.meta.changes ?? 0) > 0));
  if (changed.size === 0) return;
  const statements = [...changed].map((accountId) =>
    auditStatement(env.DB, {
      orgId: user.orgId,
      userId: user.id,
      accountId,
      kind: "group_changed",
      detail: { inGroup },
    }),
  );

  const state = await loadEditorState(env, user.id);
  for (const direction of state.directions) {
    if (!changed.has(direction.from) && !changed.has(direction.to)) continue;
    const from = state.accounts.find((account) => account.id === direction.from);
    const to = state.accounts.find((account) => account.id === direction.to);
    if (!from || !to?.calendar) continue;
    for (const { rule } of direction.slots) {
      if (!inGroup && rule?.origin === "group") {
        // Like "off", leaving needs no write access to the target.
        const target = { accountId: to.id, remoteCalendarId: to.calendar.remoteId };
        const queued = await queueRemoval(env, rule.id, target);
        statements.push(
          env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?").bind(rule.id, user.id),
          auditStatement(env.DB, {
            orgId: user.orgId,
            userId: user.id,
            accountId: to.id,
            ruleId: rule.id,
            kind: "rule_deleted",
            detail: queued ? { cleanup: "queued" } : { cleanupFailed: true },
          }),
        );
      } else if (
        inGroup &&
        from.inGroup &&
        to.inGroup &&
        to.calendar.canEdit &&
        rule?.origin === "custom" &&
        rule.enabled &&
        choiceOf(rule.options, true) === "busy" &&
        hasDefaultOptions(rule.options, state.settings)
      ) {
        statements.push(
          env.DB.prepare(
            `UPDATE rules SET origin = 'group'
             WHERE id = ? AND enabled = 1 AND json_extract(options, '$.detailLevel') = 'busy'`,
          ).bind(rule.id),
        );
        // Copies for other source calendars of the direction follow the adopted rule.
        rule.origin = "group";
      }
    }
  }
  const missing = inGroup ? missingRules(state) : [];
  const results = await env.DB.batch([...statements, ...insertStatements(env, user, missing)]);
  await requestSyncs(env, syncTargets(missing, results, statements.length));
}

function hasDefaultOptions(options: RuleOptions | null, settings: SyncSettings): boolean {
  if (!options) return false;
  const { detailLevel: _level, ...rest } = options;
  const { detailLevel: _default, ...defaults } = newRuleOptions(settings, "busy");
  return JSON.stringify(rest) === JSON.stringify(defaults);
}

/**
 * Insert a rule, or write this request's choice into the rule of the same pair. Two requests can
 * add the same pair at once, for example after a double click or from two tabs; the UNIQUE
 * constraint on the pair would refuse the second insert. Here the later request wins, as if it
 * came second. Returns the ID of the stored rule and whether this call created it.
 */
async function upsertRule(
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
): Promise<{ id: string; created: boolean } | null> {
  const stored = await env.DB.prepare(
    `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_calendar_id, target_calendar_id) DO UPDATE SET
       options = excluded.options, enabled = excluded.enabled, origin = excluded.origin
     WHERE rules.user_id = excluded.user_id
     RETURNING id`,
  )
    .bind(
      rule.id,
      user.id,
      rule.sourceCalendarId,
      rule.targetCalendarId,
      JSON.stringify(rule.options),
      rule.enabled ? 1 : 0,
      rule.origin,
    )
    .first<{ id: string }>();
  return stored ? { id: stored.id, created: stored.id === rule.id } : null;
}

async function audit(
  env: Env,
  user: CurrentUser,
  accountId: string,
  ruleId: string,
  kind: "rule_created" | "rule_updated",
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
