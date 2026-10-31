/**
 * Pure part of `pnpm trial:report`: the read-only queries, the guard that keeps them read-only,
 * and the evaluation of the rows. No wrangler, no Node API, so tests run it in any pool.
 *
 * The report is a list, not a verdict. It stores and prints IDs, times, counts and codes only.
 */

/** Rows of the audit read at most. If the read hits this, the period is cut short and says so. */
export const AUDIT_ROW_LIMIT = 5000;

/** Default period of the audit read. */
export const DEFAULT_SINCE_MS = 7 * 24 * 3600_000;

/** A rule whose newest successful run is older than this is listed as quiet. Informational. */
export const QUIET_AFTER_MS = 3 * 3600_000;

/** Pauses longer than this are marked, because they stretch the fault clock. */
export const LONG_PAUSE_MS = 24 * 3600_000;

/** Kinds the report reads for rules and accounts. Others are known and not relevant here. */
const KNOWN_RELEVANT = new Set([
  "rule_created",
  "sync_run",
  "sync_failed",
  "sync_run_aborted",
  "account_paused",
  "account_resumed",
  "alert_sent",
  "compare_run",
  "compare_failed",
]);

/**
 * Kinds that the app writes and that this report does not need. A kind outside both sets shows in
 * the list of unknown codes. `alert_sent` comes with the run alerts; older databases have none.
 */
const KNOWN_IGNORED = new Set([
  "alert_test",
  "sign_in",
  "sign_in_refused",
  "sign_in_reset",
  "sign_out",
  "account_connected",
  "account_disconnect_failed",
  "cleanup_finished",
  "account_disconnected",
  "account_renamed",
  "token_refresh_failed",
  "rule_deleted",
  "rule_enabled",
  "rule_paused",
  "rule_updated",
  "group_changed",
  "settings_changed",
  "user_provisioned",
  "user_deactivated",
  "user_reactivated",
  "user_deleted",
  "feed_created",
  "feed_rotated",
  "feed_deleted",
]);

/** Every audit kind this report knows. A test compares it with `AuditKind` in `src/audit.ts`. */
export const KNOWN_KINDS: ReadonlySet<string> = new Set([...KNOWN_RELEVANT, ...KNOWN_IGNORED]);

// ---------------------------------------------------------------------------------------------
// Queries: SELECT only

/** Throws unless `sql` is one plain SELECT statement. Every statement goes through this. */
export function assertReadOnly(sql: string): string {
  const text = sql.trim();
  if (!/^select\s/i.test(text)) throw new Error("trial:report sends SELECT statements only");
  if (text.includes(";")) throw new Error("trial:report sends one statement at a time");
  if (/--|\/\*/.test(text)) throw new Error("trial:report sends no comments");
  return text;
}

/** An ISO timestamp as the audit log writes it. The only value that enters a statement. */
function isoLiteral(ms: number): string {
  const iso = new Date(ms).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) throw new Error("Invalid time");
  return `'${iso}'`;
}

/**
 * Active and inactive rules with the accounts they read from and write into. The worker skips a
 * rule while either account needs a reconnect. No names, no calendar IDs.
 */
export const RULES_SQL = assertReadOnly(
  `SELECT r.id AS id, r.enabled AS enabled,
          c.account_id AS accountId, COALESCE(a.needs_reconnect, 0) AS needsReconnect,
          sc.account_id AS sourceAccountId, COALESCE(sa.needs_reconnect, 0) AS sourceNeedsReconnect
   FROM rules r
   JOIN calendars c ON c.id = r.target_calendar_id
   LEFT JOIN accounts a ON a.id = c.account_id
   JOIN calendars sc ON sc.id = r.source_calendar_id
   LEFT JOIN accounts sa ON sa.id = sc.account_id
   ORDER BY r.id`,
);

/**
 * The newest audit rows since `sinceMs`, newest first. Reads at most `AUDIT_ROW_LIMIT` rows, so
 * the read stays small on the Free plan. `created_at` holds an ISO string with a `T`, so the
 * bound is an ISO string too, never `datetime('now')`.
 */
