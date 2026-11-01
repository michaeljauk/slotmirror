import type { CleanupResult } from "./audit";

/**
 * Tombstones: the removal of an offboarding as a D1 row. `AccountSync` holds the running job. The
 * row keeps the owner, the target calendar, the rule tag, the progress and the end state, also after
 * the rule, the account and the user went. A row with a rest is what the user deletes by hand; a
 * reconnect does not reopen it. Rows hold no event content, see `migrations/0019`.
 *
 * Every open row ends once. A job sets the deadline of its row, so a row with a deadline has a job,
 * and only that job ends it. A row without a deadline has none, and the cron ends it, or removes it
 * if the owner took the rule over, see `ownerEndedRule()`.
 */

/**
 * A job on a paused account ends this long after its offboarding queued it. The account may never
 * come back: a deactivated user does not reconnect, and nothing else ends the wait.
 */
export const CLEANUP_DEADLINE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A tombstone that no job took closes this long after it opened: its request failed or died. This
 * is longer than `HOLD_LEASE_MS` plus the time between two crons, so that a rule that runs again
 * runs by then.
 */
export const JOBLESS_TOMBSTONE_MS = 60 * 60 * 1000;

/**
 * A request holds a stopped rule this long. Then the cron may read the hold of a request that died.
 * A request takes seconds, and its rule then runs again or goes with its account. The cron renews
 * the lease of a rule that waits, so the lease is longer than the 10 minutes between two crons: a
 * rule that waits stays out of the next read, and the rules behind it get its place.
 */
export const HOLD_LEASE_MS = 15 * 60 * 1000;

/** The removal of one rule's blocks. A rule writes into one calendar. */
export interface TombstoneKey {
  accountId: string;
  ruleId: string;
}

interface TombstoneOwner extends TombstoneKey {
  remoteCalendarId: string;
  orgId: string;
  userId: string;
  ruleTag: string;
}

export interface NewTombstone extends TombstoneOwner {
  calendarName: string;
  blockTitle: string | null;
  /** The rule was off before this offboarding, so its last sync run counts no block. */
  ruleWasOff: boolean;
  windowStart: string | null;
  windowEnd: string | null;
  /** The clock of the worker, like the time the cron compares it with. */
  openedAt: string;
}

export interface TombstoneResult extends TombstoneOwner {
  state: CleanupResult;
  removed: number;
  left: number | null;
  estimated: boolean;
}

/**
 * Open the tombstone of a job. An open tombstone stays as it is: a retry of the request takes its
 * job over, or starts the job that it never got. An end state makes room for the new job. With
 * `whileUserActive`, it does so only while the user is active: a second deactivation is no new
 * offboarding, and what ended stays ended. The exception is `not_started`: nothing ran, and a repeated
 * deactivation is the retry of its request.
 */
