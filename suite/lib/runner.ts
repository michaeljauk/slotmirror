import { evaluate, type Evaluation, type Interval, type ResolvedExpectation } from "./coverage.ts";
import {
  UnsupportedScenario,
  type CalendarChange,
  type CalendarSide,
  type EventFields,
  type Expectation,
  type Manifest,
  type ResolvedEvent,
  type Scenario,
  type Step,
  SuiteAbort,
  type SuiteDriver,
} from "./scenario.ts";
import {
  dateOf,
  instantOf,
  localMidnight,
  resolveAnchors,
  resolveTime,
  type Anchors,
} from "./time.ts";

const DEFAULT_TIMEOUT_SECONDS = 900;
const DEFAULT_DAYS_AHEAD = 30;
/** The plan's sample size per direction. */
const LATENCY_SAMPLES = 20;
const DAY_MS = 86_400_000;

export type Status = "pass" | "fail" | "not_run";

export interface IntervalText {
  start: string;
  end: string;
}

export interface Availability {
  window: IntervalText;
  busy: IntervalText[];
}

/**
 * The target state of a check. A data check has no target state for times, so its `busy` is null:
 * an empty list would read as "free", next to an `observed` that is busy.
 */
export interface ExpectedAvailability {
  window: IntervalText;
  busy: IntervalText[] | null;
  checks: "times" | "data";
}

/** One run of a scenario in one direction. */
export interface DirectionRun {
  direction: string;
  status: Status;
  /**
   * True if an exception ended the run and no check of the target state failed. Such a run has the
   * status `fail`, but it says nothing about the scenario.
   */
  stopped: boolean;
  text: string;
  durationMs: number;
  /** The number of the step that stopped the run, from 1. Null for a run to its end. */
  failedStep: number | null;
  expected: ExpectedAvailability | null;
  observed: Availability | null;
}

/** One scenario over all its directions, the row of the result page. */
export interface ScenarioResult {
  id: string;
  title: string;
  covers: string;
  status: Status;
  /** True if an exception ended the run of any direction. */
  stopped: boolean;
  expectedText: string;
  /** What this result cannot show, on simulated calendars. Null on real calendars. */
  local_limit: string | null;
  expected: ExpectedAvailability | null;
  observed: Availability | null;
  text: string;
  durationMs: number;
  failedStep: number | null;
  directions: DirectionRun[];
}

export interface LatencyResult {
  mode: "real-time" | "simulated-clock";
  /** Samples per direction, timeouts included. */
  samplesPerDirection: Record<string, number>;
  /** Samples that reached the time limit. They count as the limit, which is a lower bound. */
  timedOut: number;
  /** True if a sample timed out or a direction lacks samples. */
  incomplete: boolean;
  /** The grid of the samples: a value can be this much too high. Null without polling. */
  pollMs: number | null;
  /** Null on simulated calendars: a value there is no measurement of delay. */
  p50Ms: number | null;
  p95Ms: number | null;
  /** The self-test of the runner on simulated calendars. Null on real calendars. */
  selfTestMs: { p50: number | null; p95: number | null } | null;
}

export interface SuiteResult {
  suiteVersion: string;
  frozenAt: string;
  commit: string;
  /** True if tracked files differ from `commit`. */
  dirty: boolean;
  /** SHA-256 over the files of the version folder. */
  listHash: string;
  runAt: string;
  driver: {
    name: string;
    mode: "real-time" | "simulated-clock";
    /** `adapter`: an outside program stated the mode, and the suite did not verify it. */
    modeSource: "driver" | "adapter";
    /** The IDs that `--allow-foreign` named. The checks do not see these entries. */
    allowForeign: number;
  };
  scope: "all" | "selected";
  summary: Record<Status, number>;
  scenarios: ScenarioResult[];
  latency: LatencyResult | null;
}

function text(interval: Interval): IntervalText {
  return {
    start: new Date(interval[0]).toISOString(),
    end: new Date(interval[1]).toISOString(),
  };
}

