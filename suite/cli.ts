/**
 * `pnpm suite`: run the scenario suite.
 *
 *   pnpm suite [--scenario <id>]
 *   pnpm suite --gate
 *   pnpm suite --driver live --command "<adapter command>" [--scenario <id>]
 *     [--allow-foreign <entry ID,entry ID>]
 *
 * The default driver runs the real sync engine against simulated calendars, inside Vitest. The
 * live driver gives every calendar access to the adapter command. The gate compares a local run
 * of all scenarios with `suite/known-red.json`. See `suite/README.md`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { argv, env, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { runAdapterCommand } from "./drivers/adapter-command.ts";
import { LiveDriver } from "./drivers/live.ts";
import { gateProblems } from "./lib/gate.ts";
import { loadKnownRed, loadSuite } from "./lib/load.ts";
import { exitCode, runSuite, type ScenarioResult, type SuiteResult } from "./lib/runner.ts";
import { SuiteAbort } from "./lib/scenario.ts";
import { runStamp } from "./lib/stamp.ts";

const suiteDir = dirname(fileURLToPath(import.meta.url));

function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function line(result: ScenarioResult): string {
  const detail = result.status === "pass" ? "" : `  ${result.text}`;
  return `${result.status.padEnd(7)} ${result.id}${detail}`;
}

function runLocal(scenarioId: string | undefined): SuiteResult {
  const file = join(mkdtempSync(join(tmpdir(), "suite-")), "result.json");
  const run = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      "suite/vitest.config.ts",
      "--reporter=dot",
      "suite/drivers/local.run.ts",
    ],
    {
      cwd: dirname(suiteDir),
      stdio: "inherit",
      env: {
        ...env,
        SUITE_RESULT_FILE: file,
        SUITE_SCENARIO: scenarioId ?? "",
      },
    },
  );
  if (run.status !== 0) throw new Error(`The local run stopped with exit code ${run.status}`);
  return JSON.parse(readFileSync(file, "utf8")) as SuiteResult;
}

/** How exact the values are. The suite cannot verify the mode, and it reads the target in steps. */
function caveats({ driver, latency }: SuiteResult): string[] {
  const lines: string[] = [];
  if (driver.allowForeign > 0) {
    lines.push(
      `--allow-foreign named ${driver.allowForeign} IDs. The checks do not see these entries.`,
    );
  }
  if (driver.modeSource === "adapter") {
    lines.push(`The adapter states the mode ${driver.mode}. The suite cannot verify it.`);
  }
  if (latency?.p50Ms != null && latency.p95Ms != null) {
    const { p50Ms, p95Ms, pollMs } = latency;
    const grid = pollMs === null ? "" : ` Each value lies on a ${pollMs} ms read grid.`;
    lines.push(`Latency p50 ${p50Ms} ms, p95 ${p95Ms} ms.${grid}`);
  }
  return lines;
}

/** 0 only if a run of all scenarios holds against the known list. */
function gateExit(result: SuiteResult): number {
  const { manifest } = loadSuite(suiteDir);
  const problems = gateProblems(result, loadKnownRed(suiteDir), manifest);
  if (problems.length === 0) {
    stdout.write("The gate holds: red are only the scenarios of suite/known-red.json.\n");
    return 0;
  }
  stderr.write(`The gate does not hold:\n${problems.join("\n")}\n`);
  return 1;
}

async function main(): Promise<number> {
  const scenarioId = option("scenario");
  const driverName = option("driver") ?? "local";
  const gate = argv.includes("--gate");
  if (gate && driverName !== "local") throw new Error("The gate holds only for the local run.");
  let result: SuiteResult;
  if (driverName === "local") {
    result = runLocal(scenarioId);
  } else if (driverName === "live") {
    const command = option("command") ?? env.SUITE_LIVE_COMMAND;
    if (!command) throw new Error("The live driver needs --command or SUITE_LIVE_COMMAND");
    const { manifest, scenarios } = loadSuite(suiteDir);
    const allowForeign = option("allow-foreign")?.split(",").filter(Boolean) ?? [];
    const driver = new LiveDriver((request) => runAdapterCommand(command, request), {
      allowForeign,
    });
    result = await runSuite(manifest, scenarios, await driver.start(), {
      ...(scenarioId ? { scenarioId } : {}),
      ...runStamp(suiteDir),
      runAt: new Date().toISOString(),
    });
  } else {
    throw new Error(`Unknown driver: ${driverName}`);
  }
  const directory = join(suiteDir, "results");
  mkdirSync(directory, { recursive: true });
  const stamp = result.runAt.replaceAll(":", "-").slice(0, 19);
  const label = result.driver.name.replaceAll(/[^a-z0-9-]/gi, "-");
  const path = join(directory, `${stamp}-${label}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  stdout.write(`${result.scenarios.map(line).join("\n")}\n`);
  const { pass, fail, not_run: notRun } = result.summary;
  stdout.write(`\n${pass} pass, ${fail} fail, ${notRun} not run. ${path}\n`);
  for (const caveat of caveats(result)) stdout.write(`${caveat}\n`);
  return gate ? gateExit(result) : exitCode(result);
}

try {
  exit(await main());
} catch (error) {
  if (!(error instanceof SuiteAbort)) throw error;
  stderr.write(`The run stopped: ${error.message}\n`);
  exit(1);
}
