// The spies keep the original methods and call them with their own `this`.
// oxlint-disable typescript/unbound-method
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCalendar } from "../../src/providers/fake-calendar.ts";
import { LocalDriver } from "../drivers/local.ts";
import { runScenario } from "../lib/runner.ts";
import type { CalendarSide, Scenario } from "../lib/scenario.ts";
import type { DirectionRun } from "../lib/runner.ts";

declare const __SUITE_INPUT__: { scenarios: Scenario[] };

type Batch = Parameters<FakeCalendar["applyBatch"]>[2];
type Action = Batch[number];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DIRECTIONS = ["forward", "reverse"];

/**
 * The proof that a real fault of the engine turns a scenario red through `LocalDriver`. Each case
 * disturbs the engine at the edge of the calendar, or by a rule setting that makes it copy details.
 * The real alarms, plans and reads run, and only the oracle decides.
 *
 * `pnpm suite:proof` runs this file, with the config of the local run.
 */
function scenarioNamed(id: string): Scenario {
  const scenario = __SUITE_INPUT__.scenarios.find((item) => item.id === id);
  if (!scenario) throw new Error(`No scenario ${id}`);
  return scenario;
}

function moved(time: string, ms: number): string {
  return new Date(Date.parse(time) + ms).toISOString();
}

/**
 * A driver for a fault that starts inside a run, for example at the `advance`. The fault ends with
 * the run, or it would also be active from the start of the next direction, in another step.
 */
class FaultyDriver extends LocalDriver {
  override async cleanup(): Promise<void> {
    vi.restoreAllMocks();
    await super.cleanup();
  }
}

/** Every batch of the engine passes through `change` before it reaches the calendar. */
function disturbWrites(change: (action: Action) => Action[]): void {
  const applyBatch = FakeCalendar.prototype.applyBatch;
  vi.spyOn(FakeCalendar.prototype, "applyBatch").mockImplementation(function (
    this: FakeCalendar,
    calendarId,
    ruleTag,
    actions,
  ) {
    return applyBatch.call(this, calendarId, ruleTag, actions.flatMap(change));
  });
}

function withBlock(action: Action, change: (block: Action & { kind: "create" }) => Action): Action {
  return action.kind === "create" ? change(action) : action;
}

/** One run after the other: the clock of the isolate allows no two at a time. */
async function run(scenario: Scenario, driver = new LocalDriver()) {
  const results = [];
  for (const direction of DIRECTIONS) results.push(await runScenario(scenario, driver, direction));
  return results;
}

/** The number of the last step of a kind: the step at which a case claims that its fault shows. */
function lastStep(id: string, kind: Scenario["steps"][number]["do"]): number {
  return scenarioNamed(id).steps.findLastIndex((step) => step.do === kind) + 1;
}

/** Every direction is red in the step of `id` that the case claims, and with the claimed text. */
function expectRed(
  results: DirectionRun[],
  id: string,
  kind: Scenario["steps"][number]["do"],
  ...texts: string[]
): void {
  expect(results.map((result) => result.direction)).toEqual(DIRECTIONS);
  for (const result of results) {
    expect([result.direction, result.status]).toEqual([result.direction, "fail"]);
    expect([result.direction, result.failedStep]).toEqual([result.direction, lastStep(id, kind)]);
    for (const text of texts) expect(result.text).toContain(text);
  }
}

