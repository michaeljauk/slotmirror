import { describe, expect, it } from "vitest";
import { MAX_BUFFER_MINUTES, parseRuleOptions, ruleOptionsSchema } from "../src/config";
import type { RuleOptions } from "../src/config";
import {
  addSlice,
  blockReadWindow,
  compareSlice,
  finishScan,
  firstSliceStart,
  halveSlice,
  LEFTOVER_DAYS,
  MAX_HITS,
  newCompare,
  OPTION_ROLES,
  ruleSetHash,
  scanHorizon,
  sliceAfter,
  sliceItems,
  sourceReadWindow,
  startConfirmScan,
  type CompareRule,
  type CompareState,
  type SliceResult,
} from "../src/sync/compare";
import { claimsFrom, desiredBlocks, markerFor, ruleTagFor } from "../src/sync/plan";
import type { DesiredBlock, ExistingBlock, SourceEvent } from "../src/sync/types";

const STARTED = Date.parse("2026-11-02T09:00:00Z");
const DAY = 86_400_000;
const SLICE = {
  start: Date.parse("2026-11-03T00:00:00Z"),
  end: Date.parse("2026-11-10T00:00:00Z"),
};
const SOURCE = "source";
const SCOPE = "user";

function options(overrides: Partial<RuleOptions> = {}): RuleOptions {
  return { ...parseRuleOptions("{}"), ...overrides };
}

function rule(id = "rule-a", overrides: Partial<RuleOptions> = {}, source = SOURCE): CompareRule {
  return { id, source, options: options(overrides) };
}

function event(key: string, overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    occurrenceKey: key,
    start: "2026-11-04T10:00:00.000Z",
    end: "2026-11-04T11:00:00.000Z",
    allDay: false,
    showAs: "busy",
    isPrivate: false,
    declined: false,
    categories: [],
    subject: "",
    location: "",
    body: "",
    isMirror: false,
    ...overrides,
  };
}

/** The blocks that the planner wants for a rule, as the target calendar would return them. */
async function planned(
  from: CompareRule,
  events: SourceEvent[],
  claimed?: ExistingBlock[],
): Promise<ExistingBlock[]> {
  const blocks = await desiredBlocks(from.id, events, from.options, {
    scope: SCOPE,
    ...(claimed ? { claimed: claimsFrom(claimed) } : {}),
  });
  return asExisting(blocks, await ruleTagFor(from.id), from.id);
}

function asExisting(blocks: DesiredBlock[], ruleTag: string, prefix: string): ExistingBlock[] {
  return blocks.map((block, index) => ({
    targetId: `${prefix}-${index}`,
    ruleTag,
    marker: block.marker,
    contentHash: block.contentHash,
    dedupKey: block.dedupKey,
    start: block.start,
    end: block.end,
    allDay: block.allDay,
    status: block.showAs === "free" ? "free" : "blocked",
  }));
}

function compared(
  rules: CompareRule[],
  events: SourceEvent[],
  blocks: ExistingBlock[],
  slice = SLICE,
): Promise<SliceResult> {
  return compareSlice({
    rules,
    events: new Map([[SOURCE, events]]),
    blocks,
    slice,
    startedAt: STARTED,
  });
}

const NONE = { missing: 0, surplus: 0, mismatched: 0, duplicates: 0 };

function utc(time: number): number {
  return Math.floor(time / DAY) * DAY;
}

function dateOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

