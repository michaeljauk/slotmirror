import { describe, expect, it } from "vitest";
import {
  STAGES,
  checkTestInstance,
  formatReport,
  isSettled,
  judgeWindow,
  limitsStatement,
  normalizeTarget,
  parseArgs,
  stageFailures,
  summarizeStage,
  type Stats,
} from "../scripts/capacity-probe-lib";

const stats = (over: Partial<Stats> = {}): Stats => ({
  accounts: 3,
  rules: 6,
  calls: { sourceEvents: 12, applyBatch: 30 },
  runs: 6,
  writes: 100,
  failedWrites: 0,
  throttledWrites: 0,
  sumStepMs: 600,
  maxStepMs: 180,
  lastRunAt: "2026-10-30T10:00:00.000Z",
  failedRuns: 0,
  ...over,
});

const stage = (events: number, over: Partial<Stats> = {}, settled = true) =>
  summarizeStage({ windowDays: 90, events, stats: stats(over), settled, durationMs: 5000 });

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
  it("rejects a target that is not http(s)", () => {
    expect(normalizeTarget("ftp://x.example")).toBeNull();
    expect(normalizeTarget("not a url")).toBeNull();
  });
});

describe("checkTestInstance", () => {
  it("accepts only the test marker", () => {
    expect(checkTestInstance(200, { testInstance: true, fakeCalendars: true })).toBeNull();
    expect(checkTestInstance(404, "Not Found")).toMatch(/not a test instance/);
    expect(checkTestInstance(200, { testInstance: false, fakeCalendars: true })).not.toBeNull();
    expect(checkTestInstance(200, null)).not.toBeNull();
  });
});

describe("isSettled", () => {
  it("settles after a quiet period with at least one run", () => {
    let state = { runs: 0, changedAt: 0 };
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
  it("restarts the quiet period when a run arrives", () => {
    const result = isSettled({ runs: 5, changedAt: 0 }, 6, 30_000, 20_000);
    expect(result).toMatchObject({ settled: false, state: { runs: 6, changedAt: 30_000 } });
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
});

describe("judgeWindow", () => {
  it("stops at the first failing stage and names the stage before it", () => {
    const verdict = judgeWindow(90, [
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
    const verdict = judgeWindow(365, [stage(1000, { failedRuns: 1 })]);
    expect(verdict.lastPassed).toBeNull();
    expect(limitsStatement(verdict)).toContain("No stage passed");
  });
  it("passes a run that clears every stage", () => {
    const verdict = judgeWindow(
      90,
      STAGES.map((n) => stage(n)),
    );
    expect(verdict).toMatchObject({ failedAt: null, lastPassed: 10_000 });
  });
});

describe("formatReport", () => {
  it("lists every window with its stages and the statement", () => {
    const report = formatReport([judgeWindow(90, [stage(1000), stage(2500, { failedRuns: 1 })])]);
    expect(report).toContain("## Window 90 days");
    expect(report).toContain("| 1000 |");
    expect(report).toContain("Stopped at 2500");
    expect(report).toContain("Passed up to 1000");
  });
});