describe("a fault of the engine turns a scenario red", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes without a fault, so that a red case below comes from its fault", async () => {
    for (const id of [
      "single-event",
      "privacy-title",
      "privacy-location",
      "privacy-description",
      "privacy-attendee",
      "private-event",
      "buffer",
      "disconnect-target",
      "loop-both-directions",
      "window-start-edge",
      "window-edge-all-day",
    ]) {
      const statuses = (await run(scenarioNamed(id))).map((result) => result.status);
      expect([id, ...statuses]).toEqual([id, "pass", "pass"]);
    }
  });

  it("finds a missing block", async () => {
    disturbWrites((action) => (action.kind === "create" ? [] : [action]));
    expectRed(await run(scenarioNamed("single-event")), "single-event", "sync", "must be busy");
  });

  it("finds a block too many", async () => {
    disturbWrites((action) => {
      if (action.kind !== "create") return [action];
      const { block } = action;
      const start = moved(block.start, DAY_MS);
      const end = moved(block.end, DAY_MS);
      return [action, { kind: "create", block: { ...block, start, end, marker: "extra" } }];
    });
    expectRed(await run(scenarioNamed("single-event")), "single-event", "sync", "must be free");
  });

  it("finds a second block at the same time, where the scenario forbids it", async () => {
    disturbWrites((action) =>
      action.kind === "create"
        ? [action, { kind: "create", block: { ...action.block, marker: "copy" } }]
        : [action],
    );
    expectRed(await run(scenarioNamed("private-event")), "private-event", "sync", "duplicate");
  });

  it("finds a second block that only a later cycle writes", async () => {
    // The read of the existing blocks comes back empty. The first cycle writes the right blocks,
    // and the second one writes them again.
    vi.spyOn(FakeCalendar.prototype, "existingBlocks").mockResolvedValue([]);
    for (const id of ["buffer", "private-event"]) {
      expectRed(await run(scenarioNamed(id)), id, "sync", "duplicate entries");
    }
  });

  it("does not see that second block without the time to settle", async () => {
    vi.spyOn(FakeCalendar.prototype, "existingBlocks").mockResolvedValue([]);
    for (const id of ["buffer", "private-event"]) {
      const scenario = scenarioNamed(id);
      const steps = scenario.steps.map((step) => {
        if (step.do !== "sync") return step;
        const { settleSeconds: _settle, ...rest } = step;
        return rest;
      });
      const statuses = (await run({ ...scenario, steps })).map((result) => result.status);
      expect([id, ...statuses]).toEqual([id, "pass", "pass"]);
    }
  });

  it("finds that second block with rules in both directions, in the step of the settle time", async () => {
    vi.spyOn(FakeCalendar.prototype, "existingBlocks").mockResolvedValue([]);
    const results = await run(scenarioNamed("loop-both-directions"));
    expect(results.map((result) => result.direction)).toEqual(DIRECTIONS);
    for (const result of results) {
      expect(result).toMatchObject({ status: "fail", stopped: false, failedStep: 3 });
      expect(result.text).toContain("duplicate entries");
    }
  });

  it("finds that block later, and only through the delete, without the settle time", async () => {
    vi.spyOn(FakeCalendar.prototype, "existingBlocks").mockResolvedValue([]);
    const scenario = scenarioNamed("loop-both-directions");
    const steps = scenario.steps.map((step) => {
      if (step.do !== "sync") return step;
      const { settleSeconds: _settle, ...rest } = step;
      return rest;
    });
    for (const result of await run({ ...scenario, steps })) {
      expect(result).toMatchObject({ status: "fail", failedStep: 6 });
    }
  });

  it("finds a moved block", async () => {
    disturbWrites((action) => [
      withBlock(action, ({ block }) => ({
        kind: "create",
        block: {
          ...block,
          start: moved(block.start, HOUR_MS / 2),
          end: moved(block.end, HOUR_MS / 2),
        },
      })),
    ]);
    expectRed(
      await run(scenarioNamed("single-event")),
      "single-event",
      "sync",
      "free but must be busy",
      "busy but must be free",
    );
  });

  it("finds a title, a location and a description that the engine really copies", async () => {
    const leaks = [
      ["privacy-title", "SUITE-CONTENT-TITLE-7Q2"],
      ["privacy-location", "SUITE-CONTENT-LOCATION-7Q2"],
      ["privacy-description", "SUITE-CONTENT-DESCRIPTION-7Q2"],
    ] as const;
    for (const [id, text] of leaks) {
      // No hook: this rule asks the real engine for all details.
      const scenario = { ...scenarioNamed(id), rule: { detail: "full" as const } };
      const results = await run(scenario);
      expectRed(results, id, "sync");
      for (const result of results) expect(result.text).toBe(`forbidden text found: ${text}`);
    }
  });

  it("finds an attendee on a block", async () => {
    const attendee = "suite.attendee.7q2@example.invalid";
    disturbWrites((action) => [
      withBlock(action, ({ block }) => ({
        kind: "create",
        block: Object.assign({}, block, { attendees: [attendee] }),
      })),
    ]);
    const results = await run(scenarioNamed("privacy-attendee"));
    expectRed(results, "privacy-attendee", "sync");
    for (const result of results) expect(result.text).toBe(`forbidden text found: ${attendee}`);
  });

  it("finds a run that deletes a foreign event at the disconnect", async () => {
    const existingBlocks = FakeCalendar.prototype.existingBlocks;
    class CarelessDriver extends FaultyDriver {
      override async control(action: Parameters<LocalDriver["control"]>[0]): Promise<void> {
        if (action.action === "disconnect") {
          // A read that no longer tells blocks from events: the event "own" looks like a block.
          vi.spyOn(FakeCalendar.prototype, "existingBlocks").mockImplementation(async function (
            this: FakeCalendar,
            calendarId,
            window,
            ruleTags,
          ) {
            const blocks = await existingBlocks.call(this, calendarId, window, ruleTags);
            const own = { ...blocks[0], targetId: "own", marker: "own", ruleTag: ruleTags[0] };
            return blocks[0] ? [...blocks, own as (typeof blocks)[number]] : blocks;
          });
        }
        await super.control(action);
      }
    }
    const id = "disconnect-target";
    expectRed(await run(scenarioNamed(id), new CarelessDriver()), id, "sync", "must be busy");
  });

  it("finds a run that drops a block at the edge, so a cycle ran before the check", async () => {
    const sourceEvents = FakeCalendar.prototype.sourceEvents;
    class ForgetfulDriver extends FaultyDriver {
      override advance(to: number): Promise<void> {
        // From here the source shows no event, so that the next cycle deletes the block.
        vi.spyOn(FakeCalendar.prototype, "sourceEvents").mockImplementation(async function (
          this: FakeCalendar,
          ...args
        ) {
          await sourceEvents.apply(this, args);
          return [];
        });
        return super.advance(to);
      }
    }
    for (const id of ["window-start-edge", "window-edge-all-day"]) {
      // The sync behind `expect-calls`, the check before the delete.
      const results = await run(scenarioNamed(id), new ForgetfulDriver());
      expect(results.map((result) => result.failedStep)).toEqual(
        DIRECTIONS.map(() => lastStep(id, "expect-calls") + 1),
      );
      for (const result of results) {
        expect(result.status).toBe("fail");
        expect(result.text).toContain("free but must be busy");
      }
    }
  });
});

