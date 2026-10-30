import { describe, expect, it } from "vitest";
import {
  DAILY_ROWS_WRITTEN,
  EXIT,
  STAGES,
  checkTestInstance,
  expectedBlocks,
  formatPlan,
  formatReport,
  isSettled,
  judgeRpc,
  judgeWindow,
  limitsStatement,
  limitsWarning,
  normalizeTarget,
  parseArgs,
  planDays,
  profileMismatch,
  runProbe,
  stageCost,
  stageFailures,
  summarizeStage,
  type ProbeIo,
  type ProbeOptions,
  type Stats,
} from "../scripts/capacity-probe-lib";
// @ts-expect-error `?raw` imports are untyped without `vite/client`
import probeConfig from "../wrangler.probe.example.jsonc?raw";

const stats = (over: Partial<Stats> = {}): Stats => ({
  startedSteps: (over.runs ?? 6) + (over.failedRuns ?? 0),
  storedBlocks: null,
  accounts: 3,
  rules: 6,
  ruleDays: { min: 90, max: 90 },
  calls: { sourceEvents: 12, applyBatch: 30 },
  blocks: 6000,
  rowsWritten: 6042,
  rowsRead: 9000,
  runs: 6,
  writes: 100,
  failedWrites: 0,
  throttledWrites: 0,
  sumStepMs: 600,
  maxStepMs: 180,
  lastRunAt: "2026-10-30T10:00:00.000Z",
  lastRuns: ["a", "b", "c", "d", "e", "f"].map((ruleId) => ({ ruleId, failed: 0, remaining: 0 })),
  failedRuns: 0,
  ...over,
});

const stage = (events: number, over: Partial<Stats> = {}, settled = true) =>
  summarizeStage({
    windowDays: 90,
    events,
    stats: stats({ blocks: expectedBlocks(events, 3), ...over }),
    settled,
    durationMs: 5000,
  });

describe("parseArgs", () => {
  const env = {};
  it("refuses without a target", () => {
    expect(parseArgs(["--cookie", "x"], env)).toMatchObject({ ok: false });
  });
  it("refuses without a cookie", () => {
    expect(parseArgs(["--target", "http://localhost:8787"], env)).toMatchObject({ ok: false });
  });
  it("reads the cookie from the environment and strips the cookie name", () => {
    const result = parseArgs(["--target", "http://localhost:8787/x?y"], {
      PROBE_COOKIE: "slotmirror_session=abc.def",
    });
    expect(result).toMatchObject({
      ok: true,
      options: { target: "http://localhost:8787", cookie: "abc.def" },
    });
  });
  it("uses the fixed stages and both windows by default", () => {
    const result = parseArgs(["--target", "https://a.example", "--cookie", "c"], env);
    expect(result).toMatchObject({
      ok: true,
      options: { stages: [...STAGES], windows: [90, 365], accounts: 3 },
    });
  });
  it("sorts stages and rejects out-of-range values", () => {
    expect(
      parseArgs(["--target", "https://a.example", "--cookie", "c", "--stages", "1000,500"], env),
    ).toMatchObject({ ok: true, options: { stages: [500, 1000] } });
    for (const bad of [
      ["--stages", "20000"],
      ["--window", "400"],
      ["--accounts", "1"],
      ["--bogus", "1"],
    ]) {
      expect(
        parseArgs(["--target", "https://a.example", "--cookie", "c", ...bad], env),
      ).toMatchObject({ ok: false });
    }
  });
  it("reads the daily row limit and the stage passed earlier", () => {
    const base = ["--target", "https://a.example", "--cookie", "c", "--window", "90"];
    expect(parseArgs(base, env)).toMatchObject({
      ok: true,
      options: { dailyRows: 100_000, passedBefore: null },
    });
    expect(
      parseArgs([...base, "--daily-rows", "0", "--stages", "5000", "--passed-before", "2500"], env),
    ).toMatchObject({ ok: true, options: { dailyRows: 0, passedBefore: 2500 } });
    expect(parseArgs([...base, "--daily-rows", "-1"], env)).toMatchObject({ ok: false });
    expect(
      parseArgs(["--target", "https://a.example", "--cookie", "c", "--passed-before", "2500"], env),
    ).toMatchObject({ ok: false });
  });
  it("takes only the stage below the first stage as --passed-before", () => {
    const base = ["--target", "https://a.example", "--cookie", "c", "--window", "90"];
    const passed = (stages: string, value: string) =>
      parseArgs([...base, "--stages", stages, "--passed-before", value], env);
    expect(passed("10000", "5000")).toMatchObject({ ok: true, options: { passedBefore: 5000 } });
    expect(passed("10000", "2500")).toMatchObject({ ok: false, message: /5000/ });
    expect(passed("5000", "5000")).toMatchObject({ ok: false });
    expect(passed("5000", "7000")).toMatchObject({ ok: false });
    expect(passed("1000,2500", "500")).toMatchObject({ ok: false, message: /there is none/ });
  });
  it("rejects a target that is not http(s)", () => {
    expect(normalizeTarget("ftp://x.example")).toBeNull();
    expect(normalizeTarget("not a url")).toBeNull();
  });
  it("takes http only for a local target, because the cookie travels with every request", () => {
    expect(parseArgs(["--target", "http://probe.example", "--cookie", "c"], env)).toMatchObject({
      ok: false,
      message: /https/,
    });
    expect(parseArgs(["--target", "http://127.0.0.1:8787", "--cookie", "c"], env)).toMatchObject({
      ok: true,
    });
  });
});

