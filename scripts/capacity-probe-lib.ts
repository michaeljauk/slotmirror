/**
 * Pure logic of the capacity probe: the load profile, the checks before a run, and the verdict
 * per stage. No Node APIs and no network, so that tests run it inside the Workers runtime.
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
}

export type ParsedArgs = { ok: true; options: ProbeOptions } | { ok: false; message: string };

const DEFAULTS = { accounts: PROFILE.accounts, quietMs: 20_000, timeoutMs: 30 * 60_000 };

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
  const known = ["target", "cookie", "window", "stages", "accounts", "quiet-s", "timeout-min"];
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

/**
 * The target must answer `GET /dev/probe` as a test instance. The route exists only with
 * DEV_FAKE_CALENDARS=1 and an admin session, so a production deployment answers 404.
 */
export function checkTestInstance(status: number, body: unknown): string | null {
  if (status !== 200) {
    return `The target is not a test instance: GET /dev/probe answered ${status}. The probe needs DEV_FAKE_CALENDARS=1 and an admin cookie.`;
  }
  const marker = body as { testInstance?: unknown; fakeCalendars?: unknown } | null;
  if (marker?.testInstance !== true || marker.fakeCalendars !== true) {
    return "The target did not mark itself as a test instance.";
  }
  return null;
}

/** What `GET /dev/stats` returns. */
export interface Stats {
  accounts: number;
  rules: number;
  calls: Record<string, number>;
  runs: number;
  writes: number | null;
  failedWrites: number | null;
  throttledWrites: number | null;
  sumStepMs: number | null;
  maxStepMs: number | null;
  lastRunAt: string | null;
  failedRuns: number;
}

/**
 * Whether the sync has gone quiet: the number of runs did not change for `quietMs` and at least
 * one run happened.
 */
export function isSettled(
  previous: { runs: number; changedAt: number },
  runs: number,
  now: number,
  quietMs: number,
): { state: { runs: number; changedAt: number }; settled: boolean } {
  const state = runs === previous.runs ? previous : { runs, changedAt: now };
  return { state, settled: runs > 0 && now - state.changedAt >= quietMs };
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
  maxStepMs: number;
  meanStepMs: number | null;
  /** Rows in the audit log for the stage: sync runs and failed runs. */
  auditRows: number;
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
    maxStepMs: stats.maxStepMs ?? 0,
    meanStepMs: stats.runs > 0 ? Math.round((stats.sumStepMs ?? 0) / stats.runs) : null,
    auditRows: stats.runs + stats.failedRuns,
    cpuMs: null,
  };
}

/** Reasons why a stage failed. An empty list means it passed. */
export function stageFailures(result: StageResult): string[] {
  const reasons: string[] = [];
  if (!result.settled) reasons.push("the sync did not settle before the timeout");
  if (result.failedRuns > 0) reasons.push(`${result.failedRuns} sync runs failed`);
  if (result.failedWrites > 0) reasons.push(`${result.failedWrites} writes failed`);
  if (result.steps === 0) reasons.push("no sync run happened");
  return reasons;
}

export interface WindowVerdict {
  windowDays: number;
  results: StageResult[];
  /** Set when a stage failed; the run for this window stopped there. */
  failedAt: { events: number; reasons: string[] } | null;
  /** The highest stage that passed before the first failure, or null if none did. */
  lastPassed: number | null;
}

/** Fold the results of one window, in stage order: stop at the first failing stage. */
export function judgeWindow(windowDays: number, results: readonly StageResult[]): WindowVerdict {
  const kept: StageResult[] = [];
  let lastPassed: number | null = null;
  for (const result of results) {
    kept.push(result);
    const reasons = stageFailures(result);
    if (reasons.length > 0) {
      return {
        windowDays,
        results: kept,
        failedAt: { events: result.events, reasons },
        lastPassed,
      };
    }
    lastPassed = result.events;
  }
  return { windowDays, results: kept, failedAt: null, lastPassed };
}

/** The sentence for `limits.md`: the stage before the first failure, and the profile. */
export function limitsStatement(verdict: WindowVerdict): string {
  const profile = `${PROFILE.accounts} accounts in the block group, ${verdict.windowDays}-day window, each target holding its native events plus the mirrors`;
  if (verdict.lastPassed === null) {
    return `No stage passed (${profile}). The first stage failed.`;
  }
  const next = verdict.failedAt ? ` The next stage (${verdict.failedAt.events}) failed.` : "";
  return `Passed up to ${verdict.lastPassed} events per source calendar (${profile}).${next}`;
}

const MINUTE = 60_000;

function duration(ms: number): string {
  return ms >= MINUTE ? `${(ms / MINUTE).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
}

/** A Markdown report of the whole run. The caller adds the target and the date. */
export function formatReport(verdicts: readonly WindowVerdict[]): string {
  const lines: string[] = [];
  for (const verdict of verdicts) {
    lines.push(`## Window ${verdict.windowDays} days`, "");
    lines.push(
      "| Events per source | Duration | Steps | Provider calls | Writes | Failed | Throttled | Max step | Audit rows | CPU |",
      "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const r of verdict.results) {
      lines.push(
        `| ${r.events} | ${duration(r.durationMs)} | ${r.steps} | ${r.providerCalls} | ${r.writes} | ${r.failedWrites + r.failedRuns} | ${r.throttledWrites} | ${r.maxStepMs} ms | ${r.auditRows} | not measured |`,
      );
    }
    lines.push("");
    if (verdict.failedAt) {
      lines.push(
        `Stopped at ${verdict.failedAt.events}: ${verdict.failedAt.reasons.join("; ")}.`,
        "",
      );
    }
    lines.push(limitsStatement(verdict), "");
  }
  return lines.join("\n");
}
