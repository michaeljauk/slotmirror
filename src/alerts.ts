import { DEFAULT_ORG_ID } from "./access";
import { auditStatement, errorLogFields, type AuditEvent, type AuditKind } from "./audit";
import { PROVIDER_LABEL, type Provider } from "./config";
import { i18nFor, LOCALES } from "./i18n";
import type { CompareMode, CompareRunDetail } from "./sync/compare";
import { OWNER_COLUMNS, ownerAdmission, type OwnerColumns } from "./users";

/** A slow webhook must not hold the alarm that found the refused token. */
const ALERT_TIMEOUT_MS = 5_000;

/**
 * A rule's full cycle starts at the first tick after one hour. Three hours without a run is no gap
 * of one cycle, as long as the cron reaches each account in time; see `accountsToTick`.
 */
export const SILENT_RULE_MS = 3 * 60 * 60_000;

/** After a delivered alert, the same rule and reason stay quiet for this long. */
export const ALERT_REPEAT_MS = 6 * 60 * 60_000;

/**
 * Rules that one alert names. A rule beyond this limit goes into a later alert. This keeps the
 * text short and the write of the repeat lock small after an outage of the whole deployment.
 */
export const MAX_ALERT_RULES = 20;

/**
 * How far back a silence check looks for the last alert about a rule. A check names the rules with
 * the oldest alert first, so this time must be longer than one round through all silent rules.
 * Seven days cover 3,360 rules: 20 per hour. With more silent rules, those beyond the seven days
 * count as never named, so an alert can no longer name each rule in turn. The read walks the index
 * of alert events, as the lock does.
 */
const NAMED_MEMORY_MS = 7 * 24 * 60 * 60_000;

/**
 * Rules that one silence check looks at. D1 returns one row for each, with the owner's policy, and
 * the Free plan allows 10 ms of CPU time. With more rules, each check reads the next ones.
 */
export const MAX_CHECKED_RULES = 500;

/**
 * Audit rows that one silence check scans at most. D1 counts each of them twice, in the index walk
 * and in the subquery. At one check per hour this is at most 480,000 of the 5 million rows that
 * the D1 Free plan reads per day. A small team stays far below: about 1,000 scanned rows.
 */
export const SILENCE_SCAN_ROWS = 10_000;

/**
 * Subrequests that one silence check takes at most: a D1 batch that fails, a read of the repeat
 * lock, a webhook call and a D1 batch to write. It sends one alert at most.
 */
export const SILENCE_CHECK_SUBREQUESTS = 4;

/** The interval of the cron. */
export const CRON_TICK_MS = 10 * 60_000;

/** The result of a post to the webhook. `off`: nothing was due, or no URL is set. */
export type AlertOutcome = "sent" | "off" | "failed";

/** Seconds between two test alerts of an org. */
export const TEST_ALERT_SECONDS = 60;

/** What a click on "Send test alert" did. `limited`: the last request is too recent. */
export const TEST_ALERT_OUTCOMES = ["sent", "off", "failed", "limited"] as const;
export type TestAlertOutcome = (typeof TEST_ALERT_OUTCOMES)[number];

/** The reason of an alert, stored as `code` in the detail of its `alert_sent` event. */
type AlertReason = "rule_silent" | "run_aborted" | "check_blind" | "compare_deviation";

/**
 * One row of the repeat lock. `ruleId` is null for an alert about no rule. `calendarId` is set for
 * `compare_deviation`, which has a lock per calendar.
 */
interface AlertLock {
  ruleId: string | null;
  code: string | null;
  calendarId: string | null;
  /** The newest delivered alert of this row. */
  at: string;
}

/** Why the silence check could not look at the rules. */
type BlindCause = "scanLimit" | "database" | "access";

/** The rule IDs of an aborted-run alert that are still to send, and the result of this post. */
export interface AbortAlertResult {
  outcome: AlertOutcome;
  open: string[];
}

/**
 * What an alert about a comparison keeps of its result: IDs and counts, no marker. `notBefore` is
 * set while the repeat lock of its calendar holds the alert back.
 */
export type CompareAlert = Pick<
  CompareRunDetail,
  | "calendarId"
  | "mode"
  | "scanStartedAt"
  | "deviations"
  | "missing"
  | "surplus"
  | "mismatched"
  | "duplicates"
  | "hitsCapped"
> & { notBefore?: number };