describe("comparison of one slice", () => {
  it("finds nothing if the target holds exactly what the planner wants", async () => {
    const from = rule("rule-a", {
      skipAllDay: false,
      skipFree: false,
      bufferBefore: 15,
      bufferAfter: 30,
    });
    const events = [
      event("event:1"),
      event("event:2", {
        start: "2026-11-05T08:00:00.000Z",
        end: "2026-11-05T09:30:00.000Z",
        isPrivate: true,
      }),
      event("event:3", { start: "2026-11-06", end: "2026-11-07", allDay: true }),
      event("event:4", { showAs: "tentative" }),
      event("event:5", { showAs: "free", start: "2026-11-07T10:00:00.000Z" }),
    ];
    const result = await compared([from], events, await planned(from, events));
    expect(result).toMatchObject({ counts: NONE, hits: [], expected: 5 });
  });

  it("reports a block that the target lost", async () => {
    const from = rule();
    const events = [event("event:1"), event("event:2", { start: "2026-11-05T10:00:00.000Z" })];
    const [, second] = await planned(from, events);
    const result = await compared([from], events, [second as ExistingBlock]);
    expect(result.counts).toEqual({ ...NONE, missing: 1 });
    expect(result.hits).toEqual([`missing:${await markerFor(from.id, "event:1")}`]);
  });

  it("reports a block whose source event is gone", async () => {
    const from = rule();
    const blocks = await planned(from, [event("event:1")]);
    const result = await compared([from], [], blocks);
    expect(result.counts).toEqual({ ...NONE, surplus: 1 });
    expect(result.hits).toEqual([`surplus:${blocks[0]?.marker}`]);
  });

  it("counts a tag without an active rule as surplus", async () => {
    const from = rule();
    const events = [event("event:1")];
    const blocks = await planned(from, events);
    const orphans = await planned(rule("rule-deleted"), [event("event:9")]);
    const legacy: ExistingBlock = { ...(blocks[0] as ExistingBlock), targetId: "x", ruleTag: "" };
    const result = await compared([from], events, [
      ...blocks,
      ...orphans,
      { ...legacy, marker: "legacy" },
    ]);
    expect(result.counts).toEqual({ ...NONE, surplus: 2 });
  });

  it("reports a time that differs by one minute", async () => {
    const from = rule();
    const events = [event("event:1")];
    const [block] = await planned(from, events);
    const result = await compared([from], events, [
      { ...(block as ExistingBlock), start: "2026-11-04T10:01:00.000Z" },
    ]);
    expect(result.counts).toEqual({ ...NONE, mismatched: 1 });
  });

  it("reports a block that is too large", async () => {
    const from = rule();
    const events = [event("event:1")];
    const [block] = await planned(from, events);
    const result = await compared([from], events, [
      { ...(block as ExistingBlock), end: "2026-11-04T12:00:00.000Z" },
    ]);
    expect(result.counts).toEqual({ ...NONE, mismatched: 1 });
  });

  it("reports a block with the wrong status", async () => {
    const from = rule();
    const events = [event("event:1")];
    const [block] = await planned(from, events);
    const result = await compared([from], events, [
      { ...(block as ExistingBlock), status: "free" },
    ]);
    expect(result.counts).toEqual({ ...NONE, mismatched: 1 });
  });

  it("treats tentative and out of office as blocked, because Google has neither", async () => {
    const from = rule();
    const events = [
      event("event:1", { showAs: "tentative" }),
      event("event:2", { showAs: "oof", start: "2026-11-05T10:00:00.000Z" }),
    ];
    const blocks = await planned(from, events);
    expect(blocks.map((block) => block.status)).toEqual(["blocked", "blocked"]);
    expect((await compared([from], events, blocks)).counts).toEqual(NONE);
  });

  it("reports a timed block for an all-day event", async () => {
    const from = rule("rule-a", { skipAllDay: false });
    const events = [event("event:1", { start: "2026-11-05", end: "2026-11-06", allDay: true })];
    const [block] = await planned(from, events);
    const result = await compared([from], events, [
      {
        ...(block as ExistingBlock),
        start: "2026-11-05T00:00:00.000Z",
        end: "2026-11-06T00:00:00.000Z",
        allDay: false,
      },
    ]);
    expect(result.counts).toEqual({ ...NONE, mismatched: 1 });
  });

  it("compares no privacy and no content", async () => {
    const from = rule();
    const events = [event("event:1", { subject: "Board", isPrivate: true })];
    const [block] = await planned(from, events);
    const result = await compared([from], events, [
      { ...(block as ExistingBlock), contentHash: "other", dedupKey: "other" },
    ]);
    expect(result.counts).toEqual(NONE);
  });
});

