import { describe, expect, it } from "vitest";
import knownRedFile from "../suite/known-red.json";
import manifestFile from "../suite/v1/manifest.json";
import { gateProblems, knownRedProblems, type KnownRed } from "../suite/lib/gate";
import type { DirectionRun, ScenarioResult, Status, SuiteResult } from "../suite/lib/runner";
import type { Manifest } from "../suite/lib/scenario";

const manifest: Manifest = {
  suite: "s",
  version: "v1",
  frozenAt: "2026-10-30",
  scenarios: ["one", "two", "red"],
};

const KNOWN: KnownRed[] = [{ id: "red", reason: "The tool is wrong.", issue: "TBD", step: 6 }];

function direction(
  direction: string,
  status: Status,
  failedStep: number | null,
  stopped = false,
): DirectionRun {
  const text = status === "fail" ? "busy but must be free" : "";
  return {
    direction,
    status,
    stopped,
    text,
    durationMs: 1,
    failedStep,
    expected: null,
    observed: null,
  };
}

function row(id: string, runs: DirectionRun[]): ScenarioResult {
  const [first] = runs;
  return {
    id,
    title: id,
    covers: "single event",
    status: runs.some((run) => run.status === "fail") ? "fail" : (first?.status ?? "not_run"),
    stopped: runs.some((run) => run.stopped),
    expectedText: "",
    local_limit: null,
    expected: null,
    observed: null,
    text: first?.text ?? "",
    durationMs: 1,
    failedStep: first?.failedStep ?? null,
    directions: runs,
  };
}

const green = (id: string) =>
  row(id, [direction("forward", "pass", null), direction("reverse", "pass", null)]);
const red = (id: string, step = 6) =>
  row(id, [direction("forward", "fail", step), direction("reverse", "fail", step)]);

function result(scenarios: ScenarioResult[], scope: SuiteResult["scope"] = "all") {
  return { scope, scenarios };
}

describe("gateProblems", () => {
  it("holds with the known red scenario and all others green", () => {
    expect(gateProblems(result([green("one"), green("two"), red("red")]), KNOWN, manifest)).toEqual(
      [],
    );
  });

  it("is red if another scenario turns red", () => {
    const problems = gateProblems(result([green("one"), red("two"), red("red")]), KNOWN, manifest);
    expect(problems).toEqual([expect.stringMatching(/^two: red and not on the known list/)]);
  });

  it("is red if one direction of another scenario turns red", () => {
    const half = row("two", [direction("forward", "pass", null), direction("reverse", "fail", 2)]);
    const problems = gateProblems(result([green("one"), half, red("red")]), KNOWN, manifest);
    expect(problems).toEqual([expect.stringMatching(/^two: red and not on the known list/)]);
  });

  it("is red if a scenario was not run, also next to a failed direction", () => {
    const notRun = row("one", [direction("forward", "not_run", null)]);
    const problems = gateProblems(result([notRun, green("two"), red("red")]), KNOWN, manifest);
    expect(problems).toEqual([expect.stringMatching(/^one: not run/)]);
    const mixed = row("two", [direction("forward", "fail", 2), direction("reverse", "not_run", 2)]);
    const both = gateProblems(result([green("one"), mixed, red("red")]), KNOWN, manifest);
    expect(both).toContainEqual(expect.stringMatching(/^two: not run/));
  });

  it("is red if a known red scenario was not run", () => {
    const notRun = row("red", [direction("forward", "not_run", null)]);
    const problems = gateProblems(result([green("one"), green("two"), notRun]), KNOWN, manifest);
    expect(problems).toEqual([expect.stringMatching(/^red: not run/)]);
  });

  it("is red if a known red scenario turns green and the list stays", () => {
    const problems = gateProblems(
      result([green("one"), green("two"), green("red")]),
      KNOWN,
      manifest,
    );
    expect(problems).toEqual([expect.stringMatching(/^red: green in forward, reverse/)]);
  });

  it("is red if a known red scenario turns green in one direction only", () => {
    const half = row("red", [direction("forward", "fail", 6), direction("reverse", "pass", null)]);
    const problems = gateProblems(result([green("one"), green("two"), half]), KNOWN, manifest);
    expect(problems).toEqual([expect.stringMatching(/^red: green in reverse/)]);
  });

  it("is red if a known red scenario fails in another step, for another reason", () => {
    const problems = gateProblems(
      result([green("one"), green("two"), red("red", 2)]),
      KNOWN,
      manifest,
    );
    expect(problems).toEqual([
      expect.stringMatching(/^red: red in step 2 in forward/),
      expect.any(String),
    ]);
  });

  it("is red if a known red scenario stops in its own step: a stop is no known red", () => {
    const stopped = row("red", [
      direction("forward", "fail", 6, true),
      direction("reverse", "fail", 6, true),
    ]);
    const problems = gateProblems(result([green("one"), green("two"), stopped]), KNOWN, manifest);
    expect(problems).toEqual([
      expect.stringMatching(/^red: the run stopped in step 6 in forward/),
      expect.stringMatching(/^red: the run stopped in step 6 in reverse/),
    ]);
  });

  it("is red if a known red scenario stops in one direction only", () => {
    const half = row("red", [
      direction("forward", "fail", 6),
      direction("reverse", "fail", 6, true),
    ]);
    const problems = gateProblems(result([green("one"), green("two"), half]), KNOWN, manifest);
    expect(problems).toEqual([expect.stringMatching(/^red: the run stopped in step 6 in reverse/)]);
  });

  it("names a stop as a stop in a scenario outside the list", () => {
    const stopped = row("two", [direction("forward", "fail", 2, true)]);
    const problems = gateProblems(result([green("one"), stopped, red("red")]), KNOWN, manifest);
    expect(problems).toEqual([expect.stringMatching(/^two: the run stopped in step 2 in forward/)]);
  });

  it("is red if a run leaves out a scenario", () => {
    const problems = gateProblems(result([green("one"), red("red")]), KNOWN, manifest);
    expect(problems).toEqual(["two: no result"]);
  });

  it("is red for a run of selected scenarios", () => {
    const problems = gateProblems(result([green("one")], "selected"), KNOWN, manifest);
    expect(problems).toEqual(["The gate needs a run of all scenarios."]);
  });

  it("is red for a known list with a problem", () => {
    const stale = [...KNOWN, { id: "gone", reason: "Old.", issue: "TBD", step: 1 }];
    const problems = gateProblems(
      result([green("one"), green("two"), red("red")]),
      stale,
      manifest,
    );
    expect(problems).toEqual(["gone: on the known list but not in the manifest"]);
  });
});

describe("knownRedProblems", () => {
  it("wants a reason, an issue and the step of every entry, once per scenario", () => {
    const entry = (fields: Partial<KnownRed>) => ({ ...KNOWN[0], ...fields }) as KnownRed;
    expect(knownRedProblems([entry({ reason: " " })], manifest)).toEqual(["red: no reason"]);
    expect(knownRedProblems([entry({ issue: "" })], manifest)).toEqual(["red: no issue"]);
    expect(knownRedProblems([entry({ step: 0 })], manifest)).toEqual(["red: no step"]);
    expect(knownRedProblems([entry({}), entry({})], manifest)).toEqual(["red: listed twice"]);
  });

  it("holds for the list of this repository", () => {
    expect(knownRedProblems(knownRedFile, manifestFile)).toEqual([]);
  });
});
