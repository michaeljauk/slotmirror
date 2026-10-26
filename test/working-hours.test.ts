import { describe, expect, it } from "vitest";
import { parseRuleOptions, ruleOptionsSchema, type RuleOptions } from "../src/config";
import { fromGraphEvent } from "../src/sync/graph-events";
import { desiredBlocks, isIncluded } from "../src/sync/plan";
import type { SourceEvent } from "../src/sync/types";
import fixture from "./fixtures/graph/calendar-view.json";

const RULE = "rule-1";

/** Monday to Friday, 08:00 to 18:00, Vienna: the common case. */
const OFFICE: Partial<RuleOptions> = {
  workDays: [1, 2, 3, 4, 5],
  workStart: "08:00",
  workEnd: "18:00",
  workTimeZone: "Europe/Vienna",
};

function options(overrides: Partial<RuleOptions> = {}): RuleOptions {
  return ruleOptionsSchema.parse(overrides);
}

function event(start: string, end: string, extra: Partial<SourceEvent> = {}): SourceEvent {
  return {
    occurrenceKey: `event:${start}`,
    start,
    end,
    allDay: false,
    showAs: "busy",
    isPrivate: false,
    declined: false,
    categories: [],
    subject: "Visit",
    location: "",
    body: "",
    isMirror: false,
    ...extra,
  };
}

function allDay(start: string, end: string): SourceEvent {
  return event(start, end, { allDay: true });
}

const mirrored = (e: SourceEvent, overrides: Partial<RuleOptions> = OFFICE) =>
  isIncluded(e, options(overrides));

// After 25 Oct 2026 Vienna is on CET (UTC+1). 27 Oct 2026 is a Tuesday, 31 Oct a Saturday.
describe("working hours: weekdays", () => {
  it("mirrors an event on a chosen weekday and skips one on another day", () => {
    expect(mirrored(event("2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z"))).toBe(true);
    expect(mirrored(event("2026-10-31T09:00:00.000Z", "2026-10-31T10:00:00.000Z"))).toBe(false);
    const saturday = { ...OFFICE, workDays: [6] };
    expect(mirrored(event("2026-10-31T09:00:00.000Z", "2026-10-31T10:00:00.000Z"), saturday)).toBe(
      true,
    );
    expect(mirrored(event("2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z"), saturday)).toBe(
      false,
    );
  });

  it("filters by weekday alone when no time range is set", () => {
    const weekdays = { workDays: [1, 2, 3, 4, 5], workTimeZone: "Europe/Vienna" };
    // Saturday 23:30 to Sunday 00:30 in Vienna: weekend only.
    expect(mirrored(event("2026-10-31T22:30:00.000Z", "2026-10-31T23:30:00.000Z"), weekdays)).toBe(
      false,
    );
    // Sunday 23:30 to Monday 00:30 in Vienna: reaches into Monday.
    expect(mirrored(event("2026-11-01T22:30:00.000Z", "2026-11-01T23:30:00.000Z"), weekdays)).toBe(
      true,
    );
    // Sunday 23:00 to Monday 00:00 in Vienna: ends where Monday starts.
    expect(mirrored(event("2026-11-01T22:00:00.000Z", "2026-11-01T23:00:00.000Z"), weekdays)).toBe(
      false,
    );
  });

  it("filters by time alone when every weekday is chosen", () => {
    const daily = { ...OFFICE, workDays: [1, 2, 3, 4, 5, 6, 7] };
    expect(mirrored(event("2026-10-31T09:00:00.000Z", "2026-10-31T10:00:00.000Z"), daily)).toBe(
      true,
    );
    expect(mirrored(event("2026-10-31T19:00:00.000Z", "2026-10-31T20:00:00.000Z"), daily)).toBe(
      false,
    );
  });
});