describe("slices and the horizon", () => {
  it("counts a block in the slice in which it begins", async () => {
    const from = rule();
    const events = [
      event("event:1", { start: "2026-11-09T23:00:00.000Z", end: "2026-11-10T01:00:00.000Z" }),
    ];
    const blocks = await planned(from, events);
    const next = { start: SLICE.end, end: SLICE.end + 7 * DAY };
    expect(await compared([from], events, blocks)).toMatchObject({ counts: NONE, expected: 1 });
    expect(await compared([from], events, blocks, next)).toMatchObject({
      counts: NONE,
      expected: 0,
    });
    // The next slice neither wants the event nor judges the block that reaches into it.
    expect((await compared([from], [], blocks, next)).counts).toEqual(NONE);
    expect((await compared([from], [], blocks)).counts).toEqual({ ...NONE, surplus: 1 });
  });

  it("gives a buffered block to the slice of its own start", async () => {
    const from = rule("rule-a", { bufferBefore: MAX_BUFFER_MINUTES });
    const events = [
      event("event:1", { start: "2026-11-10T03:00:00.000Z", end: "2026-11-10T04:00:00.000Z" }),
    ];
    const blocks = await planned(from, events);
    const next = { start: SLICE.end, end: SLICE.end + 7 * DAY };
    expect(await compared([from], events, blocks)).toMatchObject({ counts: NONE, expected: 1 });
    expect(await compared([from], events, blocks, next)).toMatchObject({
      counts: NONE,
      expected: 0,
    });
  });

  it("reads the sources wider by the longest buffer", () => {
    const margin = MAX_BUFFER_MINUTES * 60_000;
    expect(sourceReadWindow(SLICE)).toEqual({
      start: new Date(SLICE.start - margin),
      end: new Date(SLICE.end + margin),
    });
  });

  it("reads the target a little wider than the slice, for a block without duration", () => {
    expect(blockReadWindow(SLICE).end).toEqual(new Date(SLICE.end));
    expect(blockReadWindow(SLICE).start.getTime()).toBeLessThan(SLICE.start);
  });

  it("judges timed blocks of today, but neither all-day blocks of today nor the last day", async () => {
    const from = rule("rule-a", { daysAhead: 10, skipAllDay: false });
    const today = utc(STARTED);
    const allDayToday = event("event:1", {
      allDay: true,
      start: dateOf(today),
      end: dateOf(today + DAY),
    });
    const lastDay = event("event:2", { start: "2026-11-11T10:00:00.000Z" });
    const inside = event("event:3", { start: "2026-11-10T23:00:00.000Z" });
    const timedToday = event("event:4", {
      start: "2026-11-02T06:00:00.000Z",
      end: "2026-11-02T07:00:00.000Z",
    });
    const wide = { start: today, end: SLICE.end + 7 * DAY };
    const result = await compared([from], [allDayToday, lastDay, inside, timedToday], [], wide);
    expect(result.counts).toEqual({ ...NONE, missing: 2 });
    expect(result.hits.sort()).toEqual(
      [
        `missing:${await markerFor(from.id, "event:3")}`,
        `missing:${await markerFor(from.id, "event:4")}`,
      ].sort(),
    );
    // A block on such a day stays unjudged too.
    const blocks = await planned(from, [allDayToday, lastDay]);
    expect((await compared([from], [], blocks, wide)).counts).toEqual(NONE);
    const judged = await planned(from, [timedToday]);
    expect((await compared([from], [], judged, wide)).counts).toEqual({ ...NONE, surplus: 1 });
  });

  it("starts at today, and ends at the widest rule or after 7 days for the near mode", () => {
    const rules = [rule("a", { daysAhead: 10 }), rule("b", { daysAhead: 30 })];
    const start = firstSliceStart(STARTED);
    expect(start).toBe(utc(STARTED));
    expect(scanHorizon(rules, STARTED, "full")).toEqual({
      start,
      end: Date.parse("2026-12-01T00:00:00Z"),
    });
    expect(scanHorizon(rules, STARTED, "near")).toEqual({ start, end: start + 7 * DAY });
  });

  it("reads a calendar without a rule as far as any rule can write", () => {
    const start = firstSliceStart(STARTED);
    expect(scanHorizon([], STARTED, "leftover")).toEqual({
      start,
      end: start + LEFTOVER_DAYS * DAY,
    });
    expect(ruleOptionsSchema.safeParse({ daysAhead: LEFTOVER_DAYS }).success).toBe(true);
    expect(ruleOptionsSchema.safeParse({ daysAhead: LEFTOVER_DAYS + 1 }).success).toBe(false);
  });
});

describe("blocks of another calendar row", () => {
  it("leaves blocks alone that a rule wrote through another row of the same remote calendar", async () => {
    const from = rule();
    const other = rule("rule-other");
    const events = [event("event:1")];
    const own = await planned(from, events);
    const foreign = await planned(other, [event("event:9", { start: "2026-11-05T10:00:00.000Z" })]);
    const input = {
      rules: [from],
      events: new Map([[SOURCE, events]]),
      blocks: [...own, ...foreign],
      slice: SLICE,
      startedAt: STARTED,
    };
    expect((await compareSlice(input)).counts).toEqual({ ...NONE, surplus: 1 });
    expect((await compareSlice({ ...input, others: ["rule-other"] })).counts).toEqual(NONE);
  });

  it("takes all marked blocks of a calendar without a rule for surplus", async () => {
    const blocks = await planned(rule("gone"), [event("event:1"), event("event:2")]);
    const result = await compareSlice({
      rules: [],
      events: new Map(),
      blocks,
      slice: SLICE,
      startedAt: STARTED,
    });
    expect(result).toMatchObject({ counts: { ...NONE, surplus: 2 }, expected: 0 });
  });
});

