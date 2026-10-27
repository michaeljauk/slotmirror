/**
 * Golden test for the sync engine: it runs the parsers, the planner and the block builders over a
 * generated fixture of several hundred events and compares a digest of the exact output with the
 * digest that the code produced before the CPU optimisations. Markers, dedup keys and block bodies
 * are stored in calendars, so any difference would rewrite blocks. If a digest changes on purpose,
 * explain the behaviour change in the pull request.
 */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ruleOptionsSchema } from "../src/config";
import { GoogleCalendar } from "../src/providers/google-calendar";
import { GraphCalendar, toGraphBlock } from "../src/providers/graph-calendar";
import {
  fromGoogleEvent,
  GOOGLE_DEDUP_KEY,
  GOOGLE_MARKER_KEY,
  googleMarker,
  LEGACY_GOOGLE_MARKER_KEY,
  toGoogleBlock,
} from "../src/sync/google-events";
import {
  DEDUP_PROPERTY_ID,
  fromGraphEvent,
  graphDedupKey,
  graphMarkerValue,
  LEGACY_MARKER_PROPERTY_ID,
  MARKER_PROPERTY_ID,
  markerValueFor,
  parseMarkerValue,
} from "../src/sync/graph-events";
import {
  blockContent,
  dedupKeyFor,
  desiredBlocks,
  inPrecedenceOrder,
  isIncluded,
  markerFor,
  planSync,
  ruleTagFor,
} from "../src/sync/plan";
import type { DesiredBlock, ExistingBlock, SourceEvent } from "../src/sync/types";
import { signIn } from "./helpers";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BASE = Date.UTC(2026, 9, 20);
const RULE_A = "golden-rule-a";
const RULE_B = "golden-rule-b";
const SCOPE = "golden-user";
const WINDOW = { start: new Date(BASE), end: new Date(BASE + 120 * DAY) };

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Marks a field that the generated event leaves out. */
const OMIT = Symbol("omit");

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

function compact(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== OMIT));
}

