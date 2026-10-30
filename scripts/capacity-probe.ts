/**
 * Capacity probe: runs the fixed load profile against a test instance, stage by stage, and
 * prints a Markdown report. Usage and prerequisites: scripts/README.md.
 *
 *   PROBE_COOKIE=<session cookie> pnpm capacity:probe --target https://probe.example.workers.dev
 *
 * Safety: the probe talks to one instance that you name. It refuses unless the instance answers
 * GET /dev/probe, which exists only with DEV_FAKE_CALENDARS=1 and answers 409 as soon as the
 * instance holds an account that is not simulated. It uses only the /dev routes.
 */
import { EXIT, PROFILE, parseArgs, runProbe } from "./capacity-probe-lib.ts";

const parsed = parseArgs(process.argv.slice(2), process.env);
if (!parsed.ok) {
  console.error(parsed.message);
  console.error(
    "Usage: PROBE_COOKIE=<session cookie> capacity-probe --target <url> [--window 90,365] " +
      "[--stages 1000,2500,5000,10000] [--accounts 3] [--quiet-s 20] [--timeout-min 30] " +
      "[--daily-rows 100000] [--passed-before <events>]",
  );
  process.exit(EXIT.usage);
}
const options = parsed.options;

const outcome = await runProbe(options, {
  async call(method, path) {
    const response = await fetch(`${options.target}${path}`, {
      method,
      headers: { cookie: `slotmirror_session=${options.cookie}` },
      redirect: "manual",
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (line) => console.error(line),
}).catch((error: unknown) => {
  console.error(`The run broke: ${String(error)}`);
  return { exitCode: EXIT.broken, report: "", verdicts: [], warnings: [], rpc: null };
});

if (outcome.report) {
  console.log(`# Capacity probe\n\nTarget: ${options.target}\nDate: ${new Date().toISOString()}\n`);
  console.log(outcome.report);
  const { warnings, rpc, verdicts } = outcome;
  const result = { profile: PROFILE, warnings, rpc, verdicts };
  console.log("```json\n" + JSON.stringify(result, null, 2) + "\n```");
}
process.exit(outcome.exitCode);
