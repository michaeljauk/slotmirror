import { describe, expect, it } from "vitest";
import { busyEvents, MAX_FEED_EVENTS } from "../src/feeds";
import { escapeText, foldLine, renderBusyCalendar } from "../src/ics";
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

function render(events: Awaited<ReturnType<typeof busyEvents>>, summary = "Busy"): string {
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
      await busyEvents([{ calendarId: "c1", events: [sourceEvent()] }], {
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
    const events = await busyEvents(
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
      await busyEvents([{ calendarId: "c1", events: [event] }], {
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

  it("skips free, declined, all-day and mirrored events, and keeps tentative ones", async () => {
    const events = await busyEvents(
      [
        {
          calendarId: "c1",
          events: [
            sourceEvent({ occurrenceKey: "busy" }),
            sourceEvent({ occurrenceKey: "free", showAs: "free", start: "2026-10-27T11:00:00Z" }),
            sourceEvent({
              occurrenceKey: "declined",
              declined: true,
              start: "2026-10-27T12:00:00Z",
            }),
            sourceEvent({
              occurrenceKey: "all-day",
              allDay: true,
              start: "2026-10-28",
              end: "2026-10-29",
            }),
            sourceEvent({ occurrenceKey: "mirror", isMirror: true, start: "2026-10-27T13:00:00Z" }),
            sourceEvent({
              occurrenceKey: "tentative",
              showAs: "tentative",
              start: "2026-10-27T14:00:00.000Z",
              end: "2026-10-27T15:00:00.000Z",
            }),
          ],
        },
      ],
      options,
    );
    expect(events.map((event) => event.start)).toEqual([
      "2026-10-27T09:00:00.000Z",
      "2026-10-27T14:00:00.000Z",
    ]);
  });

  it("includes all-day events when the feed asks for them", async () => {
    const events = await busyEvents(
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

  it("makes UIDs stable per feed, different between feeds, and free of the source ID", async () => {
    const read = [{ calendarId: "c1", events: [sourceEvent()] }];
    const [first] = await busyEvents(read, options);
    const [again] = await busyEvents(read, options);
    const [otherFeed] = await busyEvents(read, { ...options, uidSalt: OTHER_SALT });
    expect(first?.uid).toMatch(/^[0-9a-f]{32}@slotmirror$/);
    expect(again?.uid).toBe(first?.uid);
    expect(otherFeed?.uid).not.toBe(first?.uid);
    expect(first?.uid).not.toContain("AAMk");
  });

  it("lists an interval found in two calendars once, whatever the order", async () => {
    const a = { calendarId: "c1", events: [sourceEvent({ occurrenceKey: "a" })] };
    const b = { calendarId: "c2", events: [sourceEvent({ occurrenceKey: "b" })] };
    const one = await busyEvents([a, b], options);
    const other = await busyEvents([b, a], options);
    expect(one).toHaveLength(1);
    expect(other).toEqual(one);
  });

  it("keeps at most MAX_FEED_EVENTS, nearest first", async () => {
    const base = Date.parse("2026-10-20T00:00:00Z");
    const many = Array.from({ length: MAX_FEED_EVENTS + 50 }, (_, index) =>
      sourceEvent({
        occurrenceKey: `e${index}`,
        start: new Date(base + index * 3_600_000).toISOString(),
        end: new Date(base + index * 3_600_000 + 1_800_000).toISOString(),
      }),
    ).reverse();
    const events = await busyEvents([{ calendarId: "c1", events: many }], options);
    expect(events).toHaveLength(MAX_FEED_EVENTS);
    expect(events[0]?.start).toBe(new Date(base).toISOString());
  });
});
