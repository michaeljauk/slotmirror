import type { DirectionRun, SuiteResult } from "./runner.ts";
import type { Manifest } from "./scenario.ts";

/**
 * A scenario that is red through a known fault of the tool. The freeze rule keeps it on the list, so
 * it stays red until the tool is fixed.
 */
export interface KnownRed {
  id: string;
  reason: string;
  /** The issue of the fault, or `TBD`. */
  issue: string;
  /** The step that fails, from 1. A failure in another step has another cause. */
  step: number;
}

export function knownRedProblems(
  known: readonly KnownRed[],
  manifest: Pick<Manifest, "scenarios">,
): string[] {
  const seen = new Set<string>();
  return known.flatMap(({ id, reason, issue, step }) => {
    const problems: string[] = [];
    if (!manifest.scenarios.includes(id)) {
      problems.push(`${id}: on the known list but not in the manifest`);
    }
    if (seen.has(id)) problems.push(`${id}: listed twice`);
    seen.add(id);
    if (!reason.trim()) problems.push(`${id}: no reason`);
    if (!issue.trim()) problems.push(`${id}: no issue`);
    if (!Number.isInteger(step) || step < 1) problems.push(`${id}: no step`);
    return problems;
  });
}

function directionNames(runs: readonly DirectionRun[]): string {
  return runs.map((run) => run.direction).join(", ");
}

/**
 * Why a run of all scenarios does not hold against the known list. An empty list means that the
 * gate is green: every scenario ran, and red are exactly the scenarios of the list, in their step.
 * A run that an exception stopped is never a known red, also not in the step of the list: its last
 * check did not run.
 */
export function gateProblems(
  result: Pick<SuiteResult, "scope" | "scenarios">,
  known: readonly KnownRed[],
  manifest: Pick<Manifest, "scenarios">,
): string[] {
  if (result.scope !== "all") return ["The gate needs a run of all scenarios."];
  const problems = knownRedProblems(known, manifest);
  const ran = new Set(result.scenarios.map((row) => row.id));
  for (const id of manifest.scenarios) {
    if (!ran.has(id)) problems.push(`${id}: no result`);
  }
  for (const row of result.scenarios) {
    const entry = known.find((item) => item.id === row.id);
    const failed = row.directions.filter((run) => run.status === "fail" && !run.stopped);
    for (const run of row.directions.filter((item) => item.stopped)) {
      problems.push(
        `${row.id}: the run stopped in step ${String(run.failedStep)} in ${run.direction}: ` +
          run.text,
      );
    }
    if (row.status === "not_run" || row.directions.some((run) => run.status === "not_run")) {
      problems.push(`${row.id}: not run: ${row.text}`);
    } else if (!entry && failed.length > 0) {
      problems.push(`${row.id}: red and not on the known list: ${row.text}`);
    }
    if (!entry) continue;
    const passed = row.directions.filter((run) => run.status === "pass");
    if (passed.length > 0) {
      problems.push(
        `${row.id}: green in ${directionNames(passed)}. Fix the known list or the scenario.`,
      );
    }
    for (const run of failed) {
      if (run.failedStep !== entry.step) {
        problems.push(
          `${row.id}: red in step ${String(run.failedStep)} in ${run.direction}, ` +
            `known in step ${entry.step}: ${run.text}`,
        );
      }
    }
  }
  return problems;
}