export function resolveExpectation(
  expectation: Expectation,
  scenario: Scenario,
  anchors: Anchors,
): ResolvedExpectation & { calendar: CalendarSide } {
  const calendar = expectation.calendar ?? "target";
  const zone = scenario.calendars[calendar].timeZone;
  const timed = expectation.busy?.map(([start, end]): Interval => [
    instantOf(start, anchors),
    instantOf(end, anchors),
  ]);
  const dates = expectation.busyDates?.map(([start, end]): Interval => [
    localMidnight(dateOf(start, anchors), zone),
    localMidnight(dateOf(end, anchors), zone),
  ]);
  const checksCoverage = timed !== undefined || dates !== undefined;
  return {
    calendar,
    zone,
    window: [instantOf(expectation.window[0], anchors), instantOf(expectation.window[1], anchors)],
    busy: checksCoverage ? [...(timed ?? []), ...(dates ?? [])] : null,
    noDuplicates: expectation.noDuplicates ?? false,
    forbidden: expectation.forbidden ?? [],
    required: expectation.required ?? [],
    minEntries: expectation.minEntries ?? 0,
  };
}

function resolveEvent(event: EventFields, anchors: Anchors): ResolvedEvent {
  const { start, end, timeZone, ...fields } = event;
  return {
    ...fields,
    ...(start === undefined ? {} : { start: resolveTime(start, anchors, timeZone) }),
    ...(end === undefined ? {} : { end: resolveTime(end, anchors, timeZone) }),
  };
}

function describe(interval: Interval): string {
  const { start, end } = text(interval);
  return `${start} to ${end}`;
}

/** The first failure of an evaluation as one line. */
function failureText(evaluation: Evaluation, expectation: ResolvedExpectation): string {
  const parts = [
    ...evaluation.missing.map((part) => `free but must be busy: ${describe(part)}`),
    ...evaluation.extra.map((part) => `busy but must be free: ${describe(part)}`),
    ...evaluation.duplicates.map((part) => `duplicate entries: ${describe(part)}`),
    ...evaluation.leaks.map((value) => `forbidden text found: ${value}`),
    ...evaluation.absent.map((value) => `required text not found: ${value}`),
  ];
  if (evaluation.entries < expectation.minEntries) {
    parts.push(`${evaluation.entries} entries, at least ${expectation.minEntries} expected`);
  }
  return parts.join("; ");
}

class ScenarioFailure extends Error {}

/** The latest time of the events of a scenario, the last occurrence of a series included. */
function latestEventTime(scenario: Scenario, anchors: Anchors): number {
  const instants = scenario.steps.flatMap((step) => {
    if (step.do !== "write" || !step.event) return [];
    const { start, end, repeat } = step.event;
    const span = repeat ? (repeat.count - 1) * (repeat.every === "week" ? 7 : 1) * DAY_MS : 0;
    return [start, end].flatMap((time) => {
      if (time === undefined) return [];
      const resolved = resolveTime(time, anchors, "UTC");
      return [Date.parse("date" in resolved ? resolved.date : `${resolved.dateTime}Z`) + span];
    });
  });
  return Math.max(0, ...instants);
}

/**
 * True if the events of a scenario lie behind the sync window of the rule on this run date. The
 * window ends `daysAhead` days after the UTC day of the run, or of the last `advance`: a scenario
 * can wait for the window to reach an event.
 */
function isBehindWindow(scenario: Scenario, anchors: Anchors, now: number): boolean {
  const advances = scenario.steps.flatMap((step) =>
    step.do === "advance" ? [instantOf(step.to, anchors)] : [],
  );
  const day = Math.floor(Math.max(now, ...advances) / DAY_MS) * DAY_MS;
  const end = day + (scenario.rule?.daysAhead ?? DEFAULT_DAYS_AHEAD) * DAY_MS;
  return latestEventTime(scenario, anchors) >= end;
}

