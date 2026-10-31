import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ruleOptionsSchema } from "../src/config";
import { MARKER_PROPERTY_ID } from "../src/sync/graph-events";
import {
  blocksAtEdge,
  desiredBlocks,
  markerFor,
  planSync,
  ruleTagFor,
  type EdgeRead,
} from "../src/sync/plan";
import { edgeReadWindow, readWindow, syncWindow, targetReadWindow } from "../src/sync/rules";
import type { DesiredBlock, ExistingBlock, SourceEvent, SyncPlan } from "../src/sync/types";
import fixture from "./fixtures/graph/calendar-view.json";
import { signIn, stopClock } from "./helpers";

// Each provider filters all-day events at the local midnights of its own calendar, but returns
// them as dates. So a source and a target in different time zones disagree about which all-day
// dates at the edges of the sync window are in a read. These tests model both reads that way.

const HOUR = 60 * 60 * 1000;
const RULE = "rule-1";
const OPTIONS = ruleOptionsSchema.parse({ daysAhead: 30 });

type Window = { start: Date; end: Date };
type Times = { start: string; end: string; allDay: boolean };

function event(key: string, start: string, end: string, changes: Partial<SourceEvent> = {}) {
  return {
    occurrenceKey: key,
    start,
    end,
    allDay: start.length === 10,
    showAs: "busy",
    isPrivate: false,
    declined: false,
    categories: [],
    subject: "Meeting",
    location: "",
    body: "",
    isMirror: false,
    ...changes,
  } satisfies SourceEvent;
}

/** True if a calendar `offset` hours east of UTC returns the event for the window. */
function inRead(times: Times, window: Window, offset: number): boolean {
  const shift = times.allDay ? offset * HOUR : 0;
  const start = Date.parse(times.start) - shift;
  const end = Date.parse(times.end) - shift;
  return start < window.end.getTime() && end > window.start.getTime();
}

/** A target calendar at a fixed UTC offset. It keeps blocks as written: all-day blocks as dates. */
class Target {
  readonly blocks = new Map<string, DesiredBlock>();
  private next = 0;
  constructor(readonly offset: number) {}

  read(window: Window): ExistingBlock[] {
    return [...this.blocks]
      .filter(([, block]) => inRead(block, window, this.offset))
      .map(([targetId, block]) => ({
        ...block,
        targetId,
        ruleTag: "tag",
        status: "blocked" as const,
      }));
  }

  apply(plan: SyncPlan): void {
    for (const action of plan.actions) {
      if (action.kind === "create") this.blocks.set(`t${this.next++}`, action.block);
      else if (action.kind === "update") this.blocks.set(action.targetId, action.block);
      else this.blocks.delete(action.targetId);
    }
  }

  markers(): string[] {
    return [...this.blocks.values()].map((block) => block.marker);
  }
}

/** One run of a rule, as `AccountSync` does it: read source and target, plan, apply. */
async function run(target: Target, events: SourceEvent[], sourceOffset: number, now: Date) {
  const window = syncWindow(OPTIONS, now);
  const read = events.filter((item) => inRead(item, window, sourceOffset));
  const desired = await desiredBlocks(RULE, read, OPTIONS);
  const targetRead = targetReadWindow(window);
  const plan = planSync(desired, target.read(targetRead), { sync: window, target: targetRead });
  target.apply(plan);
  return { stats: plan.stats, read };
}

/**
 * What the read of the source edge returns, for the tests of the plan across time zones. This
 * models `readEdge` of `AccountSync`, so filters and the failed read have tests of their own there.
 */
async function edgeOf(events: SourceEvent[], sourceOffset: number, sync: Window) {
  const window = edgeReadWindow(sync);
  const seen = events.filter((item) => inRead(item, window, sourceOffset));
  const markers = await Promise.all(seen.map((item) => markerFor(RULE, item.occurrenceKey)));
  return { window, markers: new Set(markers) } satisfies EdgeRead;
}

/** One run with the edge read, as `AccountSync` does it: only if a block at the edge lost its event. */
async function runWithEdge(
  target: Target,
  events: SourceEvent[],
  sourceOffset: number,
  now: Date,
  options = OPTIONS,
) {
  const window = syncWindow(options, now);
  const read = readWindow(window, options);
  const seen = events.filter((item) => inRead(item, read ?? window, sourceOffset));
  const desired = await desiredBlocks(RULE, seen, options);
  const targetRead = targetReadWindow(window);
  const existing = target.read(targetRead);
  const edge =
    blocksAtEdge(desired, existing, window).length > 0
      ? await edgeOf(events, sourceOffset, window)
      : undefined;
  const plan = planSync(desired, existing, { sync: window, target: targetRead, read, edge });
  target.apply(plan);
  return { stats: plan.stats, edgeRead: edge !== undefined };
}

/** The date of the target calendar's current local day. */
function localDay(at: number, offset: number): string {
  return new Date(at + offset * HOUR).toISOString().slice(0, 10);
}

