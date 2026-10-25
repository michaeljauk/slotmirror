import { recordAudit } from "./audit";
import { parseRuleOptions, ruleOptionsSchema, type Provider, type RuleOptions } from "./config";
import { detailLevelFor, type DetailLevel } from "./detail-policy";
import { accountSync } from "./durable";
import type { CurrentUser } from "./users";

/**
 * The calendar editor shows one choice per direction between two accounts: from the main calendar
 * of one account into the main calendar of another. Each choice is a rule in D1, so the sync engine
 * stays unaware of the editor.
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
  /** Short display name, derived from the address. */
  name: string;
  /** Main calendar; null until the calendars are loaded or if the account has none it can write. */
  calendar: { id: string; remoteId: string; canEdit: boolean } | null;
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
}

export interface EditorState {
  accounts: EditorAccount[];
  directions: EditorDirection[];
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
    `SELECT a.id, a.provider, a.email, a.tenant_id AS tenantId, a.in_block_group AS inGroup,
            c.id AS calendarId, c.remote_id AS remoteId, c.can_edit AS canEdit
     FROM accounts a
     LEFT JOIN calendars c ON c.account_id = a.id AND c.is_default = 1
     WHERE a.user_id = ?
     ORDER BY a.created_at, a.id`,
  )
    .bind(userId)
    .all<{
      id: string;
      provider: Provider;
      email: string;
      tenantId: string | null;
      inGroup: number;
      calendarId: string | null;
      remoteId: string | null;
      canEdit: number | null;
    }>();
  const names = shortNames(accountRows.map((row) => row.email));
  const accounts: EditorAccount[] = accountRows.map((row, index) => ({
    id: row.id,
    provider: row.provider,
    email: row.email,
    tenantId: row.tenantId,
    inGroup: row.inGroup === 1,
    name: names[index] ?? row.email,
    calendar:
      row.calendarId && row.remoteId
        ? { id: row.calendarId, remoteId: row.remoteId, canEdit: row.canEdit === 1 }
        : null,
  }));

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
    for (const to of accounts) {
      if (from.id === to.id || !from.calendar || !to.calendar) continue;
      const row = byPair.get(`${from.calendar.id}>${to.calendar.id}`);
      const options = row ? parseRuleOptions(row.options) : null;
      const choice = row && options ? choiceOf(options, row.enabled === 1) : "off";
      const max = toChoice(detailLevelFor(env, "full", from, to).level);
      const effective = RANK[choice] > RANK[max] ? max : choice;
      directions.push({
        from: from.id,
        to: to.id,
        ruleId: row?.id ?? null,
        choice,
        origin: row?.origin ?? null,
        effective,
        capped: effective !== choice,
        maxChoice: max,
        options,
      });
    }
  }
  const mainCalendars = new Set(accounts.flatMap((account) => account.calendar?.id ?? []));
  const nameOf = (accountId: string) =>
    accounts.find((account) => account.id === accountId)?.name ?? "?";
  const others = ruleRows
    .filter((row) => !mainCalendars.has(row.sourceId) || !mainCalendars.has(row.targetId))
    .map((row) => ({
      ruleId: row.id,
      source: `${nameOf(row.sourceAccountId)} · ${row.sourceName}`,
      target: `${nameOf(row.targetAccountId)} · ${row.targetName}`,
      choice: choiceOf(parseRuleOptions(row.options), row.enabled === 1),
    }));
  return { accounts, directions, others };
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

  const cleanup = await removeBlocks(env, ruleId, target);
  await env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?")
    .bind(ruleId, user.id)
    .run();
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId: target.accountId,
    ruleId,
    kind: "rule_deleted",
    detail: cleanup
      ? { removed: cleanup.removed, remaining: cleanup.remaining }
      : { cleanupFailed: true },
  });
  return true;
}

// The rule's tag is the only way to find its blocks, so blocks go before the rule changes.
async function removeBlocks(
  env: Env,
  ruleId: string,
  target: { accountId: string; remoteCalendarId: string },
): Promise<{ removed: number; remaining: number } | null> {
  try {
    return await accountSync(env, target.accountId).removeRuleBlocks(
      ruleId,
      target.remoteCalendarId,
    );
  } catch (error) {
    console.error("Removing blocks failed", ruleId, error);
    return null;
  }
}

