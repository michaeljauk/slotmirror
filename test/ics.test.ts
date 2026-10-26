import { describe, expect, it } from "vitest";
import { busyEvents, MAX_FEED_EVENTS } from "../src/feeds";
import { escapeText, foldLine, renderBusyCalendar, type BusyEvent } from "../src/ics";
import type { SourceEvent } from "../src/sync/types";

const SALT = "11".repeat(32);
const OTHER_SALT = "22".repeat(32);

function sourceEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    occurrenceKey: "event:AAMkSourceEventId-001",
    start: "2026-10-27T09:00:00.000Z",
    end: "2026-10-27T10:00:00.000Z",
    allDay: false,
    showAs: "busy",
    isPrivate: false,
    declined: false,
    categories: ["Client X"],
    subject: "Secret merger talk",
    location: "Room 7, Vienna",
    body: "Dial-in 555-0100, attendees Jane Roe",
    isMirror: false,
    ...overrides,
  };
}

/** Start of the UTC day the tests treat as today. */
const TODAY = new Date("2026-10-26T00:00:00.000Z");

type Reads = Parameters<typeof busyEvents>[0];

/** The busy blocks of the reads, with today as above. */
async function blocks(
  reads: Reads,
  options: { includeAllDay: boolean; uidSalt: string },
): Promise<BusyEvent[]> {
  return (await busyEvents(reads, { ...options, today: TODAY })).events;
}

function render(events: BusyEvent[], summary = "Busy"): string {
  return renderBusyCalendar({
    name: "Busy times",
    summary,
    refreshMinutes: 15,
    events,
    now: new Date("2026-10-26T12:00:00.000Z"),
  });
}

/** Property names inside each VEVENT, unfolded. */
function eventProperties(ics: string): string[][] {
  const lines = ics.replace(/\r\n /g, "").split("\r\n");
  const events: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") current = [];
    else if (line === "END:VEVENT" && current) {
      events.push(current);
      current = null;
    } else if (current) current.push(line.split(/[;:]/)[0] ?? "");
  }
  return events;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("ics text", () => {
  it("escapes backslash, semicolon, comma and line breaks", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
  });

  it("folds long lines at 75 octets with a leading space, and unfolds to the original", () => {
    const line = `SUMMARY:${"x".repeat(200)}`;
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => utf8Length(part) <= 75)).toBe(true);
    expect(parts.slice(1).every((part) => part.startsWith(" "))).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });

  it("counts octets, not characters, and never splits a character", () => {
    const line = `SUMMARY:${"ä€😀".repeat(30)}`;
    const parts = foldLine(line).split("\r\n");
    for (const part of parts) {
      expect(utf8Length(part)).toBeLessThanOrEqual(75);
      // A lone surrogate would throw here.
      expect(() => encodeURIComponent(part)).not.toThrow();
    }
    expect(parts.join("\r\n").replace(/\r\n /g, "")).toBe(line);
  });

  it("leaves a line of exactly 75 octets alone", () => {
    const line = `X:${"y".repeat(73)}`;
    expect(foldLine(line)).toBe(line);
  });
});

describe("busy calendar", () => {
  it("ends every line with CRLF and has no bare line feed", async () => {
    const ics = render(
      await blocks([{ calendarId: "c1", events: [sourceEvent()] }], {
        includeAllDay: false,
        uidSalt: SALT,
      }),
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(/[^\r]\n/.test(ics)).toBe(false);
    expect(/\r[^\n]/.test(ics)).toBe(false);
  });

  it("writes UTC times for timed events and dates for all-day events", async () => {
    const events = await blocks(
      [
        {
          calendarId: "c1",
          events: [
            sourceEvent(),
            sourceEvent({
              occurrenceKey: "event:all-day",
              allDay: true,
              start: "2026-10-28",
              end: "2026-10-29",
            }),
          ],
        },
      ],
      { includeAllDay: true, uidSalt: SALT },
    );
    const ics = render(events);
    expect(ics).toContain("\r\nDTSTART:20261027T090000Z\r\nDTEND:20261027T100000Z\r\n");
    expect(ics).toContain("\r\nDTSTART;VALUE=DATE:20261028\r\nDTEND;VALUE=DATE:20261029\r\n");
    expect(ics).toContain("\r\nDTSTAMP:20261026T120000Z\r\n");
  });

  it("carries no title, location, body, category or source ID of the event", async () => {
    const event = sourceEvent();
    const ics = render(
      await blocks([{ calendarId: "c1", events: [event] }], {
        includeAllDay: false,
        uidSalt: SALT,
      }),
    );
    for (const secret of ["Secret", "merger", "Room 7", "Vienna", "Dial-in", "Jane", "Client X"]) {
      expect(ics).not.toContain(secret);
    }
    expect(ics).not.toContain("AAMkSourceEventId");
    expect(eventProperties(ics)).toEqual([
      ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "CLASS", "TRANSP"],
    ]);
    expect(ics).toContain("\r\nSUMMARY:Busy\r\nCLASS:PRIVATE\r\nTRANSP:OPAQUE\r\n");
  });

  it("escapes the fixed title", () => {
    const ics = render([], "Busy, really; ok");
    expect(ics).not.toContain("VEVENT");
    expect(
      render(
        [
          {
            uid: "u1@slotmirror",
            start: "2026-10-27T09:00:00Z",
            end: "2026-10-27T10:00:00Z",
            allDay: false,
          },
        ],
        "Busy, really; ok",
      ),
    ).toContain("\r\nSUMMARY:Busy\\, really\\; ok\r\n");
  });
});

