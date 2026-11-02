/**
 * `pnpm suite:published`: check the result file of the website against the suite. It stops on a
 * wrong form, on a result that its own fields contradict, on a result of another list of scenarios,
 * and on a red scenario that the known list does not explain.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exit } from "node:process";
import { fileURLToPath } from "node:url";
import {
  knownRedMismatches,
  shapeProblems,
  type KnownRed,
  type Manifest,
  type SuiteResult,
} from "../website/src/lib/suite-result.ts";
import { hashFolder } from "./lib/stamp.ts";

const suiteDir = dirname(fileURLToPath(import.meta.url));
const read = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

const result = read<SuiteResult>(join(suiteDir, "../website/src/data/suite-result.json"));
const manifest = read<Manifest>(join(suiteDir, "v1/manifest.json"));
const known = read<KnownRed[]>(join(suiteDir, "known-red.json"));

const problems = [
  ...shapeProblems(result, manifest, hashFolder(join(suiteDir, "v1"))),
  ...knownRedMismatches(result, known, manifest),
];
if (problems.length > 0) {
  console.error(`The result file of the website has problems:\n- ${problems.join("\n- ")}`);
  exit(1);
}
console.log("The result file of the website matches the suite.");