describe("the work of a step", () => {
  it("counts an event once per rule that hashes it", () => {
    const events = new Map([
      [SOURCE, [event("event:1"), event("event:2")]],
      ["other", [event("event:3")]],
    ]);
    const rules = [rule("a"), rule("b"), rule("c", {}, "other")];
    expect(sliceItems(10, rules, events)).toBe(10 + 2 + 2 + 1);
  });
});

describe("duplicates", () => {
  it("counts the same marker twice, also for a block without a wanted event", async () => {
    const from = rule();
    const events = [event("event:1")];
    const blocks = await planned(from, events);
    const copy = { ...(blocks[0] as ExistingBlock), targetId: "copy" };
    expect((await compared([from], events, [...blocks, copy])).counts).toEqual({
      ...NONE,
      duplicates: 1,
    });
    // An orphan twice is surplus and a duplicate. `sync_run` counts it differently, on purpose.
    expect((await compared([from], [], [...blocks, copy])).counts).toEqual({
      ...NONE,
      surplus: 2,
      duplicates: 1,
    });
  });

  it("counts a block that a block of a rule with precedence covers", async () => {
    const [first, second] = [rule("rule-a"), rule("rule-b")].sort((a, b) => (a.id < b.id ? -1 : 1));
    const tags = [await ruleTagFor("rule-a"), await ruleTagFor("rule-b")];
    const [early, late] = tags[0]! < tags[1]! ? [first!, second!] : [second!, first!];
    const events = [event("event:1")];
    const [kept] = await planned(early, events);
    const [extra] = await planned(late, events);
    expect(kept?.dedupKey).toBe(extra?.dedupKey);
    const result = await compared([early, late], events, [
      kept as ExistingBlock,
      extra as ExistingBlock,
    ]);
    expect(result.counts).toEqual({ ...NONE, duplicates: 1 });
    expect(result.hits).toEqual([`duplicate:${extra?.marker}`]);
  });

  it("does not count blocks without a dedup key as equal", async () => {
    const tags = await Promise.all(["rule-a", "rule-b"].map((id) => ruleTagFor(id)));
    const [earlyId, lateId] = tags[0]! < tags[1]! ? ["rule-a", "rule-b"] : ["rule-b", "rule-a"];
    const [early, late] = [rule(earlyId), rule(lateId)];
    const events = [event("event:1")];
    const blocks = [...(await planned(early, events)), ...(await planned(late, events))].map(
      (block) => ({ ...block, dedupKey: "" }),
    );
    expect((await compared([early, late], events, blocks)).counts).toEqual(NONE);
  });

  it("takes a block with another status for no stand-in", async () => {
    const tags = await Promise.all(["rule-a", "rule-b"].map((id) => ruleTagFor(id)));
    const [earlyId, lateId] = tags[0]! < tags[1]! ? ["rule-a", "rule-b"] : ["rule-b", "rule-a"];
    const [early, late] = [rule(earlyId), rule(lateId)];
    const events = [event("event:1")];
    const blocks = (await planned(early, events)).map((block) => ({
      ...block,
      status: "free" as const,
    }));
    expect((await compared([early, late], events, blocks)).counts).toEqual({
      ...NONE,
      missing: 1,
      mismatched: 1,
    });
  });

  it("wants no block for a block that slotmirror wrote itself", async () => {
    const mirror = event("event:1", { isMirror: true });
    expect((await compared([rule()], [mirror], [])).expected).toBe(0);
  });

  it("accepts the second block that a wider buffer writes on purpose", async () => {
    const tags = await Promise.all(["rule-a", "rule-b"].map((id) => ruleTagFor(id)));
    const [earlyId, lateId] = tags[0]! < tags[1]! ? ["rule-a", "rule-b"] : ["rule-b", "rule-a"];
    const early = rule(earlyId);
    const late = rule(lateId, { bufferAfter: 30 });
    const events = [event("event:1")];
    const blocks = await planned(early, events);
    const wider = await planned(late, events, blocks);
    expect(wider).toHaveLength(1);
    expect(blocks[0]?.dedupKey).toBe(wider[0]?.dedupKey);
    expect((await compared([early, late], events, [...blocks, ...wider])).counts).toEqual(NONE);
  });

  it("does not count the same dedup key alone", async () => {
    const tags = await Promise.all(["rule-a", "rule-b"].map((id) => ruleTagFor(id)));
    const [earlyId, lateId] = tags[0]! < tags[1]! ? ["rule-a", "rule-b"] : ["rule-b", "rule-a"];
    const early = rule(earlyId, { bufferBefore: 15 });
    const late = rule(lateId, { bufferAfter: 15 });
    const events = [event("event:1")];
    const blocks = await planned(early, events);
    const other = await planned(late, events, blocks);
    expect((await compared([early, late], events, [...blocks, ...other])).counts).toEqual(NONE);
  });

  it("does not count two events of one rule with the same dedup key", async () => {
    const from = rule();
    const events = [event("event:1"), event("event:2")];
    const blocks = await planned(from, events);
    expect(blocks).toHaveLength(2);
    expect((await compared([from], events, blocks)).counts).toEqual(NONE);
  });

  it("does not take blocks of an inactive rule for precedence", async () => {
    const tags = await Promise.all(["rule-a", "rule-b"].map((id) => ruleTagFor(id)));
    const [earlyId, lateId] = tags[0]! < tags[1]! ? ["rule-a", "rule-b"] : ["rule-b", "rule-a"];
    const late = rule(lateId);
    const events = [event("event:1")];
    const orphan = await planned(rule(earlyId), events);
    const own = await planned(late, events);
    expect((await compared([late], events, [...orphan, ...own])).counts).toEqual({
      ...NONE,
      surplus: 1,
    });
  });
});