const GROUP_OPTIONS: RuleOptions = ruleOptionsSchema.parse({ detailLevel: "busy" });

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
  const from = state.accounts.find((account) => account.id === fromId);
  const to = state.accounts.find((account) => account.id === toId);
  const direction = state.directions.find((d) => d.from === fromId && d.to === toId);
  if (!from?.calendar || !to?.calendar?.canEdit || !direction) return;
  const bothInGroup = from.inGroup && to.inGroup;
  // The sync applies the caps anyway; storing the capped value keeps the page honest.
  if (RANK[choice] > RANK[direction.maxChoice]) choice = direction.maxChoice;

  if (choice === "off") {
    if (!direction.ruleId) return;
    if (!bothInGroup) {
      await deleteRuleWithBlocks(env, user, direction.ruleId);
      return;
    }
    await removeBlocks(env, direction.ruleId, {
      accountId: to.id,
      remoteCalendarId: to.calendar.remoteId,
    });
    await env.DB.prepare(
      "UPDATE rules SET enabled = 0, origin = 'custom' WHERE id = ? AND user_id = ?",
    )
      .bind(direction.ruleId, user.id)
      .run();
    await audit(env, user, to.id, direction.ruleId, "rule_updated", { choice });
    return;
  }

  const options = { ...(direction.options ?? GROUP_OPTIONS), detailLevel: choice };
  const origin = bothInGroup && choice === "busy" ? "group" : "custom";
  if (direction.ruleId) {
    await env.DB.prepare(
      "UPDATE rules SET options = ?, enabled = 1, origin = ? WHERE id = ? AND user_id = ?",
    )
      .bind(JSON.stringify(options), origin, direction.ruleId, user.id)
      .run();
    await audit(env, user, to.id, direction.ruleId, "rule_updated", { choice });
  } else {
    const ruleId = crypto.randomUUID();
    await insertRule(env, user, ruleId, from.calendar.id, to.calendar.id, options, origin);
    await audit(env, user, to.id, ruleId, "rule_created", { choice });
  }
  await accountSync(env, to.id).requestSync();
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
    if (!from?.calendar || !to?.calendar?.canEdit) continue;

    if (inGroup && from.inGroup && to.inGroup) {
      if (!direction.ruleId) {
        const ruleId = crypto.randomUUID();
        await insertRule(
          env,
          user,
          ruleId,
          from.calendar.id,
          to.calendar.id,
          GROUP_OPTIONS,
          "group",
        );
        await audit(env, user, to.id, ruleId, "rule_created", { choice: "busy" });
        touched.add(to.id);
      } else if (direction.choice === "busy" && hasDefaultOptions(direction.options)) {
        await env.DB.prepare("UPDATE rules SET origin = 'group' WHERE id = ?")
          .bind(direction.ruleId)
          .run();
      }
    } else if (!inGroup && direction.ruleId && direction.origin === "group") {
      await deleteRuleWithBlocks(env, user, direction.ruleId);
    }
  }
  for (const id of touched) await accountSync(env, id).requestSync();
}

function hasDefaultOptions(options: RuleOptions | null): boolean {
  if (!options) return false;
  const { detailLevel: _level, ...rest } = options;
  const { detailLevel: _default, ...defaults } = GROUP_OPTIONS;
  return JSON.stringify(rest) === JSON.stringify(defaults);
}

/** Options that apply to every rule from one account, set under "More options". */
export async function setSourceOptions(
  env: Env,
  user: CurrentUser,
  fromId: string,
  patch: Pick<RuleOptions, "daysAhead" | "skipAllDay" | "skipTentative" | "markPrivate">,
): Promise<void> {
  const state = await loadEditorState(env, user.id);
  const targets = new Set<string>();
  for (const direction of state.directions) {
    if (direction.from !== fromId || !direction.ruleId || !direction.options) continue;
    const options = ruleOptionsSchema.parse({ ...direction.options, ...patch });
    await env.DB.prepare("UPDATE rules SET options = ? WHERE id = ? AND user_id = ?")
      .bind(JSON.stringify(options), direction.ruleId, user.id)
      .run();
    targets.add(direction.to);
  }
  for (const id of targets) await accountSync(env, id).requestSync();
}

async function insertRule(
  env: Env,
  user: CurrentUser,
  ruleId: string,
  sourceCalendarId: string,
  targetCalendarId: string,
  options: RuleOptions,
  origin: "group" | "custom",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(ruleId, user.id, sourceCalendarId, targetCalendarId, JSON.stringify(options), origin)
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