/** The comparisons that are still to send, and the result of this post. */
export interface CompareAlertResult {
  outcome: AlertOutcome;
  open: CompareAlert[];
}

/** The rows that own an alert about a rule. */
interface AlertScope {
  orgId: string;
  userId: string;
  accountId: string;
}

function alertUrl(env: Env): string | undefined {
  return env.ALERT_WEBHOOK_URL?.trim() || undefined;
}

/** True if this deployment has a webhook. The URL is a secret, so no page gets more than this. */
export function alertsConfigured(env: Env): boolean {
  return alertUrl(env) !== undefined;
}

/** The admin page of this deployment, or nothing without PUBLIC_URL. */
function adminLink(env: Env): string {
  let base = env.PUBLIC_URL?.trim() ?? "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  return base ? `${base}/admin` : "";
}

/**
 * Post a text to the optional ALERT_WEBHOOK_URL. The JSON body `{"text": ...}` is the Slack
 * incoming webhook format. Only a 2xx answer counts as delivered. A failure is logged without the
 * URL, which is a secret. Never throws.
 */
async function postAlert(env: Env, text: string): Promise<AlertOutcome> {
  const url = alertUrl(env);
  if (!url) return "off";
  if (!url.startsWith("https://")) {
    console.error("ALERT_WEBHOOK_URL must start with https://");
    return "failed";
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      // A redirect could send the body to another host or to plain http. workerd refuses the
      // standard "error" mode, so a 3xx comes back here and fails at `response.ok`.
      redirect: "manual",
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (response.ok) return "sent";
    console.error("Alert webhook answered", response.status);
    return "failed";
  } catch (error) {
    // The fields leave out the message, which can quote the URL.
    console.error("Alert webhook failed", ...errorLogFields(error));
    return "failed";
  }
}

/**
 * Tell the operator that an account needs to be connected again. The text names the provider and
 * the deployment, never an address, a calendar or an event.
 */
export function sendReconnectAlert(env: Env, provider: Provider): Promise<AlertOutcome> {
  const { t } = i18nFor(LOCALES[0]);
  return postAlert(env, t.alerts.reconnect(PROVIDER_LABEL[provider], env.PUBLIC_URL?.trim() ?? ""));
}

/**
 * Claim the one test alert per minute. The row is written only if the org has no recent one, in
 * one statement, so of two parallel requests one gets the claim. The bound comes from the clock of
 * D1, which also sets `created_at`. Throws if D1 fails: without a claim, nothing is sent.
 */
async function claimTestAlert(db: D1Database, scope: { orgId: string; userId: string }) {
  const { meta } = await db
    .prepare(
      `INSERT INTO audit_events (org_id, user_id, kind)
       SELECT ?1, ?2, ?3
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_events
         WHERE org_id = ?1 AND kind = ?3
           AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?4)
       )`,
    )
    .bind(
      scope.orgId,
      scope.userId,
      "alert_test" satisfies AuditKind,
      `-${TEST_ALERT_SECONDS} seconds`,
    )
    .run();
  return meta.changes === 1;
}

/**
 * Post a test alert for an admin. A request counts before the post, so a failed post also waits
 * for the next minute.
 */
export async function sendTestAlert(
  env: Env,
  scope: { orgId: string; userId: string },
): Promise<TestAlertOutcome> {
  if (!alertUrl(env)) return "off";
  if (!(await claimTestAlert(env.DB, scope))) return "limited";
  const { t } = i18nFor(LOCALES[0]);
  return postAlert(env, t.alerts.test(adminLink(env)));
}

/**
 * Store a delivered alert: this event is the repeat lock. A failed write loses the lock. A silent
 * rule then alerts again in each hourly check until a write lands. An aborted run or a comparison
 * has left its queue with the post, so only a newer one can alert again within the 6 hours.
 */
async function lockAlerts(
  db: D1Database,
  reason: AlertReason,
  events: (Omit<AuditEvent, "kind" | "detail"> & { calendarId?: string })[],
): Promise<void> {
  try {
    await db.batch(
      events.map(({ calendarId, ...event }) =>
        auditStatement(db, {
          ...event,
          kind: "alert_sent",
          detail: { code: reason, ...(calendarId ? { calendarId } : {}) },
        }),
      ),
    );
  } catch (error) {
    console.error("Storing an alert lock failed", ...errorLogFields(error));
  }
}

/**
 * The delivered alerts since `since`. The index `audit_events_alert_sent` holds these rows only, so
 * newer audit rows of any number cannot hide a lock.
 */
