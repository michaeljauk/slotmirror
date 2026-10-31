import { expectationFaults } from "./coverage.ts";
import { resolveExpectation } from "./runner.ts";
import {
  CAPABILITIES,
  type Expectation,
  type Manifest,
  type Scenario,
  type Step,
} from "./scenario.ts";
import { isTimeExpression, resolveAnchors } from "./time.ts";

/** Any date resolves the expressions of a target state. A run repeats the check on its own date. */
const REFERENCE_DATE = Date.UTC(2031, 1, 3, 9, 15);

/** The problems of a scenario file. An empty list means that the runner can read it. */
export function scenarioProblems(scenario: Scenario): string[] {
  const problems: string[] = [];
  const time = (value: string | undefined, where: string) => {
    if (value !== undefined && !isTimeExpression(value)) {
      problems.push(`${where}: invalid time ${value}`);
    }
  };
  const pairs = (list: [string, string][] | undefined, where: string) => {
    for (const [start, end] of list ?? []) {
      time(start, where);
      time(end, where);
    }
  };
  const expectation = (expect: Expectation, where: string) => {
    time(expect.window[0], where);
    time(expect.window[1], where);
    pairs(expect.busy, where);
    pairs(expect.busyDates, where);
    for (const value of [...(expect.required ?? []), ...(expect.forbidden ?? [])]) {
      if (!value.trim()) problems.push(`${where}: an empty text checks nothing`);
    }
    const checks =
      expect.busy !== undefined ||
      expect.busyDates !== undefined ||
      (expect.forbidden !== undefined && (expect.minEntries ?? 0) > 0);
    if (!checks && !expect.required?.length) {
      problems.push(`${where}: the expectation checks nothing`);
    }
    if (expect.window.every(isTimeExpression)) targetState(expect, where);
  };
  const targetState = (expect: Expectation, where: string) => {
    try {
      const anchors = resolveAnchors(REFERENCE_DATE, scenario.anchorZone);
      const { window, busy } = resolveExpectation(expect, scenario, anchors);
      problems.push(...expectationFaults(window, busy).map((fault) => `${where}: ${fault}`));
    } catch (error) {
      problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const key of ["id", "title", "covers", "expectedText"] as const) {
    if (!scenario[key]) problems.push(`missing ${key}`);
  }
  for (const capability of scenario.requires ?? []) {
    if (!CAPABILITIES.includes(capability)) problems.push(`unknown capability ${capability}`);
  }
  scenario.steps.forEach((step: Step, index) => {
    const where = `step ${index + 1}`;
    if (step.do === "write") {
      time(step.event?.start, where);
      time(step.event?.end, where);
      if (step.change === "create" && (!step.event?.start || !step.event.end)) {
        problems.push(`${where}: a create needs start and end`);
      }
    } else if (step.do === "sync") {
      expectation(step.expect, where);
    } else if (step.do === "expect") {
      expectation(step, where);
    } else if (step.do === "advance") {
      time(step.to, where);
    }
  });
  if (!scenario.steps.some((step) => step.do === "sync" || step.do === "expect")) {
    problems.push("the scenario checks nothing");
  }
  return problems;
}

export function manifestProblems(manifest: Manifest, scenarios: Scenario[]): string[] {
  const problems = scenarios.flatMap((scenario) =>
    scenarioProblems(scenario).map((problem) => `${scenario.id}: ${problem}`),
  );
  const ids = new Set(scenarios.map((scenario) => scenario.id));
  for (const id of manifest.scenarios) {
    if (!ids.has(id)) problems.push(`${id}: listed but has no file`);
  }
  for (const id of ids) {
    if (!manifest.scenarios.includes(id)) problems.push(`${id}: has a file but is not listed`);
  }
  return problems;
}