describe("working hours: time of day", () => {
  // Tuesday 27 Oct 2026; 08:00 Vienna is 07:00 UTC, 18:00 Vienna is 17:00 UTC.
  const at = (start: string, end: string) =>
    mirrored(event(`2026-10-27T${start}:00.000Z`, `2026-10-27T${end}:00.000Z`));

  it("mirrors an event that overlaps the window and skips one outside it", () => {
    expect(at("06:00", "07:00")).toBe(false); // 07:00 to 08:00, ends at the start
    expect(at("06:30", "07:30")).toBe(true); // 07:30 to 08:30
    expect(at("16:59", "18:00")).toBe(true); // 17:59 to 19:00
    expect(at("17:00", "18:00")).toBe(false); // 18:00 to 19:00, starts at the end
    expect(at("05:00", "18:00")).toBe(true); // covers the whole window
  });

  it("treats an event without duration as a point in time", () => {
    expect(at("07:00", "07:00")).toBe(true);
    expect(at("17:00", "17:00")).toBe(false);
  });

  it("never clips the block to the window: it keeps the event's times", async () => {
    const early = event("2026-10-27T06:30:00.000Z", "2026-10-27T07:30:00.000Z");
    const [block] = await desiredBlocks(RULE, [early], options(OFFICE));
    expect(block).toMatchObject({
      start: "2026-10-27T06:30:00.000Z",
      end: "2026-10-27T07:30:00.000Z",
    });
  });

  it("leaves events outside the window out of the desired blocks", async () => {
    const events = [
      event("2026-10-27T09:00:00.000Z", "2026-10-27T10:00:00.000Z"),
      event("2026-10-27T19:00:00.000Z", "2026-10-27T20:00:00.000Z"),
      event("2026-10-31T09:00:00.000Z", "2026-10-31T10:00:00.000Z"),
    ];
    const blocks = await desiredBlocks(RULE, events, options(OFFICE));
    expect(blocks.map((block) => block.start)).toEqual(["2026-10-27T09:00:00.000Z"]);
  });
});

describe("working hours: time zone", () => {
  // Tuesday 06:30 to 07:30 UTC.
  const early = event("2026-10-27T06:30:00.000Z", "2026-10-27T07:30:00.000Z");

  it("reads the window in the rule's time zone", () => {
    expect(mirrored(early, { ...OFFICE, workTimeZone: "Europe/Vienna" })).toBe(true); // 07:30
    expect(mirrored(early, { ...OFFICE, workTimeZone: "UTC" })).toBe(false); // 06:30
    expect(mirrored(early, { ...OFFICE, workTimeZone: "America/New_York" })).toBe(false); // 02:30
    expect(mirrored(early, { ...OFFICE, workTimeZone: "Asia/Tokyo" })).toBe(true); // 15:30
  });

  it("uses UTC when the rule names no time zone", () => {
    expect(mirrored(early, { ...OFFICE, workTimeZone: "" })).toBe(false);
  });

  it("takes the weekday in the rule's time zone", () => {
    // Friday 23:30 UTC is Saturday 00:30 in Vienna.
    const late = event("2026-10-30T23:30:00.000Z", "2026-10-31T00:00:00.000Z");
    const weekdays = { workDays: [1, 2, 3, 4, 5] };
    expect(mirrored(late, { ...weekdays, workTimeZone: "Europe/Vienna" })).toBe(false);
    expect(mirrored(late, { ...weekdays, workTimeZone: "UTC" })).toBe(true);
  });
});