export function openTombstone(
  db: D1Database,
  stone: NewTombstone,
  { whileUserActive = false }: { whileUserActive?: boolean } = {},
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO cleanup_tombstones (account_id, remote_calendar_id, rule_id, org_id, user_id,
         calendar_name, rule_tag, block_title, window_start, window_end, rule_was_off, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?13)
       ON CONFLICT (account_id, rule_id) DO UPDATE SET
         remote_calendar_id = excluded.remote_calendar_id,
         org_id = excluded.org_id, user_id = excluded.user_id,
         calendar_name = excluded.calendar_name, block_title = excluded.block_title,
         window_start = excluded.window_start, window_end = excluded.window_end,
         deadline_at = NULL, rule_was_off = excluded.rule_was_off,
         state = 'open', removed = 0, blocks_left = NULL, left_estimated = 0, finished_at = NULL,
         created_at = excluded.created_at,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE cleanup_tombstones.state <> 'open'
         AND (?12 = 0 OR cleanup_tombstones.state = 'not_started'
           OR EXISTS (SELECT 1 FROM users u WHERE u.id = ?5 AND u.active = 1))`,
    )
    .bind(
      stone.accountId,
      stone.remoteCalendarId,
      stone.ruleId,
      stone.orgId,
      stone.userId,
      stone.calendarName,
      stone.ruleTag,
      stone.blockTitle,
      stone.windowStart,
      stone.windowEnd,
      stone.ruleWasOff ? 1 : 0,
      whileUserActive ? 1 : 0,
      stone.openedAt,
    );
}

/**
 * Note that a job exists. A job that a repeated request took over keeps its deadline. The job is in
 * storage before this runs: if this fails, the job goes on and its request fails, so that a retry
 * comes here again.
 */
export function noteTombstoneJob(
  db: D1Database,
  accountId: string,
  ruleIds: string[],
  deadlineAt: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE cleanup_tombstones SET deadline_at = ifnull(deadline_at, ?),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE account_id = ? AND state = 'open'
         AND rule_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(deadlineAt, accountId, JSON.stringify(ruleIds));
}

/**
 * Store the end of a job. It can run twice, if an answer got lost. A job that a version without
 * tombstones queued has no row yet, so this inserts one. A removal that left nothing needs no name
 * and no ID of a calendar any more: the ID of a primary Google calendar is a mail address. A rest
 * keeps them until retention, so that the owner can find the blocks.
 */
export function closeTombstone(db: D1Database, result: TombstoneResult): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO cleanup_tombstones (account_id, remote_calendar_id, rule_id, org_id, user_id,
         rule_tag, state, removed, blocks_left, left_estimated, finished_at)
       VALUES (?1, iif(?7 = 'removed', NULL, ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (account_id, rule_id) DO UPDATE SET
         state = excluded.state, removed = excluded.removed, blocks_left = excluded.blocks_left,
         left_estimated = excluded.left_estimated, finished_at = excluded.finished_at,
         remote_calendar_id = iif(excluded.state = 'removed', NULL,
           ifnull(remote_calendar_id, excluded.remote_calendar_id)),
         calendar_name = iif(excluded.state = 'removed', NULL, calendar_name),
         block_title = iif(excluded.state = 'removed', NULL, block_title),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(
      result.accountId,
      result.remoteCalendarId,
      result.ruleId,
      result.orgId,
      result.userId,
      result.ruleTag,
      result.state,
      result.removed,
      result.left,
      result.estimated ? 1 : 0,
    );
}

/** Note how far an open job came. The end of the job writes the same numbers again. */
export function noteTombstoneProgress(
  db: D1Database,
  key: TombstoneKey,
  removed: number,
  left: number | null,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE cleanup_tombstones SET removed = ?, blocks_left = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE account_id = ? AND rule_id = ? AND state = 'open'`,
    )
    .bind(removed, left, key.accountId, key.ruleId);
}

/** The tombstone's rule runs, so it owns its blocks. */
function ruleRuns(tombstone: string): string {
  return `EXISTS (SELECT 1 FROM rules r JOIN users u ON u.id = r.user_id
    WHERE r.id = ${tombstone}.rule_id AND r.enabled = 1 AND u.active = 1)`;
}

/**
 * The owner ended the tombstone's rule after the failed offboarding. Only an offboarding with a job
 * takes a rule with its account or user, so a rule that went without a deadline on the row went
 * through a delete, which queues its own removal. A rule that ran at the offboarding and stopped
 * without a hold was stopped by its active user. The triggers in `migrations/0019` treat an ended
 * row the same way.
 */
function ownerEndedRule(tombstone: string): string {
  return `(NOT EXISTS (SELECT 1 FROM rules r WHERE r.id = ${tombstone}.rule_id)
    OR (${tombstone}.rule_was_off = 0 AND EXISTS (
      SELECT 1 FROM rules r JOIN users u ON u.id = r.user_id
      WHERE r.id = ${tombstone}.rule_id AND r.enabled = 0 AND u.active = 1
        AND NOT EXISTS (SELECT 1 FROM rule_holds h WHERE h.rule_id = r.id))))`;
}

/**
 * Close the tombstones that no job took, for the cron. A request that failed to queue a job and did
 * not run again leaves such a row, and nothing else ends it. A rule that runs keeps its blocks, so
 * that row asks nothing of the user, and it keeps no calendar. A rule that its owner ended asks for
 * nothing either: the row goes without an event, as the log has the owner's change. The end goes
 * into the audit log in the same step, so that a repeated step writes no second event.
 */