/** Run one scenario in one direction. It never throws: a failure is a result. */
export async function runScenario(
  scenario: Scenario,
  driver: SuiteDriver,
  direction: string,
): Promise<DirectionRun> {
  const run: DirectionRun = {
    direction,
    status: "pass",
    stopped: false,
    text: "",
    durationMs: 0,
    failedStep: null,
    expected: null,
    observed: null,
  };
  const missing = (scenario.requires ?? []).filter((need) => !driver.capabilities.has(need));
  if (missing.length > 0) {
    return { ...run, status: "not_run", text: `The driver offers no ${missing.join(", ")}.` };
  }
  const startedAt = performance.now();
  try {
    await driver.prepare({ scenario, direction });
    const anchors = resolveAnchors(driver.now(), scenario.anchorZone);
    if (isBehindWindow(scenario, anchors, driver.now())) {
      return {
        ...run,
        status: "not_run",
        text: "The events of this scenario lie behind the sync window on this run date.",
      };
    }
    const context: StepContext = { scenario, driver, anchors, run };
    for (const [index, step] of scenario.steps.entries()) {
      run.failedStep = index + 1;
      await runStep(step, context);
    }
    run.failedStep = null;
    run.text ||= "As expected.";
  } catch (error) {
    if (error instanceof SuiteAbort) throw error;
    if (error instanceof UnsupportedScenario) {
      run.status = "not_run";
      run.failedStep = null;
      run.text = error.message;
    } else {
      run.status = "fail";
      run.stopped = !(error instanceof ScenarioFailure);
      const failure = run.stopped ? "The run stopped: " : "";
      run.text = `${failure}${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    run.durationMs = Math.round(performance.now() - startedAt);
    await driver.cleanup();
  }
  return run;
}

interface StepContext {
  scenario: Scenario;
  driver: SuiteDriver;
  anchors: Anchors;
  run: DirectionRun;
}

async function check(
  expectation: Expectation,
  { scenario, driver, anchors }: StepContext,
): Promise<{ resolved: ResolvedExpectation; evaluation: Evaluation }> {
  const resolved = resolveExpectation(expectation, scenario, anchors);
  const entries = await driver.read(resolved.calendar, {
    start: new Date(resolved.window[0]).toISOString(),
    end: new Date(resolved.window[1]).toISOString(),
  });
  return { resolved, evaluation: evaluate(resolved, entries) };
}

function record(
  context: StepContext,
  { resolved, evaluation }: Awaited<ReturnType<typeof check>>,
): void {
  const window = text(resolved.window);
  context.run.expected = {
    window,
    busy: resolved.busy?.map(text) ?? null,
    checks: resolved.busy ? "times" : "data",
  };
  context.run.observed = { window, busy: evaluation.observedBusy.map(text) };
  if (!evaluation.pass) throw new ScenarioFailure(failureText(evaluation, resolved));
}

/**
 * A count that is no count would pass every comparison of a call step. The tool did nothing wrong,
 * so this is no failed scenario: the run cannot go on.
 */
function callCount(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new SuiteAbort(`The driver gave no call count, but ${String(value)}.`);
}

async function runStep(step: Step, context: StepContext): Promise<void> {
  const { driver, anchors } = context;
  switch (step.do) {
    case "write": {
      const change: CalendarChange = {
        change: step.change,
        key: step.key,
        ...(step.occurrence === undefined ? {} : { occurrence: step.occurrence }),
        ...(step.event ? { event: resolveEvent(step.event, anchors) } : {}),
      };
      await driver.write(step.calendar ?? "source", change);
      return;
    }
    case "sync": {
      const visible = await driver.waitForSync({
        until: async () => (await check(step.expect, context)).evaluation.pass,
        timeoutSeconds: step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      });
      if (visible && step.settleSeconds) {
        await driver.waitForSync({ timeoutSeconds: step.settleSeconds });
      }
      record(context, await check(step.expect, context));
      return;
    }
    case "expect":
      record(context, await check(step, context));
      return;
    case "control":
      if (!driver.control) throw new UnsupportedScenario("The driver has no controls.");
      await driver.control(step);
      return;
    case "wait-for-fault": {
      if (!driver.faultsFired) throw new UnsupportedScenario("The driver cannot watch faults.");
      const fired = await driver.waitForSync({
        until: async () => (await driver.faultsFired?.()) === true,
        timeoutSeconds: step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      });
      if (!fired) throw new ScenarioFailure("The tool never ran into the injected fault.");
      return;
    }
    case "expect-no-calls":
    case "expect-calls": {
      if (!driver.providerCalls) throw new UnsupportedScenario("The driver counts no calls.");
      const before = callCount(await driver.providerCalls(step.calendar));
      await driver.waitForSync({ timeoutSeconds: step.seconds });
      const calls = callCount(await driver.providerCalls(step.calendar)) - before;
      if (calls < 0) throw new SuiteAbort("The call count of the driver fell during a wait.");
      if (step.do === "expect-no-calls" && calls > 0) {
        throw new ScenarioFailure(`${calls} calls during the ${step.seconds} s of required quiet.`);
      }
      if (step.do === "expect-calls" && calls === 0) {
        throw new ScenarioFailure(`No call in the ${step.seconds} s in which a cycle must run.`);
      }
      return;
    }
    case "advance":
      if (!driver.advance) throw new UnsupportedScenario("The driver cannot move the clock.");
      await driver.advance(instantOf(step.to, anchors));
      return;
  }
}

/** No run is no pass. */
function worst(statuses: Status[]): Status {
  if (statuses.includes("fail")) return "fail";
  return statuses.length === 0 || statuses.includes("not_run") ? "not_run" : "pass";
}

/** One row per scenario. The first run that failed speaks for the row. */
function summarize(scenario: Scenario, runs: DirectionRun[], driver: SuiteDriver): ScenarioResult {
  const status = worst(runs.map((run) => run.status));
  const lead = runs.find((run) => run.status === status) ?? runs[0];
  return {
    id: scenario.id,
    title: scenario.title,
    covers: scenario.covers,
    status,
    stopped: runs.some((run) => run.stopped),
    expectedText: scenario.expectedText,
    local_limit: driver.mode === "simulated-clock" ? (scenario.localLimit ?? null) : null,
    expected: lead?.expected ?? null,
    observed: lead?.observed ?? null,
    text: lead?.text ?? "The driver offers no direction.",
    durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
    failedStep: lead?.failedStep ?? null,
    directions: runs,
  };
}

/** The value below which `share` of the sorted samples lie, by the nearest-rank method. */
export function percentile(samples: readonly number[], share: number): number | null {
  if (samples.length === 0) return null;
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.ceil(share * sorted.length) - 1] ?? null;
}

const LATENCY_SCENARIO: Pick<Scenario, "id" | "calendars" | "rule"> = {
  id: "latency-sample",
  calendars: { source: { timeZone: "UTC" }, target: { timeZone: "UTC" } },
  rule: {},
};

interface LatencySamples {
  values: number[];
  timedOut: number;
}

/**
 * `LATENCY_SAMPLES` single creates, each measured from the write until the target shows it. They
 * start tomorrow, one per day, so that all of them lie inside the default sync window. A sample
 * that times out counts as the limit, so that a slow tool does not look fast.
 */
async function sampleLatency(driver: SuiteDriver, direction: string): Promise<LatencySamples> {
  await driver.prepare({ scenario: LATENCY_SCENARIO, direction });
  const samples: LatencySamples = { values: [], timedOut: 0 };
  try {
    const first = (resolveAnchors(driver.now()).today as number) + DAY_MS;
    for (let index = 0; index < LATENCY_SAMPLES; index++) {
      const start = first + index * DAY_MS + 9 * 3_600_000;
      const event = (time: number) => ({
        dateTime: new Date(time).toISOString().slice(0, 19),
        timeZone: "UTC",
      });
      await driver.write("source", {
        change: "create",
        key: `sample-${index}`,
        event: { start: event(start), end: event(start + 1_800_000) },
      });
      const writtenAt = driver.now();
      const window = {
        start: new Date(start).toISOString(),
        end: new Date(start + 1_800_000).toISOString(),
      };
      const visible = await driver.waitForSync({
        timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        until: async () => {
          const expectation = {
            window: [start, start + 1_800_000] as const,
            busy: [[start, start + 1_800_000] as const],
            noDuplicates: false,
            forbidden: [],
            required: [],
            minEntries: 0,
            zone: "UTC",
          };
          return evaluate(expectation, await driver.read("target", window)).pass;
        },
      });
      samples.values.push(visible ? driver.now() - writtenAt : DEFAULT_TIMEOUT_SECONDS * 1000);
      if (!visible) samples.timedOut += 1;
    }
  } finally {
    await driver.cleanup();
  }
  return samples;
}

export interface SuiteOptions {
  /** Run only this scenario, without the latency sample. */
  scenarioId?: string;
  commit: string;
  dirty: boolean;
  listHash: string;
  runAt: string;
  /** Called after each scenario, for progress output. */
  onResult?: (result: ScenarioResult) => void;
}

function latencyOf(driver: SuiteDriver, samples: Record<string, LatencySamples>): LatencyResult {
  const lists = Object.values(samples);
  const all = lists.flatMap((list) => list.values);
  const timedOut = lists.reduce((sum, list) => sum + list.timedOut, 0);
  const p50 = percentile(all, 0.5);
  const p95 = percentile(all, 0.95);
  const real = driver.mode === "real-time";
  return {
    mode: driver.mode,
    samplesPerDirection: Object.fromEntries(
      Object.entries(samples).map(([direction, list]) => [direction, list.values.length]),
    ),
    timedOut,
    incomplete:
      timedOut > 0 ||
      lists.length === 0 ||
      lists.some((list) => list.values.length < LATENCY_SAMPLES),
    pollMs: driver.pollMs ?? null,
    p50Ms: real ? p50 : null,
    p95Ms: real ? p95 : null,
    selfTestMs: real ? null : { p50, p95 },
  };
}

/** 0 only for a run with at least one passed scenario and no failed one. */
export function exitCode({ summary }: Pick<SuiteResult, "summary">): number {
  return summary.pass > 0 && summary.fail === 0 ? 0 : 1;
}

export async function runSuite(
  manifest: Manifest,
  scenarios: Scenario[],
  driver: SuiteDriver,
  options: SuiteOptions,
): Promise<SuiteResult> {
  const selected = scenarios.filter(
    (scenario) => !options.scenarioId || scenario.id === options.scenarioId,
  );
  if (selected.length === 0) throw new Error(`Unknown scenario: ${options.scenarioId}`);
  const results: ScenarioResult[] = [];
  for (const scenario of selected) {
    const runs: DirectionRun[] = [];
    for (const direction of driver.directions) {
      runs.push(await runScenario(scenario, driver, direction));
    }
    const result = summarize(scenario, runs, driver);
    results.push(result);
    options.onResult?.(result);
  }
  let latency: LatencyResult | null = null;
  if (!options.scenarioId) {
    const samples: Record<string, LatencySamples> = {};
    for (const direction of driver.directions) {
      samples[direction] = await sampleLatency(driver, direction);
    }
    latency = latencyOf(driver, samples);
  }
  const count = (status: Status) => results.filter((result) => result.status === status).length;
  return {
    suiteVersion: manifest.version,
    frozenAt: manifest.frozenAt,
    commit: options.commit,
    dirty: options.dirty,
    listHash: options.listHash,
    runAt: options.runAt,
    driver: {
      name: driver.name,
      mode: driver.mode,
      modeSource: driver.modeSource ?? "driver",
      allowForeign: driver.allowForeign ?? 0,
    },
    scope: options.scenarioId ? "selected" : "all",
    summary: { pass: count("pass"), fail: count("fail"), not_run: count("not_run") },
    scenarios: results,
    latency,
  };
}