describe("working hours: daylight saving time in Vienna", () => {
  const everyDay = { ...OFFICE, workDays: [1, 2, 3, 4, 5, 6, 7] };

  it("uses summer time on the day clocks go forward (29 Mar 2026)", () => {
    // 08:00 to 18:00 CEST is 06:00 to 16:00 UTC. With CET the window would be 07:00 to 17:00.
    const sunday = (start: string, end: string) =>
      mirrored(event(`2026-03-29T${start}:00.000Z`, `2026-03-29T${end}:00.000Z`), everyDay);
    expect(sunday("06:30", "06:45")).toBe(true); // 08:30 CEST
    expect(sunday("05:30", "06:00")).toBe(false); // 07:30 CEST
    expect(sunday("16:15", "16:45")).toBe(false); // 18:15 CEST
    expect(sunday("15:45", "16:15")).toBe(true); // 17:45 CEST
  });

  it("uses winter time on the day clocks go back (25 Oct 2026)", () => {
    // 08:00 to 18:00 CET is 07:00 to 17:00 UTC. With CEST the window would be 06:00 to 16:00.
    const sunday = (start: string, end: string) =>
      mirrored(event(`2026-10-25T${start}:00.000Z`, `2026-10-25T${end}:00.000Z`), everyDay);
    expect(sunday("06:30", "06:50")).toBe(false); // 07:30 CET
    expect(sunday("07:10", "07:20")).toBe(true); // 08:10 CET
    expect(sunday("16:30", "16:50")).toBe(true); // 17:30 CET
    expect(sunday("17:00", "17:30")).toBe(false); // 18:00 CET
  });

  it("moves a time that does not exist forward when clocks go forward", () => {
    // 02:30 does not exist on 29 Mar; the window starts at 03:30 CEST, which is 01:30 UTC.
    const night = { ...everyDay, workStart: "02:30", workEnd: "04:00" };
    // 01:45 CET to 03:15 CEST: before the window.
    expect(mirrored(event("2026-03-29T00:45:00.000Z", "2026-03-29T01:15:00.000Z"), night)).toBe(
      false,
    );
    // 03:45 CEST.
    expect(mirrored(event("2026-03-29T01:45:00.000Z", "2026-03-29T01:50:00.000Z"), night)).toBe(
      true,
    );
  });

  it("takes the first of two equal times when clocks go back", () => {
    // 02:00 to 02:30 happens twice on 25 Oct: 00:00 UTC (CEST) and 01:00 UTC (CET).
    const night = { ...everyDay, workStart: "02:00", workEnd: "02:30" };
    expect(mirrored(event("2026-10-25T00:10:00.000Z", "2026-10-25T00:20:00.000Z"), night)).toBe(
      true,
    );
    expect(mirrored(event("2026-10-25T01:10:00.000Z", "2026-10-25T01:20:00.000Z"), night)).toBe(
      false,
    );
  });

  it("checks each day of an event that crosses the change", () => {
    // Saturday 28 Mar 20:00 CET to Monday 30 Mar 07:30 CEST: Monday ends before 08:00.
    const weekend = event("2026-03-28T19:00:00.000Z", "2026-03-30T05:30:00.000Z");
    expect(mirrored(weekend)).toBe(false);
    // The same event until Monday 08:30 CEST reaches the window.
    expect(mirrored({ ...weekend, end: "2026-03-30T06:30:00.000Z" })).toBe(true);
  });
});

describe("working hours: events over several days", () => {
  it("mirrors an event if any of its days overlaps the window", () => {
    // Friday 20:00 to Monday 07:00 in Vienna: Friday evening and Monday early only.
    const weekend = event("2026-10-30T19:00:00.000Z", "2026-11-02T06:00:00.000Z");
    expect(mirrored(weekend)).toBe(false);
    // Until Monday 09:00 it overlaps Monday's window.
    expect(mirrored({ ...weekend, end: "2026-11-02T08:00:00.000Z" })).toBe(true);
    // From Friday 17:00 it overlaps Friday's window.
    expect(mirrored({ ...weekend, start: "2026-10-30T16:00:00.000Z" })).toBe(true);
  });

  it("finds a chosen weekday inside a long event", () => {
    // Saturday 31 Oct to Saturday 14 Nov; only Wednesdays are chosen.
    const long = event("2026-10-31T10:00:00.000Z", "2026-11-14T10:00:00.000Z");
    expect(mirrored(long, { ...OFFICE, workDays: [3] })).toBe(true);
    // Saturday to Sunday only, with weekdays chosen.
    const weekend = event("2026-10-31T10:00:00.000Z", "2026-11-01T20:00:00.000Z");
    expect(mirrored(weekend)).toBe(false);
  });
});

