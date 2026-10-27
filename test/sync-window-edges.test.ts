import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ruleOptionsSchema } from "../src/config";
import { desiredBlocks, planSync } from "../src/sync/plan";
import { syncWindow, targetReadWindow } from "../src/sync/rules";
import type { DesiredBlock, ExistingBlock, SourceEvent, SyncPlan } from "../src/sync/types";
import fixture from "./fixtures/graph/calendar-view.json";
import { signIn } from "./helpers";

// Each provider filters all-day events at the local midnights of its own calendar, but returns
// them as dates. So a source and a target in different time zones disagree about which all-day
// dates at the edges of the sync window are in a read. These tests model both reads that way.

const HOUR = 60 * 60 * 1000;
const RULE = "rule-1";
const OPTIONS = ruleOptionsSchema.parse({ skipAllDay: false, daysAhead: 30 });

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
      .map(([targetId, block]) => ({ ...block, targetId, ruleTag: "tag" }));
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
      ["a", "b"].map((copy) => ({ ...block, targetId: `t${index}${copy}`, ruleTag: "tag" })),
    );
    const target = targetReadWindow(window);
    expect(planSync([], existing, { sync: window, target }).actions).toEqual([]);
  });

  it("deletes the copies of an all-day block outside the sync window whose event it reads", async () => {
    const window = syncWindow(OPTIONS, new Date("2026-10-27T12:00:00Z"));
    const [block] = await desiredBlocks(RULE, [EVENTS[0]!], OPTIONS);
    if (!block) throw new Error("no block");
    const existing = ["t0", "t1"].map((targetId) => ({ ...block, targetId, ruleTag: "tag" }));
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
    const existing = [{ ...old, targetId: "t0", ruleTag: "tag" }];
    // The event moved into the window: a new block, and yesterday's block stays as it was.
    expect(planSync([moved], existing, windows).actions).toEqual([
      { kind: "create", block: moved },
    ]);
    // An event the source returns outside the window still gets its block, and keeps it.
    expect(planSync([old], [], windows).stats).toMatchObject({ create: 1 });
    expect(planSync([old], existing, windows).stats).toMatchObject({ unchanged: 1 });
  });
});

describe("AccountSync with all-day events at the window edges", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
