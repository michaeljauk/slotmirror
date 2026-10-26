import { recordAudit } from "./audit";
import { ACCOUNT_COLORS, resolveAccountColors, type AccountColor } from "./colors";
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

export async function loadEditorState(env: Env, userId: string): Promise<EditorState> {
  const { results: accountRows } = await env.DB.prepare(
    `SELECT id, provider, email, tenant_id AS tenantId, in_block_group AS inGroup,
            display_name AS displayName, needs_reconnect AS needsReconnect, color
     FROM accounts WHERE user_id = ? ORDER BY created_at, id`,
  )
    .bind(userId)
    .all<{
      id: string;
      provider: Provider;
      email: string;
      tenantId: string | null;
      inGroup: number;
      displayName: string | null;
      needsReconnect: number;
      color: string | null;
    }>();
  const { results: calendarRows } = await env.DB.prepare(
    `SELECT c.id, c.account_id AS accountId, c.remote_id AS remoteId, c.name,
            c.can_edit AS canEdit, c.is_default AS isMain, c.is_source AS isSource
     FROM calendars c JOIN accounts a ON a.id = c.account_id
     WHERE a.user_id = ? ORDER BY c.is_default DESC, c.name`,
  )
    .bind(userId)
    .all<{
      id: string;
      accountId: string;
      remoteId: string;
      name: string;
      canEdit: number;
      isMain: number;
      isSource: number;
    }>();
  const names = shortNames(accountRows.map((row) => row.email));
  const colors = resolveAccountColors(accountRows.map((row) => row.color));
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
      color: colors[index] ?? "slate",
      colorChosen: row.color !== null && Object.hasOwn(ACCOUNT_COLORS, row.color),
      calendar: main ? { id: main.id, remoteId: main.remoteId, canEdit: main.canEdit === 1 } : null,
      calendars: own.map((calendar) => ({
        id: calendar.id,
        name: calendar.name,
        isMain: calendar.isMain === 1,
        isSource: calendar.isSource === 1,
      })),
    };
  });

  const { results: ruleRows } = await env.DB.prepare(
    `SELECT r.id, r.source_calendar_id AS sourceId, r.target_calendar_id AS targetId, r.options,
            r.enabled, r.origin, sc.name AS sourceName, sc.account_id AS sourceAccountId,
            tc.name AS targetName, tc.account_id AS targetAccountId
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ?`,
  )
    .bind(userId)
    .all<{
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
    }>();
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
  const settingsRow = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
    .bind(userId)
    .first<{ json: string }>();
  return { accounts, directions, others, settings: parseSettings(settingsRow?.json ?? "{}") };
}

function parseSettings(json: string): SyncSettings {
  const { daysAhead, skipAllDay, skipTentative, markPrivate, blockTitle, skipCategories } =
    parseRuleOptions(json);
  return { daysAhead, skipAllDay, skipTentative, markPrivate, blockTitle, skipCategories };
}

/** Options of a new rule: the user's settings with the given detail level. */
function newRuleOptions(settings: SyncSettings, detailLevel: Choice): RuleOptions {
  return ruleOptionsSchema.parse({
    ...settings,
    detailLevel: detailLevel === "off" ? "busy" : detailLevel,
  });
}

/**
 * Store the settings and apply them to every rule of the user. The detail level of each rule
 * stays; it is the choice per direction.
 */