describe("checkTestInstance", () => {
  const remote = "https://probe.example";
  const marker = {
    testInstance: true,
    fakeCalendars: true,
    simulatedFetch: "ok",
    subrequestLimit: "enforced",
  };
  it("accepts only the test marker", () => {
    expect(checkTestInstance(200, marker, remote)).toBeNull();
    expect(checkTestInstance(404, "Not Found", remote)).toMatch(/not a test instance/);
    expect(checkTestInstance(200, { ...marker, testInstance: false }, remote)).not.toBeNull();
    expect(checkTestInstance(200, null, remote)).not.toBeNull();
  });
  it("refuses an instance with real accounts", () => {
    expect(checkTestInstance(409, { realAccounts: 2 }, remote)).toMatch(
      /2 accounts that are not simulated/,
    );
  });
  it("refuses an instance that cannot reach its fetch target", () => {
    expect(checkTestInstance(200, { ...marker, simulatedFetch: "failed" }, remote)).toMatch(
      /FETCH_URL/,
    );
  });
  it("refuses a remote instance without a fetch target, also without a marker field", () => {
    const off = { ...marker, simulatedFetch: "off", subrequestLimit: "unknown" };
    expect(checkTestInstance(200, off, remote)).toMatch(/no DEV_FAKE_FETCH_URL/);
    const old = { testInstance: true, fakeCalendars: true };
    expect(checkTestInstance(200, old, remote)).toMatch(/no DEV_FAKE_FETCH_URL/);
    expect(checkTestInstance(200, off, "http://localhost:8787")).toBeNull();
  });
  it("refuses a remote instance whose 51st fetch succeeds", () => {
    const paid = { ...marker, subrequestLimit: "absent" };
    expect(checkTestInstance(200, paid, remote)).toMatch(/not on the Workers Free plan/);
    expect(checkTestInstance(200, paid, "http://localhost:8787")).toBeNull();
  });
});

describe("limitsWarning", () => {
  it("marks a local run", () => {
    expect(limitsWarning("http://localhost:8787")).toMatch(/Local run/);
    expect(limitsWarning("https://a.example")).toBeNull();
  });
});

describe("judgeRpc", () => {
  const limited = (fetches: number) => ({ state: "limited", fetches });
  it("reads the lost fetches", () => {
    const check = (baseline: number, mixed: number) =>
      judgeRpc({ rpcCalls: 25, baseline: limited(50), mixed: limited(mixed) }).result;
    expect(check(50, 25)).toBe("counted");
    expect(check(50, 50)).toBe("not counted");
    expect(check(50, 40)).toBe("unclear");
  });
  it("draws no conclusion without a limit", () => {
    const open = { state: "unlimited", fetches: 51 };
    expect(judgeRpc({ rpcCalls: 25, baseline: open, mixed: open }).result).toBe("unclear");
  });
});