describe("blocks of other rules", () => {
  async function ordered(): Promise<[string, string]> {
    const tags = await Promise.all(["rule-a", "rule-b"].map((id) => ruleTagFor(id)));
    return tags[0]! < tags[1]! ? ["rule-a", "rule-b"] : ["rule-b", "rule-a"];
  }

  it("expects no block for an event that a rule with precedence blocks", async () => {
    const [earlyId, lateId] = await ordered();
    const early = rule(earlyId);
    const late = rule(lateId);
    const events = [event("event:1")];
    const blocks = await planned(early, events);
    expect(await planned(late, events, blocks)).toEqual([]);
    expect((await compared([early, late], events, blocks)).counts).toEqual(NONE);
  });

  it("wants the block of the rule with precedence, even if a later rule covers the time", async () => {
    const [earlyId, lateId] = await ordered();
    const early = rule(earlyId);
    const late = rule(lateId);
    const events = [event("event:1")];
    const later = await planned(late, events);
    expect((await compared([early, late], events, later)).counts).toEqual({ ...NONE, missing: 1 });
  });

  it("wants a wider block that the rule with precedence does not cover", async () => {
    const [earlyId, lateId] = await ordered();
    const early = rule(earlyId);
    const late = rule(lateId, { bufferAfter: 30 });
    const events = [event("event:1")];
    const blocks = await planned(early, events);
    expect((await compared([early, late], events, blocks)).counts).toEqual({ ...NONE, missing: 1 });
  });

  it("uses the marker and the tag of the planner, without importing them", async () => {
    const from = rule("rule-z");
    const events = [event("series:abc:2026-11-04T10:00:00.000Z")];
    const blocks = await planned(from, events);
    expect((await compared([from], events, blocks)).counts).toEqual(NONE);
    expect((await compared([from], [], blocks)).hits).toEqual([
      `surplus:${await markerFor(from.id, events[0]!.occurrenceKey)}`,
    ]);
  });
});

/**
 * What each rule option does in a comparison. A case proves that the comparator reacts as its role
 * says. The test below fails for an option of the schema without a case.
 */
type OptionRole = (typeof OPTION_ROLES)[keyof RuleOptions];

