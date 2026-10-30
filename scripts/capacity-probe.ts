/**
 * Capacity probe: runs the fixed load profile against a test instance, stage by stage, and
 * prints a Markdown report. Usage and prerequisites: scripts/README.md.
 *
 *   pnpm capacity:probe --target https://probe.example.workers.dev --cookie <session cookie>
 *
 * Safety: the probe talks to one instance that you name. It refuses unless the instance answers
 * GET /dev/probe, which exists only with DEV_FAKE_CALENDARS=1. It uses only the /dev routes, which
 * touch simulated accounts named `sim-*` and never a real calendar.
 */
import {
  checkTestInstance,
  formatReport,
  isSettled,
  judgeWindow,
  parseArgs,
  summarizeStage,
  type ProbeOptions,
  type Stats,
  type StageResult,
  type WindowVerdict,
} from "./capacity-probe-lib.ts";

const parsed = parseArgs(process.argv.slice(2), process.env);
if (!parsed.ok) {
  console.error(parsed.message);
  console.error(
    "Usage: capacity-probe --target <url> --cookie <session cookie> [--window 90,365] " +
      "[--stages 1000,2500,5000,10000] [--accounts 3] [--quiet-s 20] [--timeout-min 30]",
  );
  process.exit(2);
}
const options = parsed.options;

async function call(
  method: "GET" | "POST",
  path: string,
): Promise<{ status: number; body: unknown }> {
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
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function stats(since: string): Promise<Stats> {
  const { status, body } = await call("GET", `/dev/stats?since=${encodeURIComponent(since)}`);
  if (status !== 200) throw new Error(`GET /dev/stats answered ${status}`);
  return body as Stats;
}

async function runStage(
  windowDays: number,
  events: number,
  opts: ProbeOptions,
): Promise<StageResult> {
  const since = new Date().toISOString();
  const seed = await call(
    "POST",
    `/dev/seed?accounts=${opts.accounts}&events=${events}&days=${windowDays}`,
  );
  if (seed.status !== 200) throw new Error(`POST /dev/seed answered ${seed.status}`);
  const started = Date.now();
  const cycle = await call("POST", "/dev/cycle");
  if (cycle.status !== 200) throw new Error(`POST /dev/cycle answered ${cycle.status}`);

  let state = { runs: 0, changedAt: started };
  let latest = await stats(since);
  let settled = false;
  while (Date.now() - started < opts.timeoutMs) {
    await sleep(2000);
    latest = await stats(since);
    const next = isSettled(state, latest.runs, Date.now(), opts.quietMs);
    state = next.state;
    if (next.settled) {
      settled = true;
      break;
    }
  }
  console.error(`  ${events} events: ${latest.runs} steps, ${settled ? "settled" : "timeout"}`);
  return summarizeStage({
    windowDays,
    events,
    stats: latest,
    settled,
    durationMs: settled ? state.changedAt - started : Date.now() - started,
  });
}

const marker = await call("GET", "/dev/probe");
const refusal = checkTestInstance(marker.status, marker.body);
if (refusal) {
  console.error(refusal);
  process.exit(3);
}

const verdicts: WindowVerdict[] = [];
for (const windowDays of options.windows) {
  console.error(`Window ${windowDays} days`);
  const results: StageResult[] = [];
  for (const events of options.stages) {
    const result = await runStage(windowDays, events, options);
    results.push(result);
    // Stop at the first failing stage: the stage before it is the answer.
    if (judgeWindow(windowDays, results).failedAt) break;
  }
  verdicts.push(judgeWindow(windowDays, results));
}

console.log(`# Capacity probe\n\nTarget: ${options.target}\nDate: ${new Date().toISOString()}\n`);
console.log(formatReport(verdicts));
console.log("```json\n" + JSON.stringify(verdicts, null, 2) + "\n```");
process.exit(verdicts.some((v) => v.failedAt) ? 1 : 0);
