import { MAX_BUFFER_MINUTES, parseRuleOptions, type RuleOptions } from "../config";
import { isLocale, LOCALES, messagesFor } from "../i18n";
import { OWNER_COLUMNS, ownerAdmission, type OwnerColumns } from "../users";

/** A rule with everything the runner needs, joined from D1. */
export interface RuleContext {
  id: string;
  userId: string;
  orgId: string;
  options: RuleOptions;
  enabled: boolean;
  /** The owner's state: SCIM or an admin can deactivate them, the policy can stop admitting them. */
  owner: OwnerColumns & { active: boolean };
  source: RuleEnd;
  target: RuleEnd;
}

interface RuleEnd {
  accountId: string;
  provider: string;
  /** The name the user gave the account; null for the name derived from the address. */
  name: string | null;
  remoteCalendarId: string;
  /** Address and Entra tenant of the account; they decide whether it belongs to the org. */
  email: string;
  tenantId: string | null;
  /** The provider refused the account's refresh token; see `accounts.needs_reconnect`. */
  needsReconnect: boolean;
}

interface RuleRow extends OwnerColumns {
  id: string;
  userId: string;
  orgId: string;
  options: string;
  enabled: number;
  ownerActive: number;
  sourceAccountId: string;
  sourceProvider: string;
  sourceName: string | null;
  sourceRemoteId: string;
  sourceEmail: string;
  sourceTenantId: string | null;
  sourceNeedsReconnect: number;
  targetAccountId: string;
  targetProvider: string;
  targetName: string | null;
  targetRemoteId: string;
  targetEmail: string;
  targetTenantId: string | null;
  targetNeedsReconnect: number;
}

const RULE_SELECT = `
  SELECT r.id, r.user_id AS userId, u.org_id AS orgId, r.options, r.enabled,
         u.active AS ownerActive, ${OWNER_COLUMNS},
         sa.id AS sourceAccountId, sa.provider AS sourceProvider, sc.remote_id AS sourceRemoteId,
         sa.email AS sourceEmail, sa.tenant_id AS sourceTenantId, sa.display_name AS sourceName,
         sa.needs_reconnect AS sourceNeedsReconnect,
         ta.id AS targetAccountId, ta.provider AS targetProvider, tc.remote_id AS targetRemoteId,
         ta.email AS targetEmail, ta.tenant_id AS targetTenantId, ta.display_name AS targetName,
         ta.needs_reconnect AS targetNeedsReconnect
  FROM rules r
  JOIN users u ON u.id = r.user_id
  JOIN orgs o ON o.id = u.org_id
  JOIN calendars sc ON sc.id = r.source_calendar_id
  JOIN accounts sa ON sa.id = sc.account_id
  JOIN calendars tc ON tc.id = r.target_calendar_id
  JOIN accounts ta ON ta.id = tc.account_id`;

function toContext(row: RuleRow): RuleContext {
  return {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    options: parseRuleOptions(row.options),
    enabled: row.enabled === 1,
    owner: {
      active: row.ownerActive === 1,
      ownerOrgId: row.ownerOrgId,
      ownerEmail: row.ownerEmail,
      ownerTenantId: row.ownerTenantId,
      ownerPolicy: row.ownerPolicy,
    },
    source: {
      accountId: row.sourceAccountId,
      provider: row.sourceProvider,
      name: row.sourceName,
      remoteCalendarId: row.sourceRemoteId,
      email: row.sourceEmail,
      tenantId: row.sourceTenantId,
      needsReconnect: row.sourceNeedsReconnect === 1,
    },
    target: {
      accountId: row.targetAccountId,
      provider: row.targetProvider,
      name: row.targetName,
      remoteCalendarId: row.targetRemoteId,
      email: row.targetEmail,
      tenantId: row.targetTenantId,
      needsReconnect: row.targetNeedsReconnect === 1,
    },
  };
}

/**
 * The first line of the origin note of a rule's blocks, in the language stored with the option:
 * "From: Work (Microsoft)" with the name the user gave the source account, else "From: Microsoft
 * account". Never the address: the target calendar can be visible to other people.
 */
export function originLine(rule: Pick<RuleContext, "options" | "source">): string {
  const locale = rule.options.originLocale;
  const t = messagesFor(isLocale(locale) ? locale : LOCALES[0]).mirror;
  const provider = rule.source.provider === "google" ? t.google : t.microsoft;
  const name = noteName(rule.source.name ?? "");
  return name === "" ? t.originAccount(provider) : t.origin(name, provider);
}

/**
 * An account name for the note: one line, without control or format characters. Format characters
 * (`\p{Cf}`) include the bidi controls, which can reorder the text around the name, zero-width
 * characters, the soft hyphen and tag characters.
 */
function noteName(name: string): string {
  return name
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
}