const SUBJECTS = [
  OMIT,
  null,
  "",
  "   ",
  "Weekly sync",
  "  Weekly   SYNC ",
  "Café with Ana",
  "Café with Ana",
  "Board meeting: budget 2027",
  "Dentist",
  "Focus time",
  "Projekt-Übergabe (Teil 2)",
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A Graph calendarView item with every variant the sync distinguishes. */
function graphEvent(next: () => number, index: number, markers: string[]): Record<string, unknown> {
  const day = Math.floor(next() * 110);
  const allDay = next() < 0.12;
  const multiDay = next() < 0.08;
  const type = pick(next, [
    "singleInstance",
    "singleInstance",
    "singleInstance",
    "occurrence",
    "occurrence",
    "exception",
    "seriesMaster",
  ]);
  const start = allDay
    ? BASE + day * DAY
    : BASE + day * DAY + Math.floor(next() * 40) * 30 * MINUTE;
  const end = allDay
    ? start + (multiDay ? 3 : 1) * DAY
    : start + (multiDay ? 26 * 60 : pick(next, [15, 30, 60, 90])) * MINUTE;
  const dateTime = (ms: number) => {
    const text = iso(ms).slice(0, 19);
    return pick(next, [`${text}.0000000`, `${text}.0000000`, text]);
  };
  const inSeries = type === "occurrence" || type === "exception";
  const seriesMasterId = inSeries
    ? next() < 0.9
      ? `series-${Math.floor(next() * 12)}`
      : pick(next, [null, OMIT])
    : pick(next, [null, OMIT]);
  const original = start - (type === "exception" ? pick(next, [1, 2]) * DAY : 0);
  const originalStart = inSeries
    ? pick(next, [
        iso(original).replace(".000Z", "Z"),
        iso(original).replace(".000Z", "Z"),
        iso(original),
        iso(original).replace(".000Z", ".0000000Z"),
        null,
      ])
    : pick(next, [null, OMIT]);
  const marker = pick(next, markers);
  const properties = pick(next, [
    OMIT,
    OMIT,
    OMIT,
    OMIT,
    [],
    [{ id: MARKER_PROPERTY_ID, value: marker }],
    [{ id: MARKER_PROPERTY_ID.toLowerCase(), value: marker }],
    [{ id: LEGACY_MARKER_PROPERTY_ID, value: marker }],
    [
      { id: MARKER_PROPERTY_ID, value: null },
      { id: LEGACY_MARKER_PROPERTY_ID, value: marker },
    ],
    [
      { id: LEGACY_MARKER_PROPERTY_ID, value: "legacy" },
      { id: MARKER_PROPERTY_ID, value: marker },
      { id: DEDUP_PROPERTY_ID, value: "d".repeat(32) },
    ],
    [{ id: "String {00000000-0000-0000-0000-000000000000} Name other", value: "x" }],
    [{ id: DEDUP_PROPERTY_ID }],
  ]);
  return compact({
    "@odata.etag": `W/"etag-${index}"`,
    id: `graph-${index}-${"x".repeat(Math.floor(next() * 40))}`,
    type,
    seriesMasterId,
    originalStart,
    start: { dateTime: dateTime(start), timeZone: "UTC" },
    end: { dateTime: dateTime(end), timeZone: "UTC" },
    isAllDay: allDay,
    isCancelled: pick(next, [false, false, false, false, false, true, OMIT]),
    showAs: pick(next, [
      "busy",
      "busy",
      "busy",
      "free",
      "tentative",
      "oof",
      "workingElsewhere",
      "unknown",
      "other",
      OMIT,
    ]),
    sensitivity: pick(next, ["normal", "normal", "personal", "private", "confidential", OMIT]),
    categories: pick(next, [
      OMIT,
      [],
      [],
      ["Red category"],
      ["  red CATEGORY ", "Work"],
      [" Red category "],
      ["Blue category"],
    ]),
    responseStatus: pick(next, [
      OMIT,
      {},
      { response: "organizer", time: "0001-01-01T00:00:00Z" },
      { response: "accepted" },
      { response: "tentativelyAccepted" },
      { response: "declined" },
      { response: "none" },
    ]),
    subject: pick(next, SUBJECTS),
    location: pick(next, [
      OMIT,
      null,
      {},
      { displayName: null },
      { displayName: "" },
      { displayName: "Room 4.12", locationType: "default", address: {}, coordinates: {} },
      { displayName: "Graz, Hauptplatz 1" },
    ]),
    bodyPreview: pick(next, [OMIT, null, "", "Preview of the agenda"]),
    body: pick(next, [
      OMIT,
      OMIT,
      null,
      {},
      { content: null },
      { content: "Full agenda\r\nwith two lines", contentType: "text" },
    ]),
    singleValueExtendedProperties: properties,
  });
}

/** A Google events.list item with every variant the sync distinguishes. */
function googleEvent(
  next: () => number,
  index: number,
  markers: string[],
): Record<string, unknown> {
  const day = Math.floor(next() * 110);
  const allDay = next() < 0.12;
  const multiDay = next() < 0.08;
  const start = allDay
    ? BASE + day * DAY
    : BASE + day * DAY + Math.floor(next() * 40) * 30 * MINUTE;
  const end = allDay
    ? start + (multiDay ? 3 : 1) * DAY
    : start + (multiDay ? 26 * 60 : pick(next, [15, 30, 60, 90])) * MINUTE;
  const time = (ms: number) => {
    if (allDay) return { date: iso(ms).slice(0, 10) };
    const offset = pick(next, [0, 60, 120, -300, 330]);
    const local = iso(ms + offset * MINUTE).slice(0, 19);
    const sign = offset < 0 ? "-" : "+";
    const abs = Math.abs(offset);
    const zone =
      offset === 0
        ? pick(next, ["Z", "+00:00"])
        : `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    return compact({
      dateTime: `${local}${pick(next, ["", "", ".000"])}${zone}`,
      timeZone: pick(next, ["Europe/Vienna", OMIT]),
    });
  };
  const recurring = next() < 0.35;
  const original = start - (next() < 0.2 ? DAY : 0);
  const marker = pick(next, markers);
  return compact({
    kind: "calendar#event",
    etag: `"${index}"`,
    id: `google${index}${recurring ? `_${iso(original).replace(/[-:.]/g, "")}` : ""}`,
    status: pick(next, ["confirmed", "confirmed", "confirmed", "tentative", "cancelled", OMIT]),
    summary: pick(
      next,
      SUBJECTS.filter((subject) => subject !== null),
    ),
    location: pick(next, [OMIT, "", "Graz", "Room 4.12"]),
    description: pick(next, [OMIT, "", "Notes\nline two"]),
    start: time(start),
    end: time(end),
    recurringEventId: recurring ? `rec${Math.floor(next() * 10)}` : pick(next, [OMIT, OMIT]),
    originalStartTime: recurring
      ? pick(next, [time(original), time(original), OMIT])
      : pick(next, [OMIT, OMIT, OMIT, time(original)]),
    transparency: pick(next, [OMIT, OMIT, "opaque", "transparent"]),
    visibility: pick(next, [OMIT, "default", "public", "private", "confidential"]),
    colorId: pick(next, [OMIT, OMIT, "5", "11"]),
    attendees: pick(next, [
      OMIT,
      OMIT,
      [],
      [{ email: "a@example.com", responseStatus: "accepted" }],
      [
        { email: "a@example.com", responseStatus: "accepted" },
        { email: "me@example.com", self: true, responseStatus: "tentative" },
      ],
      [{ email: "me@example.com", self: true, responseStatus: "declined" }],
      [{ email: "me@example.com", self: true, responseStatus: "accepted" }],
      [{ email: "me@example.com", self: false, responseStatus: "declined" }],
    ]),
    extendedProperties: pick(next, [
      OMIT,
      OMIT,
      OMIT,
      {},
      { private: {} },
      { private: { [GOOGLE_MARKER_KEY]: marker } },
      { private: { [LEGACY_GOOGLE_MARKER_KEY]: marker, other: "x" } },
      { private: { [GOOGLE_MARKER_KEY]: marker, [GOOGLE_DEDUP_KEY]: "e".repeat(32) } },
      { shared: { [GOOGLE_MARKER_KEY]: marker } },
    ]),
  });
}

const OPTION_SETS = [
  {},
  { detailLevel: "title", markPrivate: false },
  { detailLevel: "title_location", blockColor: " 5 " },
  {
    detailLevel: "full",
    skipAllDay: false,
    skipFree: false,
    skipDeclined: false,
    blockTitle: "Occupied",
  },
  { skipTentative: true, skipCategories: ["red category", " WORK "] },
  {
    detailLevel: "full",
    markPrivate: false,
    blockColor: "Blue category",
    skipCategories: ["color:5"],
  },
  { skipAllDay: false, blockColor: "12" },
].map((options) => ruleOptionsSchema.parse(options));

/**
 * Raw target events for the blocks of a rule, in every state the planner tells apart: unchanged,
 * changed content, moved, without dedup key, duplicated, missing, orphaned, and blocks of other
 * rules and other events around them.
 */
function targetEvents(
  provider: "graph" | "google",
  blocks: DesiredBlock[],
  tag: string,
  otherTag: string,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const add = (block: DesiredBlock, blockTag: string, extra: Record<string, unknown> = {}) => {
    const id = `${provider}-target-${events.length}`;
    if (provider === "graph") {
      const body = toGraphBlock(block, blockTag);
      events.push({
        id,
        type: "singleInstance",
        seriesMasterId: null,
        originalStart: null,
        isCancelled: false,
        bodyPreview: "",
        ...body,
        start: { ...body.start, dateTime: `${body.start.dateTime}.0000000` },
        end: { ...body.end, dateTime: `${body.end.dateTime}.0000000` },
        ...extra,
      });
    } else {
      const { colorId, ...body } = toGoogleBlock(block, blockTag);
      events.push({
        id,
        status: "confirmed",
        ...body,
        ...(colorId === null ? {} : { colorId }),
        ...extra,
      });
    }
  };
  blocks.forEach((block, index) => {
    switch (index % 11) {
      case 0:
        return; // missing: the plan creates it
      case 1:
        add({ ...block, contentHash: "0".repeat(32) }, tag);
        return;
      case 2:
        add({ ...block, start: block.allDay ? "2026-01-01" : "2026-01-01T08:00:00.000Z" }, tag);
        return;
      case 3:
        add({ ...block, dedupKey: "" }, tag);
        return;
      case 4:
        add(block, tag);
        add(block, tag);
        return;
      case 5:
        add(block, otherTag);
        return;
      default:
        add(block, tag);
    }
  });
  const orphan = blocks[0];
  if (orphan) {
    add({ ...orphan, marker: "f".repeat(32) }, tag);
    add({ ...orphan, marker: "e".repeat(32) }, "000000000000");
    if (provider === "graph") {
      add({ ...orphan, marker: "c".repeat(32) }, tag, { type: "seriesMaster" });
      add({ ...orphan, marker: "b".repeat(32) }, tag, { isCancelled: true });
      add({ ...orphan, marker: "a".repeat(32) }, tag, {
        singleValueExtendedProperties: [
          { id: LEGACY_MARKER_PROPERTY_ID, value: `${tag}.${"a".repeat(32)}.${"1".repeat(32)}` },
        ],
      });
      add({ ...orphan, marker: "9".repeat(32) }, tag, {
        singleValueExtendedProperties: [{ id: MARKER_PROPERTY_ID, value: "two.parts" }],
      });
    } else {
      add({ ...orphan, marker: "b".repeat(32) }, tag, { status: "cancelled" });
      add({ ...orphan, marker: "a".repeat(32) }, tag, {
        extendedProperties: {
          private: { [LEGACY_GOOGLE_MARKER_KEY]: `${tag}.${"a".repeat(32)}.${"1".repeat(32)}` },
        },
      });
    }
  }
  return events;
}

/** Raw events that the parsers must reject, each with the error it raised before. */
const INVALID_GRAPH: unknown[] = [
  null,
  "event",
  [],
  {},
  { id: 7 },
  { id: "a", type: "other" },
  { id: "a", type: "singleInstance", start: null },
  { id: "a", type: "singleInstance", start: { dateTime: 5, timeZone: "UTC" } },
  {
    id: "a",
    type: "singleInstance",
    start: { dateTime: "2026-11-01T08:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-11-01T09:00:00", timeZone: "UTC" },
    isAllDay: "false",
  },
];

function validGraph(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "valid",
    type: "singleInstance",
    start: { dateTime: "2026-11-01T08:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-01T09:00:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    ...overrides,
  };
}

function validGoogle(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "valid",
    start: { dateTime: "2026-11-01T08:00:00+01:00" },
    end: { dateTime: "2026-11-01T09:00:00+01:00" },
    ...overrides,
  };
}

const GRAPH_CASES: unknown[] = [
  ...INVALID_GRAPH,
  validGraph({}),
  validGraph({ seriesMasterId: 5 }),
  validGraph({ originalStart: 5 }),
  validGraph({ isCancelled: null }),
  validGraph({ showAs: null }),
  validGraph({ sensitivity: 1 }),
  validGraph({ categories: ["a", 1] }),
  validGraph({ categories: "a" }),
  validGraph({ responseStatus: null }),
  validGraph({ responseStatus: { response: 1 } }),
  validGraph({ subject: 5 }),
  validGraph({ location: "Room" }),
  validGraph({ location: { displayName: 3 } }),
  validGraph({ bodyPreview: 3 }),
  validGraph({ body: "x" }),
  validGraph({ body: { content: 1 } }),
  validGraph({ singleValueExtendedProperties: null }),
  validGraph({ singleValueExtendedProperties: [{ id: 1 }] }),
  validGraph({ singleValueExtendedProperties: [{ id: "a", value: 1 }] }),
  validGraph({ singleValueExtendedProperties: [null] }),
  validGraph({ start: { dateTime: "2026-11-01T08:00:00" } }),
  validGraph({ end: { timeZone: "UTC" } }),
  validGraph({ start: { dateTime: "2026-11-01T08:00:00", timeZone: "W. Europe Standard Time" } }),
  validGraph({ start: { dateTime: "2026-13-45T99:00:00", timeZone: "UTC" } }),
  validGraph({ start: { dateTime: "2026-02-30T08:00:00", timeZone: "UTC" } }),
  validGraph({ start: { dateTime: "2026-11-01T24:00:00", timeZone: "UTC" } }),
  validGraph({ start: { dateTime: "not a time", timeZone: "UTC" } }),
  validGraph({ start: { dateTime: "2026-11-01", timeZone: "UTC" } }),
  validGraph({ start: { dateTime: "+002026-11-01T08:00:00", timeZone: "UTC" } }),
  validGraph({ isAllDay: true, start: { dateTime: "junk", timeZone: "Other" } }),
  validGraph({ seriesMasterId: "s", originalStart: "garbage" }),
  validGraph({ seriesMasterId: "s", originalStart: "2026-11-01T08:00:00+02:00" }),
  validGraph({ seriesMasterId: "s", originalStart: "2026-11-01" }),
  validGraph({ seriesMasterId: "", originalStart: "2026-11-01T08:00:00Z" }),
  validGraph({ type: "seriesMaster", start: { dateTime: "junk", timeZone: "Other" } }),
  validGraph({ extra: { nested: [1, 2, 3] } }),
  Object.assign(Object.create({ inherited: true }) as object, validGraph({})),
];

const GOOGLE_CASES: unknown[] = [
  null,
  [],
  "event",
  {},
  { id: 1 },
  validGoogle({}),
  validGoogle({ start: {} }),
  validGoogle({ start: { date: 5 } }),
  validGoogle({ start: { date: "", dateTime: "2026-11-01T08:00:00Z" } }),
  validGoogle({ start: null }),
  validGoogle({ end: undefined }),
  validGoogle({ status: 3 }),
  validGoogle({ summary: null }),
  validGoogle({ location: 1 }),
  validGoogle({ description: false }),
  validGoogle({ recurringEventId: 1 }),
  validGoogle({ recurringEventId: "r", originalStartTime: null }),
  validGoogle({ recurringEventId: "r", originalStartTime: {} }),
  validGoogle({ recurringEventId: "r", originalStartTime: { date: "2026-11-01" } }),
  validGoogle({ transparency: 0 }),
  validGoogle({ visibility: [] }),
  validGoogle({ colorId: null }),
  validGoogle({ colorId: 5 }),
  validGoogle({ attendees: null }),
  validGoogle({ attendees: [null] }),
  validGoogle({ attendees: [{ self: "yes" }] }),
  validGoogle({ attendees: [{ self: true, responseStatus: 1 }] }),
  validGoogle({ extendedProperties: null }),
  validGoogle({ extendedProperties: { private: null } }),
  validGoogle({ extendedProperties: { private: [] } }),
  validGoogle({ extendedProperties: { private: { a: 1 } } }),
  validGoogle({ extendedProperties: { private: { [GOOGLE_MARKER_KEY]: "t.m.h" } } }),
  validGoogle({
    extendedProperties: { private: Object.assign(Object.create(null) as object, { a: "b" }) },
  }),
  validGoogle({ extendedProperties: { private: new Map([["a", "b"]]) } }),
  validGoogle({ extendedProperties: { private: { [Symbol("s")]: "x", a: "b" } } }),
  validGoogle({ start: { dateTime: "nope" } }),
  validGoogle({ start: { dateTime: "2026-11-01T08:00:00" } }),
  validGoogle({ start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }),
];

/** The outcome of one call: its value, or the name and message of what it threw. */
function outcome(run: () => unknown): unknown {
  try {
    return { value: run() };
  } catch (error) {
    return error instanceof Error
      ? { name: error.name, message: error.message }
      : { thrown: String(error) };
  }
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function respondWith(routes: [string, string][]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const route = routes.find(([part]) => url.includes(part));
    if (!route) return new Response("unexpected", { status: 500 });
    return new Response(route[1], { headers: { "content-type": "application/json" } });
  });
}

function onlyEvents(events: (SourceEvent | null)[]): SourceEvent[] {
  return events.filter((event): event is SourceEvent => event !== null);
}

async function fixture() {
  const tagA = await ruleTagFor(RULE_A);
  const tagB = await ruleTagFor(RULE_B);
  const markers = [
    `${tagA}.${"1".repeat(32)}.${"2".repeat(32)}`,
    `${tagB}.${"3".repeat(32)}.${"4".repeat(32)}`,
    `${"5".repeat(32)}.${"6".repeat(32)}`,
    "",
  ];
  const graphNext = random(20261027);
  const graphRaw = Array.from({ length: 420 }, (_, index) => graphEvent(graphNext, index, markers));
  const googleNext = random(4242);
  const googleRaw = Array.from({ length: 420 }, (_, index) =>
    googleEvent(googleNext, index, markers),
  );
  return { tagA, tagB, graphRaw, googleRaw };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("golden output of the sync engine", () => {
  it("parses events, plans and builds blocks exactly as before", async () => {
    const { tagA, tagB, graphRaw, googleRaw } = await fixture();
    const sections: Record<string, unknown> = {};

    // Parsers, directly and through the clients (two pages each).
    respondWith([
      [
        "/calendars/graph-src/calendarView",
        JSON.stringify({
          value: graphRaw.slice(0, 200),
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/page-two/calendars/graph-src-2/x",
        }),
      ],
      ["/calendars/graph-src-2/", JSON.stringify({ value: graphRaw.slice(200) })],
    ]);
    const graphSources = await new GraphCalendar("token").sourceEvents("graph-src", WINDOW);
    const graphWithBody = await new GraphCalendar("token").sourceEvents("graph-src", WINDOW, {
      withBody: true,
    });
    expect(graphSources).toEqual(onlyEvents(graphRaw.map((raw) => fromGraphEvent(raw))));
    sections.graphSources = graphSources;
    sections.graphWithBody = graphWithBody;

    vi.restoreAllMocks();
    respondWith([
      [
        "/calendars/google-src/events",
        JSON.stringify({ items: googleRaw.slice(0, 210), nextPageToken: "two" }),
      ],
    ]);
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const items = url.includes("pageToken=two") ? googleRaw.slice(210) : googleRaw.slice(0, 210);
      return Response.json(
        url.includes("pageToken=two") ? { items } : { items, nextPageToken: "two" },
      );
    });
    const googleSources = await new GoogleCalendar("token").sourceEvents("google-src", WINDOW, {
      withBody: true,
    });
    expect(googleSources).toEqual(onlyEvents(googleRaw.map((raw) => fromGoogleEvent(raw))));
    sections.googleSources = googleSources;
    sections.googleMarkers = googleRaw.map((raw) => googleMarker(raw));
    sections.graphMarkers = graphRaw.map((raw) => {
      const properties = (raw as { singleValueExtendedProperties?: never })
        .singleValueExtendedProperties;
      const value = graphMarkerValue(properties);
      return [value ?? null, value ? parseMarkerValue(value) : null, graphDedupKey(properties)];
    });

    // Planner and block builders, for each provider, option set and dedup state.
    const plans: unknown[] = [];
    const existingSections: unknown[] = [];
    for (const [provider, sources] of [
      ["graph", graphSources],
      ["google", googleSources],
    ] as const) {
      for (const [index, options] of OPTION_SETS.entries()) {
        const included = sources.map((event) => isIncluded(event, options));
        const contents = sources.map((event) => blockContent(event, options));
        const claimedBy = await desiredBlocks(RULE_B, sources, options, { scope: SCOPE });
        const desired = await desiredBlocks(RULE_A, sources, options, { scope: SCOPE });
        const target = targetEvents(provider, desired, tagA, tagB);
        vi.mocked(fetch).mockImplementation(async () =>
          Response.json(provider === "graph" ? { value: target } : { items: target }),
        );
        const client =
          provider === "graph" ? new GraphCalendar("token") : new GoogleCalendar("token");
        const blocks = await client.existingBlocks("target", WINDOW, [tagA, tagB]);
        existingSections.push(blocks);
        const existing = blocks.filter((block) => block.ruleTag === tagA);
        const claimed = new Set([
          ...blocks
            .filter((block) => block.ruleTag !== tagA && block.dedupKey !== "")
            .map((block) => block.dedupKey),
          ...claimedBy.filter((_, i) => i % 3 === 0).map((block) => block.dedupKey),
        ]);
        const deduped = await desiredBlocks(RULE_A, sources, options, { scope: SCOPE, claimed });
        const unscoped = await desiredBlocks(RULE_A, sources, options);
        for (const [variant, blocksForPlan] of [
          ["plain", desired],
          ["deduped", deduped],
        ] as const) {
          const plan = planSync(blocksForPlan, existing);
          plans.push({
            provider,
            options: index,
            variant,
            plan,
            bodies: plan.actions.map((action) =>
              action.kind === "delete"
                ? action
                : provider === "graph"
                  ? toGraphBlock(action.block, tagA)
                  : toGoogleBlock(action.block, tagA),
            ),
            markerValues: blocksForPlan.map((block) => markerValueFor(tagA, block)),
          });
        }
        plans.push({ provider, options: index, included, contents, unscoped });
      }
    }
    sections.existing = existingSections;
    sections.plans = plans;

    // Planner edge cases with hand-made existing blocks.
    const [sample] = await desiredBlocks(RULE_A, graphSources, OPTION_SETS[3]!, { scope: SCOPE });
    const base: ExistingBlock = {
      targetId: "t",
      ruleTag: tagA,
      marker: sample!.marker,
      contentHash: sample!.contentHash,
      dedupKey: sample!.dedupKey,
      start: sample!.start,
      end: sample!.end,
      allDay: sample!.allDay,
    };
    sections.edges = [
      planSync([sample!], [base]),
      planSync([sample!], [{ ...base, start: sample!.start.replace(".000Z", "Z") }]),
      planSync([sample!], [{ ...base, start: sample!.start.replace(".000Z", "+00:00") }]),
      planSync([sample!], [{ ...base, start: "junk" }]),
      planSync([sample!], [{ ...base, allDay: !sample!.allDay }]),
      planSync([sample!], [{ ...base, dedupKey: "" }]),
      planSync(
        [sample!, sample!],
        [base, { ...base, targetId: "t2" }, { ...base, targetId: "t3" }],
      ),
      planSync([], [base]),
      planSync([sample!], []),
    ];

    // Hashes on their own.
    sections.hashes = {
      markers: await Promise.all(
        ["event:a", "series:s:2026-11-01T08:00:00.000Z", "", "ü\u0000x"].map((key) =>
          markerFor(RULE_A, key),
        ),
      ),
      tags: await Promise.all(["", RULE_A, RULE_B, "ünïcode", "x".repeat(500)].map(ruleTagFor)),
      order: await inPrecedenceOrder(["r1", "r2", "r3", "r4", "r5", RULE_A, RULE_B]),
      dedup: await Promise.all(
        [
          { subject: "Café  WITH ana ", allDay: false, isPrivate: true },
          { subject: "Café with Ana", allDay: false, isPrivate: true },
          { subject: "\t\nX Y", allDay: true, isPrivate: false },
        ].map((variant) =>
          dedupKeyFor(SCOPE, {
            start: "2026-11-01T08:00:00.000Z",
            end: "2026-11-01T09:00:00.000Z",
            showAs: "busy",
            location: "",
            body: "",
            ...variant,
          }),
        ),
      ),
    };

    // Invalid input fails in the same way.
    sections.errors = {
      graph: GRAPH_CASES.map((raw) => outcome(() => fromGraphEvent(raw))),
      google: GOOGLE_CASES.map((raw) => outcome(() => fromGoogleEvent(raw))),
      googleMarker: GOOGLE_CASES.map((raw) => outcome(() => googleMarker(raw))),
      graphExisting: await Promise.all(
        GRAPH_CASES.map(async (raw) => {
          vi.mocked(fetch).mockImplementation(async () => Response.json({ value: [raw] }));
          try {
            return { value: await new GraphCalendar("t").existingBlocks("c", WINDOW, ["tag"]) };
          } catch (error) {
            return { name: (error as Error).name, message: (error as Error).message };
          }
        }),
      ),
      googleExisting: await Promise.all(
        GOOGLE_CASES.map(async (raw) => {
          vi.mocked(fetch).mockImplementation(async () => Response.json({ items: [raw] }));
          try {
            return { value: await new GoogleCalendar("t").existingBlocks("c", WINDOW, ["t"]) };
          } catch (error) {
            return { name: (error as Error).name, message: (error as Error).message };
          }
        }),
      ),
    };

    // The fixture covers what it claims to cover.
    const allPlans = plans.flatMap((entry) =>
      "plan" in (entry as object)
        ? [(entry as { plan: { stats: Record<string, number> } }).plan]
        : [],
    );
    for (const kind of ["create", "update", "delete", "unchanged"]) {
      expect(allPlans.some((plan) => plan.stats[kind]! > 0)).toBe(true);
    }
    expect(graphSources.some((event) => event.isMirror)).toBe(true);
    expect(graphSources.some((event) => event.allDay)).toBe(true);
    expect(graphSources.some((event) => event.occurrenceKey.startsWith("series:"))).toBe(true);
    expect(graphSources.length).toBeLessThan(graphRaw.length);
    expect(googleSources.some((event) => event.isMirror)).toBe(true);
    expect(googleSources.some((event) => event.occurrenceKey.startsWith("series:"))).toBe(true);
    expect(googleSources.length).toBeLessThan(googleRaw.length);

    const digests: Record<string, string> = {};
    for (const [name, value] of Object.entries(sections)) digests[name] = await digest(value);
    expect(digests).toEqual(GOLDEN);
  });

  it("writes the same batches in full rule runs across accounts and providers", async () => {
    // The plan keeps blocks outside the sync window, so the output depends on the date of the run.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE);
    const { graphRaw, googleRaw } = await fixture();
    const { user } = await signIn("owner@example.com");
    const org = await env.DB.prepare("SELECT org_id AS orgId FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ orgId: string }>();
    await env.DB.prepare(
      "INSERT INTO users (id, org_id, email, role) VALUES (?, ?, 'golden@org.example', 'member')",
    )
      .bind(SCOPE, org!.orgId)
      .run();
    const accounts = [
      ["gold-ms-src", "microsoft", "src@org.example"],
      ["gold-ms-dst", "microsoft", "dst@example.com"],
      ["gold-g-src", "google", "src@example.com"],
      ["gold-g-dst", "google", "dst@example.net"],
    ] as const;
    const rules = [
      [
        "golden-e2e-1",
        "gold-ms-src",
        "gold-g-dst",
        { detailLevel: "title_location", skipAllDay: false, blockColor: "7" },
      ],
      [
        "golden-e2e-2",
        "gold-g-src",
        "gold-ms-dst",
        { detailLevel: "full", markPrivate: false, skipFree: false, blockColor: "Green category" },
      ],
      ["golden-e2e-3", "gold-ms-src", "gold-ms-dst", {}],
    ] as const;
    await env.DB.batch([
      ...accounts.flatMap(([id, provider, email]) => [
        env.DB.prepare(
          "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)",
        ).bind(id, SCOPE, provider, email),
        env.DB.prepare(
          "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, ?, 'Cal')",
        ).bind(`${id}-cal`, id, `${id}-remote`),
      ]),
      ...rules.map(([id, source, target, options]) =>
        env.DB.prepare(
          "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
        ).bind(id, SCOPE, `${source}-cal`, `${target}-cal`, JSON.stringify(options)),
      ),
    ]);
    const tokens = { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + 3_600_000 };
    for (const [id, provider] of accounts) {
      await env.ACCOUNT_SYNC.getByName(id).storeTokens(id, tokens, provider);
    }

    // Each target already holds blocks of its rules in every state; see `targetEvents`.
    const graphSources = onlyEvents(graphRaw.map((raw) => fromGraphEvent(raw)));
    const googleSources = onlyEvents(googleRaw.map((raw) => fromGoogleEvent(raw)));
    const tag = (id: string) => ruleTagFor(id);
    const googleTarget = targetEvents(
      "google",
      await desiredBlocks(
        "golden-e2e-1",
        graphSources,
        ruleOptionsSchema.parse({ detailLevel: "title", skipAllDay: false, blockColor: "7" }),
        { scope: SCOPE },
      ),
      await tag("golden-e2e-1"),
      await tag("golden-e2e-3"),
    );
    const graphTarget = [
      ...targetEvents(
        "graph",
        await desiredBlocks("golden-e2e-2", googleSources, ruleOptionsSchema.parse(rules[1][3]), {
          scope: SCOPE,
        }),
        await tag("golden-e2e-2"),
        await tag("golden-e2e-3"),
      ),
      ...targetEvents(
        "graph",
        await desiredBlocks(
          "golden-e2e-3",
          graphSources,
          ruleOptionsSchema.parse({ detailLevel: "busy" }),
          { scope: SCOPE },
        ),
        await tag("golden-e2e-3"),
        await tag("golden-e2e-2"),
      ).map((event, index) => ({ ...event, id: `graph-second-${index}` })),
    ];

    const sent: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/calendars/gold-ms-src-remote/calendarView")) {
        return Response.json({ value: graphRaw });
      }
      if (url.includes("/calendars/gold-ms-dst-remote/calendarView")) {
        return Response.json({ value: graphTarget });
      }
      if (url.includes("/calendars/gold-g-src-remote/events")) {
        return Response.json({ items: googleRaw });
      }
      if (url.includes("/calendars/gold-g-dst-remote/events")) {
        return Response.json({ items: googleTarget });
      }
      if (url.endsWith("/$batch")) {
        const body = JSON.parse(init?.body as string) as {
          requests: { id: string; method: string }[];
        };
        sent.push(body);
        return Response.json({
          responses: body.requests.map((request) => ({
            id: request.id,
            status: request.method === "DELETE" ? 204 : 201,
            body: request.method === "POST" ? { id: `new-${request.id}` } : undefined,
          })),
        });
      }
      if (url.includes("/batch/calendar/v3")) {
        const contentType = new Headers(init?.headers).get("content-type") ?? "";
        const boundary = contentType.split("boundary=")[1] ?? "";
        const text = (init?.body as string | undefined)?.replaceAll(boundary, "BOUNDARY") ?? "";
        sent.push(text);
        const count = text.split("Content-ID: <item").length - 1;
        const parts = Array.from(
          { length: count },
          (_, index) =>
            `--r\r\nContent-ID: <response-item${index}>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"g-${index}"}\r\n`,
        );
        return new Response(`${parts.join("")}--r--\r\n`, {
          headers: { "content-type": "multipart/mixed; boundary=r" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const results = [];
    for (const [ruleId, , target] of rules) {
      results.push(await env.ACCOUNT_SYNC.getByName(target).runRule(ruleId));
    }
    expect(results.every((result) => result.applied > 0 && result.failed === 0)).toBe(true);
    expect(sent.length).toBeGreaterThan(3);
    expect({ results: await digest(results), batches: await digest(sent) }).toEqual(GOLDEN_RUNS);
  });
});

/** Digests of the output before the CPU optimisations. */
const GOLDEN: Record<string, string> = {
  graphSources: "153ff88d1f25d02bef34c16a049910c01fa83c9d55f9eb31caa205765af64a77",
  graphWithBody: "153ff88d1f25d02bef34c16a049910c01fa83c9d55f9eb31caa205765af64a77",
  googleSources: "076ebd124bb4584ac9173c9f02d5aecab25433a590e1f751e766a124cc054693",
  googleMarkers: "150fe89a2b1b88ece8732db6e8ac9f1f0d1ea3b4388af41377aca0f47a74ec2a",
  graphMarkers: "9e207669fba560fb4c00f92760a2d94928d3651ec8fe0a543fbe391a4beb1857",
  existing: "d950b5f176e1fc5314e5e9265b5d3fad22e9ea94e213616d85a4886b562c92df",
  plans: "d056329383fb64dd99d1f9532d64807e4d4edc3151fee7a2a1670e11158d336b",
  edges: "024c3cffb372d14357a1db9ed1c4e1bbcfba39f3c590a81a067c94a95b6c1d18",
  hashes: "62665bc65a26b3ad0aa29f9d5868782f47590856e9599d7706e42306fb65f538",
  errors: "b34457994a2f55a7ce058535217f3ea5ba454f6440155624f27d647cd314fee7",
};

/**
 * Digests of the full rule runs on the fixture's base date. They differ from the output before the
 * CPU optimisations only where the plan keeps timed blocks outside the sync window.
 */
const GOLDEN_RUNS = {
  results: "d674af13045f075d46e1251f62015f9416daed4ee99c3da3bf2b725b22d67537",
  batches: "781626c422566cf22087ad775d1c36467137d411ed626a660e09cdc5073e508b",
};
