import { describe, expect, it } from "vitest";
import { LiveDriver, parseAdapterAnswer, type AdapterRequest } from "../suite/drivers/live";
import { exitCode, percentile, runScenario, runSuite } from "../suite/lib/runner";
import {
  SUITE_MARKER,
  SuiteAbort,
  UnsupportedScenario,
  type CalendarChange,
  type CalendarEntry,
  type CalendarSide,
  type Capability,
  type Manifest,
  type Scenario,
  type SuiteDriver,
} from "../suite/lib/scenario";

const NOW = Date.parse("2031-02-03T09:15:00Z");
const WINDOW: [string, string] = ["week@00:00Z", "week+7d@00:00Z"];

/** A tool in memory: it copies events to the target after one second, with an optional fault. */
class MemoryDriver implements SuiteDriver {
  readonly name = "memory";
  readonly mode = "simulated-clock";
  readonly directions = ["forward", "reverse"];
  capabilities: ReadonlySet<Capability> = new Set();
  clock = NOW;
  source = new Map<string, CalendarEntry>();
  target = new Map<string, CalendarEntry>();
  transform: (entry: CalendarEntry) => CalendarEntry = (entry) => entry;
  unsupported = false;
  cleaned = 0;
  providerCalls?: SuiteDriver["providerCalls"];

  now(): number {
    return this.clock;
  }

  prepare(): Promise<void> {
    if (this.unsupported) throw new UnsupportedScenario("No such rule.");
    this.source.clear();
    this.target.clear();
    return Promise.resolve();
  }

  write(_calendar: CalendarSide, { change, key, event }: CalendarChange): Promise<void> {
    if (change === "delete") {
      this.source.delete(key);
      return Promise.resolve();
    }
    const time = (value: unknown) => `${(value as { dateTime: string }).dateTime}.000Z`;
    this.source.set(key, {
      start: time(event?.start),
      end: time(event?.end),
      allDay: false,
      status: "busy",
      ...(event?.title ? { title: event.title } : {}),
    });
    return Promise.resolve();
  }

  read(calendar: CalendarSide): Promise<CalendarEntry[]> {
    return Promise.resolve([...(calendar === "source" ? this.source : this.target).values()]);
  }

  async waitForSync(wait: {
    until?: () => Promise<boolean>;
    timeoutSeconds: number;
  }): Promise<boolean> {
    this.clock += 1000;
    this.target = new Map(
      [...this.source].map(([key, entry]) => [key, this.transform(entry)] as const),
    );
    return wait.until ? wait.until() : false;
  }

  cleanup(): Promise<void> {
    this.cleaned += 1;
    return Promise.resolve();
  }
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "meeting",
    title: "A meeting",
    covers: "single event",
    expectedText: "Busy on Tuesday.",
    calendars: { source: { timeZone: "UTC" }, target: { timeZone: "UTC" } },
    steps: [
      {
        do: "write",
        change: "create",
        key: "meeting",
        event: { start: "week+1d@10:00Z", end: "week+1d@11:00Z", title: "SECRET" },
      },
      {
        do: "sync",
        expect: {
          window: WINDOW,
          busy: [["week+1d@10:00Z", "week+1d@11:00Z"]],
          forbidden: ["SECRET"],
        },
      },
    ],
    ...overrides,
  };
}

const withoutTitle = (entry: CalendarEntry): CalendarEntry => {
  const { title: _title, ...rest } = entry;
  return rest;
};

