// Pure helpers for the suite page and for its test. No Astro imports, so that Vitest can load it.

export type Status = "pass" | "fail" | "not_run";
export type Interval = { start: string; end: string };
export type Observation = { window: Interval; busy: Interval[] | null };

export type ScenarioResult = {
  id: string;
  title: string;
  covers: string;
  status: Status;
  stopped: boolean;
  expectedText: string;
  local_limit: string | null;
  expected: (Observation & { checks: string }) | null;
  observed: Observation | null;
  text: string;
  durationMs: number;
  failedStep: number | null;
  directions: DirectionResult[];
};

export type DirectionResult = {
  direction: string;
  status: Status;
  stopped: boolean;
  text: string;
  failedStep: number | null;
  expected: ScenarioResult["expected"];
  observed: Observation | null;
};

export type SuiteResult = {
  suiteVersion: string;
  frozenAt: string;
  commit: string;
  dirty: boolean;
  listHash: string;
  runAt: string;
  driver: { name: string; mode: string; modeSource: string; allowForeign: number };
  scope: string;
  summary: { pass: number; fail: number; not_run: number };
  scenarios: ScenarioResult[];
  latency: {
    mode: string;
    samplesPerDirection: Record<string, number>;
    timedOut: number;
    incomplete: boolean;
    pollMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
  } | null;
};

export type Manifest = { suite: string; version: string; frozenAt: string; scenarios: string[] };
export type KnownRed = { id: string; reason: string; issue: string; step: number };

export function countStatuses(scenarios: ScenarioResult[]): SuiteResult["summary"] {
  const counts = { pass: 0, fail: 0, not_run: 0 };
  for (const scenario of scenarios) counts[scenario.status] += 1;
  return counts;
}

// Only a run in real time against an outside adapter counts as live. The local driver is never
// live, whatever its mode field says.
export function isLiveRun(result: SuiteResult): boolean {
  return (
    result.driver.mode === "real-time" &&
    result.driver.modeSource === "adapter" &&
    result.driver.name !== "local" &&
    result.latency?.mode === "real-time"
  );
}

// Latency counts as real only if the run is live, no sample is missing or timed out, and both
// percentiles exist. Anything else shows no latency.
export function realLatency(result: SuiteResult) {
  const latency = result.latency;
  if (!isLiveRun(result) || !latency) return null;
  if (latency.incomplete || latency.timedOut > 0) return null;
  if (latency.p50Ms === null || latency.p95Ms === null) return null;
  return { ...latency, p50Ms: latency.p50Ms, p95Ms: latency.p95Ms };
}

const STATUSES = ["pass", "fail", "not_run"];
const MODES = ["real-time", "simulated-clock"];

function worst(statuses: Status[]): Status {
  if (statuses.includes("fail")) return "fail";
  return statuses.length === 0 || statuses.includes("not_run") ? "not_run" : "pass";
}

/**
 * Problems of form and of consistency inside the result file. The build stops on any of them: the
 * page must claim nothing that the file does not show. `listHash` is the hash of the folder
 * `suite/v1` as it is now. Pass null to skip that check.
 */
