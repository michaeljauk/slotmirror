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
  /** Events of one source account that change after the first sync of a stage. */
  burstEvents: 50,
  provider: "simulated calendars (DEV_FAKE_CALENDARS=1)",
} as const;

/** What a run on simulated calendars cannot state. See scripts/README.md. */
const NOT_MEASURED =
  "Graph and Google throttling, CPU time per invocation, D1 rows per day, more than one user";

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

/** Writes that a burst of `events` changes causes: one update per mirror of each event. */
export function expectedBurstWrites(events: number, accounts: number): number {
  return Math.min(events, PROFILE.burstEvents) * (accounts - 1);
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
  if (target.startsWith("http:") && !isLocalTarget(target)) {
    return { ok: false, message: "--target must use https: the probe sends a session cookie" };
  }

  const cookie = flags.get("cookie") ?? env["PROBE_COOKIE"];
  if (!cookie) {
    return { ok: false, message: "Set PROBE_COOKIE to the admin session cookie" };
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
  const sortedStages = [...stages].sort((a, b) => a - b);
  const rawPassed = flags.get("passed-before");
  const passedBefore = rawPassed === undefined ? null : Number(rawPassed);
  if (passedBefore !== null && (!Number.isInteger(passedBefore) || passedBefore < 1)) {
    return { ok: false, message: "--passed-before takes an event count" };
  }
  if (passedBefore !== null && windows.length !== 1) {
    return { ok: false, message: "--passed-before needs exactly one --window" };
  }
  const stageBelow = STAGES.filter((stage) => stage < (sortedStages[0] ?? 0)).at(-1);
  if (passedBefore !== null && passedBefore !== stageBelow) {
    return {
      ok: false,
      message: `--passed-before must be the stage below the first stage: ${stageBelow ?? "there is none"}`,
    };
  }
  return {
    ok: true,
    options: {
      target,
      cookie: cookie.replace(/^slotmirror_session=/, ""),
      windows,
      stages: sortedStages,
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

/** Local targets may use http, and no Workers limit applies to them. */
export function isLocalTarget(target: string): boolean {
  const host = new URL(target).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** What `GET /dev/probe` answers. */
export interface ProbeMarker {
  testInstance?: unknown;
  fakeCalendars?: unknown;
  realAccounts?: unknown;
  simulatedFetch?: unknown;
  /** `enforced`: the runtime refused a fetch before the 51st. `absent`: the 51st worked. */
  subrequestLimit?: unknown;
  fetches?: unknown;
}

/**
 * The target must answer `GET /dev/probe` as a test instance. The route exists only with
 * DEV_FAKE_CALENDARS=1 and an admin session, so a production deployment answers 404. An instance
 * with an account that is not simulated answers 409. A remote target must show the Free plan
 * limit: on the Paid plan the limit lies at 10,000 subrequests, so a run there proves nothing.
 */
export function checkTestInstance(status: number, body: unknown, target: string): string | null {
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
  if (marker.subrequestLimit === "absent" && !isLocalTarget(target)) {
    return "The target is not on the Workers Free plan: its 51st fetch in one request succeeded.";
  }
  return null;
}

/** Why a run on this target cannot back a statement in `limits.md`, or null. */
export function limitsWarning(target: string, marker: ProbeMarker | null): string | null {
  if (isLocalTarget(target)) {
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
/** Writes per alarm step: the queue, the alarm, the step counter and the counters of the reads. */
const ROWS_PER_STEP = 13;
/** Rows of a reseed per account: the dropped tables and the new seed. */
const ROWS_PER_SEED = 40;
/** The smaller limit of the two providers, so the estimate is an upper bound. */
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
  // The burst adds one more run per rule, and the updates of its mirrors.
  const steps = (Math.ceil(events / WRITES_PER_STEP) + 1) * rules;
  const burst = expectedBurstWrites(events, accounts);
  const written = blocks + burst + batches * ROWS_PER_BATCH + steps * ROWS_PER_STEP;
  // Each step reads the target and, unless cached, the source. Both hold half the mirrors on average.
  // The count at the end of a stage reads every block once.
  const read = steps * events * (accounts - 1) + blocks;
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
  /** Alarm steps that started a rule. A step that a limit stopped has no run. */
  startedSteps: number;
  /** Stored blocks per calendar; null unless the request asked for the count. */
  storedBlocks: number[] | null;
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

/** The second part of a stage: the changes after the first sync. */
export interface BurstResult {
  events: number;
  expectedWrites: number;
  writes: number;
  settled: boolean;
  /** Time from the change to the last provider call. */
  durationMs: number;
}

export interface StageResult {
  windowDays: number;
  events: number;
  /** Times to look up in Cloudflare; null outside a run. */
  startedAt: string | null;
  finishedAt: string | null;
  accounts: number;
  rules: number;
  settled: boolean;
  /** Convergence time: from the start of the stage to the last provider call. */
  durationMs: number;
  steps: number;
  startedSteps: number;
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
  storedBlocks: number[] | null;
  burst: BurstResult | null;
  maxStepMs: number;
  meanStepMs: number | null;
  /** Rows in the audit log for the stage: sync runs and failed runs. */
  auditRows: number;
  /** Rows of the simulation itself; a real provider costs none of them. */
  simRowsWritten: number;
  simRowsRead: number;
  /** Not measurable inside the Worker. The README names where to read it. */
  cpuMs: null;
}

export function summarizeStage(input: {
  windowDays: number;
  events: number;
  stats: Stats;
  settled: boolean;
  durationMs: number;
  burst?: BurstResult | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}): StageResult {
  const { stats } = input;
  const providerCalls = Object.values(stats.calls).reduce((sum, n) => sum + n, 0);
  return {
    windowDays: input.windowDays,
    events: input.events,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    accounts: stats.accounts,
    rules: stats.rules,
    settled: input.settled,
    durationMs: input.durationMs,
    steps: stats.runs,
    startedSteps: stats.startedSteps,
    writes: stats.writes ?? 0,
    providerCalls,
    providerCallsByOperation: stats.calls,
    failedWrites: stats.failedWrites ?? 0,
    throttledWrites: stats.throttledWrites ?? 0,
    failedRuns: stats.failedRuns,
    completeRules: stats.lastRuns.filter((run) => run.failed === 0 && run.remaining === 0).length,
    blocks: stats.blocks,
    expectedBlocks: expectedBlocks(input.events, stats.accounts),
    storedBlocks: stats.storedBlocks,
    burst: input.burst ?? null,
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
 * Silence proves nothing: an alarm that a limit stopped writes no audit row, and its retry can end
 * clean within the quiet time. So every step that started must have a finished run.
 */
export function stageFailures(result: StageResult): string[] {
  const reasons: string[] = [];
  if (!result.settled) reasons.push("the sync did not settle before the timeout");
  if (result.failedRuns > 0) reasons.push(`${result.failedRuns} sync runs failed`);
  if (result.failedWrites > 0) reasons.push(`${result.failedWrites} writes failed`);
  if (result.steps === 0) reasons.push("no sync run happened");
  const finished = result.steps + result.failedRuns;
  if (result.startedSteps !== finished) {
    reasons.push(`${result.startedSteps} alarm steps started, ${finished} runs finished`);
  }
  if (result.completeRules < result.rules) {
    reasons.push(`${result.completeRules} of ${result.rules} rules finished their work`);
  }
  if (result.blocks !== result.expectedBlocks) {
    reasons.push(`${result.blocks} blocks instead of ${result.expectedBlocks}`);
  }
  const perCalendar = result.expectedBlocks / result.accounts;
  const stored = result.storedBlocks;
  if (stored && (stored.length !== result.accounts || stored.some((n) => n !== perCalendar))) {
    reasons.push(`the calendars store ${stored.join(", ") || 0} blocks, not ${perCalendar} each`);
  }
  if (result.burst && !result.burst.settled) {
    reasons.push("the sync did not settle after the change burst");
  }
  if (result.burst && result.burst.writes !== result.burst.expectedWrites) {
    reasons.push(
      `${result.burst.writes} writes after the change burst instead of ${result.burst.expectedWrites}`,
    );
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
  /** The value of `--passed-before`, which this run did not measure. */
  passedBefore: number | null;
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
        passedBefore,
      };
    }
    lastPassed = result.events;
  }
  return {
    windowDays,
    accounts,
    results: kept,
    failedAt: null,
    brokenAt,
    lastPassed,
    passedBefore,
  };
}

/**
 * The sentence for `limits.md`: the stage before the first failure, the profile and what the run
 * did not cover. A warning means that the run backs no statement, so it replaces the sentence.
 */
export function limitsStatement(verdict: WindowVerdict, warnings: readonly string[] = []): string {
  if (warnings.length > 0) return `No statement for limits.md: ${warnings.join(" ")}`;
  const profile = `${verdict.accounts} accounts in the block group, ${verdict.windowDays}-day window, each target holding its native events plus the mirrors, ${PROFILE.burstEvents} changed events, ${PROFILE.provider}`;
  const next = verdict.failedAt
    ? ` The next stage (${verdict.failedAt.events}) failed.`
    : verdict.brokenAt
      ? ` The run broke at ${verdict.brokenAt.events}, so that stage has no verdict.`
      : "";
  const gaps = ` Not measured: ${NOT_MEASURED}.`;
  if (verdict.lastPassed === null) return `No stage passed (${profile}).${next}${gaps}`;
  const earlier =
    verdict.lastPassed === verdict.passedBefore ? ", from an earlier run, not this one" : "";
  return `Passed up to ${verdict.lastPassed} events per source calendar${earlier} (${profile}).${next}${gaps}`;
}

/** What `GET /dev/rpc-budget` answers, with the conclusion. */
export interface RpcCheck {
  rpcCalls: number;
  baseline: { state: string; fetches: number };
  mixed: { state: string; fetches: number };
  result: "counted" | "not counted" | "unclear";
}

/** RPC counts if the calls take their number of fetches away; it does not if they take none. */
export function judgeRpc(body: Omit<RpcCheck, "result">): RpcCheck {
  const lost = body.baseline.fetches - body.mixed.fetches;
  const limited = body.baseline.state === "limited" && body.mixed.state === "limited";
  const result =
    limited && lost === body.rpcCalls
      ? "counted"
      : limited && lost === 0
        ? "not counted"
        : "unclear";
  return { ...body, result };
}

function rpcLine(check: RpcCheck): string {
  return `Cross-Durable-Object RPC as a subrequest: ${check.result}. ${check.baseline.fetches} fetches alone, ${check.mixed.fetches} fetches after ${check.rpcCalls} RPC calls.`;
}

const MINUTE = 60_000;

function duration(ms: number): string {
  return ms >= MINUTE ? `${(ms / MINUTE).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
}

function burstCell(burst: BurstResult | null): string {
  if (!burst) return "not run";
  const time = burst.settled ? duration(burst.durationMs) : "no end";
  return `${burst.events} events, ${burst.writes} of ${burst.expectedWrites} writes, ${time}`;
}

/** A Markdown report of the whole run. The caller adds the target and the date. */
export function formatReport(
  verdicts: readonly WindowVerdict[],
  notes: readonly string[] = [],
  { warnings = [], rpc = null }: { warnings?: readonly string[]; rpc?: RpcCheck | null } = {},
): string {
  const lines: string[] = [...warnings, ...notes].flatMap((note) => [`**${note}**`, ""]);
  if (rpc) lines.push(rpcLine(rpc), "");
  for (const verdict of verdicts) {
    lines.push(`## Window ${verdict.windowDays} days`, "");
    lines.push(
      "| Events per source | Convergence | Steps (started) | Provider calls | Writes | Blocks | Failed | Throttled | Max step | Audit rows | Sim rows written | Change burst | CPU |",
      "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    );
    for (const r of verdict.results) {
      lines.push(
        `| ${r.events} | ${duration(r.durationMs)} | ${r.steps} (${r.startedSteps}) | ${r.providerCalls} | ${r.writes} | ${r.blocks} of ${r.expectedBlocks} | ${r.failedWrites + r.failedRuns} | ${r.throttledWrites} | ${r.maxStepMs} ms | ${r.auditRows} | ${r.simRowsWritten} | ${burstCell(r.burst)} | not measured |`,
      );
    }
    lines.push("");
    const timed = verdict.results.filter((r) => r.startedAt);
    if (timed.length > 0) {
      lines.push("Times for the manual readings (scripts/README.md):", "");
      for (const r of timed) lines.push(`- ${r.events}: ${r.startedAt} to ${r.finishedAt}`);
      lines.push("");
    }
    if (verdict.passedBefore !== null) {
      lines.push(
        `Stage ${verdict.passedBefore} comes from --passed-before, not from this run.`,
        "",
      );
    }
    if (verdict.failedAt) {
      lines.push(
        `Stopped at ${verdict.failedAt.events}: ${verdict.failedAt.reasons.join("; ")}.`,
        "",
      );
    }
    if (verdict.brokenAt) {
      lines.push(`Broke at ${verdict.brokenAt.events}: ${verdict.brokenAt.message}.`, "");
    }
    lines.push(limitsStatement(verdict, warnings), "");
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
  /** Why this run backs no statement in `limits.md`. */
  warnings: string[];
  /** Null if the check could not run. */
  rpc: RpcCheck | null;
}

/** The run itself failed, so the stage has no verdict. It can still be a limit of the instance. */
class ProbeBroken extends Error {}

async function readStats(io: ProbeIo, since: string, countBlocks = false): Promise<Stats> {
  const count = countBlocks ? "&count=1" : "";
  let last = "";
  for (let attempt = 0; attempt < STATS_ATTEMPTS; attempt++) {
    try {
      const { status, body } = await io.call(
        "GET",
        `/dev/stats?since=${encodeURIComponent(since)}${count}`,
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

/** Poll until the sync is quiet. `baseline` is the progress before this work started. */
async function waitSettled(
  io: ProbeIo,
  since: string,
  options: ProbeOptions,
  { baseline, started }: { baseline: number; started: number },
): Promise<{ stats: Stats; settled: boolean; durationMs: number }> {
  let stats = await readStats(io, since);
  let state = { progress: 0, changedAt: started };
  while (io.now() - started < options.timeoutMs) {
    await io.sleep(POLL_MS);
    stats = await readStats(io, since);
    const next = isSettled(state, progressOf(stats) - baseline, io.now(), options.quietMs);
    state = next.state;
    if (next.settled) {
      return { stats, settled: true, durationMs: state.changedAt - started };
    }
  }
  return { stats, settled: false, durationMs: io.now() - started };
}

/** One `POST` that must answer 200 and name a start time. */
async function startWork(io: ProbeIo, path: string): Promise<string> {
  const name = path.split("?")[0] ?? path;
  const response = await io.call("POST", path);
  if (response.status !== 200) throw new ProbeBroken(`POST ${name} answered ${response.status}`);
  const since = (response.body as Seeded | null)?.startedAt;
  if (typeof since !== "string") throw new ProbeBroken(`POST ${name} named no start time`);
  return since;
}

async function startCycle(io: ProbeIo): Promise<void> {
  const cycle = await io.call("POST", "/dev/cycle");
  if (cycle.status !== 200) throw new ProbeBroken(`POST /dev/cycle answered ${cycle.status}`);
}

/** Change events of one account after the first sync, and wait until their mirrors follow. */
async function runBurst(events: number, options: ProbeOptions, io: ProbeIo): Promise<BurstResult> {
  const burstEvents = Math.min(events, PROFILE.burstEvents);
  const since = await startWork(io, `/dev/burst?events=${burstEvents}`);
  const baseline = progressOf(await readStats(io, since));
  const started = io.now();
  await startCycle(io);
  const wait = { baseline, started };
  const { stats, settled, durationMs } = await waitSettled(io, since, options, wait);
  return {
    events: burstEvents,
    expectedWrites: expectedBurstWrites(events, options.accounts),
    writes: stats.writes ?? 0,
    settled,
    durationMs,
  };
}

async function runStage(
  windowDays: number,
  events: number,
  options: ProbeOptions,
  io: ProbeIo,
): Promise<StageResult> {
  const since = await startWork(
    io,
    `/dev/seed?accounts=${options.accounts}&events=${events}&days=${windowDays}`,
  );
  const started = io.now();
  await startCycle(io);

  const mismatch = profileMismatch(await readStats(io, since), options.accounts, windowDays);
  if (mismatch) throw new ProbeBroken(mismatch);

  const first = await waitSettled(io, since, options, { baseline: 0, started });
  io.log(`  ${events} events: ${first.stats.runs} steps, ${first.settled ? "settled" : "timeout"}`);
  const summarize = (stats: Stats, burst: BurstResult | null) =>
    summarizeStage({
      windowDays,
      events,
      stats,
      settled: first.settled,
      durationMs: first.durationMs,
      burst,
      startedAt: since,
      finishedAt: new Date(io.now()).toISOString(),
    });
  const synced = summarize(first.stats, null);
  if (stageFailures(synced).length > 0) return synced;

  const burst = await runBurst(events, options, io);
  io.log(`  ${burst.events} changes: ${burst.writes} writes`);
  return summarize(await readStats(io, since, true), burst);
}

/** Whether work may still be queued, which would run into the next window. */
function leftWork(result: StageResult): boolean {
  return !result.settled || result.burst?.settled === false;
}

/** The RPC check. It runs once and never ends a run: without it, one number is missing. */
async function checkRpc(io: ProbeIo, notes: string[]): Promise<RpcCheck | null> {
  try {
    const { status, body } = await io.call("GET", "/dev/rpc-budget");
    if (status === 200) return judgeRpc(body as Omit<RpcCheck, "result">);
    notes.push(`The RPC check did not run: GET /dev/rpc-budget answered ${status}.`);
  } catch (error) {
    notes.push(`The RPC check did not run: ${String(error)}.`);
  }
  return null;
}

/** Run the probe. Every failure after the start ends in a report with the stage before it. */
export async function runProbe(options: ProbeOptions, io: ProbeIo): Promise<ProbeOutcome> {
  const none = (exitCode: number) => ({
    exitCode,
    report: "",
    verdicts: [],
    warnings: [],
    rpc: null,
  });
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
    const message = `GET /dev/probe failed: ${String(error)}`;
    return { ...none(EXIT.broken), report: formatReport([], [message]) };
  }
  const refusal = checkTestInstance(marker.status, marker.body, options.target);
  if (refusal) {
    io.log(refusal);
    return none(EXIT.refused);
  }

  const verdicts: WindowVerdict[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const probeMarker = marker.body as ProbeMarker | null;
  const warning = limitsWarning(options.target, probeMarker);
  if (warning) warnings.push(warning);
  const rpc = probeMarker?.simulatedFetch === "ok" ? await checkRpc(io, notes) : null;
  if (rpc && rpc.baseline.state !== "limited" && !isLocalTarget(options.target)) {
    warnings.push("A Durable Object showed no subrequest limit, so this run tests no limit of 50.");
  }
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
    if (brokenAt || results.some(leftWork)) {
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
  return {
    exitCode,
    report: formatReport(verdicts, notes, { warnings, rpc }),
    verdicts,
    warnings,
    rpc,
  };
}