describe("runScenario", () => {
  it("passes a correct tool", async () => {
    const driver = new MemoryDriver();
    driver.transform = withoutTitle;
    const run = await runScenario(scenario(), driver, "forward");
    expect(run).toMatchObject({ status: "pass", text: "As expected." });
    expect(run.observed?.busy).toEqual([
      { start: "2031-02-11T10:00:00.000Z", end: "2031-02-11T11:00:00.000Z" },
    ]);
    expect(driver.cleaned).toBe(1);
  });

  it("fails a tool that shifts a block, and names the difference", async () => {
    const driver = new MemoryDriver();
    driver.transform = (entry) => ({
      ...withoutTitle(entry),
      end: "2031-02-11T11:30:00.000Z",
    });
    const run = await runScenario(scenario(), driver, "forward");
    expect(run.status).toBe("fail");
    expect(run.text).toContain("busy but must be free: 2031-02-11T11:00:00.000Z");
  });

  it("fails a tool that copies forbidden text", async () => {
    const run = await runScenario(scenario(), new MemoryDriver(), "forward");
    expect(run).toMatchObject({ status: "fail", text: "forbidden text found: SECRET" });
  });

  it("does not run a scenario that the driver cannot serve", async () => {
    const needs = await runScenario(
      scenario({ requires: ["clock"] }),
      new MemoryDriver(),
      "forward",
    );
    expect(needs).toMatchObject({ status: "not_run", text: "The driver offers no clock." });
    const driver = new MemoryDriver();
    driver.unsupported = true;
    expect(await runScenario(scenario(), driver, "forward")).toMatchObject({
      status: "not_run",
      text: "No such rule.",
    });
  });

  it("does not run a scenario whose anchor lies behind the window", async () => {
    const run = await runScenario(
      scenario({
        anchorZone: "Europe/Vienna",
        rule: { daysAhead: 30 },
        steps: [
          {
            do: "write",
            change: "create",
            key: "late",
            event: { start: "dst-fall@10:00Z", end: "dst-fall@11:00Z" },
          },
          { do: "expect", window: WINDOW, busy: [] },
        ],
      }),
      new MemoryDriver(),
      "forward",
    );
    expect(run.status).toBe("not_run");
  });

  it("waits for the window of the last advance before it calls a scenario too far", async () => {
    const steps = (days: number): Scenario["steps"] => [
      {
        do: "write",
        change: "create",
        key: "late",
        event: { start: `today+${days}d@10:00Z`, end: `today+${days}d@11:00Z` },
      },
      { do: "advance", to: "today+10d@00:00Z" },
      { do: "expect", window: WINDOW, busy: [] },
    ];
    const run = (days: number) =>
      runScenario(
        scenario({ rule: { daysAhead: 14 }, steps: steps(days) }),
        new MemoryDriver(),
        "f",
      );
    expect((await run(30)).status).toBe("not_run");
    const reached = await run(20);
    expect(reached.status).toBe("not_run");
    expect(reached.text).toBe("The driver cannot move the clock.");
  });

  it("does not run a series whose last occurrence lies behind the window", async () => {
    const steps: Scenario["steps"] = [
      {
        do: "write",
        change: "create",
        key: "weekly",
        event: {
          start: "week@10:00Z",
          end: "week@11:00Z",
          repeat: { every: "week", count: 10 },
        },
      },
      { do: "expect", window: WINDOW, busy: [] },
    ];
    const run = await runScenario(scenario({ steps }), new MemoryDriver(), "forward");
    expect(run).toMatchObject({ status: "not_run" });
    expect(run.text).toContain("behind the sync window");
  });

  it("marks a data check, so that it does not read as an empty target state", async () => {
    const driver = new MemoryDriver();
    driver.transform = withoutTitle;
    const steps: Scenario["steps"] = [
      ...scenario().steps.slice(0, 1),
      { do: "sync", expect: { window: WINDOW, minEntries: 1, forbidden: ["SECRET"] } },
    ];
    const run = await runScenario(scenario({ steps }), driver, "forward");
    expect(run.status).toBe("pass");
    expect(run.expected).toMatchObject({ busy: null, checks: "data" });
    expect(run.observed?.busy).toHaveLength(1);
  });

  it("fails an entry that the oracle cannot read, with the reason", async () => {
    const driver = new MemoryDriver();
    driver.transform = (entry) => withoutTitle({ ...entry, end: "soon" });
    const run = await runScenario(scenario(), driver, "forward");
    expect(run.status).toBe("fail");
    expect(run.text).toContain("The run stopped: An entry has an invalid time");
  });

  it("fails if no call came in the time of a required cycle", async () => {
    const driver = new MemoryDriver();
    driver.providerCalls = () => Promise.resolve(3);
    const steps: Scenario["steps"] = [
      { do: "expect-calls", calendar: "target", seconds: 600 },
      ...scenario().steps,
    ];
    const run = await runScenario(scenario({ steps }), driver, "forward");
    expect(run).toMatchObject({
      status: "fail",
      text: "No call in the 600 s in which a cycle must run.",
    });
    let calls = 0;
    driver.providerCalls = () => Promise.resolve(++calls);
    driver.transform = withoutTitle;
    expect((await runScenario(scenario({ steps }), driver, "forward")).status).toBe("pass");
  });

  it.each([
    ["expect-calls", undefined],
    ["expect-no-calls", undefined],
    ["expect-calls", Number.NaN],
    ["expect-no-calls", Number.NaN],
    ["expect-no-calls", -1],
  ] as const)("stops the run if %s gets %s as a call count", async (kind, count) => {
    const driver = new MemoryDriver();
    driver.providerCalls = () => Promise.resolve(count as unknown as number);
    const steps: Scenario["steps"] = [
      { do: kind, calendar: "target", seconds: 600 },
      ...scenario().steps,
    ];
    await expect(runScenario(scenario({ steps }), driver, "forward")).rejects.toThrow(SuiteAbort);
    expect(driver.cleaned).toBe(1);
  });

  it("stops the run if the call count falls during the wait", async () => {
    const driver = new MemoryDriver();
    let calls = 5;
    driver.providerCalls = () => Promise.resolve(calls--);
    const steps: Scenario["steps"] = [
      { do: "expect-no-calls", calendar: "target", seconds: 600 },
      ...scenario().steps,
    ];
    await expect(runScenario(scenario({ steps }), driver, "forward")).rejects.toThrow(SuiteAbort);
  });

  it("names the step that stopped a run, and no step for a run to its end", async () => {
    const driver = new MemoryDriver();
    const failed = await runScenario(scenario(), driver, "forward");
    expect(failed).toMatchObject({ status: "fail", failedStep: 2 });
    driver.transform = withoutTitle;
    const passed = await runScenario(scenario(), driver, "forward");
    expect(passed).toMatchObject({ status: "pass", failedStep: null });
  });

  it("reports a driver that throws as a failure", async () => {
    const driver = new MemoryDriver();
    driver.read = () => Promise.reject(new Error("read broke"));
    const run = await runScenario(scenario(), driver, "forward");
    expect(run).toMatchObject({ status: "fail", text: "The run stopped: read broke" });
    expect(driver.cleaned).toBe(1);
  });

  it("marks an exception as a stop, and a failed check, a pass or no run as none", async () => {
    const driver = new MemoryDriver();
    const failed = await runScenario(scenario(), driver, "forward");
    expect(failed).toMatchObject({ status: "fail", stopped: false });
    driver.transform = withoutTitle;
    const passed = await runScenario(scenario(), driver, "forward");
    expect(passed).toMatchObject({ status: "pass", stopped: false });
    driver.unsupported = true;
    const notRun = await runScenario(scenario(), driver, "forward");
    expect(notRun).toMatchObject({ status: "not_run", stopped: false });
    driver.unsupported = false;
    driver.read = () => Promise.reject(new Error("read broke"));
    const stopped = await runScenario(scenario(), driver, "forward");
    expect(stopped).toMatchObject({ status: "fail", stopped: true, failedStep: 2 });
  });

  it("marks an entry that the oracle cannot read as a stop", async () => {
    const driver = new MemoryDriver();
    driver.transform = (entry) => withoutTitle({ ...entry, end: "soon" });
    const run = await runScenario(scenario(), driver, "forward");
    expect(run).toMatchObject({ status: "fail", stopped: true });
  });

  it("marks a fault that never fired as a failure of the tool, not as a stop", async () => {
    const driver = new MemoryDriver();
    Object.assign(driver, { faultsFired: () => Promise.resolve(false) });
    const steps: Scenario["steps"] = [{ do: "wait-for-fault", timeoutSeconds: 0 }];
    const run = await runScenario(scenario({ steps }), driver, "forward");
    expect(run).toMatchObject({ status: "fail", stopped: false });
  });
});