export function auditSql(sinceMs: number, limit = AUDIT_ROW_LIMIT): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new Error("Invalid limit");
  return assertReadOnly(
    `SELECT id, rule_id AS ruleId, account_id AS accountId, kind, detail, created_at AS createdAt
     FROM audit_events
     WHERE created_at >= ${isoLiteral(sinceMs)}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Rows in

export interface RuleRow {
  id: string;
  enabled: number;
  /** Target account. */
  accountId: string;
  needsReconnect: number;
  sourceAccountId: string;
  sourceNeedsReconnect: number;
}

export interface AuditRow {
  id: number;
  ruleId: string | null;
  accountId: string | null;
  kind: string;
  detail: string;
  createdAt: string;
}

export interface ReportInput {
  rules: RuleRow[];
  /** Any order. */
  audit: AuditRow[];
  /** Start of the requested period, Unix ms. */
  sinceMs: number;
  nowMs: number;
  /** The audit read stopped at its row limit. */
  auditTruncated: boolean;
}

// ---------------------------------------------------------------------------------------------
// Evaluation

type Detail = Record<string, unknown>;

function parseDetail(json: string): Detail {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Detail)
      : {};
  } catch {
    return {};
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A stored code for print: cut to 80 characters, every character outside a small set replaced by
 * `_`. Control characters and `@` never reach the output.
 */
export function safeCode(value: unknown): string {
  if (typeof value !== "string" || value === "") return "?";
  return value.slice(0, 80).replace(/[^\w .:$/+-]/g, "_");
}

/** A short stable reference for an ID that may hold an address. FNV-1a, 32 bit, not a secret. */
export function shortRef(value: unknown): string {
  let hash = 0x811c9dc5;
  for (const char of String(value ?? "")) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ref-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Both forms of a stored error code. Old rows hold the message, "Graph GET failed: 504 timeout".
 * New rows hold `errorCode()`, "graph_504_timeout". Anything else is "other".
 */
export function classifyErrorCode(code: string): {
  form: "message" | "code" | "other";
  provider: string | null;
  status: number | null;
} {
  const old = /^(Graph|Google) [A-Za-z $]{1,40} failed: (\d{3})(?: |$)/.exec(code);
  if (old) return { form: "message", provider: old[1]!.toLowerCase(), status: Number(old[2]) };
  const fresh = /^(graph|google)_(\d{3})(?:_|$)/.exec(code);
  if (fresh) return { form: "code", provider: fresh[1]!, status: Number(fresh[2]) };
  if (/^token_/.test(code)) return { form: "code", provider: "token", status: null };
  return { form: "other", provider: null, status: null };
}

export interface RunLine {
  at: string;
  failed: number;
  remaining: number;
  duplicates: number;
  dryRun: boolean;
}

export interface FailureLine {
  at: string;
  code: string;
  form: "message" | "code" | "other";
}

export interface RuleReport {
  ruleId: string;
  accountId: string;
  sourceAccountId: string;
  /** The target account needs a reconnect now (`accounts.needs_reconnect`). */
  targetPausedNow: boolean;
  /** The source account needs a reconnect now. The worker skips the rule then too. */
  sourcePausedNow: boolean;
  /** ISO time of the newest run without failed actions and without dry run, in the period. */
  lastSuccessAt: string | null;
  /** Milliseconds from `lastSuccessAt` to now. */
  sinceSuccessMs: number | null;
  /** The newest run of any kind in the period, for context. */
  lastRun: RunLine | null;
  runs: number;
  dryRuns: number;
  /** Non-dry runs with `failed` > 0. */
  failedRuns: number;
  /** Non-dry runs with `failed` = 0 and `remaining` > 0, for example throttled ones. */
  partialRuns: number;
  failures: FailureLine[];
  aborts: string[];
  /**
   * Pairs of consecutive successful runs that both held `duplicates` > 0. A run with failed or
   * remaining actions is no part of a pair and breaks the chain.
   */
  duplicateSuspicions: { at: string; previousAt: string; gapMs: number }[];
  /** ISO time of a `rule_created` event in the period, if the audit holds one. */
  createdAt: string | null;
  /** `lastSuccessAt` is null: the period holds no successful run. The report cannot say more. */
  notCovered: boolean;
  /** Facts about why: no run at all, only dry runs, runs but none successful. */
  notCoveredReason: "no_runs" | "only_dry_runs" | "no_successful_run" | null;
}

export interface AccountPause {
  accountId: string;
  pausedAt: string;
  /** Code of the pause, e.g. a token code. */
  code: string;
  resumedAt: string | null;
  /** Length of a pause that ended, in ms. */
  pausedMs: number | null;
  /** The pause is still open at `nowMs` and older than `LONG_PAUSE_MS`, or ended after that. */
  long: boolean;
}

export interface CompareLine {
  at: string;
  kind: "compare_run" | "compare_failed";
  /** `shortRef` of the calendar ID. The stored ID can hold an address. */
  calendarRef: string;
  mode: string;
  deviations: number | null;
  cleared: number | null;
  rounds: number | null;
  clean: boolean | null;
  code: string | null;
}

export interface Report {
  sinceMs: number;
  nowMs: number;
  /** Start of what the audit read really covers: later than `sinceMs` if the read was cut. */
  coveredFromMs: number;
  auditRows: number;
  auditTruncated: boolean;
  activeRules: RuleReport[];
  inactiveRules: number;
  pauses: AccountPause[];
  alerts: { at: string; ruleId: string | null; code: string }[];
  compares: CompareLine[];
  unknownKinds: { kind: string; count: number; lastAt: string }[];
  /** Rows of a kind with a rule ID that matches no rule in `rules`. Count only. */
  rowsOfUnknownRules: number;
}

/**
 * Evaluate rows into a report. A successful run is a `sync_run` that is not a dry run and has
 * `failed` = 0 and `remaining` = 0, as in `src/alerts.ts`. Consecutive runs are the non-dry `sync_run` rows of one rule in time order; a
 * `sync_failed` row between them does not break the sequence.
 */
export function buildReport(input: ReportInput): Report {
  const { rules, nowMs, sinceMs } = input;
  const rows = [...input.audit].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id - b.id : a.createdAt < b.createdAt ? -1 : 1,
  );

  const oldest = rows[0];
  const coveredFromMs =
    input.auditTruncated && oldest ? Math.max(sinceMs, Date.parse(oldest.createdAt)) : sinceMs;

  const byRule = new Map<string, AuditRow[]>();
  for (const row of rows) {
    if (!row.ruleId) continue;
    const list = byRule.get(row.ruleId) ?? [];
    list.push(row);
    byRule.set(row.ruleId, list);
  }
  const ruleIds = new Set(rules.map((rule) => rule.id));

  const activeRules: RuleReport[] = [];
  for (const rule of rules.filter((r) => r.enabled === 1)) {
    const own = byRule.get(rule.id) ?? [];
    const report: RuleReport = {
      ruleId: rule.id,
      accountId: rule.accountId,
      sourceAccountId: rule.sourceAccountId,
      targetPausedNow: rule.needsReconnect === 1,
      sourcePausedNow: rule.sourceNeedsReconnect === 1,
      lastSuccessAt: null,
      sinceSuccessMs: null,
      lastRun: null,
      runs: 0,
      dryRuns: 0,
      failedRuns: 0,
      partialRuns: 0,
      failures: [],
      aborts: [],
      duplicateSuspicions: [],
      createdAt: null,
      notCovered: false,
      notCoveredReason: null,
    };
    let previousDuplicates: string | null = null;
    for (const row of own) {
      const detail = parseDetail(row.detail);
      if (row.kind === "sync_run") {
        const dryRun = detail.dryRun === true;
        const line: RunLine = {
          at: row.createdAt,
          failed: num(detail.failed),
          remaining: num(detail.remaining),
          duplicates: num(detail.duplicates),
          dryRun,
        };
        report.lastRun = line;
        if (dryRun) {
          report.dryRuns += 1;
          continue;
        }
        report.runs += 1;
        if (line.failed > 0) report.failedRuns += 1;
        else if (line.remaining > 0) report.partialRuns += 1;
        if (line.failed > 0 || line.remaining > 0) {
          // A retry after a partial failure shows duplicates by design. It breaks the chain.
          previousDuplicates = null;
          continue;
        }
        report.lastSuccessAt = row.createdAt;
        if (line.duplicates > 0) {
          if (previousDuplicates) {
            report.duplicateSuspicions.push({
              at: row.createdAt,
              previousAt: previousDuplicates,
              gapMs: Date.parse(row.createdAt) - Date.parse(previousDuplicates),
            });
          }
          previousDuplicates = row.createdAt;
        } else {
          previousDuplicates = null;
        }
      } else if (row.kind === "sync_failed") {
        const code = safeCode(detail.code);
        report.failures.push({ at: row.createdAt, code, form: classifyErrorCode(code).form });
      } else if (row.kind === "sync_run_aborted") {
        report.aborts.push(row.createdAt);
      } else if (row.kind === "rule_created") {
        report.createdAt = row.createdAt;
      }
    }
    if (report.lastSuccessAt) {
      report.sinceSuccessMs = nowMs - Date.parse(report.lastSuccessAt);
    } else {
      report.notCovered = true;
      report.notCoveredReason =
        report.runs > 0 ? "no_successful_run" : report.dryRuns > 0 ? "only_dry_runs" : "no_runs";
    }
    activeRules.push(report);
  }

  // Account pauses: pair each `account_paused` with the next `account_resumed` of the account.
  const pauses: AccountPause[] = [];
  const open = new Map<string, AccountPause>();
  for (const row of rows) {
    if (!row.accountId) continue;
    const detail = parseDetail(row.detail);
    if (row.kind === "account_paused") {
      if (open.has(row.accountId)) continue; // a repeat of the same pause
      const pause: AccountPause = {
        accountId: row.accountId,
        pausedAt: row.createdAt,
        code: safeCode(detail.code),
        resumedAt: null,
        pausedMs: null,
        long: nowMs - Date.parse(row.createdAt) > LONG_PAUSE_MS,
      };
      open.set(row.accountId, pause);
      pauses.push(pause);
    } else if (row.kind === "account_resumed") {
      const pause = open.get(row.accountId);
      if (!pause) {
        // The pause began before the period. Only the resume is known.
        const pausedMs = num(detail.pausedMs);
        pauses.push({
          accountId: row.accountId,
          pausedAt: "before period",
          code: safeCode(detail.code),
          resumedAt: row.createdAt,
          pausedMs: pausedMs > 0 ? pausedMs : null,
          long: pausedMs > LONG_PAUSE_MS,
        });
        continue;
      }
      pause.resumedAt = row.createdAt;
      const stored = num(detail.pausedMs);
      pause.pausedMs = stored > 0 ? stored : Date.parse(row.createdAt) - Date.parse(pause.pausedAt);
      pause.long = pause.pausedMs > LONG_PAUSE_MS;
      open.delete(row.accountId);
    }
  }

  const alerts: Report["alerts"] = [];
  const compares: CompareLine[] = [];
  const unknown = new Map<string, { kind: string; count: number; lastAt: string }>();
  let rowsOfUnknownRules = 0;
  for (const row of rows) {
    if (row.ruleId && !ruleIds.has(row.ruleId) && KNOWN_RELEVANT.has(row.kind)) {
      rowsOfUnknownRules += 1;
    }
    const detail = parseDetail(row.detail);
    if (row.kind === "alert_sent") {
      alerts.push({ at: row.createdAt, ruleId: row.ruleId, code: safeCode(detail.code) });
    } else if (row.kind === "compare_run") {
      compares.push({
        at: row.createdAt,
        kind: "compare_run",
        calendarRef: shortRef(detail.calendarId),
        mode: safeCode(detail.mode),
        deviations: typeof detail.deviations === "number" ? detail.deviations : null,
        cleared: typeof detail.cleared === "number" ? detail.cleared : null,
        rounds: typeof detail.rounds === "number" ? detail.rounds : null,
        clean: typeof detail.clean === "boolean" ? detail.clean : null,
        code: null,
      });
    } else if (row.kind === "compare_failed") {
      compares.push({
        at: row.createdAt,
        kind: "compare_failed",
        calendarRef: shortRef(detail.calendarId),
        mode: safeCode(detail.mode),
        deviations: null,
        cleared: null,
        rounds: null,
        clean: null,
        code: safeCode(detail.code),
      });
    } else if (!KNOWN_RELEVANT.has(row.kind) && !KNOWN_IGNORED.has(row.kind)) {
      const key = safeCode(row.kind);
      const entry = unknown.get(key) ?? { kind: key, count: 0, lastAt: row.createdAt };
      entry.count += 1;
      entry.lastAt = row.createdAt;
      unknown.set(key, entry);
    }
  }

  return {
    sinceMs,
    nowMs,
    coveredFromMs,
    auditRows: rows.length,
    auditTruncated: input.auditTruncated,
    activeRules,
    inactiveRules: rules.filter((r) => r.enabled !== 1).length,
    pauses,
    alerts,
    compares,
    unknownKinds: [...unknown.values()],
    rowsOfUnknownRules,
  };
}

// ---------------------------------------------------------------------------------------------
// Text out

function age(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} d`;
}