/** Each case shows the behaviour of its option and returns the role that this behaviour proves. */
const OPTION_CASES: Record<string, () => Promise<OptionRole>> = {
  skipAllDay: () =>
    filters(
      { skipAllDay: true },
      { skipAllDay: false },
      event("event:1", { start: "2026-11-05", end: "2026-11-06", allDay: true }),
    ),
  skipFree: () =>
    filters({ skipFree: true }, { skipFree: false }, event("event:1", { showAs: "free" })),
  skipTentative: () =>
    filters(
      { skipTentative: true },
      { skipTentative: false },
      event("event:1", { showAs: "tentative" }),
    ),
  skipDeclined: () =>
    filters({ skipDeclined: true }, { skipDeclined: false }, event("event:1", { declined: true })),
  skipCategories: () =>
    filters(
      { skipCategories: [" Privat "] },
      { skipCategories: [] },
      event("event:1", { categories: ["privat"] }),
    ),
  // 2026-11-04 is a Wednesday, 10:00 UTC.
  workDays: () =>
    filters(
      { workDays: [1, 2], workStart: "09:00", workEnd: "17:00" },
      { workDays: [1, 2, 3], workStart: "09:00", workEnd: "17:00" },
      event("event:1"),
    ),
  workStart: () =>
    filters(
      { workDays: [3], workStart: "12:00", workEnd: "17:00" },
      { workDays: [3], workStart: "09:00", workEnd: "17:00" },
      event("event:1"),
    ),
  workEnd: () =>
    filters(
      { workDays: [3], workStart: "08:00", workEnd: "09:00" },
      { workDays: [3], workStart: "08:00", workEnd: "17:00" },
      event("event:1"),
    ),
  workTimeZone: () =>
    filters(
      { workDays: [3], workStart: "08:00", workEnd: "10:00", workTimeZone: "Asia/Tokyo" },
      { workDays: [3], workStart: "08:00", workEnd: "10:00", workTimeZone: "UTC" },
      event("event:1", { start: "2026-11-04T09:00:00.000Z" }),
    ),
  daysAhead: async () => {
    const wide = { start: SLICE.start, end: SLICE.end + 30 * DAY };
    const late = event("event:1", { start: "2026-11-20T10:00:00.000Z" });
    expect((await compared([rule("r", { daysAhead: 10 })], [late], [], wide)).expected).toBe(0);
    expect((await compared([rule("r", { daysAhead: 30 })], [late], [], wide)).expected).toBe(1);
    return "horizon";
  },
  bufferBefore: () => movesBlock({ bufferBefore: 30 }),
  bufferAfter: () => movesBlock({ bufferAfter: 30 }),
  detailLevel: () => ignored({ detailLevel: "full" }),
  blockTitle: () => ignored({ blockTitle: "Away" }),
  markPrivate: () => ignored({ markPrivate: false }),
  blockColor: () => ignored({ blockColor: "5" }),
  showOrigin: () => ignored({ showOrigin: true }),
  linkOrigin: () => ignored({ linkOrigin: true }),
  originLocale: () => ignored({ originLocale: "de" }),
};

/** With `drop` the rule wants no block for the event, with `keep` it does. */
async function filters(
  drop: Partial<RuleOptions>,
  keep: Partial<RuleOptions>,
  source: SourceEvent,
): Promise<OptionRole> {
  const wanted = rule("rule-a", keep);
  expect((await compared([rule("rule-a", drop)], [source], [])).expected).toBe(0);
  expect((await compared([wanted], [source], [])).counts).toEqual({ ...NONE, missing: 1 });
  // The planner agrees on both sides.
  expect(await planned(rule("rule-a", drop), [source])).toEqual([]);
  expect(await planned(wanted, [source])).toHaveLength(1);
  return "filter";
}

/** The option changes where the rule wants the block, so a block without it no longer fits. */
async function movesBlock(change: Partial<RuleOptions>): Promise<OptionRole> {
  const events = [event("event:1")];
  const before = await planned(rule(), events);
  const after = rule("rule-a", change);
  expect((await compared([after], events, before)).counts).toEqual({ ...NONE, mismatched: 1 });
  expect((await compared([after], events, await planned(after, events))).counts).toEqual(NONE);
  return "times";
}

/** The option changes the content of a block only, which a comparison does not read. */
async function ignored(change: Partial<RuleOptions>): Promise<OptionRole> {
  const events = [event("event:1", { subject: "Title", location: "Room", body: "Text" })];
  const before = await planned(rule(), events);
  expect((await compared([rule("rule-a", change)], events, before)).counts).toEqual(NONE);
  return "content";
}

describe("rule options", () => {
  const names = Object.keys(ruleOptionsSchema.shape);

  it("has a role and a case for every option", () => {
    expect(names.length).toBeGreaterThan(10);
    expect(Object.keys(OPTION_ROLES).sort()).toEqual([...names].sort());
    expect(Object.keys(OPTION_CASES).sort()).toEqual([...names].sort());
  });

  it.each(names)("handles %s", async (name) => {
    const check = OPTION_CASES[name];
    if (!check) throw new Error(`Option ${name} has no case`);
    expect(await check()).toBe(OPTION_ROLES[name as keyof RuleOptions]);
  });
});