const MANIFEST: Manifest = {
  suite: "s",
  version: "v1",
  frozenAt: "2026-10-30",
  scenarios: ["meeting"],
};
const STAMP = {
  commit: "abc",
  dirty: false,
  listHash: "hash",
  runAt: "2031-02-03T09:15:00Z",
  scenarioId: "meeting",
};

describe("runSuite", () => {
  const manifest: Manifest = { suite: "s", version: "v1", frozenAt: "2026-10-30", scenarios: [] };
  const options = {
    commit: "abc",
    dirty: true,
    listHash: "hash",
    runAt: "2026-10-30T00:00:00.000Z",
  };

  it("writes one row per scenario, and one failed direction fails the row", async () => {
    const driver = new MemoryDriver();
    let reads = 0;
    const read = driver.read.bind(driver);
    driver.transform = withoutTitle;
    driver.read = async (calendar) => {
      reads += 1;
      return reads > 2 ? [] : read(calendar);
    };
    const result = await runSuite(manifest, [scenario()], driver, {
      ...options,
      scenarioId: "meeting",
    });
    expect(result).toMatchObject({
      suiteVersion: "v1",
      commit: "abc",
      dirty: true,
      listHash: "hash",
      scope: "selected",
      driver: { name: "memory", mode: "simulated-clock" },
      summary: { pass: 0, fail: 1, not_run: 0 },
      latency: null,
    });
    expect(result.scenarios[0]?.directions.map((run) => run.status)).toEqual(["pass", "fail"]);
  });

  it("reports a simulated run as a self-test and not as a measurement", async () => {
    const driver = new MemoryDriver();
    driver.transform = withoutTitle;
    const result = await runSuite(manifest, [scenario()], driver, options);
    expect(result.scope).toBe("all");
    expect(result.latency).toEqual({
      mode: "simulated-clock",
      samplesPerDirection: { forward: 20, reverse: 20 },
      timedOut: 0,
      incomplete: false,
      pollMs: null,
      p50Ms: null,
      p95Ms: null,
      selfTestMs: { p50: 1000, p95: 1000 },
    });
  });

  it("measures latency in real time and keeps all samples inside the window", async () => {
    const driver = new MemoryDriver();
    Object.assign(driver, { mode: "real-time" });
    driver.transform = withoutTitle;
    const starts: number[] = [];
    const write = driver.write.bind(driver);
    driver.write = (calendar, change) => {
      const start = change.event?.start;
      if (start && "dateTime" in start) starts.push(Date.parse(`${start.dateTime}Z`));
      return write(calendar, change);
    };
    const result = await runSuite(manifest, [scenario()], driver, options);
    expect(result.latency).toMatchObject({ p50Ms: 1000, p95Ms: 1000, selfTestMs: null });
    const windowEnd = Date.parse("2031-02-03T00:00:00Z") + 30 * 86_400_000;
    expect(Math.max(...starts)).toBeLessThan(windowEnd);
  });

  it("says that the adapter stated the mode, and gives the grid of the latency values", async () => {
    const adapter = (request: AdapterRequest) => {
      if (request.op === "describe") {
        return Promise.resolve({ value: { name: "tool", mode: "real-time" } });
      }
      if (request.op !== "read") return Promise.resolve({});
      const entry = {
        start: request.window.start,
        end: request.window.end,
        allDay: false,
        status: "busy",
        owner: "tool",
      };
      return Promise.resolve({ value: [entry] });
    };
    const driver = await new LiveDriver(adapter, { pollMs: 7 }).start();
    const steps: Scenario["steps"] = [{ do: "expect", window: WINDOW, required: ["tool"] }];
    const result = await runSuite(manifest, [scenario({ steps })], driver, options);
    expect(result.driver).toEqual({
      name: "live:tool",
      mode: "real-time",
      modeSource: "adapter",
      allowForeign: 0,
    });
    expect(result.latency?.pollMs).toBe(7);
  });

  it("gives no grid and no outside source of the mode for a driver of its own", async () => {
    const driver = new MemoryDriver();
    driver.transform = withoutTitle;
    const result = await runSuite(manifest, [scenario()], driver, options);
    expect(result.driver.modeSource).toBe("driver");
    expect(result.latency?.pollMs).toBeNull();
  });

  it("counts a sample that times out at the limit and marks the measurement", async () => {
    const driver = new MemoryDriver();
    Object.assign(driver, { mode: "real-time" });
    driver.transform = withoutTitle;
    let writes = 0;
    const write = driver.write.bind(driver);
    driver.write = async (calendar, change) => {
      if (change.key.startsWith("sample-") && ++writes % 2 === 0) return;
      await write(calendar, change);
    };
    const { latency } = await runSuite(manifest, [scenario()], driver, options);
    expect(latency).toMatchObject({
      samplesPerDirection: { forward: 20, reverse: 20 },
      timedOut: 20,
      incomplete: true,
      p50Ms: 1000,
      p95Ms: 900_000,
    });
  });

  it("does not pass a run without a direction", async () => {
    const driver = new MemoryDriver();
    Object.assign(driver, { directions: [] });
    const result = await runSuite(manifest, [scenario()], driver, options);
    expect(result.summary).toEqual({ pass: 0, fail: 0, not_run: 1 });
    expect(result.scenarios[0]).toMatchObject({
      status: "not_run",
      text: "The driver offers no direction.",
    });
    expect(result.latency?.incomplete).toBe(true);
    expect(exitCode(result)).toBe(1);
  });

  it("repeats the local limit of a scenario on simulated calendars only", async () => {
    const driver = new MemoryDriver();
    driver.transform = withoutTitle;
    const limited = scenario({ localLimit: "Only a live run shows this." });
    const local = await runSuite(manifest, [limited], driver, {
      ...options,
      scenarioId: "meeting",
    });
    expect(local.scenarios[0]?.local_limit).toBe("Only a live run shows this.");
    Object.assign(driver, { mode: "real-time" });
    const live = await runSuite(manifest, [limited], driver, { ...options, scenarioId: "meeting" });
    expect(live.scenarios[0]?.local_limit).toBeNull();
  });

  it("refuses an unknown scenario", async () => {
    await expect(
      runSuite(manifest, [scenario()], new MemoryDriver(), { ...options, scenarioId: "none" }),
    ).rejects.toThrow("Unknown scenario");
  });
});