describe("busy events", () => {
  const options = { includeAllDay: false, uidSalt: SALT };
  const at = (time: string) => `2026-10-27T${time}:00.000Z`;
  const timed = (key: string, start: string, end: string, overrides: Partial<SourceEvent> = {}) =>
    sourceEvent({ occurrenceKey: key, start: at(start), end: at(end), ...overrides });

  it("skips free, declined, all-day and mirrored events, and keeps tentative ones", async () => {
    const events = await blocks(
      [
        {
          calendarId: "c1",
          events: [
            timed("busy", "09:00", "10:00"),
            timed("free", "11:00", "11:30", { showAs: "free" }),
            timed("declined", "12:00", "12:30", { declined: true }),
            sourceEvent({
              occurrenceKey: "all-day",
              allDay: true,
              start: "2026-10-28",
              end: "2026-10-29",
            }),
            timed("mirror", "13:00", "13:30", { isMirror: true }),
            timed("tentative", "14:00", "15:00", { showAs: "tentative" }),
          ],
        },
      ],
      options,
    );
    expect(events.map((event) => [event.start, event.end])).toEqual([
      [at("09:00"), at("10:00")],
      [at("14:00"), at("15:00")],
    ]);
  });

  it("includes all-day events when the feed asks for them", async () => {
    const events = await blocks(
      [
        {
          calendarId: "c1",
          events: [sourceEvent({ allDay: true, start: "2026-10-28", end: "2026-10-29" })],
        },
      ],
      { ...options, includeAllDay: true },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.allDay).toBe(true);
  });

  it("merges overlapping, adjacent and nested events into one block", async () => {
    const events = await blocks(
      [
        {
          calendarId: "c1",
          events: [
            timed("a", "09:00", "10:00"),
            timed("b", "09:30", "11:00"),
            timed("c", "11:00", "11:30"),
            timed("d", "13:00", "16:00"),
            timed("e", "14:00", "15:00"),
          ],
        },
        { calendarId: "c2", events: [timed("f", "11:15", "12:00"), timed("g", "16:30", "17:00")] },
      ],
      options,
    );
    expect(events.map((event) => [event.start, event.end])).toEqual([
      [at("09:00"), at("12:00")],
      [at("13:00"), at("16:00")],
      [at("16:30"), at("17:00")],
    ]);
  });

  it("merges adjacent all-day events, and keeps them apart from timed ones", async () => {
    const day = (key: string, start: string, end: string) =>
      sourceEvent({ occurrenceKey: key, allDay: true, start, end });
    const events = await blocks(
      [
        {
          calendarId: "c1",
          events: [
            day("x", "2026-10-28", "2026-10-29"),
            day("y", "2026-10-29", "2026-10-31"),
            day("z", "2026-11-02", "2026-11-03"),
            sourceEvent({
              occurrenceKey: "t",
              start: "2026-10-29T09:00:00.000Z",
              end: "2026-10-29T10:00:00.000Z",
            }),
          ],
        },
      ],
      { ...options, includeAllDay: true },
    );
    expect(events.map((event) => [event.allDay, event.start, event.end])).toEqual([
      [true, "2026-10-28", "2026-10-31"],
      [false, "2026-10-29T09:00:00.000Z", "2026-10-29T10:00:00.000Z"],
      [true, "2026-11-02", "2026-11-03"],
    ]);
  });

  it("derives the UID from the block, not from the events in it", async () => {
    const uid = async (reads: Reads, salt = SALT) =>
      (await blocks(reads, { ...options, uidSalt: salt }))[0]?.uid;
    const first = await uid([{ calendarId: "c1", events: [timed("meeting", "09:00", "10:00")] }]);
    expect(first).toMatch(/^[0-9a-f]{32}@slotmirror$/);
    // The same block from another event, in another calendar, has the same UID.
    expect(await uid([{ calendarId: "c2", events: [timed("other", "09:00", "10:00")] }])).toBe(
      first,
    );
    // A moved meeting is a new block: nothing links it to its old time.
    expect(
      await uid([{ calendarId: "c1", events: [timed("meeting", "11:00", "12:00")] }]),
    ).not.toBe(first);
    expect(
      await uid([{ calendarId: "c1", events: [timed("meeting", "09:00", "10:00")] }], OTHER_SALT),
    ).not.toBe(first);
  });

  /** `count` separate half-hour blocks, one per hour from `from`. */
  function separate(count: number, from: number, prefix: string): SourceEvent[] {
    return Array.from({ length: count }, (_, index) =>
      sourceEvent({
        occurrenceKey: `${prefix}${index}`,
        start: new Date(from + index * 3_600_000).toISOString(),
        end: new Date(from + index * 3_600_000 + 1_800_000).toISOString(),
      }),
    ).reverse();
  }

  it("drops past blocks first when there are too many", async () => {
    const past = separate(60, TODAY.getTime() - 5 * 86_400_000, "p");
    const future = separate(MAX_FEED_EVENTS - 10, TODAY.getTime(), "f");
    const result = await busyEvents([{ calendarId: "c1", events: [...past, ...future] }], {
      ...options,
      today: TODAY,
    });
    expect(result.events).toHaveLength(MAX_FEED_EVENTS);
    expect(result.cutAt).toBeNull();
    // The 50 oldest past blocks went; the 10 latest stay.
    expect(result.events[0]?.start).toBe(
      new Date(TODAY.getTime() - 5 * 86_400_000 + 50 * 3_600_000).toISOString(),
    );
    expect(result.events.at(-1)?.start).toBe(
      new Date(TODAY.getTime() + (MAX_FEED_EVENTS - 11) * 3_600_000).toISOString(),
    );
  });

  it("cuts the window end once no past block is left, and says where", async () => {
    const past = separate(5, TODAY.getTime() - 86_400_000, "p");
    const future = separate(MAX_FEED_EVENTS + 20, TODAY.getTime(), "f");
    const result = await busyEvents([{ calendarId: "c1", events: [...past, ...future] }], {
      ...options,
      today: TODAY,
    });
    expect(result.events).toHaveLength(MAX_FEED_EVENTS);
    expect(result.events[0]?.start).toBe(TODAY.toISOString());
    const firstLeftOut = new Date(TODAY.getTime() + MAX_FEED_EVENTS * 3_600_000).toISOString();
    expect(result.cutAt).toBe(firstLeftOut);
    expect(result.events.every((event) => event.start < firstLeftOut)).toBe(true);
  });

  it("keeps an ongoing all-day block when it drops past blocks", async () => {
    const day = 86_400_000;
    const vacation = sourceEvent({
      occurrenceKey: "vacation",
      allDay: true,
      start: new Date(TODAY.getTime() - 5 * day).toISOString().slice(0, 10),
      end: new Date(TODAY.getTime() + 3 * day).toISOString().slice(0, 10),
    });
    const past = separate(30, TODAY.getTime() - 4 * day, "p");
    const future = separate(MAX_FEED_EVENTS - 10, TODAY.getTime(), "f");
    const result = await busyEvents(
      [{ calendarId: "c1", events: [vacation, ...past, ...future] }],
      { includeAllDay: true, uidSalt: SALT, today: TODAY },
    );
    expect(result.events).toHaveLength(MAX_FEED_EVENTS);
    expect(result.cutAt).toBeNull();
    expect(result.events.filter((event) => event.allDay)).toEqual([
      expect.objectContaining({ start: vacation.start, end: vacation.end }),
    ]);
    // 21 of the 30 past blocks went, the oldest first.
    const kept = result.events.filter((event) => !event.allDay && event.end <= TODAY.toISOString());
    expect(kept).toHaveLength(9);
  });

  it("cuts the window end rather than drop an ongoing all-day block", async () => {
    const day = 86_400_000;
    const vacation = sourceEvent({
      occurrenceKey: "vacation",
      allDay: true,
      start: new Date(TODAY.getTime() - 5 * day).toISOString().slice(0, 10),
      end: new Date(TODAY.getTime() + 3 * day).toISOString().slice(0, 10),
    });
    const past = separate(5, TODAY.getTime() - 4 * day, "p");
    const future = separate(MAX_FEED_EVENTS, TODAY.getTime(), "f");
    const result = await busyEvents(
      [{ calendarId: "c1", events: [vacation, ...past, ...future] }],
      { includeAllDay: true, uidSalt: SALT, today: TODAY },
    );
    expect(result.events).toHaveLength(MAX_FEED_EVENTS);
    expect(result.events[0]).toMatchObject({ allDay: true, start: vacation.start });
    expect(result.cutAt).toBe(
      new Date(TODAY.getTime() + (MAX_FEED_EVENTS - 1) * 3_600_000).toISOString(),
    );
  });

  it("reports no cut below the cap", async () => {
    const result = await busyEvents(
      [{ calendarId: "c1", events: separate(10, TODAY.getTime(), "f") }],
      { ...options, today: TODAY },
    );
    expect(result.events).toHaveLength(10);
    expect(result.cutAt).toBeNull();
  });
});