export function alertLockStatement(
  db: D1Database,
  orgId: string,
  since: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT rule_id AS ruleId, json_extract(detail, '$.code') AS code,
              json_extract(detail, '$.calendarId') AS calendarId, MAX(created_at) AS at
       FROM audit_events
       WHERE kind = 'alert_sent' AND org_id = ?1 AND created_at >= ?2
       GROUP BY ruleId, code, calendarId`,
    )
    .bind(orgId, since);
}

/**
 * Tell the operator about aborted runs of one account. An invocation that the platform stopped at
 * a limit can send nothing, so the next tick or alarm calls this. It names rule IDs and no content.
 * The repeat lock applies per rule. `open` lists the rules that a later call must still send: all
 * after a failed post, and those beyond `MAX_ALERT_RULES` after a delivered one. Throws if D1
 * cannot tell the lock: the caller tries again.
 */
export async function sendAbortAlert(
  env: Env,
  scope: AlertScope,
  ruleIds: string[],
  now = Date.now(),
): Promise<AbortAlertResult> {
  if (!alertUrl(env)) return { outcome: "off", open: [] };
  const { results } = await alertLockStatement(
    env.DB,
    scope.orgId,
    new Date(now - ALERT_REPEAT_MS).toISOString(),
  ).all<AlertLock>();
  const locked = new Set(
    results
      .filter((row) => row.code === ("run_aborted" satisfies AlertReason))
      .map((row) => row.ruleId),
  );
  const due = ruleIds.filter((id) => !locked.has(id));
  if (due.length === 0) return { outcome: "off", open: [] };
  const named = due.slice(0, MAX_ALERT_RULES);
  const { t } = i18nFor(LOCALES[0]);
  const outcome = await postAlert(
    env,
    t.alerts.abortedRuns(due.length, named.join(", "), adminLink(env)),
  );
  if (outcome === "failed") return { outcome, open: due };
  if (outcome === "sent") {
    await lockAlerts(
      env.DB,
      "run_aborted",
      named.map((ruleId) => ({ ...scope, ruleId })),
    );
  }
  return { outcome, open: due.slice(MAX_ALERT_RULES) };
}

/** How much of a calendar a comparison reads. A scan speaks only for what it read. */
const COMPARE_REACH: Record<CompareMode, number> = { near: 0, full: 1, leftover: 2 };

/**
 * The open alerts of an account after a finished comparison. A confirmed deviation replaces the
 * open alert of its calendar: the newest result counts. A result without any hit ends an open alert
 * of the same calendar if it read at least as far. A daily comparison reads only the near slice,
 * so it says nothing about a deviation that a full comparison found further on.
 */
export function compareAlertsAfter(
  queue: CompareAlert[],
  detail: CompareRunDetail,
): CompareAlert[] {
  const { calendarId, mode, scanStartedAt, deviations, hitsCapped } = detail;
  const { missing, surplus, mismatched, duplicates } = detail;
  if (deviations > 0) {
    const alert: CompareAlert = {
      calendarId,
      mode,
      scanStartedAt,
      deviations,
      missing,
      surplus,
      mismatched,
      duplicates,
      hitsCapped,
    };
    return [...queue.filter((open) => open.calendarId !== calendarId), alert];
  }
  if (detail.unconfirmed > 0 || hitsCapped) return queue;
  return queue.filter(
    (open) =>
      open.calendarId !== calendarId || COMPARE_REACH[open.mode] > COMPARE_REACH[detail.mode],
  );
}

/**
 * Tell the operator about finished comparisons with confirmed deviations in one account. The text
 * names calendar IDs and counts, and no content. The repeat lock applies per calendar. `open` lists
 * the comparisons that a later call must still send: all after a failed post, those beyond
 * `MAX_ALERT_RULES` after a delivered one, and those that a lock holds back, with the end of that
 * lock in `notBefore`, so that the caller needs no read until then. Throws if D1 cannot tell the
 * lock: the caller tries again.
 */
export async function sendCompareAlert(
  env: Env,
  scope: AlertScope,
  alerts: CompareAlert[],
  now = Date.now(),
): Promise<CompareAlertResult> {
  if (!alertUrl(env)) return { outcome: "off", open: [] };
  const { results } = await alertLockStatement(
    env.DB,
    scope.orgId,
    new Date(now - ALERT_REPEAT_MS).toISOString(),
  ).all<AlertLock>();
  const lockEnds = new Map(
    results
      .filter((row) => row.code === ("compare_deviation" satisfies AlertReason))
      .map((row) => [row.calendarId, Date.parse(row.at) + ALERT_REPEAT_MS]),
  );
  const waiting = alerts.flatMap((alert) => {
    const notBefore = lockEnds.get(alert.calendarId);
    return notBefore === undefined ? [] : [{ ...alert, notBefore }];
  });
  const due = alerts.filter((alert) => !lockEnds.has(alert.calendarId));
  if (due.length === 0) return { outcome: "off", open: waiting };
  const named = due.slice(0, MAX_ALERT_RULES);
  const { t } = i18nFor(LOCALES[0]);
  const describe = (list: CompareAlert[]) =>
    list
      .map((alert) => {
        const { missing, surplus, mismatched, duplicates } = alert;
        const counts = t.activity.compareFound(missing, surplus, mismatched, duplicates);
        const capped = alert.hitsCapped ? `, ${t.activity.compareCapped}` : "";
        return `${alert.calendarId} (${counts}${capped})`;
      })
      .join("; ");
  const outcome = await postAlert(
    env,
    t.alerts.compareDeviations(
      due.length,
      describe(named.filter((alert) => alert.mode !== "leftover")),
      describe(named.filter((alert) => alert.mode === "leftover")),
      adminLink(env),
    ),
  );
  if (outcome === "failed") return { outcome, open: [...waiting, ...due] };
  if (outcome === "sent") {
    await lockAlerts(
      env.DB,
      "compare_deviation",
      named.map(({ calendarId }) => ({ ...scope, calendarId })),
    );
  }
  return { outcome, open: [...waiting, ...due.slice(MAX_ALERT_RULES)] };
}

/** The cron runs every 10 minutes. The first tick of an hour runs the hourly check. */
export function isHourlyTick(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() < 10;
}

/** The subrequests to keep for the silence check in the cron invocation of this time. */
export function silenceCheckCost(env: Env, scheduledTime: number): number {
  return isHourlyTick(scheduledTime) && alertUrl(env) ? SILENCE_CHECK_SUBREQUESTS : 0;
}

/** A rule that should run, with the accounts and the user whose events give it time. */
type ActiveRule = OwnerColumns & {
  ruleId: string;
  userId: string;
  sourceAccountId: string;
  targetAccountId: string;
};

/** One group of audit rows of the scan. */
interface ScanGroup {
  kind: string;
  ruleId: string | null;
  accountId: string | null;
  userId: string | null;
  dryRun: number;
  /** 1 if `failed` and `remaining` are both 0. Only a `sync_run` has a meaning for this. */
  clean: number;
  scanned: number;
}

/** When the last alert named a rule. */
interface NamedRule {
  ruleId: string;
  at: string;
}

/** A rule with one of these events ran, without a result. */
const FAILED_RUN_EVENTS = new Set(["sync_failed", "sync_run_aborted"]);

/** A rule with one of these events in the last 3 hours is not silent. */
const RULE_EVENTS = new Set(["rule_created", "rule_enabled", "rule_updated"]);

/** A rule of an account with one of these events in the last 3 hours is not silent. */
const ACCOUNT_EVENTS = new Set(["account_connected", "account_resumed"]);

/**
 * The four reads of one silence check, for one D1 batch.
 *
 * The first lists the rules that must run. It leaves out what `rulesTargetingAccount` and the
 * alarm leave out on purpose: rules that are turned off, rules of inactive users, and rules with a
 * source account that needs reconnecting. A rule into such an account does not run either: the
 * instance is paused. The access policy applies in code, through `ownerAdmission`. With more than
 * `MAX_CHECKED_RULES` rules, the hour selects the page. A silent rule waits for its turn, and no
 * rule stays out of the check. With fewer rules, the offset is 0.
 *
 * The second walks the index on org and time, newest first, and stops after `SILENCE_SCAN_ROWS`
 * rows. No index on `rule_id` exists. One would add a written row to each audit event, and the
 * Free plan allows far fewer row writes than row reads. `created_at` is a string with a "T", so
 * the bound comes from `toISOString()`, never from `datetime('now')`.
 *
 * The third reads the repeat lock. It starts one cron tick late. The check of a lock runs at the
 * start of a tick and the lock is written later in a tick, so the check six hours on must not see
 * it.
 *
 * The fourth tells when an alert last named each rule. The lock alone cannot order the rules: it
 * ends after 6 hours, and an alert names 20 rules per hour.
 */
export function silentRuleStatements(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `WITH active AS (
           SELECT r.id AS ruleId, r.user_id AS userId, sc.account_id AS sourceAccountId,
                  tc.account_id AS targetAccountId, ${OWNER_COLUMNS}
           FROM rules r
           JOIN calendars sc ON sc.id = r.source_calendar_id
           JOIN accounts sa ON sa.id = sc.account_id
           JOIN calendars tc ON tc.id = r.target_calendar_id
           JOIN accounts ta ON ta.id = tc.account_id
           JOIN users u ON u.id = r.user_id
           JOIN orgs o ON o.id = u.org_id
           WHERE r.enabled = 1 AND u.active = 1 AND u.org_id = ?1
             AND sa.needs_reconnect = 0 AND ta.needs_reconnect = 0
         )
         SELECT * FROM active
         ORDER BY ruleId
         LIMIT ?2 OFFSET (?3 * ?2) % MAX(?2, (SELECT COUNT(*) FROM active))`,
      )
      .bind(DEFAULT_ORG_ID, MAX_CHECKED_RULES, Math.floor(now / (60 * 60_000))),
    db
      .prepare(
        `SELECT kind, rule_id AS ruleId, account_id AS accountId, user_id AS userId,
                COALESCE(json_extract(detail, '$.dryRun'), 0) AS dryRun,
                COALESCE(json_extract(detail, '$.failed'), 0) = 0
                  AND COALESCE(json_extract(detail, '$.remaining'), 0) = 0 AS clean,
                COUNT(*) AS scanned
         FROM (
           SELECT kind, rule_id, account_id, user_id, detail, created_at FROM audit_events
           WHERE org_id = ?1 AND created_at >= ?2
           ORDER BY created_at DESC
           LIMIT ?3
         )
         GROUP BY kind, ruleId, accountId, userId, dryRun, clean`,
      )
      .bind(DEFAULT_ORG_ID, new Date(now - SILENT_RULE_MS).toISOString(), SILENCE_SCAN_ROWS),
    alertLockStatement(db, DEFAULT_ORG_ID, lockStart(now)),
    db
      .prepare(
        `SELECT rule_id AS ruleId, MAX(created_at) AS at
         FROM audit_events
         WHERE kind = 'alert_sent' AND org_id = ?1 AND created_at >= ?2
           AND json_extract(detail, '$.code') = ?3
         GROUP BY rule_id`,
      )
      .bind(
        DEFAULT_ORG_ID,
        new Date(now - NAMED_MEMORY_MS).toISOString(),
        "rule_silent" satisfies AlertReason,
      ),
  ];
}

/** The start of the repeat lock for a silence check at `now`. */
function lockStart(now: number): string {
  return new Date(now - ALERT_REPEAT_MS + CRON_TICK_MS).toISOString();
}

/**
 * The rules of `active` that are silent, and those among all rules with a run that went wrong in
 * the window. A rule is quiet with a `sync_run` without failures and open work; a preview gives it
 * nothing. `locked` holds the rules with a delivered alert in the repeat lock.
 */
function silentRules(
  active: ActiveRule[],
  groups: ScanGroup[],
  locked: Set<string | null>,
): { silent: ActiveRule[]; failing: Set<string | null> } {
  const quietRules = new Set(locked);
  const quietAccounts = new Set<string | null>();
  const quietUsers = new Set<string | null>();
  const failing = new Set<string | null>();
  for (const group of groups) {
    if (group.kind === "sync_run") {
      if (group.dryRun) continue;
      (group.clean ? quietRules : failing).add(group.ruleId);
    } else if (FAILED_RUN_EVENTS.has(group.kind)) {
      failing.add(group.ruleId);
    } else if (RULE_EVENTS.has(group.kind)) {
      quietRules.add(group.ruleId);
    } else if (ACCOUNT_EVENTS.has(group.kind)) {
      quietAccounts.add(group.accountId);
    } else if (group.kind === "user_reactivated") {
      quietUsers.add(group.userId);
    }
  }
  const silent = active.filter(
    (rule) =>
      !quietRules.has(rule.ruleId) &&
      !quietAccounts.has(rule.sourceAccountId) &&
      !quietAccounts.has(rule.targetAccountId) &&
      !quietUsers.has(rule.userId),
  );
  return { silent, failing };
}

/**
 * The rules in the order of their turn in an alert: never named first, then the oldest alert. The
 * sort is stable, so the order of the read decides among equals. A failed post writes no row, so
 * the same rules stay first. No rule can wait forever behind rules whose lock has ended.
 */
function oldestNamedFirst(rules: ActiveRule[], named: NamedRule[]): ActiveRule[] {
  const lastAt = new Map(named.map((row) => [row.ruleId, row.at]));
  const at = (rule: ActiveRule) => lastAt.get(rule.ruleId) ?? "";
  return [...rules].sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
}

/** The lock of `check_blind` during a D1 failure. If D1 cannot tell it, no lock counts. */
async function readLocksAfterFailure(env: Env, now: number): Promise<AlertLock[]> {
  try {
    const locks = alertLockStatement(env.DB, DEFAULT_ORG_ID, lockStart(now));
    return (await locks.all<AlertLock>()).results;
  } catch (error) {
    console.error("Reading the alert lock failed", ...errorLogFields(error));
    return [];
  }
}

/**
 * Tell the operator that the silence check itself cannot see the rules, because a check that fails
 * looks like a healthy deployment. It has its own repeat lock, which belongs to no rule.
 */
async function reportBlindCheck(env: Env, cause: BlindCause, locks: AlertLock[]): Promise<void> {
  if (locks.some((lock) => lock.code === ("check_blind" satisfies AlertReason))) return;
  const { t } = i18nFor(LOCALES[0]);
  const text = t.alerts.checkBlind(t.alerts.blindCauses[cause], adminLink(env));
  if ((await postAlert(env, text)) !== "sent") return;
  await lockAlerts(env.DB, "check_blind", [{ orgId: DEFAULT_ORG_ID }]);
}

/**
 * The hourly check: tell the operator about active rules without a successful run for 3 hours. A
 * successful run is no preview, and has no failed actions and no open work. A check that cannot
 * look at the rules reports that instead. Its budget is fixed, however many rules are silent; see
 * `SILENCE_CHECK_SUBREQUESTS`. Without a webhook it does nothing.
 */
export async function checkSilentRules(env: Env, now: number): Promise<void> {
  if (!alertUrl(env)) return;
  let reads: D1Result[];
  try {
    reads = await env.DB.batch(silentRuleStatements(env.DB, now));
  } catch (error) {
    console.error("Silence check failed", ...errorLogFields(error));
    await reportBlindCheck(env, "database", await readLocksAfterFailure(env, now));
    return;
  }
  const [rules, scan, locks, lastNamed] = reads as [
    D1Result<ActiveRule>,
    D1Result<ScanGroup>,
    D1Result<AlertLock>,
    D1Result<NamedRule>,
  ];
  const scanned = scan.results.reduce((sum, group) => sum + group.scanned, 0);
  // Rows beyond the limit may hold a rule's run, so no rule counts as silent.
  if (scanned >= SILENCE_SCAN_ROWS) {
    console.error("Silence check skipped: the audit scan reached its limit", scanned);
    await reportBlindCheck(env, "scanLimit", locks.results);
    return;
  }
  const admitted = rules.results.filter(ownerAdmission(env));
  if (admitted.length === 0 && rules.results.length > 0) {
    await reportBlindCheck(env, "access", locks.results);
    return;
  }
  const locked = new Set(
    locks.results
      .filter((lock) => lock.code === ("rule_silent" satisfies AlertReason))
      .map((lock) => lock.ruleId),
  );
  const { silent, failing } = silentRules(admitted, scan.results, locked);
  if (silent.length === 0) return;
  const named = oldestNamedFirst(silent, lastNamed.results).slice(0, MAX_ALERT_RULES);
  const { t } = i18nFor(LOCALES[0]);
  const ids = (list: ActiveRule[]) => list.map((rule) => rule.ruleId).join(", ");
  const text = t.alerts.silentRules(
    silent.length,
    SILENT_RULE_MS / (60 * 60_000),
    ids(named.filter((rule) => !failing.has(rule.ruleId))),
    ids(named.filter((rule) => failing.has(rule.ruleId))),
    adminLink(env),
  );
  if ((await postAlert(env, text)) !== "sent") return;
  await lockAlerts(
    env.DB,
    "rule_silent",
    named.map((rule) => ({
      orgId: rule.ownerOrgId,
      userId: rule.userId,
      accountId: rule.targetAccountId,
      ruleId: rule.ruleId,
    })),
  );
}
