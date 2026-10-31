/**
 * All-day events are mirrored by default. A rule with a stored `skipAllDay` keeps its value, and a
 * user who never saved the settings keeps what their rules do.
 *
 * The time-zone matrix runs against a model of a calendar, not against a provider. `inRead` models
 * the filter of a provider, and `asExisting` returns each block as the planner wrote it. So the
 * matrix shows two things for that model: a second run changes nothing, and the comparison finds no
 * difference. The form of a real response has its own tests, with raw forms from live reads.
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRuleOptions, ruleOptionsSchema, type RuleOptions } from "../src/config";
import {
  loadEditorState,
  setDefaultBlockTitle,
  setDirection,
  setRuleDetails,
  setSettings,
} from "../src/editor";
import { busyEvents } from "../src/feeds";
import { messagesFor } from "../src/i18n";
import { toGraphBlock } from "../src/providers/graph-calendar";
import {
  blockReadWindow,
  compareSlice,
  scanHorizon,
  sourceReadWindow,
  type CompareRule,
} from "../src/sync/compare";
import { fromGoogleEvent, toGoogleBlock } from "../src/sync/google-events";
import { fromGraphEvent } from "../src/sync/graph-events";
import {
  claimsFrom,
  desiredBlocks,
  inPrecedenceOrder,
  isIncluded,
  planSync,
  ruleTagFor,
} from "../src/sync/plan";
import { readWindow, syncWindow, targetReadWindow } from "../src/sync/rules";
import type { DesiredBlock, ExistingBlock, SourceEvent } from "../src/sync/types";
import { BASE, signIn } from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A Wednesday, in the middle of a UTC day. */
const NOW = new Date("2026-11-04T09:00:00.000Z");
const TODAY = Date.UTC(2026, 10, 4);
const SCOPE = "all-day-user";

const dateOn = (day: number) => new Date(TODAY + day * DAY).toISOString().slice(0, 10);

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
    subject: "Away",
    location: "",
    body: "",
    isMirror: false,
    ...changes,
  } satisfies SourceEvent;
}

/** An all-day event from `first` to `last`, counted in days from today, both included. */
const allDay = (key: string, first: number, last = first, changes: Partial<SourceEvent> = {}) =>
  event(key, dateOn(first), dateOn(last + 1), changes);

type Window = { start: Date; end: Date };
type Times = { start: string; end: string; allDay: boolean };
/** A calendar's time zone: hours east of UTC, or an IANA name with its clock changes. */
type Zone = number | string;