describe("planDays", () => {
  it("spreads the default run over days and keeps each day under the limit", () => {
    const days = planDays([90, 365], STAGES, 3, 100_000);
    expect(days.map((day) => [day.windowDays, day.stages])).toEqual([
      [90, [1000, 2500, 5000]],
      [90, [10_000]],
      [365, [1000, 2500, 5000]],
      [365, [10_000]],
    ]);
    expect(days.every((day) => day.rowsWritten <= 100_000 && !day.overLimit)).toBe(true);
    expect(formatPlan(days)).toContain("Day 2: --window 90 --stages 10000");
  });
  it("names a stage that does not fit into one day", () => {
    const [day] = planDays([90], [10_000], 10, 100_000);
    expect(day?.overLimit).toBe(true);
    expect(formatPlan(day ? [day] : [])).toContain("OVER THE DAILY LIMIT");
  });
  it("counts the mirrors, not the native events, as the main cost", () => {
    expect(stageCost(10_000, 3).rowsWritten).toBeGreaterThan(60_000);
    expect(stageCost(10_000, 3).rowsWritten).toBeLessThan(100_000);
  });
  it("adds the change burst to the cost", () => {
    expect(stageCost(10_000, 3).rowsWritten).toBeGreaterThan(70_660);
  });
});

describe("isSettled", () => {
  it("settles after a quiet period with some work done", () => {
    let state = { progress: 0, changedAt: 0 };
    let result = isSettled(state, 0, 100_000, 20_000);
    expect(result.settled).toBe(false);
    result = isSettled(state, 5, 1000, 20_000);
    state = result.state;
    expect(result.settled).toBe(false);
    result = isSettled(state, 5, 20_999, 20_000);
    expect(result.settled).toBe(false);
    result = isSettled(state, 5, 21_000, 20_000);
    expect(result.settled).toBe(true);
  });
  it("restarts the quiet period when work arrives", () => {
    const result = isSettled({ progress: 5, changedAt: 0 }, 6, 30_000, 20_000);
    expect(result).toMatchObject({ settled: false, state: { progress: 6, changedAt: 30_000 } });
  });
});

describe("summarizeStage and stageFailures", () => {
  it("sums provider calls and counts audit rows", () => {
    const result = stage(1000, { failedRuns: 2 });
    expect(result).toMatchObject({
      providerCalls: 42,
      auditRows: 8,
      meanStepMs: 100,
      cpuMs: null,
      completeRules: 6,
      blocks: 6000,
      expectedBlocks: 6000,
    });
  });
  it("passes a clean, settled stage", () => {
    expect(stageFailures(stage(1000))).toEqual([]);
  });
  it("fails on errors, timeouts and an empty run", () => {
    expect(stageFailures(stage(1000, { failedRuns: 1 }))).toHaveLength(1);
    expect(stageFailures(stage(1000, { failedWrites: 3 }))).toHaveLength(1);
    expect(stageFailures(stage(1000, {}, false))).toHaveLength(1);
    expect(stageFailures(stage(1000, { runs: 0, sumStepMs: null }))).toContain(
      "no sync run happened",
    );
  });
  it("does not count throttled writes as a failure", () => {
    expect(stageFailures(stage(1000, { throttledWrites: 4 }))).toEqual([]);
  });
  it("fails a silent stage: a rule without a finished run", () => {
    const lastRuns = stats().lastRuns.slice(0, 5);
    expect(stageFailures(stage(1000, { lastRuns }))).toEqual(["5 of 6 rules finished their work"]);
  });
  it("fails a rule with work left in its last run", () => {
    const lastRuns = stats().lastRuns.map((run, i) => (i === 0 ? { ...run, remaining: 3 } : run));
    expect(stageFailures(stage(1000, { lastRuns }))).toEqual(["5 of 6 rules finished their work"]);
  });
  it("fails on a wrong number of blocks", () => {
    expect(stageFailures(stage(1000, { blocks: 5999 }))).toEqual(["5999 blocks instead of 6000"]);
  });
  it("fails when a started step has no finished run, even if the retry ended clean", () => {
    expect(stageFailures(stage(1000, { startedSteps: 7 }))).toEqual([
      "7 alarm steps started, 6 runs finished",
    ]);
  });
  it("counts a failed run as finished", () => {
    const result = stage(1000, { runs: 6, failedRuns: 1, startedSteps: 7 });
    expect(stageFailures(result)).toEqual(["1 sync runs failed"]);
  });
  it("compares the stored rows of each calendar", () => {
    const good = stage(1000, { storedBlocks: [2000, 2000, 2000] });
    expect(stageFailures(good)).toEqual([]);
    expect(stageFailures(stage(1000, { storedBlocks: [2000, 1999, 2001] }))).toEqual([
      "the calendars store 2000, 1999, 2001 blocks, not 2000 each",
    ]);
    expect(stageFailures(stage(1000, { storedBlocks: [] }))).toEqual([
      "the calendars store 0 blocks, not 2000 each",
    ]);
  });
});