export async function loadRule(db: D1Database, ruleId: string): Promise<RuleContext | null> {
  const row = await db.prepare(`${RULE_SELECT} WHERE r.id = ?`).bind(ruleId).first<RuleRow>();
  return row ? toContext(row) : null;
}

/**
 * The rules of `ruleIds` that the alarm may run: they exist, are enabled, their user is active, and
 * the access policy still admits that user. A queued rule can be disabled or removed before its
 * turn; the editor then queues the removal of its blocks.
 */
export async function rulesRunningFromAlarm(env: Env, ruleIds: string[]): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, ${OWNER_COLUMNS} FROM rules r JOIN users u ON u.id = r.user_id
     JOIN orgs o ON o.id = u.org_id
     WHERE r.id IN (SELECT value FROM json_each(?)) AND r.enabled = 1 AND u.active = 1`,
  )
    .bind(JSON.stringify(ruleIds))
    .all<{ id: string } & OwnerColumns>();
  return new Set(results.filter(ownerAdmission(env)).map((row) => row.id));
}

/**
 * Enabled rules whose target calendar belongs to the account; they run in its Durable Object.
 * Rules of a deactivated user do not run, and neither do rules of a user the policy no longer
 * admits. Rules from an account that needs reconnecting would only fail, so they wait until it is
 * connected again.
 */
export async function rulesTargetingAccount(env: Env, accountId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, ${OWNER_COLUMNS} FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN accounts sa ON sa.id = sc.account_id
     JOIN users u ON u.id = r.user_id JOIN orgs o ON o.id = u.org_id
     WHERE tc.account_id = ? AND r.enabled = 1 AND u.active = 1 AND sa.needs_reconnect = 0
     ORDER BY r.id`,
  )
    .bind(accountId)
    .all<{ id: string } & OwnerColumns>();
  return results.filter(ownerAdmission(env)).map((row) => row.id);
}

/**
 * The rules that write into a calendar and may run: the rules a comparison judges the calendar by.
 * Unlike `rulesTargetingAccount`, it keeps rules from an account that needs reconnecting, so that
 * the comparison can tell that it cannot read them.
 */
export async function rulesIntoCalendar(env: Env, calendarId: string): Promise<RuleContext[]> {
  const { results } = await env.DB.prepare(
    `${RULE_SELECT} WHERE r.target_calendar_id = ? AND r.enabled = 1 AND u.active = 1 ORDER BY r.id`,
  )
    .bind(calendarId)
    .all<RuleRow>();
  return results.map(toContext).filter((rule) => ownerMayRun(env, rule));
}

/** The calendars of an account that an enabled rule writes into. */
export async function targetCalendars(
  db: D1Database,
  accountId: string,
): Promise<{ calendarId: string; remoteCalendarId: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT tc.id AS calendarId, tc.remote_id AS remoteCalendarId
       FROM calendars tc JOIN rules r ON r.target_calendar_id = tc.id
       WHERE tc.account_id = ? AND r.enabled = 1 ORDER BY tc.id`,
    )
    .bind(accountId)
    .all<{ calendarId: string; remoteCalendarId: string }>();
  return results;
}

/**
 * The writable calendars of an account that no enabled rule writes into. A deleted rule can leave
 * blocks there. Only calendars of an owner who may still run rules: a full comparison reads them.
 */
export async function leftoverCalendars(
  env: Env,
  accountId: string,
): Promise<{ calendarId: string; remoteCalendarId: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id AS calendarId, c.remote_id AS remoteCalendarId, ${OWNER_COLUMNS}
     FROM calendars c JOIN accounts a ON a.id = c.account_id
     JOIN users u ON u.id = a.user_id JOIN orgs o ON o.id = u.org_id
     WHERE c.account_id = ? AND c.can_edit = 1 AND u.active = 1
       AND NOT EXISTS (SELECT 1 FROM rules r WHERE r.target_calendar_id = c.id AND r.enabled = 1)
     ORDER BY c.id`,
  )
    .bind(accountId)
    .all<{ calendarId: string; remoteCalendarId: string } & OwnerColumns>();
  return results
    .filter(ownerAdmission(env))
    .map(({ calendarId, remoteCalendarId }) => ({ calendarId, remoteCalendarId }));
}

/**
 * The rules that write into the same remote calendar as this calendar row, through a row of another
 * account. Google gives the same calendar id to every account that owns a shared calendar. The
 * providers keep their ids apart, so the provider must match too.
 */