export function shapeProblems(
  result: SuiteResult,
  manifest: Manifest,
  listHash: string | null,
): string[] {
  const problems: string[] = [];
  const add = (message: string) => problems.push(message);
  const run = result as Partial<SuiteResult>;
  if (!run.driver || !Array.isArray(run.scenarios) || !run.summary) {
    return ["The result has no driver, scenarios or summary."];
  }
  const { driver, latency } = result;
  if (!MODES.includes(driver.mode)) add(`driver.mode "${driver.mode}" is unknown`);
  if (!["driver", "adapter"].includes(driver.modeSource)) add("driver.modeSource is unknown");
  if (!driver.name) add("driver.name is missing");
  if (
    driver.name === "local" &&
    (driver.mode !== "simulated-clock" || driver.modeSource !== "driver")
  ) {
    add("The local driver must run in simulated-clock mode with modeSource driver");
  }
  if (driver.modeSource === "adapter" && driver.name === "local") {
    add("modeSource adapter does not fit the driver name local");
  }
  if (driver.modeSource === "driver" && driver.mode === "real-time" && driver.name !== "live") {
    add("A real-time run without an adapter is not known");
  }
  if (result.scope !== "all" && result.scope !== "selected")
    add(`scope "${result.scope}" is unknown`);
  if (result.suiteVersion !== manifest.version) add("suiteVersion differs from the manifest");
  if (result.frozenAt !== manifest.frozenAt) add("frozenAt differs from the manifest");
  if (!/^[0-9a-f]{40}$/.test(result.commit)) add("commit is not a full SHA");
  if (listHash !== null && result.listHash !== listHash) {
    add("listHash differs from the folder suite/v1: the scenario files changed after the run");
  }
  if (result.scope === "all" && latency === null)
    add("latency is missing in a run of all scenarios");
  if (latency) {
    if (latency.mode !== driver.mode) {
      add(`latency.mode "${latency.mode}" differs from driver.mode "${driver.mode}"`);
    }
    if (latency.mode === "simulated-clock" && (latency.p50Ms !== null || latency.p95Ms !== null)) {
      add("A simulated clock must not give p50Ms or p95Ms");
    }
  }

  const ids = result.scenarios.map((scenario) => scenario.id);
  const expectedIds =
    result.scope === "all"
      ? manifest.scenarios
      : manifest.scenarios.filter((id) => ids.includes(id));
  if (ids.join() !== expectedIds.join()) {
    add("The scenarios differ from the manifest in set or order, or one is listed twice");
  }
  const counts = countStatuses(result.scenarios);
  if (JSON.stringify(counts) !== JSON.stringify(result.summary)) {
    add(
      `summary ${JSON.stringify(result.summary)} differs from the table ${JSON.stringify(counts)}`,
    );
  }

  for (const scenario of result.scenarios) {
    const at = (message: string) => add(`${scenario.id}: ${message}`);
    if (!STATUSES.includes(scenario.status)) {
      at(`status "${scenario.status}" is unknown`);
      continue;
    }
    if (!Array.isArray(scenario.directions)) {
      at("directions is missing");
      continue;
    }
    if (scenario.expected === undefined) at("expected is missing");
    if (scenario.observed === undefined) at("observed is missing");
    if (typeof scenario.text !== "string") at("text is missing");
    for (const direction of scenario.directions) {
      if (!STATUSES.includes(direction.status))
        at(`direction status "${direction.status}" is unknown`);
      if (direction.expected === undefined) at(`${direction.direction}: expected is missing`);
      if (direction.status === "pass" && direction.text !== "As expected.") {
        at(`${direction.direction} passed with the text "${direction.text}"`);
      }
      if (direction.status === "fail" && direction.text === "As expected.") {
        at(`${direction.direction} failed with the text "As expected."`);
      }
      if (direction.status === "fail" && direction.failedStep === null) {
        at(`${direction.direction} failed without a failedStep`);
      }
      if (direction.status !== "fail" && direction.stopped && direction.status !== "not_run") {
        at(`${direction.direction} passed but is marked stopped`);
      }
    }
    if (worst(scenario.directions.map((direction) => direction.status)) !== scenario.status) {
      at(`status "${scenario.status}" does not fit its directions`);
    }
    if (scenario.status === "pass" && (scenario.text !== "As expected." || scenario.stopped)) {
      at("passed with a text or a stop that says otherwise");
    }
    if (scenario.status === "pass" && scenario.failedStep !== null) at("passed with a failedStep");
    if (
      scenario.status === "fail" &&
      (scenario.text === "As expected." || scenario.failedStep === null)
    ) {
      at("failed without a reason or a failedStep");
    }
    if (scenario.status === "fail" && !scenario.directions.some((d) => d.status === "fail")) {
      at("failed but no direction failed");
    }
    if (scenario.status === "pass" && (!scenario.expected || !scenario.observed)) {
      at("passed without an expected and an observed state");
    }
  }
  return problems;
}

/**
 * Problems between the result and the list of known red scenarios. The page shows a red scenario as
 * known only if none of these applies. The test and `pnpm suite:published` stop on any of them.
 */
