import { describe, expect, it } from "vitest";
import {
  EXIT,
  STAGES,
  checkTestInstance,
  expectedBlocks,
  formatPlan,
  formatReport,
  isSettled,
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

const stats = (over: Partial<Stats> = {}): Stats => ({
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
    expect(parseArgs([...base, "--daily-rows", "0", "--passed-before", "2500"], env)).toMatchObject(
      { ok: true, options: { dailyRows: 0, passedBefore: 2500 } },
    );
    expect(parseArgs([...base, "--daily-rows", "-1"], env)).toMatchObject({ ok: false });
    expect(
      parseArgs(["--target", "https://a.example", "--cookie", "c", "--passed-before", "2500"], env),
    ).toMatchObject({ ok: false });
  });
  it("rejects a target that is not http(s)", () => {
    expect(normalizeTarget("ftp://x.example")).toBeNull();
    expect(normalizeTarget("not a url")).toBeNull();
  });
});

describe("checkTestInstance", () => {
  const marker = { testInstance: true, fakeCalendars: true, simulatedFetch: "ok" };
  it("accepts only the test marker", () => {
    expect(checkTestInstance(200, marker)).toBeNull();
    expect(checkTestInstance(404, "Not Found")).toMatch(/not a test instance/);
    expect(checkTestInstance(200, { ...marker, testInstance: false })).not.toBeNull();
    expect(checkTestInstance(200, null)).not.toBeNull();
  });
  it("refuses an instance with real accounts", () => {
    expect(checkTestInstance(409, { realAccounts: 2 })).toMatch(
      /2 accounts that are not simulated/,
    );
  });
  it("refuses an instance that cannot reach its fetch target", () => {
    expect(checkTestInstance(200, { ...marker, simulatedFetch: "failed" })).toMatch(/FETCH_URL/);
  });
});

describe("limitsWarning", () => {
  it("marks a local run and a run without a fetch target", () => {
    expect(limitsWarning("http://localhost:8787", { simulatedFetch: "ok" })).toMatch(/Local run/);
    expect(limitsWarning("https://a.example", { simulatedFetch: "off" })).toMatch(/subrequests/);
    expect(limitsWarning("https://a.example", { simulatedFetch: "ok" })).toBeNull();
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
  seed?: (events: number) => { status: number; body: unknown } | undefined;
  cycle?: () => { status: number; body: unknown } | undefined;
  stats?: (events: number, days: number) => Partial<Stats> | { status: number };
}) {
  let clock = 0;
  let events = 0;
  let days = 0;
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
            body: { testInstance: true, fakeCalendars: true, simulatedFetch: "ok" },
          }
        );
      }
      if (path.startsWith("/dev/seed")) {
        const query = new URLSearchParams(path.split("?")[1]);
        events = Number(query.get("events"));
        days = Number(query.get("days"));
        return handlers.seed?.(events) ?? { status: 200, body: { startedAt: "2026-10-30T10:00" } };
      }
      if (path === "/dev/cycle") {
        return handlers.cycle?.() ?? { status: 200, body: { started: 3 } };
      }
      const over = handlers.stats?.(events, days) ?? {};
      if ("status" in over) return { status: over.status, body: "" };
      return {
        status: 200,
        body: stats({
          ruleDays: { min: days, max: days },
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

  it("stops at a failing stage, names the stage before and goes on with the next window", async () => {
    const { io, calls } = instance({
      stats: (events, days) => (days === 90 && events === 2500 ? { blocks: 1 } : {}),
    });
    const outcome = await runProbe(options({ windows: [90, 365], stages: [1000, 2500] }), io);
    expect(outcome.exitCode).toBe(EXIT.stageFailed);
    expect(outcome.report).toContain("Stopped at 2500: 1 blocks instead of 15000.");
    expect(outcome.report).toContain("Passed up to 1000");
    expect(calls.filter((call) => call === "POST /dev/seed")).toHaveLength(4);
  });

  it("fails a stage in which a limit stopped the alarms without a trace", async () => {
    const { io } = instance({
      stats: (events) => (events === 2500 ? { lastRuns: [], runs: 2 } : {}),
    });
    const outcome = await runProbe(options(), io);
    expect(outcome.exitCode).toBe(EXIT.stageFailed);
    expect(outcome.verdicts[0]).toMatchObject({ lastPassed: 1000, failedAt: { events: 2500 } });
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
  });

  it("marks a run without a fetch target as no capacity statement", async () => {
    const { io } = instance({
      probe: () => ({ status: 200, body: { testInstance: true, fakeCalendars: true } }),
    });
    const outcome = await runProbe(options({ stages: [1000] }), io);
    expect(outcome.report).toContain("the limit of 50 cannot trip");
  });
});
