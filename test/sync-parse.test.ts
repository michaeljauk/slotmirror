/**
 * The parsers check events with a quick test before they fall back to the schema, and they write
 * ISO times without a Date. These tests compare both shortcuts with the slow path that they
 * replace, over many variants, so that a shortcut never accepts or returns something different.
 */
import { describe, expect, it } from "vitest";
import { fromGoogleEvent, googleEventSchema, googleMarker } from "../src/sync/google-events";
import {
  DEDUP_PROPERTY_ID,
  fromGraphEvent,
  graphEventSchema,
  MARKER_PROPERTY_ID,
} from "../src/sync/graph-events";
import { isoFromTime, isoInstant } from "../src/sync/iso-time";

/** The outcome of one call: its value, or the type and message of what it threw. */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() };
  } catch (error) {
    return error instanceof Error
      ? { name: error.name, message: error.message, type: error.constructor.name }
      : { thrown: String(error) };
  }
}

const sparse: unknown[] = [];
sparse[1] = "x";

/** Values that a field may hold in a broken or unusual response. */
const ODD_VALUES: unknown[] = [
  undefined,
  null,
  0,
  1,
  Number.NaN,
  "",
  "x",
  "declined",
  "seriesMaster",
  true,
  false,
  [],
  ["x"],
  [1],
  [null],
  sparse,
  {},
  { x: 1 },
  { dateTime: "2026-11-01T08:00:00.0000000", timeZone: "UTC" },
  { dateTime: "2026-11-01T08:00:00+01:00" },
  { date: "2026-11-01" },
  { id: "a" },
  { id: "a", value: null },
  { id: MARKER_PROPERTY_ID, value: "t.m.h" },
  { content: null },
  { displayName: "d" },
  { response: "declined" },
  { self: true, responseStatus: "declined" },
  { private: { slotmirrorMarker: "t.m.h" } },
  new Date(0),
  Object.create(null) as object,
];

/** Each variant of `base` with one field, at `path`, removed or replaced by an odd value. */
function variants(base: Record<string, unknown>, paths: string[][]): unknown[] {
  const result: unknown[] = [];
  for (const path of paths) {
    for (const value of [...ODD_VALUES, REMOVE]) result.push(withValue(base, path, value));
  }
  return result;
}

const REMOVE = Symbol("remove");

function withValue(target: unknown, path: string[], value: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  const copy: Record<string, unknown> = Array.isArray(target)
    ? ([...target] as unknown as Record<string, unknown>)
    : { ...(target as Record<string, unknown>) };
  const next = withValue(copy[key], rest, value);
  if (next === REMOVE) delete copy[key];
  else copy[key] = next;
  return copy;
}

const GRAPH_BASES: Record<string, unknown>[] = [
  {
    "@odata.etag": 'W/"1"',
    id: "single",
    type: "singleInstance",
    seriesMasterId: null,
    originalStart: null,
    start: { dateTime: "2026-11-01T08:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-01T09:00:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    sensitivity: "normal",
    categories: ["Red category"],
    responseStatus: { response: "accepted", time: "2026-10-01T00:00:00Z" },
    subject: "Weekly sync",
    location: { displayName: "Room", address: {} },
    bodyPreview: "Preview",
    webLink: "https://outlook.office365.com/owa/?itemid=AAMk%2Bx&exvsurl=1&path=/calendar/item",
    body: { content: "Body", contentType: "text" },
    singleValueExtendedProperties: [
      { id: MARKER_PROPERTY_ID, value: "tag.marker.hash" },
      { id: DEDUP_PROPERTY_ID, value: "dedup" },
    ],
  },
  {
    id: "occurrence",
    type: "occurrence",
    seriesMasterId: "series",
    originalStart: "2026-11-02T09:00:00Z",
    start: { dateTime: "2026-11-02T00:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-03T00:00:00.0000000", timeZone: "UTC" },
    isAllDay: true,
  },
];

const GRAPH_PATHS = [
  ...Object.keys(GRAPH_BASES[0]!).map((key) => [key]),
  ["start", "dateTime"],
  ["start", "timeZone"],
  ["end", "dateTime"],
  ["responseStatus", "response"],
  ["location", "displayName"],
  ["body", "content"],
  ["categories", "0"],
  ["singleValueExtendedProperties", "0"],
  ["singleValueExtendedProperties", "0", "id"],
  ["singleValueExtendedProperties", "1", "value"],
  ["originalStart"],
  ["seriesMasterId"],
];

const GOOGLE_BASES: Record<string, unknown>[] = [
  {
    kind: "calendar#event",
    id: "single",
    status: "confirmed",
    summary: "Dentist",
    location: "Graz",
    description: "Notes",
    start: { dateTime: "2026-11-01T08:00:00+01:00", timeZone: "Europe/Vienna" },
    end: { dateTime: "2026-11-01T09:00:00+01:00", timeZone: "Europe/Vienna" },
    recurringEventId: "rec",
    originalStartTime: { dateTime: "2026-11-01T08:00:00+01:00" },
    transparency: "opaque",
    visibility: "private",
    colorId: "5",
    htmlLink: "https://www.google.com/calendar/event?eid=eDEgbWVAZXhhbXBsZS5jb20",
    attendees: [
      { email: "a@example.com", responseStatus: "accepted" },
      { email: "me@example.com", self: true, responseStatus: "tentative" },
    ],
    extendedProperties: {
      private: { slotmirrorMarker: "tag.marker.hash", slotmirrorDedupKey: "dedup" },
    },
  },
  { id: "all-day", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } },
];