/** Plain text. No verdict: a line states what the rows hold, and what they cannot tell. */
export function formatReport(report: Report): string {
  const out: string[] = [];
  const { sinceMs, nowMs } = report;
  out.push(`Trial report at ${new Date(nowMs).toISOString()}`);
  out.push(
    `Period asked: ${new Date(sinceMs).toISOString()} to now. Audit rows read: ${report.auditRows}.`,
  );
  if (report.auditTruncated) {
    out.push(
      `The audit read hit its row limit. Rows are complete only from ` +
        `${new Date(report.coveredFromMs).toISOString()}.`,
    );
  }
  out.push("");
  out.push(`Active rules: ${report.activeRules.length} (inactive: ${report.inactiveRules})`);
  for (const rule of report.activeRules) {
    const parts: string[] = [];
    if (rule.lastSuccessAt && rule.sinceSuccessMs !== null) {
      const quiet = rule.sinceSuccessMs > QUIET_AFTER_MS ? ", over 3 h" : "";
      parts.push(
        `last successful run ${rule.lastSuccessAt} (${age(rule.sinceSuccessMs)} ago${quiet})`,
      );
    } else {
      const from = new Date(report.coveredFromMs).toISOString();
      const created = rule.createdAt ? `; rule created ${rule.createdAt}` : "";
      const reason = {
        no_runs: `no run of this rule since ${from}; a longer --since may show one`,
        only_dry_runs: `only dry runs since ${from}, ${rule.dryRuns} of them`,
        no_successful_run: `${rule.runs} runs since ${from}, none with failed = 0 and remaining = 0`,
      }[rule.notCoveredReason ?? "no_runs"];
      parts.push(`the period does not cover a successful run: ${reason}${created}`);
    }
    if (rule.targetPausedNow) parts.push(`target account ${rule.accountId} paused now`);
    if (rule.sourcePausedNow) parts.push(`source account ${rule.sourceAccountId} paused now`);
    out.push(`- rule ${rule.ruleId} (account ${rule.accountId}): ${parts.join("; ")}`);
    out.push(
      `    runs ${rule.runs}, with failed actions ${rule.failedRuns}, ` +
        `with remaining ${rule.partialRuns}, dry runs ${rule.dryRuns}, ` +
        `sync_failed ${rule.failures.length}, aborted ${rule.aborts.length}`,
    );
    if (rule.lastRun) {
      const run = rule.lastRun;
      out.push(
        `    newest run ${run.at}: failed ${run.failed}, remaining ${run.remaining}, ` +
          `duplicates ${run.duplicates}${run.dryRun ? ", dry run" : ""}`,
      );
    }
    for (const pair of rule.duplicateSuspicions) {
      out.push(
        `    suspicion: two successful runs in a row with duplicates > 0, ${pair.previousAt} and ` +
          `${pair.at} (${age(pair.gapMs)} apart)`,
      );
    }
    for (const failure of rule.failures) {
      out.push(`    sync_failed ${failure.at}: ${failure.code} [${failure.form}]`);
    }
    for (const at of rule.aborts) out.push(`    aborted run: ${at}`);
  }

  out.push("");
  out.push(`Account pauses in the period: ${report.pauses.length}`);
  for (const pause of report.pauses) {
    const end = pause.resumedAt
      ? `resumed ${pause.resumedAt} after ${pause.pausedMs === null ? "?" : age(pause.pausedMs)}`
      : `still open, ${age(report.nowMs - Date.parse(pause.pausedAt))}`;
    out.push(
      `- account ${pause.accountId}: paused ${pause.pausedAt} (${pause.code}), ${end}` +
        `${pause.long ? ", over 24 h" : ""}`,
    );
  }

  out.push("");
  out.push(`Alerts sent: ${report.alerts.length}`);
  for (const alert of report.alerts) {
    out.push(`- ${alert.at} ${alert.code}${alert.ruleId ? ` rule ${alert.ruleId}` : ""}`);
  }

  out.push("");
  out.push(`Comparisons: ${report.compares.length}`);
  for (const c of report.compares) {
    if (c.kind === "compare_failed") {
      out.push(`- ${c.at} compare_failed ${c.mode} calendar ${c.calendarRef}: ${c.code}`);
    } else {
      out.push(
        `- ${c.at} compare_run ${c.mode} calendar ${c.calendarRef}: deviations ${c.deviations ?? "?"}, ` +
          `cleared ${c.cleared ?? "?"}, rounds ${c.rounds ?? "?"}, clean ${c.clean ?? "?"}`,
      );
    }
  }

  out.push("");
  out.push(`Unknown audit codes: ${report.unknownKinds.length}`);
  for (const u of report.unknownKinds) {
    out.push(`- ${u.kind}: ${u.count} rows, newest ${u.lastAt}`);
  }
  if (report.rowsOfUnknownRules > 0) {
    out.push("");
    out.push(`Rows of rules that no longer exist: ${report.rowsOfUnknownRules}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Orchestration with an injected executor

/** Runs `wrangler d1 execute` with these arguments and returns its stdout. */
export type Exec = (args: string[]) => string;

export interface Options {
  /** Database name or binding in the wrangler config. */
  database: string;
  remote: boolean;
  config?: string;
  sinceMs: number;
  nowMs: number;
  limit?: number;
}

/** The wrangler arguments of one read. Throws for anything but a SELECT. */
export function wranglerArgs(
  sql: string,
  options: Pick<Options, "database" | "remote" | "config">,
) {
  const args = [
    "d1",
    "execute",
    options.database,
    options.remote ? "--remote" : "--local",
    "--json",
    "--command",
    assertReadOnly(sql),
  ];
  if (options.config) args.push("--config", options.config);
  return args;
}

/** Wrangler prints `[{ results, success, meta }]`. Returns the rows of the first result. */
export function parseWranglerRows<T>(stdout: string): T[] {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error("wrangler returned no JSON");
  const parsed: unknown = JSON.parse(stdout.slice(start));
  const first = Array.isArray(parsed)
    ? (parsed[0] as { results?: unknown } | undefined)
    : undefined;
  if (!first || !Array.isArray(first.results)) throw new Error("wrangler returned no results");
  return first.results as T[];
}

/** Read both tables and evaluate. Sends two SELECT statements. */
export function collectReport(exec: Exec, options: Options): Report {
  const limit = options.limit ?? AUDIT_ROW_LIMIT;
  const rules = parseWranglerRows<RuleRow>(exec(wranglerArgs(RULES_SQL, options)));
  const audit = parseWranglerRows<AuditRow>(
    exec(wranglerArgs(auditSql(options.sinceMs, limit), options)),
  );
  return buildReport({
    rules,
    audit,
    sinceMs: options.sinceMs,
    nowMs: options.nowMs,
    auditTruncated: audit.length >= limit,
  });
}

/** `72h`, `7d`, `30m` or an ISO date. Returns the start of the period in Unix ms. */
export function parseSince(value: string, nowMs: number): number {
  const relative = /^(\d{1,4})([mhd])$/.exec(value);
  if (relative) {
    const unit = { m: 60_000, h: 3600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"];
    return nowMs - Number(relative[1]) * unit;
  }
  // A date or time without a zone counts as UTC, not as local time.
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(zoned ? value : `${value}Z`) : NaN;
  if (Number.isNaN(ms))
    throw new Error(`Cannot read --since "${value}". Use 72h, 7d or a date (UTC if no zone).`);
  return ms;
}

/** The value after `--name`. Throws if it is missing or looks like another flag. */
export function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}
