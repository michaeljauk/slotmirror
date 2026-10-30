/**
 * Logic of the capacity probe: the load profile, the checks before a run, the run itself and the
 * verdict per stage. No Node APIs. Network, time and output come in through `ProbeIo`, so that
 * tests run the whole flow inside the Workers runtime.
 */

/** Events per source calendar in the window. The run stops at the first stage that fails. */
export const STAGES = [1000, 2500, 5000, 10_000] as const;

/** Windows in days: the default window, then one run with the longest allowed window. */
export const WINDOWS = [90, 365] as const;

/** The fixed load profile. It is part of every result, so that a number never loses its context. */
export const PROFILE = {
  /** Three accounts in the block group make six rules, each with a target that holds mirrors. */
  accounts: 3,
  /** Native meetings per source calendar, spread over the window; the targets add mirrors. */
  eventsPerSource: "stage",
  provider: "simulated calendars (DEV_FAKE_CALENDARS=1)",
} as const;

/** Free plan: rows per day, for SQLite in Durable Objects. D1 has its own limit of the same size. */
export const DAILY_ROWS_WRITTEN = 100_000;
export const DAILY_ROWS_READ = 5_000_000;

/** Exit codes. `stageFailed` is a measurement; `broken` means that the run measured nothing. */
export const EXIT = { passed: 0, stageFailed: 1, usage: 2, refused: 3, broken: 4 } as const;

/** Rules in the block group: every account mirrors into every other. */
export function ruleCount(accounts: number): number {
  return accounts * (accounts - 1);
}

/** Mirrors that a stage must create: each source calendar into each of the other accounts. */
export function expectedBlocks(events: number, accounts: number): number {
  return events * ruleCount(accounts);
}

export interface ProbeOptions {
  target: string;
  cookie: string;
  windows: number[];
  stages: number[];
  accounts: number;
  /** Time without a new sync run before the stage counts as settled. */
  quietMs: number;
  /** Longest wait for a stage to settle. */
  timeoutMs: number;
  /** Rows written per day that the run may plan for. Zero turns the check off. */
  dailyRows: number;
  /** The last stage that passed on an earlier day, when a window spreads over several days. */
  passedBefore: number | null;
}

export type ParsedArgs = { ok: true; options: ProbeOptions } | { ok: false; message: string };

const DEFAULTS = { accounts: PROFILE.accounts, quietMs: 20_000, timeoutMs: 30 * 60_000 };

/** A failed status read does not end a stage at once; the Worker may be busy for a moment. */
const STATS_ATTEMPTS = 5;
const POLL_MS = 5000;