const GOOGLE_PATHS = [
  ...Object.keys(GOOGLE_BASES[0]!).map((key) => [key]),
  ["start", "date"],
  ["start", "dateTime"],
  ["end", "dateTime"],
  ["originalStartTime", "date"],
  ["originalStartTime", "dateTime"],
  ["attendees", "0"],
  ["attendees", "1", "self"],
  ["attendees", "1", "responseStatus"],
  ["extendedProperties", "private"],
  ["extendedProperties", "private", "slotmirrorMarker"],
  ["extendedProperties", "private", "slotmirrorDedupKey"],
];

/** Records that only the schema can judge: other prototypes, symbol and hidden keys. */
function unusualRecords(): unknown[] {
  const hidden = { a: "b" };
  Object.defineProperty(hidden, "slotmirrorMarker", { value: "t.m.h", enumerable: false });
  class Properties {
    slotmirrorMarker = "t.m.h";
  }
  return [
    Object.assign(Object.create(null) as object, { slotmirrorMarker: "t.m.h" }),
    { [Symbol("s")]: "x", slotmirrorMarker: "t.m.h" },
    hidden,
    new Properties(),
    new Map([["slotmirrorMarker", "t.m.h"]]),
    JSON.parse('{"__proto__": 1, "slotmirrorMarker": "t.m.h"}') as unknown,
    JSON.parse('{"__proto__": "x", "slotmirrorMarker": "t.m.h"}') as unknown,
  ];
}

describe("quick event checks", () => {
  it("accept and convert Graph events exactly as the schema does", () => {
    const cases = GRAPH_BASES.flatMap((base) => variants(base, GRAPH_PATHS));
    let accepted = 0;
    for (const raw of cases) {
      const reference = outcome(() => fromGraphEvent(graphEventSchema.parse(raw)));
      expect(
        outcome(() => fromGraphEvent(raw)),
        JSON.stringify(raw),
      ).toEqual(reference);
      if ("value" in (reference as object)) accepted++;
    }
    // Both outcomes occur, so the comparison means something.
    expect(accepted).toBeGreaterThan(50);
    expect(accepted).toBeLessThan(cases.length - 50);
  });

  it("accept and convert Google events exactly as the schema does", () => {
    const cases = [
      ...GOOGLE_BASES.flatMap((base) => variants(base, GOOGLE_PATHS)),
      ...unusualRecords().map((record) =>
        withValue(GOOGLE_BASES[0], ["extendedProperties", "private"], record),
      ),
    ];
    let accepted = 0;
    for (const raw of cases) {
      const reference = outcome(() => fromGoogleEvent(googleEventSchema.parse(raw)));
      expect(
        outcome(() => fromGoogleEvent(raw)),
        String(JSON.stringify(raw)),
      ).toEqual(reference);
      const marker = outcome(() => googleMarker(googleEventSchema.parse(raw)));
      expect(
        outcome(() => googleMarker(raw)),
        String(JSON.stringify(raw)),
      ).toEqual(marker);
      if ("value" in (reference as object)) accepted++;
    }
    expect(accepted).toBeGreaterThan(50);
    expect(accepted).toBeLessThan(cases.length - 50);
  });
});

describe("ISO times without a Date", () => {
  it("match toISOString for times across and beyond the four-digit years", () => {
    const times = [
      0,
      -1,
      1,
      -0,
      Date.parse("0000-01-01T00:00:00.000Z"),
      Date.parse("0000-01-01T00:00:00.000Z") - 1,
      Date.parse("9999-12-31T23:59:59.999Z"),
      Date.parse("9999-12-31T23:59:59.999Z") + 1,
      Date.parse("2000-02-29T12:00:00.000Z"),
      Date.parse("1900-03-01T00:00:00.000Z"),
      Date.parse("2100-02-28T23:59:59.999Z"),
      8.64e15,
      -8.64e15,
      8.64e15 + 1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    let seed = 7;
    for (let i = 0; i < 20_000; i++) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const span = i % 2 === 0 ? 3e11 : 5e14;
      times.push(Math.round((seed / 2_147_483_648 - 0.5) * 2 * span) + (i % 3) * 1.7e12);
    }
    for (const time of times) {
      expect(
        outcome(() => isoFromTime(time)),
        String(time),
      ).toEqual(outcome(() => new Date(time).toISOString()));
    }
  });

  it("match new Date(text).toISOString() for the texts that providers send and broken ones", () => {
    const texts = [
      "2026-11-01T08:00:00Z",
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T08:00:00.5Z",
      "2026-11-01T08:00:00.0000000Z",
      "2026-11-01T08:00:00+01:00",
      "2026-11-01T00:30:00+05:30",
      "2026-01-01T00:00:00+14:00",
      "2026-12-31T23:00:00-11:00",
      "2024-02-29T23:30:00-01:00",
      "2026-02-29T08:00:00Z",
      "2026-02-30T08:00:00Z",
      "2026-11-01T24:00:00Z",
      "2026-13-01T08:00:00Z",
      "2026-11-01",
      "2026-11-01T08:00",
      "2026-11-01T08:00:00",
      "0000-01-01T00:00:00+01:00",
      "9999-12-31T23:59:59-01:00",
      "+275760-09-13T00:00:00Z",
      "-000001-01-01T00:00:00Z",
      "Sun, 01 Nov 2026 08:00:00 GMT",
      "not a time",
      "",
    ];
    for (const text of texts) {
      expect(
        outcome(() => isoInstant(text)),
        text,
      ).toEqual(outcome(() => new Date(text).toISOString()));
    }
  });
});