describe("rule set hash", () => {
  it("does not depend on the order of the rules", async () => {
    const [a, b] = [rule("a"), rule("b")];
    expect(await ruleSetHash([a, b])).toBe(await ruleSetHash([b, a]));
  });

  it("changes with a rule, an option or a source", async () => {
    const base = await ruleSetHash([rule("a")]);
    expect(await ruleSetHash([rule("b")])).not.toBe(base);
    expect(await ruleSetHash([rule("a", { daysAhead: 30 })])).not.toBe(base);
    expect(await ruleSetHash([rule("a", {}, "other")])).not.toBe(base);
    expect(await ruleSetHash([])).not.toBe(base);
  });

  it("changes with a rule of another calendar row, in any order", async () => {
    const base = await ruleSetHash([rule("a")]);
    expect(await ruleSetHash([rule("a")], ["other"])).not.toBe(base);
    expect(await ruleSetHash([rule("a")], ["x", "y"])).toBe(
      await ruleSetHash([rule("a")], ["y", "x"]),
    );
  });
});

function scan(mode: "full" | "near" = "full"): CompareState {
  return newCompare({
    calendarId: "calendar",
    remoteCalendarId: "remote",
    mode,
    ruleHash: "hash",
    now: STARTED,
  });
}

function finding(...hits: string[]): SliceResult {
  const counts = { ...NONE };
  for (const hit of hits) {
    if (hit.startsWith("missing:")) counts.missing++;
    else if (hit.startsWith("surplus:")) counts.surplus++;
    else if (hit.startsWith("mismatched:")) counts.mismatched++;
    else counts.duplicates++;
  }
  return { counts, hits, expected: hits.length };
}