/** Parse `--name value` pairs. `--target` has no default: the probe never guesses an instance. */
export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): ParsedArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!name?.startsWith("--")) return { ok: false, message: `Unexpected argument: ${name}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `${name} needs a value` };
    }
    flags.set(name.slice(2), value);
    i++;
  }
  const known = [
    "target",
    "cookie",
    "window",
    "stages",
    "accounts",
    "quiet-s",
    "timeout-min",
    "daily-rows",
    "passed-before",
  ];
  for (const name of flags.keys()) {
    if (!known.includes(name)) return { ok: false, message: `Unknown option --${name}` };
  }

  const rawTarget = flags.get("target");
  if (!rawTarget) return { ok: false, message: "--target <url> is required" };
  const target = normalizeTarget(rawTarget);
  if (!target) return { ok: false, message: `--target is not an http(s) origin: ${rawTarget}` };

  const cookie = flags.get("cookie") ?? env["PROBE_COOKIE"];
  if (!cookie) {
    return { ok: false, message: "Pass the admin session cookie with --cookie or PROBE_COOKIE" };
  }

  const windows = parseNumbers(flags.get("window"), WINDOWS);
  if (!windows || windows.some((days) => !Number.isInteger(days) || days < 1 || days > 365)) {
    return { ok: false, message: "--window takes day counts from 1 to 365, comma separated" };
  }
  const stages = parseNumbers(flags.get("stages"), STAGES);
  if (!stages || stages.some((n) => !Number.isInteger(n) || n < 1 || n > 10_000)) {
    return { ok: false, message: "--stages takes event counts from 1 to 10000, comma separated" };
  }
  const accounts = Number(flags.get("accounts") ?? DEFAULTS.accounts);
  if (!Number.isInteger(accounts) || accounts < 2 || accounts > 20) {
    return { ok: false, message: "--accounts takes a number from 2 to 20" };
  }
  const quietS = Number(flags.get("quiet-s") ?? DEFAULTS.quietMs / 1000);
  const timeoutMin = Number(flags.get("timeout-min") ?? DEFAULTS.timeoutMs / 60_000);
  if (!(quietS > 0) || !(timeoutMin > 0)) {
    return { ok: false, message: "--quiet-s and --timeout-min must be positive" };
  }
  const dailyRows = Number(flags.get("daily-rows") ?? DAILY_ROWS_WRITTEN);
  if (!Number.isInteger(dailyRows) || dailyRows < 0) {
    return { ok: false, message: "--daily-rows takes a row count, 0 for no check" };
  }
  const rawPassed = flags.get("passed-before");
  const passedBefore = rawPassed === undefined ? null : Number(rawPassed);
  if (passedBefore !== null && (!Number.isInteger(passedBefore) || passedBefore < 1)) {
    return { ok: false, message: "--passed-before takes an event count" };
  }
  if (passedBefore !== null && windows.length !== 1) {
    return { ok: false, message: "--passed-before needs exactly one --window" };
  }
  return {
    ok: true,
    options: {
      target,
      cookie: cookie.replace(/^slotmirror_session=/, ""),
      windows,
      stages: [...stages].sort((a, b) => a - b),
      accounts,
      quietMs: quietS * 1000,
      timeoutMs: timeoutMin * 60_000,
      dailyRows,
      passedBefore,
    },
  };
}

function parseNumbers(raw: string | undefined, fallback: readonly number[]): number[] | null {
  if (raw === undefined) return [...fallback];
  const numbers = raw.split(",").map((part) => Number(part.trim()));
  return numbers.length > 0 && numbers.every((n) => Number.isFinite(n)) ? numbers : null;
}

/** Reduce a URL to its origin, or null if it is not http(s). */
export function normalizeTarget(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** What `GET /dev/probe` answers. */
export interface ProbeMarker {
  testInstance?: unknown;
  fakeCalendars?: unknown;
  realAccounts?: unknown;
  simulatedFetch?: unknown;
}

/**
 * The target must answer `GET /dev/probe` as a test instance. The route exists only with
 * DEV_FAKE_CALENDARS=1 and an admin session, so a production deployment answers 404. An instance
 * with an account that is not simulated answers 409.
 */
export function checkTestInstance(status: number, body: unknown): string | null {
  const marker = body as ProbeMarker | null;
  if (status === 409) {
    return `The target holds ${String(marker?.realAccounts)} accounts that are not simulated. The probe runs only on an instance without real accounts.`;
  }
  if (status !== 200) {
    return `The target is not a test instance: GET /dev/probe answered ${status}. The probe needs DEV_FAKE_CALENDARS=1 and an admin cookie.`;
  }
  if (marker?.testInstance !== true || marker.fakeCalendars !== true) {
    return "The target did not mark itself as a test instance.";
  }
  if (marker.simulatedFetch === "failed") {
    return "The target cannot reach DEV_FAKE_FETCH_URL. See scripts/README.md, section Fetch target.";
  }
  return null;
}

/** Why a run on this target cannot back a statement in `limits.md`, or null. */
export function limitsWarning(target: string, marker: ProbeMarker | null): string | null {
  const host = new URL(target).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    return "Local run: no Workers limit applies here. This proves the script, not a capacity.";
  }
  if (marker?.simulatedFetch !== "ok") {
    return "DEV_FAKE_FETCH_URL is not set: simulated calls make no subrequests, so the limit of 50 cannot trip.";
  }
  return null;
}

/** What one stage costs in SQLite rows of the Durable Objects. */
export interface StageCost {
  rowsWritten: number;
  rowsRead: number;
}

/** Writes per batch beside the blocks: the counter row and the storage of recent writes. */
const ROWS_PER_BATCH = 3;
/** Writes per alarm step: the queue, the alarm and the counter rows of the reads. */
const ROWS_PER_STEP = 12;
/** Rows of a reseed per account: the dropped tables and the new seed. */
const ROWS_PER_SEED = 40;
const BATCH_SIZE = 20;
const WRITES_PER_STEP = 500;

/**
 * An estimate from the profile. Every mirror is one row in the simulated calendar, where a real
 * provider would hold it. Reports show the rows that the simulation counted.
 */
export function stageCost(events: number, accounts: number): StageCost {
  const rules = ruleCount(accounts);
  const blocks = expectedBlocks(events, accounts);
  const batches = Math.ceil(events / BATCH_SIZE) * rules;
  const steps = Math.ceil(events / WRITES_PER_STEP) * rules;
  const written = blocks + batches * ROWS_PER_BATCH + steps * ROWS_PER_STEP;
  // Each step reads the target and, unless cached, the source. Both hold half the mirrors on average.
  const read = steps * events * (accounts - 1);
  return { rowsWritten: written + accounts * ROWS_PER_SEED, rowsRead: read };
}

export interface ProbeDay {
  windowDays: number;
  stages: number[];
  rowsWritten: number;
  rowsRead: number;
  /** A single stage that does not fit into one day of the Free plan. */
  overLimit: boolean;
}

/** Spread the stages over days, in run order, so that no day passes the limits. */
export function planDays(
  windows: readonly number[],
  stages: readonly number[],
  accounts: number,
  dailyRows: number,
): ProbeDay[] {
  const days: ProbeDay[] = [];
  for (const windowDays of windows) {
    for (const events of stages) {
      const cost = stageCost(events, accounts);
      const last = days.at(-1);
      if (
        last?.windowDays === windowDays &&
        last.rowsWritten + cost.rowsWritten <= dailyRows &&
        last.rowsRead + cost.rowsRead <= DAILY_ROWS_READ
      ) {
        last.stages.push(events);
        last.rowsWritten += cost.rowsWritten;
        last.rowsRead += cost.rowsRead;
        continue;
      }
      days.push({
        windowDays,
        stages: [events],
        ...cost,
        overLimit: cost.rowsWritten > dailyRows || cost.rowsRead > DAILY_ROWS_READ,
      });
    }
  }
  return days;
}

/** Whether a whole plan fits into one day. `planDays` keeps windows apart, so count the rows. */
export function fitsOneDay(days: readonly ProbeDay[], dailyRows: number): boolean {
  const written = days.reduce((sum, day) => sum + day.rowsWritten, 0);
  const read = days.reduce((sum, day) => sum + day.rowsRead, 0);
  return written <= dailyRows && read <= DAILY_ROWS_READ;
}

/** The plan as text: one command per day, with the row estimate. */
export function formatPlan(days: readonly ProbeDay[]): string {
  const lines = days.map((day, index) => {
    const rows = `${day.rowsWritten} rows written, ${day.rowsRead} rows read`;
    const limit = day.overLimit ? " OVER THE DAILY LIMIT" : "";
    return `Day ${index + 1}: --window ${day.windowDays} --stages ${day.stages.join(",")} (about ${rows}${limit})`;
  });
  return lines.join("\n");
}

/** What `POST /dev/seed` answers. */
interface Seeded {
  startedAt?: unknown;
}

/** What `GET /dev/stats` returns. */
export interface Stats {
  accounts: number;
  rules: number;
  ruleDays: { min: number | null; max: number | null };
  calls: Record<string, number>;
  blocks: number;
  rowsWritten: number;
  rowsRead: number;
  runs: number;
  writes: number | null;
  failedWrites: number | null;
  throttledWrites: number | null;
  sumStepMs: number | null;
  maxStepMs: number | null;
  lastRunAt: string | null;
  /** The last finished run per rule. A step that a limit stopped leaves no row. */
  lastRuns: { ruleId: string; failed: number; remaining: number }[];
  failedRuns: number;
}

/** How much work the instance has done; it grows with every provider call and every run. */
export function progressOf(stats: Stats): number {
  return Object.values(stats.calls).reduce((sum, n) => sum + n, stats.runs + stats.failedRuns);
}

/**
 * Whether the sync has gone quiet: `progress` did not change for `quietMs` and some work happened.
 * Provider calls count, so that one long step does not look like silence.
 */
export function isSettled(
  previous: { progress: number; changedAt: number },
  progress: number,
  now: number,
  quietMs: number,
): { state: { progress: number; changedAt: number }; settled: boolean } {
  const state = progress === previous.progress ? previous : { progress, changedAt: now };
  return { state, settled: progress > 0 && now - state.changedAt >= quietMs };
}

export interface StageResult {
  windowDays: number;
  events: number;
  accounts: number;
  rules: number;
  settled: boolean;
  durationMs: number;
  steps: number;
  writes: number;
  providerCalls: number;
  providerCallsByOperation: Record<string, number>;
  failedWrites: number;
  throttledWrites: number;
  failedRuns: number;
  /** Rules whose last run after the stage start has no failed and no remaining writes. */
  completeRules: number;
  blocks: number;
  expectedBlocks: number;
  maxStepMs: number;
  meanStepMs: number | null;
  /** Rows in the audit log for the stage: sync runs and failed runs. */
  auditRows: number;
  /** Rows of the simulation itself; a real provider costs none of them. */
  simRowsWritten: number;
  simRowsRead: number;
  /** Not measurable from outside the Worker. See the README for where to read it. */
  cpuMs: null;
}

export function summarizeStage(input: {
  windowDays: number;
  events: number;
  stats: Stats;
  settled: boolean;
  durationMs: number;
}): StageResult {
  const { stats } = input;
  const providerCalls = Object.values(stats.calls).reduce((sum, n) => sum + n, 0);
  return {
    windowDays: input.windowDays,
    events: input.events,
    accounts: stats.accounts,
    rules: stats.rules,
    settled: input.settled,
    durationMs: input.durationMs,
    steps: stats.runs,
    writes: stats.writes ?? 0,
    providerCalls,
    providerCallsByOperation: stats.calls,
    failedWrites: stats.failedWrites ?? 0,
    throttledWrites: stats.throttledWrites ?? 0,
    failedRuns: stats.failedRuns,
    completeRules: stats.lastRuns.filter((run) => run.failed === 0 && run.remaining === 0).length,
    blocks: stats.blocks,
    expectedBlocks: expectedBlocks(input.events, stats.accounts),
    maxStepMs: stats.maxStepMs ?? 0,
    meanStepMs: stats.runs > 0 ? Math.round((stats.sumStepMs ?? 0) / stats.runs) : null,
    auditRows: stats.runs + stats.failedRuns,
    simRowsWritten: stats.rowsWritten,
    simRowsRead: stats.rowsRead,
    cpuMs: null,
  };
}

/**
 * Reasons why a stage failed. An empty list means it passed: every rule has a finished run with
 * nothing failed and nothing left, and the calendars hold the mirrors that the profile expects.
 * Silence proves nothing: an alarm that a limit stopped writes no audit row.
 */
export function stageFailures(result: StageResult): string[] {
  const reasons: string[] = [];
  if (!result.settled) reasons.push("the sync did not settle before the timeout");
  if (result.failedRuns > 0) reasons.push(`${result.failedRuns} sync runs failed`);
  if (result.failedWrites > 0) reasons.push(`${result.failedWrites} writes failed`);
  if (result.steps === 0) reasons.push("no sync run happened");
  if (result.completeRules < result.rules) {
    reasons.push(`${result.completeRules} of ${result.rules} rules finished their work`);
  }
  if (result.blocks !== result.expectedBlocks) {
    reasons.push(`${result.blocks} blocks instead of ${result.expectedBlocks}`);
  }
  return reasons;
}

/** A difference from the load profile: the stage would measure something else. */
export function profileMismatch(stats: Stats, accounts: number, windowDays: number): string | null {
  if (stats.accounts !== accounts) {
    return `the instance has ${stats.accounts} simulated accounts instead of ${accounts}`;
  }
  if (stats.rules !== ruleCount(accounts)) {
    return `the instance has ${stats.rules} rules instead of ${ruleCount(accounts)}`;
  }
  if (stats.ruleDays.min !== windowDays || stats.ruleDays.max !== windowDays) {
    return `the rules have a window of ${stats.ruleDays.min} to ${stats.ruleDays.max} days instead of ${windowDays}`;
  }
  return null;
}

export interface WindowVerdict {
  windowDays: number;
  accounts: number;
  results: StageResult[];
  /** Set when a stage failed; the run for this window stopped there. */
  failedAt: { events: number; reasons: string[] } | null;
  /** Set when the run broke at this stage. The stage has no verdict. */
  brokenAt: { events: number; message: string } | null;
  /** The highest stage that passed before the first failure, or null if none did. */
  lastPassed: number | null;
}

/** Fold the results of one window, in stage order: stop at the first failing stage. */
export function judgeWindow(
  windowDays: number,
  accounts: number,
  results: readonly StageResult[],
  {
    brokenAt = null,
    passedBefore = null,
  }: {
    brokenAt?: WindowVerdict["brokenAt"];
    passedBefore?: number | null;
  } = {},
): WindowVerdict {
  const kept: StageResult[] = [];
  let lastPassed = passedBefore;
  for (const result of results) {
    kept.push(result);
    const reasons = stageFailures(result);
    if (reasons.length > 0) {
      return {
        windowDays,
        accounts,
        results: kept,
        failedAt: { events: result.events, reasons },
        brokenAt: null,
        lastPassed,
      };
    }
    lastPassed = result.events;
  }
  return { windowDays, accounts, results: kept, failedAt: null, brokenAt, lastPassed };
}

/** The sentence for `limits.md`: the stage before the first failure, and the profile. */
export function limitsStatement(verdict: WindowVerdict): string {
  const profile = `${verdict.accounts} accounts in the block group, ${verdict.windowDays}-day window, each target holding its native events plus the mirrors`;
  const next = verdict.failedAt
    ? ` The next stage (${verdict.failedAt.events}) failed.`
    : verdict.brokenAt
      ? ` The run broke at ${verdict.brokenAt.events}, so that stage has no verdict.`
      : "";
  if (verdict.lastPassed === null) return `No stage passed (${profile}).${next}`;
  return `Passed up to ${verdict.lastPassed} events per source calendar (${profile}).${next}`;
}

const MINUTE = 60_000;

function duration(ms: number): string {
  return ms >= MINUTE ? `${(ms / MINUTE).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
}

/** A Markdown report of the whole run. The caller adds the target and the date. */
export function formatReport(
  verdicts: readonly WindowVerdict[],
  notes: readonly string[] = [],
): string {
  const lines: string[] = notes.flatMap((note) => [`**${note}**`, ""]);
  for (const verdict of verdicts) {
    lines.push(`## Window ${verdict.windowDays} days`, "");
    lines.push(
      "| Events per source | Duration | Steps | Provider calls | Writes | Blocks | Failed | Throttled | Max step | Audit rows | Sim rows written | CPU |",
      "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const r of verdict.results) {
      lines.push(
        `| ${r.events} | ${duration(r.durationMs)} | ${r.steps} | ${r.providerCalls} | ${r.writes} | ${r.blocks} of ${r.expectedBlocks} | ${r.failedWrites + r.failedRuns} | ${r.throttledWrites} | ${r.maxStepMs} ms | ${r.auditRows} | ${r.simRowsWritten} | not measured |`,
      );
    }
    lines.push("");
    if (verdict.failedAt) {
      lines.push(
        `Stopped at ${verdict.failedAt.events}: ${verdict.failedAt.reasons.join("; ")}.`,
        "",
      );
    }
    if (verdict.brokenAt) {
      lines.push(`Broke at ${verdict.brokenAt.events}: ${verdict.brokenAt.message}.`, "");
    }
    lines.push(limitsStatement(verdict), "");
  }
  return lines.join("\n");
}

/** The outside world of a run. */
export interface ProbeIo {
  call(method: "GET" | "POST", path: string): Promise<{ status: number; body: unknown }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface ProbeOutcome {
  exitCode: number;
  /** Markdown for stdout; empty if the run did not start. */
  report: string;
  /** All windows, also those that a failure ended early. */
  verdicts: WindowVerdict[];
}

/** The run itself failed, so the stage has no verdict. It can still be a limit of the instance. */
class ProbeBroken extends Error {}

async function readStats(io: ProbeIo, since: string): Promise<Stats> {
  let last = "";
  for (let attempt = 0; attempt < STATS_ATTEMPTS; attempt++) {
    try {
      const { status, body } = await io.call(
        "GET",
        `/dev/stats?since=${encodeURIComponent(since)}`,
      );
      if (status === 200) return body as Stats;
      last = `GET /dev/stats answered ${status}`;
    } catch (error) {
      last = `GET /dev/stats failed: ${String(error)}`;
    }
    if (attempt + 1 < STATS_ATTEMPTS) await io.sleep(POLL_MS);
  }
  throw new ProbeBroken(last);
}

async function runStage(
  windowDays: number,
  events: number,
  options: ProbeOptions,
  io: ProbeIo,
): Promise<StageResult> {
  const seed = await io.call(
    "POST",
    `/dev/seed?accounts=${options.accounts}&events=${events}&days=${windowDays}`,
  );
  if (seed.status !== 200) throw new ProbeBroken(`POST /dev/seed answered ${seed.status}`);
  const since = (seed.body as Seeded | null)?.startedAt;
  if (typeof since !== "string") throw new ProbeBroken("POST /dev/seed named no start time");
  const started = io.now();
  const cycle = await io.call("POST", "/dev/cycle");
  if (cycle.status !== 200) throw new ProbeBroken(`POST /dev/cycle answered ${cycle.status}`);

  let latest = await readStats(io, since);
  const mismatch = profileMismatch(latest, options.accounts, windowDays);
  if (mismatch) throw new ProbeBroken(mismatch);

  let state = { progress: 0, changedAt: started };
  let settled = false;
  while (io.now() - started < options.timeoutMs) {
    await io.sleep(POLL_MS);
    latest = await readStats(io, since);
    const next = isSettled(state, progressOf(latest), io.now(), options.quietMs);
    state = next.state;
    if (next.settled) {
      settled = true;
      break;
    }
  }
  io.log(`  ${events} events: ${latest.runs} steps, ${settled ? "settled" : "timeout"}`);
  return summarizeStage({
    windowDays,
    events,
    stats: latest,
    settled,
    durationMs: settled ? state.changedAt - started : io.now() - started,
  });
}

/** Run the probe. Every failure after the start ends in a report with the stage before it. */
export async function runProbe(options: ProbeOptions, io: ProbeIo): Promise<ProbeOutcome> {
  const none = (exitCode: number) => ({ exitCode, report: "", verdicts: [] });
  const days = planDays(options.windows, options.stages, options.accounts, options.dailyRows);
  if (options.dailyRows > 0 && !fitsOneDay(days, options.dailyRows)) {
    io.log("This run does not fit into one day of the Free plan. Run one line per day:");
    io.log(formatPlan(days));
    io.log("Continue a window with --passed-before <last passed stage>. See scripts/README.md.");
    return none(EXIT.usage);
  }

  let marker: { status: number; body: unknown };
  try {
    marker = await io.call("GET", "/dev/probe");
  } catch (error) {
    const verdicts: WindowVerdict[] = [];
    const message = `GET /dev/probe failed: ${String(error)}`;
    return { exitCode: EXIT.broken, report: formatReport(verdicts, [message]), verdicts };
  }
  const refusal = checkTestInstance(marker.status, marker.body);
  if (refusal) {
    io.log(refusal);
    return none(EXIT.refused);
  }

  const verdicts: WindowVerdict[] = [];
  const notes: string[] = [];
  const warning = limitsWarning(options.target, marker.body as ProbeMarker | null);
  if (warning) notes.push(warning);
  for (const windowDays of options.windows) {
    io.log(`Window ${windowDays} days`);
    const results: StageResult[] = [];
    let brokenAt: WindowVerdict["brokenAt"] = null;
    for (const events of options.stages) {
      try {
        const result = await runStage(windowDays, events, options, io);
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.log(`  ${events} events: the run broke: ${message}`);
        brokenAt = { events, message };
        break;
      }
      // Stop at the first failing stage: the stage before it is the answer.
      if (stageFailures(results.at(-1) as StageResult).length > 0) break;
    }
    const verdict = judgeWindow(windowDays, options.accounts, results, {
      brokenAt,
      passedBefore: options.passedBefore,
    });
    verdicts.push(verdict);
    // Work that is still queued would run into the next window and falsify it.
    if (brokenAt || results.some((result) => !result.settled)) {
      const rest = options.windows.slice(options.windows.indexOf(windowDays) + 1);
      if (rest.length > 0) notes.push(`Not run: window ${rest.join(", ")} days.`);
      break;
    }
  }
  const exitCode = verdicts.some((verdict) => verdict.brokenAt)
    ? EXIT.broken
    : verdicts.some((verdict) => verdict.failedAt)
      ? EXIT.stageFailed
      : EXIT.passed;
  return { exitCode, report: formatReport(verdicts, notes), verdicts };
}