export async function rulesThroughOtherRows(env: Env, calendarId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, ${OWNER_COLUMNS} FROM calendars own
     JOIN accounts oa ON oa.id = own.account_id
     JOIN calendars tc ON tc.remote_id = own.remote_id AND tc.id <> own.id
     JOIN accounts ta ON ta.id = tc.account_id AND ta.provider = oa.provider
     JOIN rules r ON r.target_calendar_id = tc.id
     JOIN users u ON u.id = r.user_id JOIN orgs o ON o.id = u.org_id
     WHERE own.id = ? AND r.enabled = 1 AND u.active = 1 ORDER BY r.id`,
  )
    .bind(calendarId)
    .all<{ id: string } & OwnerColumns>();
  return results.filter(ownerAdmission(env)).map((row) => row.id);
}

/** True if the rule's owner is active and the policy still admits them. */
export function ownerMayRun(env: Env, rule: RuleContext): boolean {
  return rule.owner.active && ownerAdmission(env)(rule.owner);
}

/**
 * True if the rule is enabled, its user is active and admitted by the access policy, and it writes
 * into this calendar.
 */
export async function ruleWritesInto(
  env: Env,
  ruleId: string,
  remoteCalendarId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT ${OWNER_COLUMNS} FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id
     JOIN users u ON u.id = r.user_id JOIN orgs o ON o.id = u.org_id
     WHERE r.id = ? AND tc.remote_id = ? AND r.enabled = 1 AND u.active = 1`,
  )
    .bind(ruleId, remoteCalendarId)
    .first<OwnerColumns>();
  return row !== null && ownerAdmission(env)(row);
}

/**
 * The other enabled rules of the same user that write into the target calendar of a rule. Their
 * blocks can stand in for the rule's own; see `desiredBlocks`.
 */
export async function siblingRuleIds(db: D1Database, ruleId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT o.id FROM rules r
       JOIN rules o ON o.target_calendar_id = r.target_calendar_id AND o.user_id = r.user_id
       WHERE r.id = ? AND o.id <> r.id AND o.enabled = 1 ORDER BY o.id`,
    )
    .bind(ruleId)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** The sync window of a rule: from the start of the current UTC day to `daysAhead` days later. */
export function syncWindow(options: RuleOptions, now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + options.daysAhead * 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * The window of the source read of a buffered rule: the sync window with the largest buffer added
 * on each side. A block that reaches into the sync window then has its event in the read, whatever
 * the buffers. The window does not depend on the size of the buffers, so that rules with different
 * buffers share one source read, and a lower buffer never narrows it. A rule without a buffer
 * reads the sync window, as before buffers existed: it returns no window then, and its blocks
 * stay exactly the same. The target read is wider still; see `targetReadWindow`.
 */
export function readWindow(
  window: { start: Date; end: Date },
  options: { bufferBefore: number; bufferAfter: number },
): { start: Date; end: Date } | undefined {
  if (options.bufferBefore === 0 && options.bufferAfter === 0) return undefined;
  const margin = MAX_BUFFER_MINUTES * 60_000;
  return {
    start: new Date(window.start.getTime() - margin),
    end: new Date(window.end.getTime() + margin),
  };
}

/**
 * True if a rule whose sync window ends at `end` never wants the block: a timed block starts at
 * `end` or later, an all-day block on a later date. The source read returns the all-day date at
 * `end` for a calendar east of UTC; see `planSync`.
 */
export function startsBeyond(block: { start: string; allDay: boolean }, end: Date): boolean {
  const start = Date.parse(block.start);
  return block.allDay ? start > end.getTime() : start >= end.getTime();
}

/**
 * The window of the target read of a rule: the sync window and one day more on each side. Each
 * provider filters all-day blocks at the midnights of the target calendar's time zone, so only a
 * wider read returns every all-day date that the source read can return; see `planSync`.
 */
export function targetReadWindow(window: { start: Date; end: Date }): { start: Date; end: Date } {
  const day = 24 * 60 * 60 * 1000;
  return {
    start: new Date(window.start.getTime() - day),
    end: new Date(window.end.getTime() + day),
  };
}

/**
 * The window of an edge read: one day on each side of the start of a window. It returns the date
 * before the window for every time zone, and an event or a block that ends exactly at the start of
 * the window. It does not depend on the rule's buffers; see `planSync`. A removal reads its target
 * like this, because a target east of UTC otherwise keeps the all-day block of the day before.
 */
export function edgeReadWindow(window: { start: Date; end: Date }): { start: Date; end: Date } {
  const day = 24 * 60 * 60 * 1000;
  return {
    start: new Date(window.start.getTime() - day),
    end: new Date(window.start.getTime() + day),
  };
}

/**
 * Window for removing a rule's blocks: from the start of the current UTC day to one year and a
 * month ahead, wider than any rule window. Blocks that end before this window stay as a record of
 * when the user was busy. A removal also deletes the blocks that end exactly at its start; see
 * `removeRuleBlocks`.
 */
export function cleanupWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 400 * 24 * 60 * 60 * 1000) };
}