describe("profileMismatch", () => {
  it("accepts the profile", () => {
    expect(profileMismatch(stats(), 3, 90)).toBeNull();
  });
  it("names other accounts, rules and windows", () => {
    expect(profileMismatch(stats({ accounts: 10 }), 3, 90)).toMatch(/10 simulated accounts/);
    expect(profileMismatch(stats({ rules: 4 }), 3, 90)).toMatch(/4 rules/);
    expect(profileMismatch(stats({ ruleDays: { min: 90, max: 365 } }), 3, 365)).toMatch(
      /90 to 365/,
    );
  });
});

describe("judgeWindow", () => {
  it("stops at the first failing stage and names the stage before it", () => {
    const verdict = judgeWindow(90, 3, [
      stage(1000),
      stage(2500),
      stage(5000, { failedRuns: 1 }),
      stage(10_000),
    ]);
    expect(verdict.results.map((r) => r.events)).toEqual([1000, 2500, 5000]);
    expect(verdict.lastPassed).toBe(2500);
    expect(verdict.failedAt).toMatchObject({ events: 5000 });
    expect(limitsStatement(verdict)).toContain("Passed up to 2500");
    expect(limitsStatement(verdict)).toContain("90-day window");
  });
  it("reports no passed stage when the first one fails", () => {
    const verdict = judgeWindow(365, 3, [stage(1000, { failedRuns: 1 })]);
    expect(verdict.lastPassed).toBeNull();
    expect(limitsStatement(verdict)).toContain("No stage passed");
  });
  it("passes a run that clears every stage", () => {
    const verdict = judgeWindow(
      90,
      3,
      STAGES.map((n) => stage(n)),
    );
    expect(verdict).toMatchObject({ failedAt: null, lastPassed: 10_000 });
  });
});

describe("formatReport", () => {
  it("lists every window with its stages and the statement", () => {
    const report = formatReport([
      judgeWindow(90, 3, [stage(1000), stage(2500, { failedRuns: 1 })]),
    ]);
    expect(report).toContain("## Window 90 days");
    expect(report).toContain("| 1000 |");
    expect(report).toContain("Stopped at 2500");
    expect(report).toContain("Passed up to 1000");
    expect(report).toContain("6000 of 6000");
  });
  it("names the real number of accounts", () => {
    const verdict = judgeWindow(90, 5, [stage(1000, { accounts: 5 })]);
    expect(limitsStatement(verdict)).toContain("5 accounts");
  });
  it("names the simulation and the gaps in the statement", () => {
    const statement = limitsStatement(judgeWindow(90, 3, [stage(1000)]));
    expect(statement).toContain("simulated calendars");
    expect(statement).toContain("CPU time per invocation");
    expect(statement).toContain("D1 rows per day");
    expect(statement).toContain("the cron fan-out over 3 users with 3 accounts each");
  });
  it("makes the manual readings a condition of a passed stage", () => {
    const statement = limitsStatement(judgeWindow(90, 3, [stage(1000)]));
    expect(statement).toMatch(/^Valid only if the manual readings .* Passed up to 1000/);
    expect(statement).toContain("ok status for every invocation");
    expect(statement).toContain("CPU limit");
    const none = limitsStatement(judgeWindow(90, 3, [stage(1000, { failedRuns: 1 })]));
    expect(none).not.toContain("Valid only if");
  });
  it("names the rows of the day beside a failed stage", () => {
    const verdict = judgeWindow(90, 3, [stage(1000), stage(2500, { failedRuns: 1 })]);
    const rows = stageCost(1000, 3).rowsWritten + stageCost(2500, 3).rowsWritten;
    expect(limitsStatement(verdict)).toContain(
      `The next stage (2500) failed, with about ${rows} of ${DAILY_ROWS_WRITTEN} daily rows`,
    );
    expect(limitsStatement(verdict, [], 500)).toContain(`about ${rows + 500} of`);
  });
  it("adds the rows of an earlier window to the rows of the day", () => {
    const first = judgeWindow(90, 3, [stage(1000)]);
    const second = judgeWindow(365, 3, [stage(1000, { failedRuns: 1 })]);
    const rows = 2 * stageCost(1000, 3).rowsWritten;
    expect(formatReport([first, second])).toContain(`failed, with about ${rows} of`);
  });
  it("gives no statement if a warning stands", () => {
    const verdict = judgeWindow(90, 3, [stage(1000)]);
    const statement = limitsStatement(verdict, ["Local run."]);
    expect(statement).toBe("No statement for limits.md: Local run.");
    expect(formatReport([verdict], [], { warnings: ["Local run."] })).not.toContain("Passed up to");
  });
  it("marks a value from --passed-before", () => {
    const verdict = judgeWindow(90, 3, [stage(5000, { failedRuns: 1 })], { passedBefore: 2500 });
    expect(limitsStatement(verdict)).toContain(
      "Passed up to 2500 events per source calendar, from an earlier run",
    );
    expect(formatReport([verdict])).toContain("Stage 2500 comes from --passed-before");
    const measured = judgeWindow(90, 3, [stage(5000)], { passedBefore: 2500 });
    expect(limitsStatement(measured)).not.toContain("earlier run");
  });
});