describe("scan state", () => {
  const horizon = { start: firstSliceStart(STARTED), end: firstSliceStart(STARTED) + 10 * DAY };

  it("cuts 7-day slices and stops at the horizon", () => {
    let state = scan();
    const first = sliceAfter(state, horizon);
    expect(first).toEqual({ start: state.sliceStart, end: state.sliceStart + 7 * DAY });
    state = addSlice(state, first.end, finding());
    expect(sliceAfter(state, horizon)).toEqual({ start: first.end, end: horizon.end });
  });

  it("adds counts and keeps one entry per hit, up to the cap", () => {
    let state = scan();
    const many = Array.from({ length: MAX_HITS + 5 }, (_, index) => `missing:${index}`);
    state = addSlice(state, SLICE.end, finding(...many));
    state = addSlice(state, SLICE.end + DAY, finding("missing:0"));
    expect(state.counts.missing).toBe(MAX_HITS + 6);
    expect(state.hits).toHaveLength(MAX_HITS);
    expect(state.capped).toBe(true);
    expect(new Set(state.hits).size).toBe(MAX_HITS);
  });

  it("halves a slice down to one day, and then gives up", () => {
    const sizes: number[] = [];
    let state: CompareState | null = scan();
    while (state) {
      sizes.push(state.sliceDays);
      state = halveSlice(state);
    }
    expect(sizes).toEqual([7, 3, 1]);
  });

  it("grows a halved slice again after a success", () => {
    let state = halveSlice(halveSlice(scan()) as CompareState) as CompareState;
    expect(state.sliceDays).toBe(1);
    state = addSlice(state, state.sliceStart + DAY, finding());
    expect(state.sliceDays).toBe(2);
    state = addSlice(state, state.sliceStart + 2 * DAY, finding());
    state = addSlice(state, state.sliceStart + 4 * DAY, finding());
    expect(state.sliceDays).toBe(7);
    state = addSlice(state, state.sliceStart + 7 * DAY, finding());
    expect(state.sliceDays).toBe(7);
  });

  it("forgets a read in progress with every new slice size", () => {
    const state = { ...scan(), attempt: SLICE.start };
    expect(halveSlice(state)?.attempt).toBeUndefined();
    expect(addSlice(state, SLICE.end, finding()).attempt).toBeUndefined();
  });

  it("reports a clean first scan at once", () => {
    const state = addSlice(scan(), SLICE.end, { ...finding(), expected: 12 });
    const done = finishScan(state, STARTED + 1000);
    expect(done).toMatchObject({
      detail: {
        calendarId: "calendar",
        mode: "full",
        rounds: 1,
        slices: 1,
        expected: 12,
        deviations: 0,
        unconfirmed: 0,
        cleared: 0,
        clearedHits: "",
        hits: "",
        clean: true,
      },
    });
  });

  it("waits for a confirmation if a first scan found something", () => {
    const state = addSlice(scan(), SLICE.end, finding("missing:a"));
    const next = finishScan(state, STARTED + 1000);
    expect(next).toMatchObject({
      state: { phase: "confirming", first: { at: STARTED + 1000, hits: ["missing:a"] } },
    });
  });

  /** A scan with the first hits, its wait, and a second scan with the second hits. */
  function confirmed(firstHits: string[], secondHits: string[]) {
    const waiting = finishScan(addSlice(scan(), SLICE.end, finding(...firstHits)), STARTED + 1000);
    if (!("state" in waiting)) throw new Error("expected a wait");
    const second = startConfirmScan(waiting.state);
    const result = { ...finding(...secondHits), expected: secondHits.length + 3 };
    const done = finishScan(addSlice(second, SLICE.end, result), STARTED + DAY + 1);
    if (!("detail" in done)) throw new Error("expected a result");
    return done.detail;
  }

  it("counts only hits that remain in the second scan", () => {
    expect(
      confirmed(
        ["missing:a", "surplus:b", "duplicate:c"],
        ["surplus:b", "duplicate:c", "mismatched:d"],
      ),
    ).toMatchObject({
      rounds: 2,
      missing: 0,
      surplus: 1,
      mismatched: 0,
      duplicates: 1,
      deviations: 2,
      unconfirmed: 1,
      cleared: 1,
      clearedHits: "missing:a",
      hits: "surplus:b,duplicate:c",
      clean: false,
    });
  });

  it("keeps the window of the first scan for the second, so that no hit falls out", () => {
    const state = addSlice(scan(), SLICE.end, finding("missing:a"));
    const waiting = finishScan(state, STARTED + 1000);
    if (!("state" in waiting)) throw new Error("expected a wait");
    const second = startConfirmScan({ ...waiting.state, sliceDays: 1 });
    expect(second).toMatchObject({
      phase: "scanning",
      startedAt: STARTED,
      sliceStart: firstSliceStart(STARTED),
      sliceDays: 7,
      slices: 0,
      counts: NONE,
      hits: [],
    });
  });

  it("follows a marker whose kind changes between the scans", () => {
    expect(confirmed(["missing:a"], ["mismatched:a"])).toMatchObject({
      mismatched: 1,
      deviations: 1,
      unconfirmed: 0,
      cleared: 0,
      hits: "mismatched:a",
      clean: false,
    });
  });

  it("is not clean with a hit that only the second scan found", () => {
    expect(confirmed(["missing:a"], ["missing:b"])).toMatchObject({
      deviations: 0,
      unconfirmed: 1,
      cleared: 1,
      clean: false,
    });
  });

  it("is clean if a run repaired every hit, and names what it repaired", () => {
    expect(confirmed(["missing:a", "duplicate:b"], [])).toMatchObject({
      deviations: 0,
      unconfirmed: 0,
      cleared: 2,
      clearedHits: "missing:a,duplicate:b",
      hits: "",
      clean: true,
    });
  });

  it("is not clean if the list of the first scan was full", () => {
    const many = Array.from({ length: MAX_HITS + 1 }, (_, index) => `missing:${index}`);
    expect(confirmed(many, [])).toMatchObject({ hitsCapped: true, clean: false });
    expect(confirmed(many, ["missing:late"])).toMatchObject({
      unconfirmed: 1,
      hitsCapped: true,
      clean: false,
    });
  });

  it("takes a list with exactly the cap for a full one", () => {
    const many = Array.from({ length: MAX_HITS }, (_, index) => `missing:${index}`);
    expect(addSlice(scan(), SLICE.end, finding(...many)).capped).toBe(true);
  });

  it("is no comparison if no block was wanted and none was found", () => {
    const state = addSlice(scan(), SLICE.end, { ...finding(), expected: 0 });
    expect(finishScan(state, STARTED + 1)).toMatchObject({
      detail: { expected: 0, deviations: 0, clean: false },
    });
  });

  it("marks a result whose list reached the cap", () => {
    const many = Array.from({ length: MAX_HITS + 1 }, (_, index) => `missing:${index}`);
    expect(confirmed(many, many)).toMatchObject({ hitsCapped: true, deviations: MAX_HITS });
  });

  it("gives every detail value a flat type", () => {
    const state = addSlice(scan(), SLICE.end, finding());
    const done = finishScan(state, STARTED + 1);
    if (!("detail" in done)) throw new Error("expected a result");
    for (const value of Object.values(done.detail)) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });
});

// Vite inlines the glob at build time. The `vite/client` types are not a dependency here.
// @ts-expect-error `import.meta.glob` is untyped without `vite/client`
const sources: Record<string, string> = import.meta.glob("../src/sync/compare.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("independence", () => {
  it("imports nothing from the planner", () => {
    const code = sources["../src/sync/compare.ts"];
    expect(code).toBeDefined();
    const imports = [...(code as string).matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((path) => /plan/.test(path ?? ""))).toEqual([]);
  });
});
