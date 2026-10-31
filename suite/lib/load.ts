import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnownRed } from "./gate.ts";
import type { Manifest, Scenario } from "./scenario.ts";
import { manifestProblems } from "./validate.ts";

export const SUITE_VERSION = "v1";

/** Read a version folder in the order of its manifest. Refuses a list with problems. */
export function loadSuite(suiteDir: string, version = SUITE_VERSION) {
  const dir = join(suiteDir, version);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const files = readdirSync(join(dir, "scenarios"));
  const scenarios = files.map(
    (file) => JSON.parse(readFileSync(join(dir, "scenarios", file), "utf8")) as Scenario,
  );
  const problems = manifestProblems(manifest, scenarios);
  if (problems.length > 0) throw new Error(`The list has problems:\n${problems.join("\n")}`);
  const order = (scenario: Scenario) => manifest.scenarios.indexOf(scenario.id);
  return { manifest, scenarios: scenarios.toSorted((a, b) => order(a) - order(b)) };
}

/** The scenarios that the gate takes as red. See `suite/README.md`. */
export function loadKnownRed(suiteDir: string): KnownRed[] {
  return JSON.parse(readFileSync(join(suiteDir, "known-red.json"), "utf8")) as KnownRed[];
}