describe("parseAdapterAnswer", () => {
  it("reads a JSON object, and no output as an empty answer", () => {
    expect(parseAdapterAnswer("read", '{ "value": [] }\n')).toEqual({ value: [] });
    expect(parseAdapterAnswer("write", " \n")).toEqual({});
  });

  it.each([
    ["no JSON", "not json"],
    ["cut JSON", '{ "value": ['],
    ["null", "null"],
    ["a list", "[]"],
    ["a number", "5"],
  ])("stops the run on %s, and repeats none of the output", (_name, stdout) => {
    const answer = () => parseAdapterAnswer("read", stdout);
    expect(answer).toThrow(SuiteAbort);
    expect(answer).toThrow("The adapter gave no JSON object on read.");
  });
});

describe("exitCode", () => {
  it("is 0 only with a passed scenario and without a failed one", () => {
    const code = (pass: number, fail: number, not_run: number) =>
      exitCode({ summary: { pass, fail, not_run } });
    expect(code(1, 0, 3)).toBe(0);
    expect(code(0, 0, 3)).toBe(1);
    expect(code(0, 0, 0)).toBe(1);
    expect(code(3, 1, 0)).toBe(1);
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile(samples, 0.5)).toBe(10);
    expect(percentile(samples, 0.95)).toBe(19);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("LiveDriver", () => {
  const description = { name: "tool", mode: "real-time" };
  const owned = (id: string, owner?: "suite" | "tool"): CalendarEntry => ({
    id,
    start: "2031-03-11T10:00:00.000Z",
    end: "2031-03-11T11:00:00.000Z",
    allDay: false,
    status: "busy",
    ...(owner ? { owner } : {}),
  });

  /** An adapter with one list of entries per calendar. */
  function memoryAdapter(entries: Record<CalendarSide, CalendarEntry[]>) {
    const requests: AdapterRequest[] = [];
    const adapter = (request: AdapterRequest) => {
      requests.push(request);
      if (request.op === "describe") return Promise.resolve({ value: description });
      if (request.op === "write") {
        const time = (value: unknown) => `${(value as { dateTime: string }).dateTime}.000Z`;
        const { start, end } = request.change.event ?? {};
        const entry: CalendarEntry = {
          start: time(start),
          end: time(end),
          allDay: false,
          status: "busy",
          owner: "suite",
        };
        entries.source.push(entry);
        entries.target.push({ ...entry, owner: "tool" });
      }
      if (request.op === "read") return Promise.resolve({ value: entries[request.calendar] });
      return Promise.resolve({});
    };
    return { adapter, requests, ops: () => requests.map((request) => request.op) };
  }

  it("gives every calendar access to the adapter and runs a scenario through it", async () => {
    const { adapter, requests, ops } = memoryAdapter({ source: [], target: [] });
    const driver = await new LiveDriver(adapter, { pollMs: 1 }).start();
    expect(driver.name).toBe("live:tool");
    expect(driver.mode).toBe("real-time");
    expect(driver.capabilities.size).toBe(0);
    const run = await runScenario(scenario(), driver, "forward");
    expect(run).toMatchObject({ status: "pass", text: "As expected." });
    expect(ops()).toEqual(expect.arrayContaining(["prepare", "write", "read", "cleanup"]));
    const marked = requests.filter(
      (request) => request.op === "prepare" || request.op === "write" || request.op === "cleanup",
    );
    expect(marked.map((request) => request.marker)).toEqual(marked.map(() => SUITE_MARKER));
  });

  it("takes the mode from the adapter and refuses an adapter without one", async () => {
    const answer = (value: unknown) => () => Promise.resolve({ value });
    const simulated = { name: "tool", mode: "simulated-clock" };
    expect((await new LiveDriver(answer(simulated)).start()).mode).toBe("simulated-clock");
    await expect(new LiveDriver(answer({ name: "tool" })).start()).rejects.toThrow(SuiteAbort);
  });

  it("stops the run on a foreign entry, before the adapter empties anything", async () => {
    const { adapter, ops } = memoryAdapter({ source: [], target: [owned("private-event")] });
    const driver = await new LiveDriver(adapter, { pollMs: 1 }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(
      "1 foreign entries in the calendars: private-event",
    );
    expect(ops()).not.toContain("prepare");
    expect(ops()).not.toContain("cleanup");
  });

  it.each([null, "", "other", "Suite", 0, false])(
    "takes an entry with the owner %j for a foreign entry",
    async (owner) => {
      const entry = { ...owned("real-event"), owner } as unknown as CalendarEntry;
      const { adapter, ops } = memoryAdapter({ source: [entry], target: [] });
      const driver = await new LiveDriver(adapter, { pollMs: 1 }).start();
      await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(
        "1 foreign entries in the calendars: real-event",
      );
      expect(ops()).not.toContain("prepare");
      expect(ops()).not.toContain("cleanup");
    },
  );

  it("reads back what the suite and the tool wrote without a stop", async () => {
    const { adapter, ops } = memoryAdapter({
      source: [owned("old-event", "suite")],
      target: [owned("old-block", "tool")],
    });
    const driver = await new LiveDriver(adapter, { pollMs: 1 }).start();
    await driver.prepare({ scenario: scenario(), direction: "forward" });
    expect(ops()).toContain("prepare");
  });

  it("goes on with a named foreign entry and hides it from the checks", async () => {
    const { adapter } = memoryAdapter({ source: [], target: [owned("named")] });
    const driver = await new LiveDriver(adapter, { pollMs: 1, allowForeign: ["named"] }).start();
    const run = await runScenario(scenario(), driver, "forward");
    expect(run.status).toBe("pass");
    expect(run.observed?.busy).toHaveLength(1);
  });

  it("names the foreign entries of the option in the result", async () => {
    const { adapter } = memoryAdapter({ source: [], target: [owned("named")] });
    const driver = await new LiveDriver(adapter, {
      pollMs: 1,
      allowForeign: ["named", "other"],
    }).start();
    const result = await runSuite(MANIFEST, [scenario()], driver, STAMP);
    expect(result.driver.allowForeign).toBe(2);
  });

  it.each(["tool", "suite"] as const)(
    "does not hide an entry with the owner %s, also if the option names its ID",
    async (owner) => {
      const { adapter } = memoryAdapter({ source: [], target: [owned("named", owner)] });
      const driver = await new LiveDriver(adapter, { pollMs: 1, allowForeign: ["named"] }).start();
      const entries = await driver.read("target", { start: "a", end: "b" });
      expect(entries.map((entry) => entry.id)).toEqual(["named"]);
    },
  );

  it("does not take a foreign entry without an ID, whatever the switch names", async () => {
    const { id: _id, ...nameless } = owned("x");
    const { adapter } = memoryAdapter({ source: [nameless], target: [] });
    const driver = await new LiveDriver(adapter, { pollMs: 1, allowForeign: ["x"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow("without ID");
  });

  it("stops the run if the adapter deleted a named foreign entry", async () => {
    const entries = { source: [owned("named")], target: [] };
    const { adapter } = memoryAdapter(entries);
    const greedy = (request: AdapterRequest) => {
      if (request.op === "prepare") entries.source = [];
      return adapter(request);
    };
    const driver = await new LiveDriver(greedy, { pollMs: 1, allowForeign: ["named"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(
      "The adapter deleted a foreign entry",
    );
  });

  it("sends no cleanup to an adapter that deleted a foreign entry", async () => {
    const entries = { source: [owned("named")], target: [] };
    const { adapter, ops } = memoryAdapter(entries);
    const greedy = (request: AdapterRequest) => {
      if (request.op === "prepare") entries.source = [];
      return adapter(request);
    };
    const driver = await new LiveDriver(greedy, { pollMs: 1, allowForeign: ["named"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(SuiteAbort);
    expect(ops()).toContain("prepare");
    expect(ops()).not.toContain("cleanup");
  });

  it("stops the run if a cleanup deleted a named foreign entry, before the next prepare", async () => {
    const entries = { source: [owned("named")], target: [] };
    const { adapter, ops } = memoryAdapter(entries);
    const greedy = (request: AdapterRequest) => {
      if (request.op === "cleanup") entries.source = [];
      return adapter(request);
    };
    const driver = await new LiveDriver(greedy, { pollMs: 1, allowForeign: ["named"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(
      "The adapter deleted a foreign entry",
    );
    expect(ops().filter((op) => op === "prepare")).toHaveLength(1);
  });

  it("stops the run if a named foreign entry went between two runs", async () => {
    const entries = { source: [owned("named")], target: [] };
    const { adapter, ops } = memoryAdapter(entries);
    const driver = await new LiveDriver(adapter, { pollMs: 1, allowForeign: ["named"] }).start();
    await runScenario(scenario(), driver, "forward");
    entries.source = [];
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(SuiteAbort);
    expect(ops().filter((op) => op === "prepare")).toHaveLength(1);
  });

  it("stops the run if the owner of a named foreign entry changes to the suite", async () => {
    const entries = { source: [owned("named")], target: [] };
    const { adapter } = memoryAdapter(entries);
    const marking = (request: AdapterRequest) => {
      if (request.op === "prepare") entries.source = [owned("named", "suite")];
      return adapter(request);
    };
    const driver = await new LiveDriver(marking, { pollMs: 1, allowForeign: ["named"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(SuiteAbort);
  });

  it("keeps a named foreign entry over several runs", async () => {
    const { adapter } = memoryAdapter({ source: [owned("named")], target: [] });
    const driver = await new LiveDriver(adapter, { pollMs: 1, allowForeign: ["named"] }).start();
    for (const direction of ["forward", "reverse"]) {
      expect((await runScenario(scenario(), driver, direction)).stopped).toBe(false);
    }
  });

  it("reads no calendar after a cleanup if neither calendar holds a foreign entry", async () => {
    const { adapter, ops } = memoryAdapter({ source: [], target: [] });
    const driver = await new LiveDriver(adapter, { pollMs: 1 }).start();
    await runScenario(scenario(), driver, "forward");
    expect(ops().at(-1)).toBe("cleanup");
  });

  it("tells the same ID in two calendars apart: a cleanup deletes one of them", async () => {
    const entries = { source: [owned("x")], target: [owned("x")] };
    const { adapter } = memoryAdapter(entries);
    const greedy = (request: AdapterRequest) => {
      if (request.op === "cleanup") entries.source = [];
      return adapter(request);
    };
    const driver = await new LiveDriver(greedy, { pollMs: 1, allowForeign: ["x"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(
      "The adapter deleted a foreign entry",
    );
  });

  it("tells the same ID in two calendars apart: a prepare deletes one of them", async () => {
    const entries = { source: [owned("x")], target: [owned("x")] };
    const { adapter, ops } = memoryAdapter(entries);
    const greedy = (request: AdapterRequest) => {
      if (request.op === "prepare") entries.target = [];
      return adapter(request);
    };
    const driver = await new LiveDriver(greedy, { pollMs: 1, allowForeign: ["x"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(SuiteAbort);
    expect(ops()).not.toContain("cleanup");
  });

  /** An adapter whose calendar gets `entry` with the first write of the suite. */
  function appearing(entry: CalendarEntry, onCleanup: (target: CalendarEntry[]) => void) {
    const entries: Record<CalendarSide, CalendarEntry[]> = { source: [], target: [] };
    const memory = memoryAdapter(entries);
    const adapter = (request: AdapterRequest) => {
      if (request.op === "write") entries.target.push(entry);
      if (request.op === "cleanup") onCleanup(entries.target);
      return memory.adapter(request);
    };
    return { ...memory, adapter, entries };
  }

  it("stops the run if a cleanup deletes a named entry that came during the run", async () => {
    const { adapter } = appearing(owned("x"), (target) => {
      target.splice(0, target.length);
    });
    const driver = await new LiveDriver(adapter, { pollMs: 1, allowForeign: ["x"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(
      "The adapter deleted a foreign entry",
    );
  });

  it("goes on if a named entry that came during the run stays", async () => {
    const { adapter } = appearing(owned("x"), () => undefined);
    const driver = await new LiveDriver(adapter, { pollMs: 1, allowForeign: ["x"] }).start();
    const run = await runScenario(scenario(), driver, "forward");
    expect(run).toMatchObject({ status: "pass", stopped: false });
  });

  it("stops the run if a cleanup deletes an entry without an ID that came during the run", async () => {
    const { id: _id, ...nameless } = owned("x");
    const { adapter } = appearing(nameless, (target) => {
      target.splice(0, target.length);
    });
    const driver = await new LiveDriver(adapter, { pollMs: 1 }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(
      "The adapter deleted a foreign entry",
    );
  });

  it("sends no cleanup if a named foreign entry went during the run", async () => {
    const entries = { source: [owned("named")], target: [] };
    const { adapter, ops } = memoryAdapter(entries);
    const greedy = (request: AdapterRequest) => {
      if (request.op === "write") entries.source = [];
      return adapter(request);
    };
    const driver = await new LiveDriver(greedy, { pollMs: 1, allowForeign: ["named"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(SuiteAbort);
    expect(ops()).not.toContain("cleanup");
  });

  it("stops the run if an entry goes that first showed in the read after a prepare", async () => {
    const entries: Record<CalendarSide, CalendarEntry[]> = { source: [], target: [] };
    const { adapter, ops } = memoryAdapter(entries);
    const brief = (request: AdapterRequest) => {
      if (request.op === "prepare") entries.target = [owned("x")];
      if (request.op === "write") entries.target = [];
      return adapter(request);
    };
    const driver = await new LiveDriver(brief, { pollMs: 1 }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(
      "The adapter deleted a foreign entry",
    );
    expect(ops()).not.toContain("cleanup");
  });

  it.each([
    ["a foreign entry", []],
    ["a named foreign entry", ["x"]],
  ])("stops the run if %s goes that only a read of a scenario saw", async (_name, allowForeign) => {
    const entries: Record<CalendarSide, CalendarEntry[]> = { source: [], target: [] };
    const { adapter, ops } = memoryAdapter(entries);
    const driver = await new LiveDriver(adapter, { pollMs: 1, allowForeign }).start();
    await driver.prepare({ scenario: scenario(), direction: "forward" });
    entries.target = [owned("x")];
    await driver.read("target", { start: "a", end: "b" });
    entries.target = [];
    await expect(driver.cleanup()).rejects.toThrow("The adapter deleted a foreign entry");
    expect(ops()).not.toContain("cleanup");
  });

  it("takes no entry for gone because a read of a scenario covers a part of the time", async () => {
    const { adapter, ops } = memoryAdapter({ source: [owned("named")], target: [] });
    const partial = (request: AdapterRequest) =>
      request.op === "read" && request.window.start === "a"
        ? Promise.resolve({ value: [] })
        : adapter(request);
    const driver = await new LiveDriver(partial, { pollMs: 1, allowForeign: ["named"] }).start();
    await driver.prepare({ scenario: scenario(), direction: "forward" });
    expect(await driver.read("source", { start: "a", end: "b" })).toEqual([]);
    await driver.cleanup();
    expect(ops()).toContain("cleanup");
  });

  it("stops the run if an entry goes that first showed in the read after a cleanup", async () => {
    const entries: Record<CalendarSide, CalendarEntry[]> = {
      source: [owned("named")],
      target: [],
    };
    const { adapter, ops } = memoryAdapter(entries);
    const late = (request: AdapterRequest) => {
      if (request.op === "cleanup") entries.target = [owned("y")];
      return adapter(request);
    };
    const driver = await new LiveDriver(late, { pollMs: 1, allowForeign: ["named"] }).start();
    await runScenario(scenario(), driver, "forward");
    entries.target = [];
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(
      "The adapter deleted a foreign entry",
    );
    expect(ops().filter((op) => op === "prepare")).toHaveLength(1);
  });

  it.each([
    ["person-a", "person-b"],
    [null, "person-b"],
    [{ name: "person-a" }, { name: "person-b" }],
  ])("stops the run if the owner of a foreign entry changes from %j to %j", async (from, to) => {
    const withOwner = (owner: unknown) =>
      ({ ...owned("named"), owner }) as unknown as CalendarEntry;
    const entries = { source: [withOwner(from)], target: [] };
    const { adapter, ops } = memoryAdapter(entries);
    const changing = (request: AdapterRequest) => {
      if (request.op === "prepare") entries.source = [withOwner(to)];
      return adapter(request);
    };
    const driver = await new LiveDriver(changing, { pollMs: 1, allowForeign: ["named"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow("changed its owner");
    expect(ops()).not.toContain("cleanup");
  });

  it.each(["person-a", null, { name: "person-a" }])(
    "goes on while a foreign entry keeps the owner %j, each read with a new object",
    async (owner) => {
      const entry = { ...owned("named"), owner } as unknown as CalendarEntry;
      const { adapter } = memoryAdapter({ source: [entry], target: [] });
      const parsed = async (request: AdapterRequest) =>
        structuredClone(await adapter(request)) as Awaited<ReturnType<typeof adapter>>;
      const driver = await new LiveDriver(parsed, { pollMs: 1, allowForeign: ["named"] }).start();
      const run = await runScenario(scenario(), driver, "forward");
      expect(run.stopped).toBe(false);
    },
  );

  it.each([
    ["without a value", {}],
    ["with null", { value: null }],
    ["with an object", { value: { entries: [] } }],
    ["with a list of text", { value: ["entry"] }],
    ["with a list that holds null", { value: [null] }],
  ])("stops the run if the adapter answers read %s", async (_name, answer) => {
    const { adapter, ops } = memoryAdapter({ source: [], target: [] });
    const broken = (request: AdapterRequest) =>
      request.op === "read" ? Promise.resolve(answer) : adapter(request);
    const driver = await new LiveDriver(broken, { pollMs: 1 }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(SuiteAbort);
    expect(ops()).not.toContain("prepare");
  });

  it("stops the run if a read of the lock fails, before the adapter gets a prepare", async () => {
    const { adapter, ops } = memoryAdapter({ source: [], target: [] });
    const failing = (request: AdapterRequest) =>
      request.op === "read" ? Promise.reject(new Error("exit code 1")) : adapter(request);
    const driver = await new LiveDriver(failing, { pollMs: 1 }).start();
    const run = runScenario(scenario(), driver, "forward");
    await expect(run).rejects.toThrow(SuiteAbort);
    await expect(run).rejects.toThrow("exit code 1");
    expect(ops()).not.toContain("prepare");
    expect(ops()).not.toContain("cleanup");
  });

  it("stops the run if the read of the lock after a prepare fails", async () => {
    const { adapter, ops } = memoryAdapter({ source: [], target: [] });
    let reads = 0;
    const failing = (request: AdapterRequest) => {
      if (request.op !== "read") return adapter(request);
      reads += 1;
      return reads > 2 ? Promise.reject(new Error("exit code 1")) : adapter(request);
    };
    const driver = await new LiveDriver(failing, { pollMs: 1 }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(SuiteAbort);
    expect(ops()).toContain("prepare");
    expect(ops()).not.toContain("cleanup");
  });

  it("stops the run if the read of the lock after a cleanup fails", async () => {
    const { adapter, ops } = memoryAdapter({ source: [owned("named")], target: [] });
    let cleaned = false;
    const failing = (request: AdapterRequest) => {
      if (request.op === "cleanup") cleaned = true;
      if (request.op === "read" && cleaned) return Promise.reject(new Error("exit code 1"));
      return adapter(request);
    };
    const driver = await new LiveDriver(failing, { pollMs: 1, allowForeign: ["named"] }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(SuiteAbort);
    expect(ops()).toContain("cleanup");
  });

  it("keeps a failed read in a check to its scenario, as a stopped run", async () => {
    const { adapter, ops } = memoryAdapter({ source: [], target: [] });
    let reads = 0;
    const failing = (request: AdapterRequest) => {
      if (request.op !== "read") return adapter(request);
      reads += 1;
      return reads === 5 ? Promise.reject(new Error("exit code 1")) : adapter(request);
    };
    const driver = await new LiveDriver(failing, { pollMs: 1 }).start();
    const run = await runScenario(scenario(), driver, "forward");
    expect(run).toMatchObject({ status: "fail", stopped: true, failedStep: 2 });
    expect(run.text).toContain("exit code 1");
    expect(ops()).toContain("cleanup");
  });

  it("sends no cleanup if the read before it fails: the lock then sees nothing", async () => {
    const { adapter, ops } = memoryAdapter({ source: [], target: [] });
    let reads = 0;
    const failing = (request: AdapterRequest) => {
      if (request.op !== "read") return adapter(request);
      reads += 1;
      return reads > 4 ? Promise.reject(new Error("exit code 1")) : adapter(request);
    };
    const driver = await new LiveDriver(failing, { pollMs: 1 }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(SuiteAbort);
    expect(ops()).toContain("prepare");
    expect(ops()).not.toContain("cleanup");
  });

  it("stops the run if read loses its value during a check", async () => {
    const { adapter, ops } = memoryAdapter({ source: [], target: [] });
    let reads = 0;
    const fading = (request: AdapterRequest) => {
      if (request.op !== "read") return adapter(request);
      reads += 1;
      return reads > 4 ? Promise.resolve({}) : adapter(request);
    };
    const driver = await new LiveDriver(fading, { pollMs: 1 }).start();
    await expect(runScenario(scenario(), driver, "forward")).rejects.toThrow(
      "The adapter gave no list of entries",
    );
    expect(ops()).not.toContain("cleanup");
  });

  it("stops the run if the adapter answers provider-calls without a value", async () => {
    const { adapter } = memoryAdapter({ source: [], target: [] });
    const driver = await new LiveDriver(adapter, { pollMs: 1 }).start();
    const steps: Scenario["steps"] = [
      { do: "expect-no-calls", calendar: "target", seconds: 0 },
      ...scenario().steps,
    ];
    await expect(runScenario(scenario({ steps }), driver, "forward")).rejects.toThrow(
      "no call count",
    );
  });

  it("gives up after the timeout of the step", async () => {
    const { adapter } = memoryAdapter({ source: [], target: [] });
    const driver = await new LiveDriver(adapter, { pollMs: 1 }).start();
    const steps: Scenario["steps"] = [
      {
        do: "sync",
        timeoutSeconds: 0,
        expect: { window: WINDOW, busy: [["week+1d@10:00Z", "week+1d@11:00Z"]] },
      },
    ];
    const run = await runScenario(scenario({ steps }), driver, "forward");
    expect(run.status).toBe("fail");
    expect(run.text).toContain("free but must be busy");
  });

  it("turns an unsupported answer into not_run", async () => {
    const { adapter } = memoryAdapter({ source: [], target: [] });
    const refusing = (request: AdapterRequest) =>
      request.op === "prepare" ? Promise.resolve({ unsupported: "No buffers." }) : adapter(request);
    const driver = await new LiveDriver(refusing, { pollMs: 1 }).start();
    expect(await runScenario(scenario(), driver, "forward")).toMatchObject({
      status: "not_run",
      text: "No buffers.",
    });
  });
});