export function closeAbandonedTombstones(db: D1Database, now: number): D1PreparedStatement[] {
  const cutoff = new Date(now - JOBLESS_TOMBSTONE_MS).toISOString();
  const runs = ruleRuns("cleanup_tombstones");
  const jobless = "state = 'open' AND deadline_at IS NULL AND created_at < ?";
  return [
    db
      .prepare(
        `DELETE FROM cleanup_tombstones
         WHERE ${jobless} AND ${ownerEndedRule("cleanup_tombstones")}`,
      )
      .bind(cutoff),
    db
      .prepare(
        `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail)
         SELECT org_id, user_id, account_id, rule_id, 'cleanup_finished',
           json_patch(json_object('result', iif(${runs}, 'kept', 'not_started'), 'removed', removed),
             iif(blocks_left > 0, json_object('left', blocks_left), '{}'))
         FROM cleanup_tombstones WHERE ${jobless}`,
      )
      .bind(cutoff),
    db
      .prepare(
        `UPDATE cleanup_tombstones SET state = iif(${runs}, 'kept', 'not_started'),
           remote_calendar_id = iif(${runs}, NULL, remote_calendar_id),
           calendar_name = iif(${runs}, NULL, calendar_name),
           block_title = iif(${runs}, NULL, block_title),
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE ${jobless}`,
      )
      .bind(cutoff),
  ];
}

/**
 * The blocks that the last run of each rule left in the account. A job that never read its calendar
 * has no other count: a refused token allows no read. Dry runs write nothing and do not count. The
 * last run of a rule that was off before its offboarding says nothing: that rule's own removal may
 * have taken the blocks long ago.
 */