// The sync window on 27 Oct runs from 27 Oct to 26 Nov, 00:00 UTC.
const EVENTS = [
  event("all-day-before", "2026-10-26", "2026-10-27"),
  event("all-day-first", "2026-10-27", "2026-10-28"),
  event("all-day-last", "2026-11-25", "2026-11-26"),
  event("all-day-after", "2026-11-26", "2026-11-27"),
  event("all-day-across", "2026-10-25", "2026-10-30"),
  event("timed-start", "2026-10-26T23:30:00.000Z", "2026-10-27T00:30:00.000Z"),
  event("timed-end", "2026-11-25T23:30:00.000Z", "2026-11-26T00:30:00.000Z"),
];
const OFFSETS = [-10, -8, -4, 0, 1, 10, 14];
const NOWS = ["2026-10-27T00:30:00Z", "2026-10-27T12:00:00Z", "2026-10-27T23:30:00Z"];

describe("all-day blocks at the edges of the sync window", () => {
  it("writes each block once and keeps it, for every pair of time zones", async () => {
    const failures: string[] = [];
    for (const sourceOffset of OFFSETS) {
      for (const targetOffset of OFFSETS) {
        for (const now of NOWS) {
          const target = new Target(targetOffset);
          const label = `source ${sourceOffset}, target ${targetOffset}, ${now}`;
          for (const at of [Date.parse(now), Date.parse(now) + 24 * HOUR]) {
            const before = new Set(target.markers());
            const { read } = await run(target, EVENTS, sourceOffset, new Date(at));
            const { stats: again } = await run(target, EVENTS, sourceOffset, new Date(at));
            const markers = target.markers();
            // Every all-day event of the local day that the source returns gets its block.
            const today = localDay(at, targetOffset);
            const blocked = new Set([...target.blocks.values()].map((block) => block.start));
            for (const item of read) {
              if (
                item.allDay &&
                item.start <= today &&
                item.end > today &&
                !blocked.has(item.start)
              ) {
                failures.push(
                  `${label}: no block for the local day at ${new Date(at).toISOString()}`,
                );
              }
            }
            if (again.create + again.update + again.delete > 0) {
              failures.push(`${label}: second run at ${new Date(at).toISOString()} changes`);
            }
            if (new Set(markers).size !== markers.length) failures.push(`${label}: duplicate`);
            // No source event goes away, so no block may go away either.
            if ([...before].some((marker) => !markers.includes(marker))) {
              failures.push(`${label}: block deleted at ${new Date(at).toISOString()}`);
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps the block of the local day west of UTC after midnight UTC", async () => {
    // At 01:00 UTC on 27 Oct it is still 26 Oct at UTC-8.
    const today = [event("today", "2026-10-26", "2026-10-27")];
    for (const sourceOffset of [-8, 0, 1]) {
      const target = new Target(-8);
      await run(target, today, -8, new Date("2026-10-26T20:00:00Z"));
      expect(target.blocks.size).toBe(1);
      // A source at UTC or east of it no longer returns the event. The block stays in each case.
      const { stats } = await run(target, today, sourceOffset, new Date("2026-10-27T01:00:00Z"));
      expect(stats).toMatchObject({ create: 0, delete: 0 });
      expect(target.blocks.size).toBe(1);
    }
  });

  it("updates such a block when its event changes", async () => {
    const target = new Target(-8);
    await run(
      target,
      [event("today", "2026-10-26", "2026-10-27")],
      -8,
      new Date("2026-10-26T20:00:00Z"),
    );
    const changed = [event("today", "2026-10-26", "2026-10-27", { showAs: "tentative" })];
    const { stats } = await run(target, changed, -8, new Date("2026-10-27T01:00:00Z"));
    expect(stats).toMatchObject({ create: 0, update: 1, delete: 0 });
  });

  it("creates the local-day block west of UTC after midnight UTC", async () => {
    const today = [event("today", "2026-10-26", "2026-10-27")];
    const target = new Target(-8);
    const { stats } = await run(target, today, -8, new Date("2026-10-27T01:00:00Z"));
    expect(stats).toMatchObject({ create: 1 });
    expect((await run(target, today, -8, new Date("2026-10-27T01:00:00Z"))).stats).toMatchObject({
      create: 0,
      unchanged: 1,
    });
  });

  it("creates an all-day block outside the sync window only if every target read returns it", async () => {
    const window = syncWindow(OPTIONS, new Date("2026-10-27T12:00:00Z"));
    const target = targetReadWindow(window);
    const twoDaysBefore = event("two-days-before", "2026-10-25", "2026-10-26");
    const outside = await desiredBlocks(RULE, [EVENTS[0]!, EVENTS[3]!, twoDaysBefore], OPTIONS);
    // Without the wider target read, the next run could miss the block and create it again.
    expect(planSync(outside, [], { sync: window }).actions).toEqual([]);
    const created = planSync(outside, [], { sync: window, target }).actions.map((action) =>
      action.kind === "create" ? action.block.start : action.kind,
    );
    expect(created).toEqual(["2026-10-26", "2026-11-26"]);
    // Half a day more on each side is not enough: a calendar at UTC+14 would miss 26 Oct.
    const half = { start: new Date(window.start.getTime() - 12 * HOUR), end: window.end };
    expect(planSync(outside.slice(0, 1), [], { sync: window, target: half }).actions).toEqual([]);
  });

  it("never deletes a block outside the sync window whose event the source did not return", async () => {
    const window = syncWindow(OPTIONS, new Date("2026-10-27T12:00:00Z"));
    const timed = event("timed-before", "2026-10-26T20:00:00.000Z", "2026-10-26T21:00:00.000Z");
    const blocks = await desiredBlocks(RULE, [EVENTS[0]!, timed], OPTIONS);
    // Two copies each, as the window-edge loop on earlier versions wrote them.
    const existing = blocks.flatMap((block, index) =>
      ["a", "b"].map((copy) => ({
        ...block,
        targetId: `t${index}${copy}`,
        ruleTag: "tag",
        status: "blocked" as const,
      })),
    );
    const target = targetReadWindow(window);
    expect(planSync([], existing, { sync: window, target }).actions).toEqual([]);
  });

  it("deletes the copies of an all-day block outside the sync window whose event it reads", async () => {
    const window = syncWindow(OPTIONS, new Date("2026-10-27T12:00:00Z"));
    const [block] = await desiredBlocks(RULE, [EVENTS[0]!], OPTIONS);
    if (!block) throw new Error("no block");
    const existing = ["t0", "t1"].map((targetId) => ({
      ...block,
      targetId,
      ruleTag: "tag",
      status: "blocked" as const,
    }));
    const plan = planSync([block], existing, { sync: window, target: targetReadWindow(window) });
    expect(plan.actions).toEqual([{ kind: "delete", targetId: "t1", marker: block.marker }]);
  });

  it("moves an all-day block from the day before the window to its event's new date", async () => {
    const target = new Target(0);
    await run(
      target,
      [event("moved", "2026-10-26", "2026-10-27")],
      0,
      new Date("2026-10-26T12:00:00Z"),
    );
    // The next day the block lies before the window, and its event moves into the window.
    const moved = [event("moved", "2026-10-29", "2026-10-30")];
    const { stats } = await run(target, moved, 0, new Date("2026-10-27T12:00:00Z"));
    expect(stats).toMatchObject({ create: 0, update: 1, delete: 0 });
    expect([...target.blocks.values()].map((block) => block.start)).toEqual(["2026-10-29"]);
    const again = await run(target, moved, 0, new Date("2026-10-27T12:00:00Z"));
    expect(again.stats).toMatchObject({ create: 0, update: 0, delete: 0, unchanged: 1 });
  });

  it("leaves a timed block outside the sync window as the narrow read did", async () => {
    const window = syncWindow(OPTIONS, new Date("2026-10-27T12:00:00Z"));
    const windows = { sync: window, target: targetReadWindow(window) };
    const yesterday = event("moved", "2026-10-26T09:00:00.000Z", "2026-10-26T10:00:00.000Z");
    const today = event("moved", "2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z");
    const [old] = await desiredBlocks(RULE, [yesterday], OPTIONS);
    const [moved] = await desiredBlocks(RULE, [today], OPTIONS);
    if (!old || !moved) throw new Error("no block");
    const existing = [{ ...old, targetId: "t0", ruleTag: "tag", status: "blocked" as const }];
    // The event moved into the window: a new block, and yesterday's block stays as it was.
    expect(planSync([moved], existing, windows).actions).toEqual([
      { kind: "create", block: moved },
    ]);
    // An event the source returns outside the window still gets its block, and keeps it.
    expect(planSync([old], [], windows).stats).toMatchObject({ create: 1 });
    expect(planSync([old], existing, windows).stats).toMatchObject({ unchanged: 1 });
  });
});

// The window on 26 Oct starts on 26 Oct, the window on 27 Oct starts on 27 Oct, 00:00 UTC. At 03:00
// UTC on 27 Oct it is still 26 Oct at UTC-8.
const BEFORE = new Date("2026-10-26T20:00:00Z");
const AFTER = new Date("2026-10-27T03:00:00Z");
// The first run on 26 Oct and the later run on 27 Oct, each early and late in the UTC day.
const BEFORES = [new Date("2026-10-26T00:30:00Z"), BEFORE];
const AFTERS = [
  new Date("2026-10-27T00:30:00Z"),
  AFTER,
  new Date("2026-10-27T12:00:00Z"),
  new Date("2026-10-27T23:30:00Z"),
];
const ZONES = [-8, 0, 1, 14];
const ALL_DAY = event("all-day", "2026-10-26", "2026-10-27");
const MULTI_DAY = event("multi-day", "2026-10-24", "2026-10-27");
const AT_MIDNIGHT = event("at-midnight", "2026-10-26T23:00:00.000Z", "2026-10-27T00:00:00.000Z");
const AT_EDGE = [ALL_DAY, MULTI_DAY, AT_MIDNIGHT];

/** Every pair of the time zones that T12 names: source, then target. */
function zonePairs(): [number, number][] {
  return ZONES.flatMap((source) => ZONES.map((target): [number, number] => [source, target]));
}

/** Every pair of those time zones at every pair of run times. */
function zonesAndTimes(): {
  sourceOffset: number;
  targetOffset: number;
  first: Date;
  later: Date;
}[] {
  return zonePairs().flatMap(([sourceOffset, targetOffset]) =>
    BEFORES.flatMap((first) =>
      AFTERS.map((later) => ({ sourceOffset, targetOffset, first, later })),
    ),
  );
}

describe("blocks at the start of the sync window, with the edge read", () => {
  it("deletes the block of a deleted event, for every pair of time zones", async () => {
    for (const item of AT_EDGE) {
      for (const { sourceOffset, targetOffset, first, later } of zonesAndTimes()) {
        const label = `${item.occurrenceKey}, ${sourceOffset}, ${targetOffset}, ${later.toISOString()}`;
        const target = new Target(targetOffset);
        await run(target, [item], sourceOffset, first);
        expect(target.blocks.size, label).toBe(1);
        const { stats } = await runWithEdge(target, [], sourceOffset, later);
        expect(stats, label).toMatchObject({ create: 0, update: 0, delete: 1 });
        expect(target.blocks.size, label).toBe(0);
      }
    }
  });

  it("keeps the block while its event exists, for every pair of time zones", async () => {
    for (const item of AT_EDGE) {
      for (const { sourceOffset, targetOffset, first, later } of zonesAndTimes()) {
        const label = `${item.occurrenceKey}, ${sourceOffset}, ${targetOffset}, ${later.toISOString()}`;
        const target = new Target(targetOffset);
        await run(target, [item], sourceOffset, first);
        const { stats } = await runWithEdge(target, [item], sourceOffset, later);
        expect(stats, label).toMatchObject({ create: 0, delete: 0 });
        expect(target.blocks.size, label).toBe(1);
      }
    }
  });

  it("deletes only the block at the edge if the target read also returns older blocks", async () => {
    const older = event("older", "2026-10-25", "2026-10-26");
    const earlier = event("earlier", "2026-10-26T22:00:00.000Z", "2026-10-26T23:59:00.000Z");
    const target = new Target(-8);
    await run(target, [older, earlier, ALL_DAY], -8, new Date("2026-10-25T20:00:00Z"));
    expect(target.blocks.size).toBe(3);
    // West of UTC the target read returns all three, and the edge read overlaps "earlier".
    const { stats, edgeRead } = await runWithEdge(target, [], -8, AFTER);
    expect(edgeRead).toBe(true);
    expect(stats).toMatchObject({ create: 0, update: 0, delete: 1 });
    const left = [...target.blocks.values()].map((block) => block.start);
    expect(left).toEqual([older.start, earlier.start]);
  });

  it("deletes a block whose event left the edge read: the block shows a wrong date", async () => {
    const changes = [
      { before: MULTI_DAY, after: event("multi-day", "2026-10-24", "2026-10-25") },
      { before: ALL_DAY, after: event("all-day", "2026-10-20", "2026-10-21") },
    ];
    for (const { before, after } of changes) {
      for (const [sourceOffset, targetOffset] of zonePairs()) {
        const label = `${before.occurrenceKey}, source ${sourceOffset}, target ${targetOffset}`;
        const target = new Target(targetOffset);
        await run(target, [before], sourceOffset, BEFORE);
        // The event exists, but no read returns it. Its block would show the old date for good.
        const { stats } = await runWithEdge(target, [after], sourceOffset, AFTER);
        expect(stats, label).toMatchObject({ create: 0, update: 0, delete: 1 });
        expect(target.blocks.size, label).toBe(0);
      }
    }
  });

  it("moves a block that ends at the start of the window to its event's new time", async () => {
    const moved = event("at-midnight", "2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z");
    for (const targetOffset of ZONES) {
      const target = new Target(targetOffset);
      await run(target, [AT_MIDNIGHT], 0, BEFORE);
      const { stats } = await runWithEdge(target, [moved], 0, AFTER);
      expect(stats).toMatchObject({ create: 0, update: 1, delete: 0 });
      expect([...target.blocks.values()].map((block) => block.start)).toEqual([moved.start]);
      const again = await runWithEdge(target, [moved], 0, AFTER);
      expect(again.stats).toMatchObject({ create: 0, update: 0, delete: 0, unchanged: 1 });
    }
  });

  it("keeps a block for good once it no longer ends at the start of the window", async () => {
    const target = new Target(0);
    await run(target, [ALL_DAY], 0, BEFORE);
    // The block outlives the day on which the edge read could delete it.
    const { stats, edgeRead } = await runWithEdge(target, [], 0, new Date("2026-10-28T03:00:00Z"));
    expect(edgeRead).toBe(false);
    expect(stats).toMatchObject({ create: 0, delete: 0 });
    expect(target.blocks.size).toBe(1);
  });

  it("keeps a zero-length block at the start of the window while its event exists", async () => {
    const zero = event("zero", "2026-10-27T00:00:00.000Z", "2026-10-27T00:00:00.000Z");
    const [block] = await desiredBlocks(RULE, [zero], OPTIONS);
    if (!block) throw new Error("no block");
    const sync = syncWindow(OPTIONS, AFTER);
    const windows = { sync, target: targetReadWindow(sync), edge: await edgeOf([zero], 0, sync) };
    const existing = [{ ...block, targetId: "t0", ruleTag: "tag", status: "blocked" as const }];
    expect(planSync([], existing, windows).actions).toEqual([]);
  });

  it("leaves blocks further in the past as a record, without an edge read", async () => {
    const older = event("older", "2026-10-25", "2026-10-26");
    const earlier = event("earlier", "2026-10-26T22:00:00.000Z", "2026-10-26T23:59:00.000Z");
    for (const [sourceOffset, targetOffset] of zonePairs()) {
      const target = new Target(targetOffset);
      await run(target, [older, earlier], sourceOffset, new Date("2026-10-25T20:00:00Z"));
      const count = target.blocks.size;
      const { stats, edgeRead } = await runWithEdge(target, [], sourceOffset, AFTER);
      // A target west of UTC also returns 25 Oct, but no block ends at the start of the window.
      expect(edgeRead).toBe(false);
      expect(stats.delete).toBe(0);
      expect(target.blocks.size).toBe(count);
    }
  });

  it("deletes a block at the end of the window a day later, when it is inside", async () => {
    const after = event("after", "2026-11-26", "2026-11-27");
    const target = new Target(14);
    await run(target, [after], 14, AFTER);
    expect(target.blocks.size).toBe(1);
    expect((await runWithEdge(target, [], 14, AFTER)).stats.delete).toBe(0);
    const nextDay = new Date("2026-10-28T03:00:00Z");
    expect((await runWithEdge(target, [], 14, nextDay)).stats.delete).toBe(1);
  });

  it("deletes nothing if the edge read cannot return the date in every time zone", async () => {
    const [block] = await desiredBlocks(RULE, [ALL_DAY], OPTIONS);
    if (!block) throw new Error("no block");
    const sync = syncWindow(OPTIONS, AFTER);
    const existing = [{ ...block, targetId: "t0", ruleTag: "tag", status: "blocked" as const }];
    const windows = { sync, target: targetReadWindow(sync) };
    const narrow = { start: new Date(sync.start.getTime() - 12 * HOUR), end: sync.start };
    const edge = { window: narrow, markers: new Set<string>() };
    expect(planSync([], existing, { ...windows, edge }).actions).toEqual([]);
    const wide = { window: edgeReadWindow(sync), markers: new Set<string>() };
    expect(planSync([], existing, { ...windows, edge: wide }).stats.delete).toBe(1);
  });

  it("deletes nothing without an edge read, for example after a failed one", async () => {
    const target = new Target(-8);
    await run(target, [ALL_DAY], -8, BEFORE);
    expect((await run(target, [], -8, AFTER)).stats.delete).toBe(0);
    expect(target.blocks.size).toBe(1);
  });

  it("names only the blocks that end at the start of the window and have no event", async () => {
    const blocks = await desiredBlocks(
      RULE,
      [
        ...AT_EDGE,
        event("older", "2026-10-25", "2026-10-26"),
        event("inside", "2026-10-27", "2026-10-28"),
        event("beyond", "2026-11-26", "2026-11-27"),
      ],
      OPTIONS,
    );
    const existing = blocks.map((block, index) => ({
      ...block,
      targetId: `t${index}`,
      ruleTag: "tag",
      status: "blocked" as const,
    }));
    const sync = syncWindow(OPTIONS, AFTER);
    expect(blocksAtEdge(blocks, existing, sync)).toEqual([]);
    const lost = blocksAtEdge([], existing, sync).map((block) => block.start);
    expect(lost).toEqual(["2026-10-26", "2026-10-24", "2026-10-26T23:00:00.000Z"]);
  });

  it("reads one day on each side of the start of the window, for a rule with any buffer", () => {
    const sync = syncWindow(OPTIONS, AFTER);
    expect(edgeReadWindow(sync)).toEqual({
      start: new Date("2026-10-26T00:00:00.000Z"),
      end: new Date("2026-10-28T00:00:00.000Z"),
    });
  });
});

describe("rules without a buffer, with the edge read", () => {
  it("plans the same as without it while no event goes away", async () => {
    const failures: string[] = [];
    for (const [sourceOffset, targetOffset] of zonePairs()) {
      for (const now of NOWS) {
        const label = `source ${sourceOffset}, target ${targetOffset}, ${now}`;
        const plain = new Target(targetOffset);
        const withEdge = new Target(targetOffset);
        for (const at of [Date.parse(now), Date.parse(now) + 24 * HOUR]) {
          const expected = await run(plain, EVENTS, sourceOffset, new Date(at));
          const actual = await runWithEdge(withEdge, EVENTS, sourceOffset, new Date(at));
          if (JSON.stringify(expected.stats) !== JSON.stringify(actual.stats)) {
            failures.push(`${label}: different stats at ${new Date(at).toISOString()}`);
          }
          if (JSON.stringify([...plain.blocks]) !== JSON.stringify([...withEdge.blocks])) {
            failures.push(`${label}: different blocks at ${new Date(at).toISOString()}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps the read window undefined", () => {
    expect(readWindow(syncWindow(OPTIONS, AFTER), OPTIONS)).toBeUndefined();
  });

  it("lets the edge read change no block that stands in", async () => {
    const sync = syncWindow(OPTIONS, AFTER);
    const windows = { sync, target: targetReadWindow(sync) };
    const edge = { window: edgeReadWindow(sync), markers: new Set<string>() };
    const yesterday = event("moved", "2026-10-26T09:00:00.000Z", "2026-10-26T10:00:00.000Z");
    const today = event("moved", "2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z");
    const [old] = await desiredBlocks(RULE, [yesterday], OPTIONS);
    const [moved] = await desiredBlocks(RULE, [today], OPTIONS);
    if (!old || !moved) throw new Error("no block");
    const existing = [{ ...old, targetId: "t0", ruleTag: "tag", status: "blocked" as const }];
    // A timed block outside the window stands in for no block inside it, as without the field.
    expect(planSync([moved], existing, { ...windows, edge })).toEqual(
      planSync([moved], existing, windows),
    );
    // A timed event the source returns outside the window is no event of the read margin.
    expect(planSync([old], [], { ...windows, edge })).toEqual(planSync([old], [], windows));
    expect(planSync([old], [], { ...windows, edge }).stats.create).toBe(1);
  });
});

describe("rules with a buffer, with the edge read", () => {
  const BUFFERED = ruleOptionsSchema.parse({ ...OPTIONS, bufferAfter: 30 });
  const LATE = event("late", "2026-10-26T23:00:00.000Z", "2026-10-26T23:30:00.000Z");

  it("deletes a block that ends at the start of the window through its buffer", async () => {
    const target = new Target(0);
    await runWithEdge(target, [LATE], 0, BEFORE, BUFFERED);
    expect([...target.blocks.values()][0]?.end).toBe("2026-10-27T00:00:00.000Z");
    const { stats } = await runWithEdge(target, [], 0, AFTER, BUFFERED);
    expect(stats).toMatchObject({ create: 0, delete: 1 });
  });

  it("keeps that block while its event exists, and reads no edge for it", async () => {
    const target = new Target(0);
    await runWithEdge(target, [LATE], 0, BEFORE, BUFFERED);
    const { stats, edgeRead } = await runWithEdge(target, [LATE], 0, AFTER, BUFFERED);
    expect(edgeRead).toBe(false);
    expect(stats).toMatchObject({ create: 0, update: 0, delete: 0 });
    expect(target.blocks.size).toBe(1);
  });
});

describe("AccountSync with a block at the start of the sync window", () => {
  beforeEach(stopClock);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const DAY = 24 * HOUR;
  const day = (offset: number) =>
    new Date(syncWindow(OPTIONS).start.getTime() + offset * DAY).toISOString().slice(0, 10);

  function graphAllDay(id: string, start: string, end: string, marker?: string) {
    return {
      ...fixture.value[0],
      id,
      type: "singleInstance",
      seriesMasterId: null,
      originalStart: null,
      isAllDay: true,
      start: { dateTime: `${start}T00:00:00.0000000`, timeZone: "UTC" },
      end: { dateTime: `${end}T00:00:00.0000000`, timeZone: "UTC" },
      ...(marker
        ? { singleValueExtendedProperties: [{ id: MARKER_PROPERTY_ID, value: marker }] }
        : {}),
    };
  }

  /** The deleted paths of a `$batch` request, and its answer. */
  function deleteBatch(init: RequestInit | undefined, deletes: string[]) {
    const { requests } = JSON.parse(init?.body as string) as {
      requests: { id: string; method: string; url: string }[];
    };
    deletes.push(...requests.filter(({ method }) => method === "DELETE").map(({ url }) => url));
    return Response.json({
      responses: requests.map(({ id, method }) => ({
        id,
        status: method === "DELETE" ? 204 : 201,
        body: { id: `written-${id}` },
      })),
    });
  }

  async function setup(
    prefix: string,
    sourceAtEdge: (url: string) => Response,
    { otherSource = false, occurrenceKey = "event:yesterday" } = {},
  ) {
    const { user } = await signIn("owner@example.com");
    const account = `acc-${prefix}`;
    const sourceAccount = otherSource ? `${account}-source` : account;
    const ruleId = `${prefix}-rule`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
      ).bind(account, user.id, `${prefix}@example.com`),
      ...(otherSource
        ? [
            env.DB.prepare(
              "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
            ).bind(sourceAccount, user.id, `${prefix}-source@example.com`),
          ]
        : []),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, 'src', 'Work'), (?, ?, 'dst', 'Test')",
      ).bind(`${prefix}-src`, sourceAccount, `${prefix}-dst`, account),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        ruleId,
        user.id,
        `${prefix}-src`,
        `${prefix}-dst`,
        JSON.stringify({ skipAllDay: false }),
      ),
    ]);
    const stub = env.ACCOUNT_SYNC.getByName(account);
    for (const id of new Set([account, sourceAccount])) {
      await env.ACCOUNT_SYNC.getByName(id).storeTokens(id, {
        refreshToken: "r",
        accessToken: "a",
        accessExpiresAt: Date.now() + HOUR,
      });
    }
    const tag = await ruleTagFor(ruleId);
    const marker = await markerFor(ruleId, occurrenceKey);
    const hash = "0123456789abcdef0123456789abcdef";
    const block = graphAllDay("block", day(-1), day(0), `${tag}.${marker}.${hash}`);
    const sourceUrls: string[] = [];
    const deletes: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/calendars/dst/")) return Response.json({ value: [block] });
      if (url.includes("/calendars/src/")) {
        sourceUrls.push(url);
        const startsEarlier = new URL(url).searchParams.get("startDateTime")?.startsWith(day(-1));
        return startsEarlier ? sourceAtEdge(url) : Response.json({ value: [] });
      }
      if (url.endsWith("/$batch")) return deleteBatch(init, deletes);
      return new Response("unexpected", { status: 500 });
    });
    return { stub, ruleId, sourceUrls, deletes, block };
  }

  /** The detail of the latest audit entry of a run of the rule. */
  async function runDetail(ruleId: string): Promise<Record<string, unknown>> {
    const row = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE rule_id = ? AND kind = 'sync_run' ORDER BY id DESC",
    )
      .bind(ruleId)
      .first<{ detail: string }>();
    return JSON.parse(row?.detail ?? "{}") as Record<string, unknown>;
  }

  /** A page of a list in Graph, with the link to the next page if there is one. */
  function graphPage(url: string, pages: unknown[][]) {
    const { searchParams } = new URL(url);
    const page = Number(searchParams.get("page") ?? 0);
    const value = pages[page] ?? [];
    if (page + 1 >= pages.length) return Response.json({ value });
    searchParams.set("page", String(page + 1));
    const next = `${url.split("?")[0]}?${searchParams.toString()}`;
    return Response.json({ value, "@odata.nextLink": next });
  }

  /**
   * A run of a rule with a gone block at the edge, 520 new events and paged reads. It counts the
   * requests to Graph that this instance makes, and the write batches among them.
   */
  async function pagedRun(
    prefix: string,
    {
      sourcePages,
      targetPages,
      ...options
    }: {
      sourcePages: number;
      targetPages: number;
      otherSource?: boolean;
    },
  ) {
    const { stub, ruleId, block } = await setup(
      prefix,
      () => Response.json({ value: [] }),
      options,
    );
    const perPage = Math.ceil(520 / sourcePages);
    const source = Array.from({ length: sourcePages }, (_, page) =>
      Array.from({ length: perPage }, (_, index) =>
        graphAllDay(`new-${page}-${index}`, day(1), day(2)),
      ),
    );
    const target = Array.from({ length: targetPages }, (_, page) => (page === 0 ? [block] : []));
    const counts = { requests: 0, batches: 0 };
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/calendars/dst/")) {
        counts.requests++;
        return graphPage(url, target);
      }
      if (url.includes("/calendars/src/")) {
        if (!options.otherSource) counts.requests++;
        const startsEarlier = new URL(url).searchParams.get("startDateTime")?.startsWith(day(-1));
        return startsEarlier ? Response.json({ value: [] }) : graphPage(url, source);
      }
      if (url.endsWith("/$batch")) {
        counts.requests++;
        counts.batches++;
        return deleteBatch(init, []);
      }
      if (url.endsWith("/me?$select=mail")) {
        counts.requests++;
        return Response.json({ mail: "owner@work.example" });
      }
      if (url.endsWith("/getSchedule")) {
        counts.requests++;
        return Response.json({ value: [] });
      }
      return new Response("unexpected", { status: 500 });
    });
    return { result: await stub.runRule(ruleId), counts };
  }

  it("deletes the block after the edge read shows that its event is gone", async () => {
    const { stub, ruleId, sourceUrls } = await setup("edge-gone", () =>
      Response.json({ value: [] }),
    );
    const result = await stub.runRule(ruleId, { dryRun: true });
    expect(result).toMatchObject({ stats: { delete: 1 } });
    expect(sourceUrls).toHaveLength(2);
    const [main, edge] = sourceUrls.map((url) => new URL(url).searchParams);
    expect(main?.get("startDateTime")).toBe(`${day(0)}T00:00:00.000Z`);
    expect(edge?.get("startDateTime")).toBe(`${day(-1)}T00:00:00.000Z`);
    expect(edge?.get("endDateTime")).toBe(`${day(1)}T00:00:00.000Z`);
    // The edge read needs identity only, so it copies no description.
    expect(edge?.get("$select")?.split(",")).not.toContain("body");
  });

  it("keeps the block if the edge read returns its event", async () => {
    const { stub, ruleId, sourceUrls } = await setup("edge-kept", () =>
      Response.json({ value: [graphAllDay("yesterday", day(-1), day(0))] }),
    );
    const result = await stub.runRule(ruleId, { dryRun: true });
    expect(result).toMatchObject({ stats: { create: 0, delete: 0 } });
    expect(sourceUrls).toHaveLength(2);
  });

  it("deletes the block for real and counts it as applied", async () => {
    const { stub, ruleId, deletes } = await setup("edge-real", () => Response.json({ value: [] }));
    const result = await stub.runRule(ruleId);
    expect(result).toMatchObject({ stats: { delete: 1 }, applied: 1, failed: 0, remaining: 0 });
    expect(deletes).toEqual(["/me/events/block"]);
    expect(await runDetail(ruleId)).toMatchObject({ delete: 1, edgeReadsFailed: 0 });
  });

  it("keeps the block of a declined event that the edge read returns", async () => {
    // A filter leaves the event out, but it exists. The run must not delete the block.
    const declined = {
      ...graphAllDay("yesterday", day(-1), day(0)),
      responseStatus: { response: "declined" },
    };
    const { stub, ruleId, sourceUrls, deletes } = await setup("edge-declined", () =>
      Response.json({ value: [declined] }),
    );
    const result = await stub.runRule(ruleId);
    expect(result).toMatchObject({ stats: { create: 0, delete: 0 } });
    expect(sourceUrls).toHaveLength(2);
    expect(deletes).toEqual([]);
  });

  it("identifies an occurrence of a series at the edge by its series key", async () => {
    const original = `${day(-1)}T00:00:00.0000000Z`;
    const occurrence = {
      ...graphAllDay("occurrence-id", day(-1), day(0)),
      type: "occurrence",
      seriesMasterId: "series-1",
      originalStart: original,
    };
    const occurrenceKey = `series:series-1:${day(-1)}T00:00:00.000Z`;
    const kept = await setup("edge-series", () => Response.json({ value: [occurrence] }), {
      occurrenceKey,
    });
    await kept.stub.runRule(kept.ruleId);
    expect(kept.deletes).toEqual([]);
    // The series goes on, but this occurrence was cancelled.
    const gone = await setup("edge-series-gone", () => Response.json({ value: [] }), {
      occurrenceKey,
    });
    await gone.stub.runRule(gone.ruleId);
    expect(gone.deletes).toEqual(["/me/events/block"]);
  });

  it("runs on, keeps the block and records the failed edge read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { stub, ruleId, deletes } = await setup(
      "edge-failed",
      () => new Response("broken", { status: 500 }),
    );
    const result = await stub.runRule(ruleId);
    expect(result).toMatchObject({ stats: { delete: 0 } });
    expect(deletes).toEqual([]);
    expect(error).toHaveBeenCalled();
    expect(await runDetail(ruleId)).toMatchObject({ delete: 0, edgeReadsFailed: 1 });
  });

  it("counts reads against the write batches of a run, so that it stays under 50 requests", async () => {
    // 20 + 5 + 1 reads and the two requests of the zone lookup leave 20 of the 25 batches. The next
    // run writes the rest.
    const { result, counts } = await pagedRun("edge-budget", { sourcePages: 20, targetPages: 5 });
    expect(counts).toEqual({ requests: 48, batches: 20 });
    expect(result).toMatchObject({
      stats: { create: 520, delete: 1 },
      applied: 400,
      remaining: 121,
    });
  });

  it("counts one request per read of another instance, whose pages are its own", async () => {
    // Two reads over RPC, 22 pages and the two requests of the zone lookup leave 22 batches.
    const { counts } = await pagedRun("edge-budget-other", {
      sourcePages: 20,
      targetPages: 22,
      otherSource: true,
    });
    expect(counts).toEqual({ requests: 46, batches: 22 });
  });

  it("waits for the provider if the edge read is throttled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { stub, ruleId } = await setup(
      "edge-throttled",
      () => new Response("busy", { status: 429, headers: { "Retry-After": "7" } }),
    );
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string[]>("ruleQueue"),
    );
    // As after a throttled main read, the rule stays queued and writes nothing.
    expect(stored).toEqual([ruleId]);
  });

  it("reads the edge through the instance of the source account", async () => {
    const { stub, ruleId, sourceUrls } = await setup(
      "edge-other",
      () => Response.json({ value: [] }),
      { otherSource: true },
    );
    const result = await stub.runRule(ruleId, { dryRun: true });
    expect(result).toMatchObject({ stats: { delete: 1 } });
    expect(sourceUrls).toHaveLength(2);
  });

  it("makes no edge read if no block at the edge lost its event", async () => {
    const { stub, ruleId, sourceUrls } = await setup("edge-none", () =>
      Response.json({ value: [] }),
    );
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/calendars/dst/")) return Response.json({ value: [] });
      if (url.includes("/calendars/src/")) sourceUrls.push(url);
      return Response.json({ value: [] });
    });
    await stub.runRule(ruleId, { dryRun: true });
    expect(sourceUrls).toHaveLength(1);
    const { searchParams } = new URL(sourceUrls[0]!);
    expect(searchParams.get("startDateTime")).toBe(`${day(0)}T00:00:00.000Z`);
  });
});

describe("AccountSync with all-day events at the window edges", () => {
  beforeEach(stopClock);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reads the target one day wider and creates yesterday's all-day block", async () => {
    const { user } = await signIn("owner@example.com");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('acc-edge', ?, 'microsoft', 'edge@example.com')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES ('edge-src', 'acc-edge', 'src', 'Work'), ('edge-dst', 'acc-edge', 'dst', 'Test')",
      ),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES ('edge-rule', ?, 'edge-src', 'edge-dst', ?)",
      ).bind(user.id, JSON.stringify({ skipAllDay: false })),
    ]);
    const stub = env.ACCOUNT_SYNC.getByName("acc-edge");
    await stub.storeTokens("acc-edge", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + HOUR,
    });

    // A source calendar west of UTC returns yesterday's all-day event after midnight UTC.
    const day = (offset: number) =>
      new Date(syncWindow(OPTIONS).start.getTime() + offset * 24 * HOUR).toISOString().slice(0, 10);
    const allDay = (id: string, start: string, end: string) => ({
      ...fixture.value[0],
      id,
      type: "singleInstance",
      seriesMasterId: null,
      originalStart: null,
      isAllDay: true,
      start: { dateTime: `${start}T00:00:00.0000000`, timeZone: "UTC" },
      end: { dateTime: `${end}T00:00:00.0000000`, timeZone: "UTC" },
    });
    const source = [allDay("yesterday", day(-1), day(0)), allDay("today", day(0), day(1))];
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (url.includes("/calendars/src/")) return Response.json({ value: source });
      if (url.includes("/calendars/dst/")) return Response.json({ value: [] });
      return new Response("unexpected", { status: 500 });
    });

    const result = await stub.runRule("edge-rule", { dryRun: true });
    expect(result).toMatchObject({ stats: { create: 2, delete: 0 } });
    // One list call for the target, as before, over the wider range.
    const targetCalls = urls.filter((url) => url.includes("/calendars/dst/"));
    expect(targetCalls).toHaveLength(1);
    const params = new URL(targetCalls[0]!).searchParams;
    expect(params.get("startDateTime")).toBe(`${day(-1)}T00:00:00.000Z`);
    const { daysAhead } = ruleOptionsSchema.parse({});
    expect(params.get("endDateTime")).toBe(`${day(daysAhead + 1)}T00:00:00.000Z`);
  });
});