describe("the local driver", () => {
  it("runs a disconnect to its end before the last check", async () => {
    const gone: boolean[] = [];
    class WatchingDriver extends LocalDriver {
      override async cleanup(): Promise<void> {
        gone.push(!(await this.stub("target").hasTokens()));
        await super.cleanup();
      }
    }
    await run(scenarioNamed("disconnect-target"), new WatchingDriver());
    expect(gone).toEqual([true, true]);
  });

  it("keeps the provider of an account through a refresh failure and a reconnect", async () => {
    const providers: string[] = [];
    class ProviderDriver extends LocalDriver {
      async providerOf(side: CalendarSide): Promise<string> {
        return runInDurableObject(this.stub(side), (_instance, state) => {
          const rows = state.storage.sql.exec<{ provider: string }>(`SELECT provider FROM tokens`);
          return rows.one().provider;
        });
      }
    }
    for (const direction of DIRECTIONS) {
      const driver = new ProviderDriver();
      await driver.prepare({ scenario: scenarioNamed("account-paused"), direction });
      const before = await driver.providerOf("source");
      await driver.control({ action: "refuse-token", calendar: "source" });
      await driver.control({ action: "reconnect", calendar: "source" });
      expect(await driver.providerOf("source")).toBe(before);
      providers.push(before);
      await driver.cleanup();
    }
    expect(new Set(providers).size).toBe(2);
  });
});
