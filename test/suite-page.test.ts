import { describe, expect, it } from "vitest";
import knownRedFile from "../suite/known-red.json";
import manifestFile from "../suite/v1/manifest.json";
import resultFile from "../website/src/data/suite-result.json";
import {
  isKnownRed,
  isLiveRun,
  knownRedMismatches,
  realLatency,
  shapeProblems,
  type KnownRed,
  type Manifest,
  type SuiteResult,
} from "../website/src/lib/suite-result";

const manifest = manifestFile as Manifest;
const known = knownRedFile as KnownRed[];
const original = resultFile as unknown as SuiteResult;
const HASH = original.listHash;

// A deep copy that a case may break. The checked-in file stays untouched.
function mutate(change: (copy: SuiteResult) => void): SuiteResult {
  const copy = structuredClone(original);
  change(copy);
  return copy;
}
const problemsOf = (result: SuiteResult) => [
  ...shapeProblems(result, manifest, HASH),
  ...knownRedMismatches(result, known, manifest),
];
const red = (copy: SuiteResult) => copy.scenarios.find((s) => s.status === "fail")!;

describe("the checked-in result file", () => {
  it("has no problem of form and none against the known-red list", () => {
    expect(problemsOf(original)).toEqual([]);
  });

  it("shows no latency unless the run is live", () => {
    if (!isLiveRun(original)) expect(realLatency(original)).toBeNull();
  });
});

// Each case is a mutation that an earlier version of the check let through.
describe("a result that claims more than it shows", () => {
  it.each<[string, (copy: SuiteResult) => void]>([
    [
      "a red scenario set to pass",
      (copy) => {
        red(copy).status = "pass";
      },
    ],
    [
      "driver.mode set to real-time, latency.mode left",
      (copy) => {
        copy.driver.mode = "real-time";
      },
    ],
    [
      "driver and latency both real-time, driver still local",
      (copy) => {
        copy.driver.mode = "real-time";
        if (copy.latency) copy.latency.mode = "real-time";
      },
    ],
    [
      "modeSource adapter on the local driver",
      (copy) => {
        copy.driver.modeSource = "adapter";
      },
    ],
    [
      "a passed scenario with a failing text",
      (copy) => {
        copy.scenarios[0]!.text = "busy but must be free";
      },
    ],
    [
      "a red scenario without failedStep",
      (copy) => {
        red(copy).failedStep = null;
      },
    ],
    [
      "a red row whose directions all pass",
      (copy) => {
        for (const direction of red(copy).directions) direction.status = "pass";
      },
    ],
    [
      "an unknown status",
      (copy) => {
        (copy.scenarios[0] as { status: string }).status = "green";
      },
    ],
    [
      "a missing latency block in a run of all scenarios",
      (copy) => {
        copy.latency = null;
      },
    ],
    [
      "a missing directions list",
      (copy) => {
        delete (copy.scenarios[0] as { directions?: unknown }).directions;
      },
    ],
    [
      "a missing expected field",
      (copy) => {
        delete (copy.scenarios[0] as { expected?: unknown }).expected;
      },
    ],
    [
      "a p50 on a simulated clock",
      (copy) => {
        if (copy.latency) copy.latency.p50Ms = 1000;
      },
    ],
    [
      "a summary that differs from the table",
      (copy) => {
        copy.summary.pass += 1;
      },
    ],
    [
      "a scenario listed twice",
      (copy) => {
        copy.scenarios[1] = structuredClone(copy.scenarios[0]!);
      },
    ],
    [
      "a red scenario without a known-red entry",
      (copy) => {
        const scenario = copy.scenarios.find((s) => s.status === "pass")!;
        scenario.status = "fail";
        scenario.text = "busy but must be free";
        scenario.failedStep = 2;
        for (const direction of scenario.directions) {
          direction.status = "fail";
          direction.text = "busy but must be free";
          direction.failedStep = 2;
        }
      },
    ],
    [
      "a stopped run that sits on the known list",
      (copy) => {
        for (const direction of red(copy).directions) direction.stopped = true;
      },
    ],
    [
      "a red step that differs from the known step",
      (copy) => {
        for (const direction of red(copy).directions) direction.failedStep = 2;
      },
    ],
  ])("fails for %s", (_name, change) => {
    expect(problemsOf(mutate(change)).length).toBeGreaterThan(0);
  });

  it("fails if the known list names a scenario that passes", () => {
    const extra = [...known, { id: original.scenarios[0]!.id, reason: "x", issue: "#1", step: 1 }];
    expect(knownRedMismatches(original, extra, manifest).length).toBeGreaterThan(0);
  });

  it("fails if the scenario files changed after the run", () => {
    expect(shapeProblems(original, manifest, "0".repeat(64))).toHaveLength(1);
  });

  it("never calls a mutated simulated run live", () => {
    expect(isLiveRun(mutate((copy) => (copy.driver.mode = "real-time")))).toBe(false);
    const both = mutate((copy) => {
      copy.driver.mode = "real-time";
      if (copy.latency) copy.latency.mode = "real-time";
    });
    expect(isLiveRun(both)).toBe(false);
    expect(realLatency(both)).toBeNull();
  });

  it("calls a red row known only when its step matches and no error stopped it", () => {
    const scenario = original.scenarios.find((s) => s.status === "fail")!;
    const entry = known.find((item) => item.id === scenario.id);
    expect(isKnownRed(scenario, entry)).toBe(true);
    expect(
      isKnownRed(
        { ...scenario, directions: scenario.directions.map((d) => ({ ...d, stopped: true })) },
        entry,
      ),
    ).toBe(false);
    expect(isKnownRed(scenario, entry && { ...entry, step: entry.step + 1 })).toBe(false);
  });
});