export function knownRedMismatches(
  result: SuiteResult,
  known: KnownRed[],
  manifest: Manifest,
): string[] {
  const problems: string[] = [];
  for (const entry of known) {
    if (!manifest.scenarios.includes(entry.id)) problems.push(`${entry.id}: not in the manifest`);
  }
  for (const scenario of result.scenarios) {
    const entry = known.find((item) => item.id === scenario.id);
    const failed = (scenario.directions ?? []).filter((direction) => direction.status === "fail");
    if (scenario.status === "fail" && !entry)
      problems.push(`${scenario.id}: red, not on the known list`);
    if (!entry) continue;
    if (scenario.status === "pass") problems.push(`${scenario.id}: on the known list but passes`);
    for (const direction of failed) {
      if (direction.stopped) problems.push(`${scenario.id}: stopped by an error, not a known red`);
      else if (direction.failedStep !== entry.step) {
        problems.push(
          `${scenario.id}: red in step ${String(direction.failedStep)}, known in step ${entry.step}`,
        );
      }
    }
  }
  return problems;
}

/** True if the page may call this red row known. */
export function isKnownRed(scenario: ScenarioResult, entry: KnownRed | undefined): boolean {
  if (!entry || scenario.status !== "fail") return false;
  const failed = scenario.directions.filter((direction) => direction.status === "fail");
  return failed.length > 0 && failed.every((d) => !d.stopped && d.failedStep === entry.step);
}

export function assertShape(result: SuiteResult, manifest: Manifest, listHash: string | null) {
  const problems = shapeProblems(result, manifest, listHash);
  if (problems.length > 0) {
    throw new Error(`The suite result file is not valid:\n- ${problems.join("\n- ")}`);
  }
}

export function formatSeconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

// "2026-10-30T23:38:29.079Z" -> "2026-10-30 23:38 UTC"
export function formatInstant(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function formatInterval({ start, end }: Interval): string {
  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  return sameDay
    ? `${start.slice(0, 10)} ${start.slice(11, 16)} to ${end.slice(11, 16)} UTC`
    : `${formatInstant(start)} to ${formatInstant(end)}`;
}

export function describeBusy(state: Observation | null, checks?: string): string[] {
  if (!state || !state.busy) return [];
  const intervals = state.busy;
  if (checks === "data") {
    return [`Content check on ${intervals.length} target entries (text, not times)`];
  }
  if (intervals.length === 0) return ["Free in the whole window"];
  return intervals.map((interval) => `Busy ${formatInterval(interval)}`);
}

export function describeExpected(scenario: ScenarioResult): string[] {
  const expected = scenario.expected;
  if (!expected) return [];
  if (expected.checks === "data" || !expected.busy) return [];
  return describeBusy(expected);
}

export type ObservedGroup = { label: string; lines: string[] };

const directionLabel = (names: string[]) =>
  names.map((name) => name[0]?.toUpperCase() + name.slice(1)).join(" and ");

// Directions with the same observed state and text form one group. A red direction is always named.
export function describeObserved(scenario: ScenarioResult): ObservedGroup[] {
  const groups = new Map<string, { names: string[]; run: DirectionResult }>();
  for (const run of scenario.directions) {
    const key = JSON.stringify([run.status, run.text, run.observed]);
    const group = groups.get(key);
    if (group) group.names.push(run.direction);
    else groups.set(key, { names: [run.direction], run });
  }
  return [...groups.values()].map(({ names, run }) => {
    const checks = run.expected?.checks;
    const lines = describeBusy(run.observed, checks);
    if (run.status === "fail" && checks === "data") lines.shift();
    if (run.status === "fail") lines.push(run.text);
    if (run.status === "not_run") lines.push(run.text);
    return { label: directionLabel(names), lines };
  });
}

export function statusText(scenario: ScenarioResult): string {
  if (scenario.status === "pass") return "Passed";
  if (scenario.status === "not_run") return "Not run";
  return scenario.stopped ? "Stopped by an error" : "Failed (red)";
}

export function issueUrl(repo: string, issue: string): string | null {
  const match = /^#?(\d+)$/.exec(issue.trim());
  return match ? `${repo}/issues/${match[1]}` : null;
}