export async function lastRunBlocks(
  db: D1Database,
  accountId: string,
  ruleIds: string[],
): Promise<Map<string, number>> {
  if (ruleIds.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT rule_id AS ruleId, detail FROM audit_events WHERE id IN (
         SELECT MAX(e.id) FROM audit_events e
         WHERE e.account_id = ?1 AND e.kind = 'sync_run'
           AND json_extract(e.detail, '$.dryRun') = 0
           AND e.rule_id IN (SELECT value FROM json_each(?2))
           AND NOT EXISTS (SELECT 1 FROM cleanup_tombstones t
             WHERE t.account_id = ?1 AND t.rule_id = e.rule_id AND t.rule_was_off = 1)
         GROUP BY e.rule_id)`,
    )
    .bind(accountId, JSON.stringify(ruleIds))
    .all<{ ruleId: string; detail: string }>();
  return new Map(results.map(({ ruleId, detail }) => [ruleId, blocksAfterRun(detail)]));
}

function blocksAfterRun(detail: string): number {
  const run = JSON.parse(detail) as Partial<
    Record<"create" | "update" | "unchanged" | "remaining" | "failed", number>
  >;
  const wanted = (run.create ?? 0) + (run.update ?? 0) + (run.unchanged ?? 0);
  return Math.max(0, wanted - (run.remaining ?? 0) - (run.failed ?? 0));
}

/** Why a job ended with blocks left. */
export type LeftBehind = Exclude<CleanupResult, "removed" | "kept">;

/** The jobs of one target calendar that ended with blocks left, or that still run. */
export interface CalendarCleanup {
  name: string | null;
  /** The address of the account, for the owner, while the account exists. */
  account: string | null;
  /** Null if at least one job has no count. */
  blocks: number | null;
  estimated: boolean;
  markers: { ruleTag: string; blockTitle: string | null }[];
  windowStart: string | null;
  windowEnd: string | null;
  /** The ends of the jobs. Empty for jobs that run. */
  reasons: LeftBehind[];
  /** The day a job that waits for a reconnect ends, or null if no job runs. */
  waitsUntil: string | null;
}

/** What a user or an admin still finds of offboardings: a rest to delete, and jobs that run. */
export interface Cleanups {
  left: CalendarCleanup[];
  running: CalendarCleanup[];
}

export const NO_CLEANUPS: Cleanups = { left: [], running: [] };

interface TombstoneRow {
  accountId: string;
  remoteCalendarId: string | null;
  accountEmail: string | null;
  calendarName: string | null;
  ruleTag: string;
  blockTitle: string | null;
  state: "open" | Exclude<CleanupResult, "kept">;
  blocksLeft: number | null;
  leftEstimated: number;
  windowStart: string | null;
  windowEnd: string | null;
  deadlineAt: string | null;
}

const TOMBSTONE_COLUMNS = `t.account_id AS accountId, t.remote_calendar_id AS remoteCalendarId,
  t.calendar_name AS calendarName, t.rule_tag AS ruleTag, t.block_title AS blockTitle, t.state,
  t.blocks_left AS blocksLeft, t.left_estimated AS leftEstimated, t.window_start AS windowStart,
  t.window_end AS windowEnd, t.deadline_at AS deadlineAt`;

/**
 * Tombstones with a rest or a job that runs. A rule that runs again owns its blocks: a failed
 * request leaves such a job, and a reactivation ends the need for one. The row goes once the rule
 * stops, see the triggers in `migrations/0019`.
 */
const WITH_REST = `t.state NOT IN ('removed', 'kept') AND NOT ${ruleRuns("t")}`;

/** Users of the org who can no longer see their own rest. */
const OWNER_GONE = `t.org_id = ? AND NOT EXISTS (
  SELECT 1 FROM users u WHERE u.id = t.user_id AND u.active = 1)`;

function earliest(values: (string | null)[]): string | null {
  return values.reduce<string | null>(
    (a, b) => (a === null || (b !== null && b < a) ? b : a),
    null,
  );
}

function latest(values: (string | null)[]): string | null {
  return values.reduce<string | null>(
    (a, b) => (a === null || (b !== null && b > a) ? b : a),
    null,
  );
}

function byCalendar(rows: TombstoneRow[]): CalendarCleanup[] {
  const groups = Map.groupBy(rows, (row) => `${row.accountId}\u0000${row.remoteCalendarId ?? ""}`);
  return [...groups.values()].map((group) => {
    const open = group.filter((row) => row.state === "open");
    const ended = group.flatMap(({ state }) =>
      state === "open" || state === "removed" ? [] : [state],
    );
    // Zero blocks with an end other than `removed` means a block at the window's edge may be left.
    const counts = group.map((row) => row.blocksLeft || null);
    return {
      name: group.find((row) => row.calendarName !== null)?.calendarName ?? null,
      account: group.find((row) => row.accountEmail !== null)?.accountEmail ?? null,
      blocks: counts.includes(null) ? null : counts.reduce<number>((a, b) => a + (b ?? 0), 0),
      estimated: group.some((row) => row.leftEstimated === 1),
      markers: group.map(({ ruleTag, blockTitle }) => ({ ruleTag, blockTitle })),
      windowStart: earliest(group.map((row) => row.windowStart)),
      windowEnd: latest(group.map((row) => row.windowEnd)),
      reasons: [...new Set(ended)],
      waitsUntil: latest(open.map((row) => row.deadlineAt)),
    };
  });
}

/**
 * A job that runs is no rest: the page names it apart, and asks nothing of the user. A row without a
 * job is neither, until the cron closes it.
 */
function cleanupsOf(rows: TombstoneRow[]): Cleanups {
  return {
    left: byCalendar(rows.filter((row) => row.state !== "open")),
    running: byCalendar(rows.filter((row) => row.state === "open" && row.deadlineAt !== null)),
  };
}

/** What a user's offboardings left, per target calendar. */
export async function ownCleanups(db: D1Database, userId: string): Promise<Cleanups> {
  const { results } = await db
    .prepare(
      `SELECT ${TOMBSTONE_COLUMNS}, a.email AS accountEmail FROM cleanup_tombstones t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND ${WITH_REST} ORDER BY t.calendar_name, t.rule_tag`,
    )
    .bind(userId)
    .all<TombstoneRow>();
  return cleanupsOf(results);
}

/** What the org's deactivated and deleted users left, for an admin, without their accounts. */
export async function cleanupsOfOthers(db: D1Database, orgId: string): Promise<Cleanups> {
  const { results } = await db
    .prepare(
      `SELECT ${TOMBSTONE_COLUMNS}, NULL AS accountEmail FROM cleanup_tombstones t
       WHERE ${OWNER_GONE} AND ${WITH_REST} ORDER BY t.calendar_name, t.rule_tag`,
    )
    .bind(orgId)
    .all<TombstoneRow>();
  return cleanupsOf(results);
}