const options = (over: Partial<ProbeOptions> = {}): ProbeOptions => ({
  target: "https://probe.example",
  cookie: "c",
  windows: [90],
  stages: [1000, 2500],
  accounts: 3,
  quietMs: 20_000,
  timeoutMs: 600_000,
  dailyRows: 0,
  passedBefore: null,
  ...over,
});

/**
 * A scripted instance: each stage settles at once unless a handler says otherwise. A handler may
 * answer a request or throw; without an answer the default applies.
 */
function instance(handlers: {
  probe?: () => { status: number; body: unknown };
  rpc?: () => { status: number; body: unknown };
  burst?: () => { status: number; body: unknown } | undefined;
  seed?: (events: number) => { status: number; body: unknown } | undefined;
  cycle?: () => { status: number; body: unknown } | undefined;
  stats?: (events: number, days: number) => Partial<Stats> | { status: number };
}) {
  let clock = 0;
  let events = 0;
  let days = 0;
  let cycles = 0;
  const calls: string[] = [];
  const log: string[] = [];
  const io: ProbeIo = {
    async call(method, path) {
      calls.push(`${method} ${path.split("?")[0] ?? ""}`);
      await Promise.resolve();
      if (path === "/dev/probe") {
        return (
          handlers.probe?.() ?? {
            status: 200,
            body: {
              testInstance: true,
              fakeCalendars: true,
              simulatedFetch: "ok",
              subrequestLimit: "enforced",
            },
          }
        );
      }
      if (path === "/dev/rpc-budget") {
        return (
          handlers.rpc?.() ?? {
            status: 200,
            body: {
              rpcCalls: 25,
              baseline: { state: "limited", fetches: 50 },
              mixed: { state: "limited", fetches: 50 },
            },
          }
        );
      }
      if (path.startsWith("/dev/burst")) {
        return handlers.burst?.() ?? { status: 200, body: { startedAt: "2026-10-30T10:05" } };
      }
      if (path.startsWith("/dev/seed")) {
        const query = new URLSearchParams(path.split("?")[1]);
        events = Number(query.get("events"));
        days = Number(query.get("days"));
        return handlers.seed?.(events) ?? { status: 200, body: { startedAt: "2026-10-30T10:00" } };
      }
      if (path === "/dev/cycle") {
        cycles += 1;
        return handlers.cycle?.() ?? { status: 200, body: { started: 3 } };
      }
      const over = handlers.stats?.(events, days) ?? {};
      if ("status" in over) return { status: over.status, body: "" };
      return {
        status: 200,
        body: stats({
          ruleDays: { min: days, max: days },
          calls: { sourceEvents: 12 + cycles, applyBatch: 30 },
          blocks: expectedBlocks(events, 3),
          ...over,
        }),
      };
    },
    sleep(ms) {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    log: (line) => log.push(line),
  };
  return { io, calls, log };
}

describe("runProbe", () => {
  it("passes every stage in order and reports each window", async () => {
    const { io, calls } = instance({});
    const outcome = await runProbe(options({ windows: [90, 365] }), io);
    expect(outcome.exitCode).toBe(EXIT.passed);
    expect(calls.filter((call) => call === "POST /dev/seed")).toHaveLength(4);
    expect(outcome.report).toContain("## Window 365 days");
    expect(outcome.report).toContain("Passed up to 2500");
  });

  it("stops at a failing stage, names the stage before and starts no next window", async () => {
    const { io, calls } = instance({
      stats: (events, days) => (days === 90 && events === 2500 ? { blocks: 1 } : {}),
    });
    const outcome = await runProbe(options({ windows: [90, 365], stages: [1000, 2500] }), io);
    expect(outcome.exitCode).toBe(EXIT.stageFailed);
    expect(outcome.report).toContain("Stopped at 2500: 1 blocks instead of 15000.");
    expect(outcome.report).toContain("Passed up to 1000");
    expect(outcome.report).toContain("Not run: window 365 days.");
    expect(calls.filter((call) => call === "POST /dev/seed")).toHaveLength(2);
  });

  it("fails a stage in which a limit stopped the alarms without a trace", async () => {
    const { io } = instance({
      stats: (events) => (events === 2500 ? { lastRuns: [], runs: 2 } : {}),
    });
    const outcome = await runProbe(options(), io);
    expect(outcome.exitCode).toBe(EXIT.stageFailed);
    expect(outcome.verdicts[0]).toMatchObject({ lastPassed: 1000, failedAt: { events: 2500 } });
  });

  it("fails a stage in which a stopped alarm came back and ended clean", async () => {
    const { io } = instance({
      stats: (events) => (events === 2500 ? { startedSteps: 7 } : {}),
    });
    const outcome = await runProbe(options(), io);
    expect(outcome.exitCode).toBe(EXIT.stageFailed);
    expect(outcome.verdicts[0]?.failedAt?.reasons).toEqual([
      "7 alarm steps started, 6 runs finished",
    ]);
  });

  it("runs the change burst after the first sync and reports it", async () => {
    const { io, calls } = instance({});
    const outcome = await runProbe(options({ stages: [1000] }), io);
    expect(outcome.exitCode).toBe(EXIT.passed);
    const burst = calls.indexOf("POST /dev/burst");
    expect(burst).toBeGreaterThan(calls.indexOf("POST /dev/cycle"));
    expect(calls.lastIndexOf("POST /dev/cycle")).toBeGreaterThan(burst);
    expect(outcome.verdicts[0]?.results[0]?.burst).toMatchObject({
      events: 50,
      expectedWrites: 100,
      writes: 100,
      settled: true,
    });
    expect(outcome.report).toContain("50 events, 100 of 100 writes");
  });

  it("fails a stage if the sync does not react to the burst", async () => {
    let burst = false;
    const { io } = instance({
      burst: () => {
        burst = true;
        return undefined;
      },
      stats: () => (burst ? { calls: { sourceEvents: 1 } } : {}),
    });
    const outcome = await runProbe(options({ stages: [1000], timeoutMs: 60_000 }), io);
    expect(outcome.exitCode).toBe(EXIT.stageFailed);
    expect(outcome.verdicts[0]?.failedAt?.reasons).toContain(
      "the sync did not settle after the change burst",
    );
  });

  it("fails a stage whose burst wrote the wrong number of blocks", async () => {
    let burst = false;
    const { io } = instance({
      burst: () => {
        burst = true;
        return undefined;
      },
      stats: () => (burst ? { writes: 99 } : {}),
    });
    const outcome = await runProbe(options({ stages: [1000] }), io);
    expect(outcome.verdicts[0]?.failedAt?.reasons).toEqual([
      "99 writes after the change burst instead of 100",
    ]);
  });

  it("asks for the block count once, at the end of a stage", async () => {
    const paths: string[] = [];
    const { io } = instance({});
    const logged: ProbeIo = {
      ...io,
      call: (method, path) => {
        paths.push(path);
        return io.call(method, path);
      },
    };
    await runProbe(options({ stages: [1000] }), logged);
    const counts = paths.filter((path) => path.includes("count=1"));
    expect(counts).toHaveLength(1);
    expect(paths.at(-1)).toContain("count=1");
  });

  it("reports the result of the RPC check, and goes on without it", async () => {
    const { io } = instance({
      rpc: () => ({
        status: 200,
        body: {
          rpcCalls: 25,
          baseline: { state: "limited", fetches: 50 },
          mixed: { state: "limited", fetches: 25 },
        },
      }),
    });
    const outcome = await runProbe(options({ stages: [1000] }), io);
    expect(outcome.rpc?.result).toBe("counted");
    expect(outcome.report).toContain("RPC as a subrequest: counted");

    const broken = instance({ rpc: () => ({ status: 500, body: "" }) });
    const without = await runProbe(options({ stages: [1000] }), broken.io);
    expect(without.exitCode).toBe(EXIT.passedNoStatement);
    expect(without.rpc).toBeNull();
    expect(without.warnings[0]).toContain("GET /dev/rpc-budget answered 500");
    expect(without.report).toContain("The RPC check did not run");
    expect(without.report).toContain("No statement for limits.md");
    expect(without.report).not.toContain("Passed up to");
  });

  it("gives no statement if the RPC check throws", async () => {
    const { io } = instance({
      rpc: () => {
        throw new TypeError("fetch failed");
      },
    });
    const outcome = await runProbe(options({ stages: [1000] }), io);
    expect(outcome.exitCode).toBe(EXIT.passedNoStatement);
    expect(outcome.warnings[0]).toContain("fetch failed");
    expect(outcome.report).not.toContain("Passed up to");
  });

  it("keeps the exit code of a failed stage if a warning stands too", async () => {
    const { io } = instance({
      rpc: () => ({ status: 500, body: "" }),
      stats: () => ({ blocks: 1 }),
    });
    const outcome = await runProbe(options({ stages: [1000] }), io);
    expect(outcome.exitCode).toBe(EXIT.stageFailed);
  });

  it("gives no statement if a Durable Object shows no limit", async () => {
    const open = { state: "unlimited", fetches: 51 };
    const { io } = instance({
      rpc: () => ({ status: 200, body: { rpcCalls: 25, baseline: open, mixed: open } }),
    });
    const outcome = await runProbe(options({ stages: [1000] }), io);
    expect(outcome.exitCode).toBe(EXIT.passedNoStatement);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.report).not.toContain("Passed up to");
  });

  it("reports the stage before a 5xx on the seed and exits as broken", async () => {
    const { io } = instance({
      seed: (events) => (events === 2500 ? { status: 503, body: "" } : undefined),
    });
    const outcome = await runProbe(options(), io);
    expect(outcome.exitCode).toBe(EXIT.broken);
    expect(outcome.report).toContain("Broke at 2500: POST /dev/seed answered 503.");
    expect(outcome.report).toContain("Passed up to 1000");
    expect(outcome.report).toContain("The run broke at 2500");
  });

  it("reports a timeout of a request the same way", async () => {
    const { io } = instance({
      cycle: () => {
        throw new Error("The operation was aborted due to timeout");
      },
    });
    const outcome = await runProbe(options(), io);
    expect(outcome.exitCode).toBe(EXIT.broken);
    expect(outcome.report).toContain("aborted due to timeout");
    expect(outcome.report).toContain("No stage passed");
  });

  it("survives a short stats outage and breaks on a long one", async () => {
    let failures = 2;
    const short = instance({
      stats: (): Partial<Stats> | { status: number } => (failures-- > 0 ? { status: 500 } : {}),
    });
    expect((await runProbe(options({ stages: [1000] }), short.io)).exitCode).toBe(EXIT.passed);

    const long = instance({ stats: () => ({ status: 500 }) });
    const outcome = await runProbe(options({ stages: [1000] }), long.io);
    expect(outcome.exitCode).toBe(EXIT.broken);
    expect(outcome.report).toContain("GET /dev/stats answered 500");
  });

  it("does not run the next window after a timeout", async () => {
    let progress = 0;
    const { io, calls } = instance({
      stats: () => ({ calls: { sourceEvents: ++progress } }),
    });
    const outcome = await runProbe(options({ windows: [90, 365], timeoutMs: 60_000 }), io);
    expect(outcome.exitCode).toBe(EXIT.stageFailed);
    expect(outcome.report).toContain("Not run: window 365 days.");
    expect(calls.filter((call) => call === "POST /dev/seed")).toHaveLength(1);
  });

  it("treats leftovers of another profile as a broken run", async () => {
    const { io } = instance({ stats: () => ({ accounts: 10 }) });
    const outcome = await runProbe(options(), io);
    expect(outcome.exitCode).toBe(EXIT.broken);
    expect(outcome.report).toContain("10 simulated accounts instead of 3");
  });

  it("refuses a target that is no test instance and seeds nothing", async () => {
    const notFound = instance({ probe: () => ({ status: 404, body: "" }) });
    expect((await runProbe(options(), notFound.io)).exitCode).toBe(EXIT.refused);
    expect(notFound.calls).toEqual(["GET /dev/probe"]);

    const real = instance({ probe: () => ({ status: 409, body: { realAccounts: 1 } }) });
    expect(await runProbe(options(), real.io)).toMatchObject({
      exitCode: EXIT.refused,
      report: "",
    });
    expect(real.log.join()).toContain("not simulated");
  });

  it("refuses a remote target on the Paid plan and seeds nothing", async () => {
    const { io, calls, log } = instance({
      probe: () => ({
        status: 200,
        body: {
          testInstance: true,
          fakeCalendars: true,
          simulatedFetch: "ok",
          subrequestLimit: "absent",
        },
      }),
    });
    expect((await runProbe(options(), io)).exitCode).toBe(EXIT.refused);
    expect(calls).toEqual(["GET /dev/probe"]);
    expect(log.join()).toContain("Free plan");
  });

  it("runs a local target without a limit, and gives no statement", async () => {
    const { io } = instance({
      probe: () => ({
        status: 200,
        body: {
          testInstance: true,
          fakeCalendars: true,
          simulatedFetch: "ok",
          subrequestLimit: "absent",
        },
      }),
    });
    const outcome = await runProbe(
      options({ target: "http://localhost:8787", stages: [1000] }),
      io,
    );
    expect(outcome.exitCode).toBe(EXIT.passedNoStatement);
    expect(outcome.warnings[0]).toMatch(/Local run/);
    expect(outcome.report).not.toContain("Passed up to");
    expect(outcome.report).toContain("No statement for limits.md");
  });

  it("reports an unreachable target as a broken run", async () => {
    const { io } = instance({
      probe: () => {
        throw new TypeError("fetch failed");
      },
    });
    const outcome = await runProbe(options(), io);
    expect(outcome.exitCode).toBe(EXIT.broken);
    expect(outcome.report).toContain("fetch failed");
  });

  it("refuses a run over the daily limit and prints the plan, without a request", async () => {
    const { io, calls, log } = instance({});
    const outcome = await runProbe(
      options({ windows: [90, 365], stages: [...STAGES], dailyRows: 100_000 }),
      io,
    );
    expect(outcome.exitCode).toBe(EXIT.usage);
    expect(calls).toEqual([]);
    expect(log.join("\n")).toContain("Day 4: --window 365 --stages 10000");
  });

  it("runs two small windows on one day", async () => {
    const { io } = instance({});
    const outcome = await runProbe(options({ windows: [90, 365], dailyRows: 100_000 }), io);
    expect(outcome.exitCode).toBe(EXIT.passed);
  });

  it("keeps the stage passed on an earlier day", async () => {
    const { io } = instance({ stats: () => ({ blocks: 0 }) });
    const outcome = await runProbe(options({ stages: [5000], passedBefore: 2500 }), io);
    expect(outcome.exitCode).toBe(EXIT.stageFailed);
    expect(outcome.report).toContain("Passed up to 2500");
    expect(outcome.report).toContain("from an earlier run");
  });

  it("refuses a remote target without a fetch target and seeds nothing", async () => {
    const { io, calls, log } = instance({
      probe: () => ({
        status: 200,
        body: {
          testInstance: true,
          fakeCalendars: true,
          simulatedFetch: "off",
          subrequestLimit: "unknown",
        },
      }),
    });
    expect((await runProbe(options(), io)).exitCode).toBe(EXIT.refused);
    expect(calls).toEqual(["GET /dev/probe"]);
    expect(log.join()).toContain("the limit of 50 cannot trip");
  });

  it("runs a local target without a fetch target, without the RPC check", async () => {
    const { io, calls } = instance({
      probe: () => ({
        status: 200,
        body: { testInstance: true, fakeCalendars: true, simulatedFetch: "off" },
      }),
    });
    const target = "http://localhost:8787";
    const outcome = await runProbe(options({ target, stages: [1000] }), io);
    expect(outcome.exitCode).toBe(EXIT.passedNoStatement);
    expect(calls).not.toContain("GET /dev/rpc-budget");
    expect(outcome.report).toContain("No statement for limits.md");
  });
});

describe("wrangler.probe.example.jsonc", () => {
  it("cannot reach a production Worker or start a cron", () => {
    expect(probeConfig).toMatch(/^\s*"name": "slotmirror-capacity-probe",$/m);
    expect(probeConfig).toMatch(/^\s*"account_id": "<[^"]+>",$/m);
    expect(probeConfig).toMatch(/^\s*"database_id": "<[^"]+>",$/m);
    expect(probeConfig).toMatch(/^\s*"triggers": \{ "crons": \[\] \},$/m);
  });
});