/** The hours east of UTC of an IANA zone at an instant, in milliseconds. */
function offsetOf(zone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant at which a date starts in a zone. */
function midnightOf(date: string, zone: Zone): number {
  const utc = Date.parse(date);
  if (typeof zone === "number") return utc - zone * HOUR;
  return utc - offsetOf(zone, utc - offsetOf(zone, utc));
}

/**
 * True if the modelled calendar returns the item for the window. It filters all-day events at the
 * midnights of its zone, but returns them as dates. A real provider can differ from this model.
 */
function inRead(times: Times, window: Window, zone: Zone): boolean {
  const start = times.allDay ? midnightOf(times.start, zone) : Date.parse(times.start);
  const end = times.allDay ? midnightOf(times.end, zone) : Date.parse(times.end);
  return start < window.end.getTime() && end > window.start.getTime();
}

/** The block as the planner wrote it. The tests of a live response cover the other side. */
function asExisting(block: DesiredBlock, ruleTag: string, targetId: string): ExistingBlock {
  return {
    targetId,
    ruleTag,
    marker: block.marker,
    contentHash: block.contentHash,
    dedupKey: block.dedupKey,
    start: block.start,
    end: block.end,
    allDay: block.allDay,
    status: block.showAs === "free" ? "free" : "blocked",
  };
}

/**
 * Two runs of a rule against modelled calendars at the given zones; the second changes nothing.
 * `before` holds the blocks of earlier runs. Returns them with the blocks of this run.
 */
async function mirrored(
  id: string,
  options: RuleOptions,
  events: SourceEvent[],
  zones: { source: Zone; target: Zone },
  now = NOW,
  before: ExistingBlock[] = [],
): Promise<ExistingBlock[]> {
  const sync = syncWindow(options, now);
  const read = readWindow(sync, options);
  const target = targetReadWindow(sync);
  const tag = await ruleTagFor(id);
  const source = events.filter((item) => inRead(item, read ?? sync, zones.source));
  const desired = await desiredBlocks(id, source, options, { scope: SCOPE });
  const earlier = before.filter((block) => inRead(block, target, zones.target));
  const first = planSync(desired, earlier, { sync, target, read });
  expect(first.stats.delete + first.stats.update).toBe(0);
  const created = first.actions.flatMap((action, index) =>
    action.kind === "create"
      ? [asExisting(action.block, tag, `${id}-${before.length + index}`)]
      : [],
  );
  const blocks = [...before, ...created];
  const shown = blocks.filter((block) => inRead(block, target, zones.target));
  const again = planSync(desired, shown, { sync, target, read });
  const wanted = new Set(desired.map((block) => block.marker));
  expect(again.stats).toEqual({
    create: 0,
    update: 0,
    delete: 0,
    unchanged: shown.filter((block) => wanted.has(block.marker)).length,
  });
  return blocks;
}

/** The comparison of the whole horizon, reading both calendars as `mirrored` does. */
async function compared(
  rules: CompareRule[],
  events: SourceEvent[],
  blocks: ExistingBlock[],
  zones: { source: Zone; target: Zone },
  now = NOW,
) {
  const slice = scanHorizon(rules, now.getTime(), "full");
  return compareSlice({
    rules,
    events: new Map([
      ["source", events.filter((item) => inRead(item, sourceReadWindow(slice), zones.source))],
    ]),
    blocks: blocks.filter((block) => inRead(block, blockReadWindow(slice), zones.target)),
    slice,
    startedAt: now.getTime(),
  });
}

const NONE = { missing: 0, surplus: 0, mismatched: 0, duplicates: 0 };

/**
 * Raw forms from live reads. Under `Prefer: outlook.timezone="UTC"`, Graph returns an all-day event
 * at midnight, also an event from a CET mailbox, whose instants are 09.11. 23:00Z to 10.11. 23:00Z.
 */
const GRAPH_ALL_DAY = {
  isAllDay: true,
  start: { dateTime: "2026-11-10T00:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-11T00:00:00.0000000", timeZone: "UTC" },
};
const GOOGLE_ALL_DAY = { start: { date: "2026-11-05" }, end: { date: "2026-11-06" } };

const spansOf = (items: Times[]) =>
  items
    .filter((item) => item.allDay)
    .map(({ start, end }) => `${start} ${end}`)
    .sort();

/**
 * The all-day dates that a rule without buffers and filters must write: all that the source read
 * returns. The check does not use the plan, so a planner that writes less also fails it.
 */
function datesToWrite(events: SourceEvent[], options: RuleOptions, zone: Zone, now: Date) {
  return spansOf(events.filter((item) => inRead(item, syncWindow(options, now), zone)));
}

describe("the default for all-day events", () => {
  it("mirrors them without a stored value", () => {
    expect(ruleOptionsSchema.parse({}).skipAllDay).toBe(false);
    expect(parseRuleOptions("{}").skipAllDay).toBe(false);
    expect(parseRuleOptions('{"detailLevel":"title"}').skipAllDay).toBe(false);
  });

  it("keeps a stored value", () => {
    expect(parseRuleOptions('{"skipAllDay":true}').skipAllDay).toBe(true);
    expect(parseRuleOptions('{"skipAllDay":false}').skipAllDay).toBe(false);
  });

  it("decides for a rule by the stored value alone", () => {
    const holiday = allDay("event:1", 3);
    expect(isIncluded(holiday, parseRuleOptions("{}"))).toBe(true);
    expect(isIncluded(holiday, parseRuleOptions('{"skipAllDay":true}'))).toBe(false);
  });

  it("still leaves out all-day events that show as free", () => {
    const options = parseRuleOptions("{}");
    expect(isIncluded(allDay("event:1", 3, 3, { showAs: "free" }), options)).toBe(false);
    expect(isIncluded(allDay("event:2", 3, 3, { showAs: "oof" }), options)).toBe(true);
    expect(isIncluded(allDay("event:3", 3, 3, { showAs: "tentative" }), options)).toBe(true);
    const free = { start: { date: dateOn(3) }, end: { date: dateOn(4) } };
    const parsed = fromGoogleEvent({ id: "g", transparency: "transparent", ...free });
    expect(isIncluded(parsed!, options)).toBe(false);
  });
});

describe("a busy feed", () => {
  const read = async (includeAllDay: boolean) => {
    const reads = [{ calendarId: "c1", events: [allDay("event:1", 1)] }];
    return (await busyEvents(reads, { includeAllDay, uidSalt: "salt", today: NOW })).events;
  };

  it("takes all-day events from its own switch, not from the rule default", async () => {
    expect(await read(false)).toEqual([]);
    expect(await read(true)).toHaveLength(1);
  });
});

describe("planner and comparison in the modelled calendar", () => {
  const events = [
    // Around the start of the window, for every zone.
    allDay("event:yesterday", -1),
    allDay("event:today", 0),
    allDay("event:tomorrow", 1),
    // Over the start of the window, and over a weekend.
    allDay("event:across-start", -2, 2),
    allDay("event:friday", 2),
    allDay("event:saturday", 3),
    allDay("event:long-weekend", 2, 5),
    // The last days of the window.
    allDay("event:second-last", 28),
    allDay("event:last", 29),
    allDay("event:at-end", 30),
    allDay("event:over-end", 28, 33),
    // Timed events next to midnight UTC, on days with all-day events.
    event("event:before-midnight", `${dateOn(2)}T23:30:00.000Z`, `${dateOn(3)}T00:30:00.000Z`),
    event("event:at-midnight", `${dateOn(4)}T00:00:00.000Z`, `${dateOn(4)}T01:00:00.000Z`),
  ];
  const SHAPES: Record<string, Record<string, unknown>> = {
    plain: {},
    buffered: { bufferBefore: 30, bufferAfter: 240 },
    office: {
      workDays: [1, 2, 3, 4, 5],
      workStart: "09:00",
      workEnd: "17:00",
      workTimeZone: "Europe/Vienna",
    },
    note: { showOrigin: true, linkOrigin: true, detailLevel: "title" },
  };
  const ZONES = [-12, -8, 0, 1, 14];

  for (const [name, shape] of Object.entries(SHAPES)) {
    for (const source of ZONES) {
      for (const target of ZONES) {
        it(`repeats and compares mirrored ${name} rules, UTC${source} to UTC${target}`, async () => {
          const zones = { source, target };
          const options = ruleOptionsSchema.parse({ daysAhead: 30, ...shape });
          const blocks = await mirrored("rule-a", options, events, zones);
          const rules = [{ id: "rule-a", options, source: "source" }];
          const result = await compared(rules, events, blocks, zones);
          expect(result.counts).toEqual(NONE);
          expect(result.hits).toEqual([]);
          expect(blocks.some((block) => block.allDay)).toBe(true);
          for (const block of blocks.filter((item) => item.allDay)) {
            expect(block.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(block.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          }
        });

        it(`repeats and compares skipping ${name} rules, UTC${source} to UTC${target}`, async () => {
          const zones = { source, target };
          const options = ruleOptionsSchema.parse({ daysAhead: 30, skipAllDay: true, ...shape });
          const blocks = await mirrored("rule-a", options, events, zones);
          expect(blocks.filter((block) => block.allDay)).toEqual([]);
          const rules = [{ id: "rule-a", options, source: "source" }];
          const result = await compared(rules, events, blocks, zones);
          expect(result.counts).toEqual(NONE);
        });
      }
    }
  }

  describe("at midnight", () => {
    const plain = ruleOptionsSchema.parse({ daysAhead: 30 });
    const rules = [{ id: "rule-a", options: plain, source: "source" }];
    const pairs = ZONES.flatMap((source) => ZONES.map((target) => ({ source, target })));

    for (const [name, time] of [
      ["the first instant of the UTC day", "00:00:00.000"],
      ["the last instant of the UTC day", "23:59:59.999"],
      ["midnight at UTC+14", "10:00:00.000"],
      ["midnight at UTC-12", "12:00:00.000"],
    ] as const) {
      it(`repeats and compares a run at ${name}`, async () => {
        const now = new Date(`${dateOn(0)}T${time}Z`);
        for (const zones of pairs) {
          const blocks = await mirrored("rule-a", plain, events, zones, now);
          expect(spansOf(blocks), JSON.stringify(zones)).toEqual(
            datesToWrite(events, plain, zones.source, now),
          );
          const result = await compared(rules, events, blocks, zones, now);
          expect(result.counts, JSON.stringify(zones)).toEqual(NONE);
          expect(result.hits, JSON.stringify(zones)).toEqual([]);
        }
      });
    }

    it("reports nothing for the blocks of a run before midnight UTC", async () => {
      const before = new Date(`${dateOn(0)}T23:59:59.999Z`);
      const after = new Date(`${dateOn(1)}T00:00:00.000Z`);
      for (const zones of pairs) {
        const blocks = await mirrored("rule-a", plain, events, zones, before);
        const result = await compared(rules, events, blocks, zones, after);
        expect(result.counts, JSON.stringify(zones)).toEqual(NONE);
      }
    });

    it("moves no block between the runs before and after midnight UTC", async () => {
      const before = new Date(`${dateOn(0)}T23:59:59.999Z`);
      const after = new Date(`${dateOn(1)}T00:00:00.000Z`);
      for (const zones of pairs) {
        const first = await mirrored("rule-a", plain, events, zones, before);
        const second = await mirrored("rule-a", plain, events, zones, after, first);
        expect(second.slice(0, first.length)).toEqual(first);
        // The date at the end of the old window lies inside the new one, whatever the zone.
        const dates = second.filter((block) => block.allDay).map(({ start }) => start);
        expect(dates, JSON.stringify(zones)).toContain(dateOn(30));
        const result = await compared(rules, events, second, zones, after);
        expect(result.counts, JSON.stringify(zones)).toEqual(NONE);
      }
    });
  });

  describe("around a clock change", () => {
    /** Days on which the clock changes in a zone below, in both directions. */
    const CHANGES = ["2026-10-25", "2026-11-01", "2027-03-14", "2027-03-28", "2027-04-04"];
    const PAIRS = [
      { source: "Europe/Vienna", target: "Europe/Vienna" },
      { source: "Europe/Vienna", target: "America/New_York" },
      { source: "America/New_York", target: "Europe/Vienna" },
      { source: "Australia/Sydney", target: "America/Havana" },
      // Havana changes at midnight, so that one local midnight does not exist.
      { source: "America/Havana", target: "Australia/Sydney" },
      // The Azores change between UTC and UTC-1, so the date around midnight UTC changes.
      { source: "Atlantic/Azores", target: "Europe/Vienna" },
      { source: "Europe/Vienna", target: "Atlantic/Azores" },
    ];

    it("gives the modelled day of a clock change its real length", () => {
      const length = (first: string, next: string, zone: string) =>
        (midnightOf(next, zone) - midnightOf(first, zone)) / HOUR;
      expect(length("2026-10-25", "2026-10-26", "Europe/Vienna")).toBe(25);
      expect(length("2027-03-28", "2027-03-29", "Europe/Vienna")).toBe(23);
      expect(length("2026-11-01", "2026-11-02", "America/New_York")).toBe(25);
      expect(length("2027-03-14", "2027-03-15", "America/New_York")).toBe(23);
      expect(length("2027-04-04", "2027-04-05", "Australia/Sydney")).toBe(25);
      expect(length("2026-10-24", "2026-10-25", "Europe/Vienna")).toBe(24);
    });

    it("writes the date before the window only after the clock of a source allows it", async () => {
      const options = ruleOptionsSchema.parse({ daysAhead: 30 });
      const zones = { source: "Atlantic/Azores", target: "Europe/Vienna" };
      const yesterday = (first: string, last: string) => [event("event:1", first, last)];
      const summer = yesterday("2026-10-24", "2026-10-25");
      const winter = yesterday("2026-10-25", "2026-10-26");
      const atChange = new Date("2026-10-25T09:00:00.000Z");
      const dayLater = new Date("2026-10-26T09:00:00.000Z");
      // At UTC+0 the date ended at midnight UTC. At UTC-1 it lasts until one hour after.
      expect(await mirrored("rule-a", options, summer, zones, atChange)).toEqual([]);
      expect(spansOf(await mirrored("rule-a", options, winter, zones, dayLater))).toEqual([
        "2026-10-25 2026-10-26",
      ]);
    });

    for (const change of CHANGES) {
      const date = (days: number) =>
        new Date(Date.parse(change) + days * DAY).toISOString().slice(0, 10);
      const around = [
        event("event:before", date(-1), date(0)),
        event("event:change", date(0), date(1)),
        event("event:after", date(1), date(2)),
        event("event:over", date(-1), date(2)),
        // Over the hours in which the zones above change their clocks.
        event("event:timed", `${date(0)}T00:30:00.000Z`, `${date(0)}T09:30:00.000Z`),
      ];

      for (const zones of PAIRS) {
        it(`repeats and compares ${zones.source} to ${zones.target} on ${change}`, async () => {
          // The window starts before, on and after the change, and ends on the change.
          for (const days of [-1, 0, 1, -30]) {
            const now = new Date(Date.parse(change) + days * DAY + 9 * HOUR);
            for (const shape of [SHAPES.plain, SHAPES.buffered, SHAPES.office]) {
              const options = ruleOptionsSchema.parse({ daysAhead: 30, ...shape });
              const blocks = await mirrored("rule-a", options, around, zones, now);
              const rules = [{ id: "rule-a", options, source: "source" }];
              const result = await compared(rules, around, blocks, zones, now);
              expect(result.counts, `${days} days`).toEqual(NONE);
              expect(result.hits, `${days} days`).toEqual([]);
              // A day of 23 or 25 hours stays one date. Other shapes read wider or filter days.
              if (shape !== SHAPES.plain) continue;
              expect(spansOf(blocks), `${days} days`).toEqual(
                datesToWrite(around, options, zones.source, now),
              );
            }
          }
        });
      }
    }
  });

  it("wants every date inside the horizon once, as dates and without buffers", async () => {
    const options = ruleOptionsSchema.parse({ daysAhead: 30, bufferBefore: 240, bufferAfter: 240 });
    const zones = { source: 1, target: 1 };
    const blocks = await mirrored("rule-a", options, events, zones);
    const byDates = blocks.filter((block) => block.allDay).map(({ start, end }) => [start, end]);
    expect(byDates).toContainEqual([dateOn(1), dateOn(2)]);
    expect(byDates).toContainEqual([dateOn(-2), dateOn(3)]);
    expect(byDates).toContainEqual([dateOn(2), dateOn(6)]);
    expect(byDates).toContainEqual([dateOn(28), dateOn(34)]);
  });

  it("reports a lost all-day block, and an all-day block that a rule no longer wants", async () => {
    const zones = { source: 0, target: 0 };
    const mirrors = ruleOptionsSchema.parse({ daysAhead: 30 });
    const skips = ruleOptionsSchema.parse({ daysAhead: 30, skipAllDay: true });
    const holiday = [allDay("event:1", 5)];
    const blocks = await mirrored("rule-a", mirrors, holiday, zones);
    const lost = await compared(
      [{ id: "rule-a", options: mirrors, source: "source" }],
      holiday,
      [],
      zones,
    );
    expect(lost.counts).toEqual({ ...NONE, missing: 1 });
    const unwanted = await compared(
      [{ id: "rule-a", options: skips, source: "source" }],
      holiday,
      blocks,
      zones,
    );
    expect(unwanted.counts).toEqual({ ...NONE, surplus: 1 });
  });

  it("tells a moved all-day block from a right one", async () => {
    const zones = { source: 0, target: 0 };
    const options = ruleOptionsSchema.parse({ daysAhead: 30 });
    const [block] = await mirrored("rule-a", options, [allDay("event:1", 5)], zones);
    const moved = { ...block!, end: dateOn(7) };
    const rules = [{ id: "rule-a", options, source: "source" }];
    const result = await compared(rules, [allDay("event:1", 5)], [moved], zones);
    expect(result.counts).toEqual({ ...NONE, mismatched: 1 });
  });

  it("writes one block for an all-day event that two rules mirror into one calendar", async () => {
    const zones = { source: 0, target: 0 };
    const [first, second] = await inPrecedenceOrder(["rule-a", "rule-b"]);
    const plain = ruleOptionsSchema.parse({ daysAhead: 30 });
    const buffered = ruleOptionsSchema.parse({ daysAhead: 30, bufferBefore: 60, bufferAfter: 60 });
    const holiday = [allDay("event:1", 5)];
    const claimed = await mirrored(first!, plain, holiday, zones);
    const wanted = await desiredBlocks(second!, holiday, buffered, {
      scope: SCOPE,
      claimed: claimsFrom(claimed),
    });
    expect(wanted).toEqual([]);
    const result = await compared(
      [
        { id: first!, options: plain, source: "source" },
        { id: second!, options: buffered, source: "source" },
      ],
      holiday,
      claimed,
      zones,
    );
    expect(result.counts).toEqual(NONE);
  });
});

describe("all-day blocks at the providers", () => {
  const multiDay = allDay("event:1", -5, 25, { showAs: "oof" });
  const block = async (options: RuleOptions) => {
    const [desired] = await desiredBlocks("rule-a", [multiDay], options, { scope: SCOPE });
    return desired!;
  };

  it("writes dates to Graph, in UTC or in the zone of the mailbox", async () => {
    const options = ruleOptionsSchema.parse({});
    expect(toGraphBlock(await block(options), "tag")).toMatchObject({
      isAllDay: true,
      showAs: "oof",
      start: { dateTime: `${dateOn(-5)}T00:00:00`, timeZone: "UTC" },
      end: { dateTime: `${dateOn(26)}T00:00:00`, timeZone: "UTC" },
    });
    expect(toGraphBlock(await block(options), "tag", "Pacific Standard Time")).toMatchObject({
      start: { dateTime: `${dateOn(-5)}T00:00:00`, timeZone: "Pacific Standard Time" },
      end: { dateTime: `${dateOn(26)}T00:00:00`, timeZone: "Pacific Standard Time" },
    });
  });

  it("reads the dates from a live Graph response", () => {
    const read = fromGraphEvent({ ...GRAPH_ALL_DAY, id: "event", type: "singleInstance" });
    expect(read).toMatchObject({ start: "2026-11-10", end: "2026-11-11", allDay: true });
  });

  it("reads the dates from a live Google response", () => {
    const read = fromGoogleEvent({ ...GOOGLE_ALL_DAY, id: "event" });
    expect(read).toMatchObject({ start: "2026-11-05", end: "2026-11-06", allDay: true });
  });

  it("writes dates to Google, and removes the times of a block that turns all-day", async () => {
    const options = ruleOptionsSchema.parse({});
    const created = toGoogleBlock(await block(options), "tag");
    expect(created.start).toEqual({ date: dateOn(-5) });
    expect(created.end).toEqual({ date: dateOn(26) });
    expect(created.transparency).toBe("opaque");
    const updated = toGoogleBlock(await block(options), "tag", { update: true });
    expect(updated.start).toEqual({ date: dateOn(-5), dateTime: null, timeZone: null });
  });
});

describe("the settings of a user whose rules are older than the default", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("calendarView")) return Response.json({ value: [] });
      return new Response("unexpected", { status: 500 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A user with two accounts, a rule between them, and the given stored settings. */
  async function setup(prefix: string, rule: object | null, settings?: string) {
    const { user, cookie } = await signIn(`${prefix}@org.example`);
    const accounts = [`${prefix}-a`, `${prefix}-b`];
    await env.DB.batch(
      accounts.flatMap((id) => [
        env.DB.prepare(
          "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
        ).bind(id, user.id, `${id}@work.example`),
        env.DB.prepare(
          "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
        ).bind(`${id}-cal`, id, `${id}-remote`),
      ]),
    );
    if (rule) {
      await env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(`${prefix}-rule`, user.id, `${prefix}-a-cal`, `${prefix}-b-cal`, JSON.stringify(rule))
        .run();
    }
    if (settings !== undefined) {
      await env.DB.prepare("UPDATE users SET sync_settings = ? WHERE id = ?")
        .bind(settings, user.id)
        .run();
    }
    return { user, cookie, a: accounts[0]!, b: accounts[1]! };
  }

  async function storedRules(userId: string) {
    const { results } = await env.DB.prepare(
      "SELECT options FROM rules WHERE user_id = ? ORDER BY rowid",
    )
      .bind(userId)
      .all<{ options: string }>();
    return results.map((row) => JSON.parse(row.options) as Record<string, unknown>);
  }

  async function switchOf(cookie: string): Promise<string> {
    const page = await (
      await exports.default.fetch(`${BASE}/rules`, { headers: { cookie } })
    ).text();
    return /<input[^>]*name="skipAllDay"[^>]*>/.exec(page)?.[0] ?? "";
  }

  for (const [name, stored] of [
    ["the empty default", "{}"],
    ["only a block title", '{"blockTitle":"Belegt"}'],
  ] as const) {
    it(`shows the rules' value if the settings hold ${name}`, async () => {
      const { user, cookie } = await setup(`old-${stored.length}`, { skipAllDay: true }, stored);
      expect((await loadEditorState(env, user.id)).settings.skipAllDay).toBe(true);
      expect(await switchOf(cookie)).toContain("checked");
    });
  }

  it("keeps a skipping rule when the user saves another setting", async () => {
    const { user } = await setup("keep", { skipAllDay: true });
    const { settings } = await loadEditorState(env, user.id);
    await setSettings(env, user, { ...settings, blockTitle: "Occupied" });
    const [rule] = await storedRules(user.id);
    expect(rule).toMatchObject({ skipAllDay: true, blockTitle: "Occupied" });
  });

  it("gives a new rule of such a user the value of the old rules", async () => {
    const { user, a, b } = await setup("newrule", { skipAllDay: true });
    await setDirection(env, user, b, a, "busy");
    const rules = await storedRules(user.id);
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(rule.skipAllDay).toBe(true);
  });

  it("stops skipping for every rule when the user turns the switch off", async () => {
    const { user } = await setup("off", { skipAllDay: true });
    const { settings } = await loadEditorState(env, user.id);
    await setSettings(env, user, { ...settings, skipAllDay: false });
    expect((await storedRules(user.id))[0]).toMatchObject({ skipAllDay: false });
    expect((await loadEditorState(env, user.id)).settings.skipAllDay).toBe(false);
  });

  it("follows a stored setting, not the rules", async () => {
    const { user } = await setup("stored", { skipAllDay: false }, '{"skipAllDay":true}');
    expect((await loadEditorState(env, user.id)).settings.skipAllDay).toBe(true);
  });

  it("shows the default for a new user, and writes it into the first rule", async () => {
    const { user, cookie, a, b } = await setup("fresh", null);
    await setDefaultBlockTitle(env, user.id, "Belegt");
    expect((await loadEditorState(env, user.id)).settings.skipAllDay).toBe(false);
    expect(await switchOf(cookie)).not.toContain("checked");
    await setDirection(env, user, a, b, "busy");
    const [rule] = await storedRules(user.id);
    expect(rule).toMatchObject({ skipAllDay: false, blockTitle: "Belegt" });
  });

  it("shows the default for rules that mirror all-day events", async () => {
    const { user } = await setup("mirrors", { skipAllDay: false });
    expect((await loadEditorState(env, user.id)).settings.skipAllDay).toBe(false);
  });

  it("keeps a skipping rule when the source options of its account change", async () => {
    const { user, a, b } = await setup("source", { skipAllDay: true });
    await setRuleDetails(env, user, { sources: [{ from: a, options: { bufferBefore: 30 } }] });
    const stored = await env.DB.prepare("SELECT source_options AS json FROM accounts WHERE id = ?")
      .bind(a)
      .first<{ json: string }>();
    expect(JSON.parse(stored?.json ?? "{}")).toEqual({ bufferBefore: 30, bufferAfter: 0 });
    await setDirection(env, user, b, a, "busy");
    const rules = await storedRules(user.id);
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(rule.skipAllDay).toBe(true);
  });

  it("reads a rule without the field as a rule that mirrors all-day events", async () => {
    const { user } = await setup("nofield", {});
    expect((await loadEditorState(env, user.id)).settings.skipAllDay).toBe(false);
  });

  describe("with rules that differ on all-day events", () => {
    /** One rule that skips all-day events, then one that mirrors them. */
    async function mixed(prefix: string, settings?: string) {
      const context = await setup(prefix, { skipAllDay: true }, settings);
      await env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          `${prefix}-back`,
          context.user.id,
          `${prefix}-b-cal`,
          `${prefix}-a-cal`,
          '{"skipAllDay":false}',
        )
        .run();
      const values = async () =>
        (await storedRules(context.user.id)).map((rule) => rule.skipAllDay);
      return { ...context, values };
    }

    /** The fields of the settings form as the page shows them. */
    async function shownFields(cookie: string) {
      const page = await (
        await exports.default.fetch(`${BASE}/rules`, { headers: { cookie } })
      ).text();
      const shown = /name="skipAllDayShown" value="([^"]*)"/.exec(page)?.[1];
      return {
        blockTitle: "Busy",
        ...(shown === undefined ? {} : { skipAllDayShown: shown }),
        ...((await switchOf(cookie)).includes("checked") ? { skipAllDay: "on" } : {}),
      };
    }

    for (const [name, path, prefix] of [
      ["a save of the page", "/rules/choices", "settings."],
      ["a post of the form", "/rules/settings", ""],
    ] as const) {
      const save = (cookie: string, fields: Record<string, string>) =>
        exports.default.fetch(`${BASE}${path}`, {
          method: "POST",
          redirect: "manual",
          headers: {
            cookie,
            "x-fragment": "1",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            settings: "1",
            ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${prefix}${k}`, v])),
          }),
        });
      const tag = path.endsWith("choices") ? "c" : "f";

      it(`keeps each rule's value when ${name} changes the block title`, async () => {
        const { user, cookie, values } = await mixed(`mix-title-${tag}`);
        const fields = await shownFields(cookie);
        expect(fields.skipAllDay).toBe("on");
        expect((await save(cookie, { ...fields, blockTitle: "Occupied" })).status).toBeLessThan(
          400,
        );
        expect(await values()).toEqual([true, false]);
        const rules = await storedRules(user.id);
        expect(rules.map((rule) => rule.blockTitle)).toEqual(["Occupied", "Occupied"]);

        // The first save stored the switch; the next one must keep the rules as well.
        const again = await shownFields(cookie);
        expect((await save(cookie, { ...again, blockTitle: "Belegt" })).status).toBeLessThan(400);
        expect(await values()).toEqual([true, false]);
      });

      it(`moves every rule when ${name} turns the switch off`, async () => {
        const { cookie, values } = await mixed(`mix-off-${tag}`);
        const { skipAllDay: _on, ...fields } = await shownFields(cookie);
        expect((await save(cookie, fields)).status).toBeLessThan(400);
        expect(await values()).toEqual([false, false]);
      });

      it(`moves every rule when ${name} turns the switch on`, async () => {
        const { cookie, values } = await mixed(`mix-on-${tag}`, '{"skipAllDay":false}');
        const fields = await shownFields(cookie);
        expect(fields.skipAllDay).toBeUndefined();
        expect((await save(cookie, { ...fields, skipAllDay: "on" })).status).toBeLessThan(400);
        expect(await values()).toEqual([true, true]);
      });

      it(`changes nothing when ${name} comes from a page that showed another value`, async () => {
        const { user, cookie, values } = await mixed(`mix-stale-${tag}`);
        const fields = await shownFields(cookie);
        // Another tab turns the switch off after this page loaded.
        await env.DB.prepare("UPDATE users SET sync_settings = ? WHERE id = ?")
          .bind('{"skipAllDay":false}', user.id)
          .run();
        expect((await save(cookie, { ...fields, blockTitle: "Occupied" })).status).toBeLessThan(
          400,
        );
        expect(await values()).toEqual([true, false]);
        expect((await loadEditorState(env, user.id)).settings.skipAllDay).toBe(false);
      });

      it(`reads ${name} without a shown value against the current switch`, async () => {
        const { cookie, values } = await mixed(`mix-old-${tag}`);
        const { skipAllDayShown: _shown, ...fields } = await shownFields(cookie);
        expect((await save(cookie, { ...fields, blockTitle: "Occupied" })).status).toBeLessThan(
          400,
        );
        expect(await values()).toEqual([true, false]);
        const { skipAllDay: _on, ...off } = fields;
        expect((await save(cookie, off)).status).toBeLessThan(400);
        expect(await values()).toEqual([false, false]);
      });
    }
  });
});

describe("the text of the switch", () => {
  it("names what stays out in both languages", () => {
    expect(messagesFor("en").editor.skipAllDayHint).toBe(
      "Otherwise holidays and days off block whole days, unless they are marked as free.",
    );
    expect(messagesFor("de").editor.skipAllDayHint).toBe(
      "Sonst blocken Urlaub und Feiertage ganze Tage, außer sie sind als frei markiert.",
    );
  });
});