describe("working hours: all-day events", () => {
  const withAllDay = { ...OFFICE, skipAllDay: false };

  it("mirrors an all-day event on a chosen weekday, whatever the time range", () => {
    expect(mirrored(allDay("2026-10-27", "2026-10-28"), withAllDay)).toBe(true); // Tuesday
    expect(mirrored(allDay("2026-10-31", "2026-11-01"), withAllDay)).toBe(false); // Saturday
    const evening = { ...withAllDay, workStart: "20:00", workEnd: "21:00" };
    expect(mirrored(allDay("2026-10-27", "2026-10-28"), evening)).toBe(true);
  });

  it("mirrors a multi-day all-day event if one of its dates is a chosen weekday", () => {
    // Saturday to Monday; the end date is exclusive.
    expect(mirrored(allDay("2026-10-31", "2026-11-03"), withAllDay)).toBe(true);
    // Saturday and Sunday.
    expect(mirrored(allDay("2026-10-31", "2026-11-02"), withAllDay)).toBe(false);
  });

  it("applies skipAllDay first", () => {
    expect(mirrored(allDay("2026-10-27", "2026-10-28"), OFFICE)).toBe(false);
  });
});

describe("working hours: defaults", () => {
  const events = fixture.value.map(fromGraphEvent).filter((e): e is SourceEvent => e !== null);

  it("are off: every weekday, the whole day, no time zone", () => {
    expect(parseRuleOptions("{}")).toMatchObject({
      workDays: [1, 2, 3, 4, 5, 6, 7],
      workStart: "",
      workEnd: "",
      workTimeZone: "",
    });
  });

  it("keep the blocks of existing rules exactly as before", async () => {
    const before = await desiredBlocks(RULE, events, options({ skipAllDay: false }));
    expect(before.length).toBeGreaterThan(0);
    // A rule stored before working hours existed has none of the keys.
    const stored = parseRuleOptions('{"skipAllDay": false}');
    expect(await desiredBlocks(RULE, events, stored)).toEqual(before);
    // Every weekday with a time zone but no time range is still off.
    const zoneOnly = options({ skipAllDay: false, workTimeZone: "Pacific/Kiritimati" });
    expect(await desiredBlocks(RULE, events, zoneOnly)).toEqual(before);
    // Hash and dedup key as computed before working hours existed.
    const [block] = await desiredBlocks(
      RULE,
      [
        event("2026-10-27T10:00:00.000Z", "2026-10-27T11:00:00.000Z", {
          occurrenceKey: "event:buffer",
        }),
      ],
      options(),
      { scope: "user" },
    );
    expect(block?.contentHash).toBe("e2017962879850ddec59cee5aabb4f7e");
    expect(block?.dedupKey).toBe("74cbc6995f91445218fc104bd5fb7fbb");
  });

  it("mirror events at any time on any day", () => {
    for (const start of ["2026-10-31T03:00:00.000Z", "2026-11-01T22:00:00.000Z"]) {
      expect(mirrored(event(start, start.replace(/T\d\d/, "T23")), {})).toBe(true);
    }
  });
});

describe("working hours: validation", () => {
  const parses = (json: object) => ruleOptionsSchema.safeParse(json).success;

  it("accepts a valid window, zone and weekdays", () => {
    expect(parses(OFFICE)).toBe(true);
    expect(parses({ workStart: "00:00", workEnd: "23:59" })).toBe(true);
    expect(parses({ workDays: [7] })).toBe(true);
  });

  it("refuses an end at or before the start: overnight windows are not supported", () => {
    expect(parses({ workStart: "18:00", workEnd: "08:00" })).toBe(false);
    expect(parses({ workStart: "08:00", workEnd: "08:00" })).toBe(false);
  });

  it("refuses a start without an end, and the reverse", () => {
    expect(parses({ workStart: "08:00" })).toBe(false);
    expect(parses({ workEnd: "18:00" })).toBe(false);
  });

  it("refuses times that are not HH:MM", () => {
    for (const time of ["8:00", "24:00", "12:60", "12:00:00", "noon", " 08:00"]) {
      expect(parses({ workStart: time, workEnd: "23:59" })).toBe(false);
    }
  });

  it("refuses an unknown time zone", () => {
    expect(parses({ workTimeZone: "Mars/Olympus" })).toBe(false);
    expect(parses({ workTimeZone: "Europe/Vienna" })).toBe(true);
  });

  it("refuses no weekday, unknown weekdays and repeated weekdays", () => {
    for (const workDays of [[], [0], [8], [1.5], [1, 1]]) {
      expect(parses({ workDays })).toBe(false);
    }
  });
});