export async function setSettings(
  env: Env,
  user: CurrentUser,
  settings: SyncSettings,
): Promise<void> {
  await env.DB.prepare("UPDATE users SET sync_settings = ? WHERE id = ?")
    .bind(JSON.stringify(settings), user.id)
    .run();
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.options, tc.account_id AS targetAccountId FROM rules r
     JOIN calendars tc ON tc.id = r.target_calendar_id WHERE r.user_id = ?`,
  )
    .bind(user.id)
    .all<{ id: string; options: string; targetAccountId: string }>();
  const targets = new Set<string>();
  for (const row of results) {
    const options = ruleOptionsSchema.parse({ ...parseRuleOptions(row.options), ...settings });
    await env.DB.prepare("UPDATE rules SET options = ? WHERE id = ?")
      .bind(JSON.stringify(options), row.id)
      .run();
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
): Promise<boolean> {
  try {
    await accountSync(env, target.accountId).queueRemoval(ruleId, target.remoteCalendarId);
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
  if (!from || !to?.calendar?.canEdit || !direction) return;
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
          const ruleId = crypto.randomUUID();
          const options = newRuleOptions(state.settings, "busy");
          await insertRule(
            env,
            user,
            ruleId,
            slot.sourceCalendarId,
            to.calendar.id,
            options,
            "custom",
            false,
          );
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
      const ruleId = crypto.randomUUID();
      await insertRule(env, user, ruleId, slot.sourceCalendarId, to.calendar.id, options, origin);
      await audit(env, user, to.id, ruleId, "rule_created", { choice });
    }
  }
  if (choice !== "off") await accountSync(env, to.id).requestSync();
}

/**
 * Turn a calendar on or off as a source of its account. On: it gets a rule for every direction
 * of the account, with that direction's choice. Off: its rules go, with their blocks.
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
  const state = await loadEditorState(env, user.id);
  const account = state.accounts.find((a) => a.calendars.some((c) => c.id === calendarId));
  if (!account) return;

  if (!isSource) {
    const { results } = await env.DB.prepare(
      "SELECT id FROM rules WHERE source_calendar_id = ? AND user_id = ?",
    )
      .bind(calendarId, user.id)
      .all<{ id: string }>();
    for (const row of results) await deleteRuleWithBlocks(env, user, row.id);
    return;
  }

  for (const direction of state.directions) {
    if (
      direction.from !== account.id ||
      (direction.choice === "off" && direction.origin !== "custom")
    ) {
      continue;
    }
    const to = state.accounts.find((a) => a.id === direction.to);
    const slot = direction.slots.find((s) => s.sourceCalendarId === calendarId);
    const model = direction.slots.find((s) => s.rule)?.rule;
    if (!to?.calendar?.canEdit || !slot || slot.rule || !model) continue;
    const ruleId = crypto.randomUUID();
    await insertRule(
      env,
      user,
      ruleId,
      calendarId,
      to.calendar.id,
      model.options,
      model.origin,
      model.enabled,
    );
    await audit(env, user, to.id, ruleId, "rule_created", { choice: direction.choice });
    if (model.enabled) await accountSync(env, to.id).requestSync();
  }
}

/** Undo an exception: back to the group's busy, or no rule outside the group. */
export async function resetDirection(
  env: Env,
  user: CurrentUser,
  fromId: string,
  toId: string,
): Promise<void> {
  const state = await loadEditorState(env, user.id);
  const from = state.accounts.find((account) => account.id === fromId);
  const to = state.accounts.find((account) => account.id === toId);
  if (!from || !to) return;
  await setDirection(env, user, fromId, toId, from.inGroup && to.inGroup ? "busy" : "off");
}

/**
 * Add an account to the block group or remove it. Joining creates a busy rule to and from every
 * other member, and adopts existing busy rules with default options. Leaving deletes the group
 * rules of the account with their blocks; custom rules stay.
 */
export async function setGroupMembership(
  env: Env,
  user: CurrentUser,
  accountId: string,
  inGroup: boolean,
): Promise<void> {
  const updated = await env.DB.prepare(
    "UPDATE accounts SET in_block_group = ? WHERE id = ? AND user_id = ? AND in_block_group <> ?",
  )
    .bind(inGroup ? 1 : 0, accountId, user.id, inGroup ? 1 : 0)
    .run();
  if (updated.meta.changes === 0) return;
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId,
    kind: "group_changed",
    detail: { inGroup },
  });

  const state = await loadEditorState(env, user.id);
  const touched = new Set<string>();
  for (const direction of state.directions) {
    if (direction.from !== accountId && direction.to !== accountId) continue;
    const from = state.accounts.find((account) => account.id === direction.from);
    const to = state.accounts.find((account) => account.id === direction.to);
    if (!from || !to?.calendar?.canEdit) continue;

    for (const slot of direction.slots) {
      const { rule } = slot;
      if (inGroup && from.inGroup && to.inGroup) {
        if (!rule) {
          const ruleId = crypto.randomUUID();
          await insertRule(
            env,
            user,
            ruleId,
            slot.sourceCalendarId,
            to.calendar.id,
            newRuleOptions(state.settings, "busy"),
            "group",
          );
          await audit(env, user, to.id, ruleId, "rule_created", { choice: "busy" });
          touched.add(to.id);
        } else if (
          rule.enabled &&
          choiceOf(rule.options, true) === "busy" &&
          hasDefaultOptions(rule.options, state.settings)
        ) {
          await env.DB.prepare("UPDATE rules SET origin = 'group' WHERE id = ?")
            .bind(rule.id)
            .run();
        }
      } else if (!inGroup && rule?.origin === "group") {
        await deleteRuleWithBlocks(env, user, rule.id);
      }
    }
  }
  for (const id of touched) await accountSync(env, id).requestSync();
}

function hasDefaultOptions(options: RuleOptions | null, settings: SyncSettings): boolean {
  if (!options) return false;
  const { detailLevel: _level, ...rest } = options;
  const { detailLevel: _default, ...defaults } = newRuleOptions(settings, "busy");
  return JSON.stringify(rest) === JSON.stringify(defaults);
}

async function insertRule(
  env: Env,
  user: CurrentUser,
  ruleId: string,
  sourceCalendarId: string,
  targetCalendarId: string,
  options: RuleOptions,
  origin: "group" | "custom",
  enabled = true,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ruleId,
      user.id,
      sourceCalendarId,
      targetCalendarId,
      JSON.stringify(options),
      enabled ? 1 : 0,
      origin,
    )
    .run();
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
