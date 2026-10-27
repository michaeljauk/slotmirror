import { describe, expect, it } from "vitest";
import { ruleOptionsSchema, type RuleOptions } from "../src/config";
import { googleMarker, LEGACY_GOOGLE_MARKER_KEY } from "../src/sync/google-events";
import {
  fromGraphEvent,
  graphMarkerValue,
  LEGACY_MARKER_PROPERTY_ID,
  MARKER_PROPERTY_ID,
} from "../src/sync/graph-events";
import { claimsFrom, desiredBlocks, isIncluded, planSync } from "../src/sync/plan";
import type { DesiredBlock, ExistingBlock, SourceEvent } from "../src/sync/types";
import fixture from "./fixtures/graph/calendar-view.json";

const RULE = "rule-1";

function options(overrides: Partial<RuleOptions> = {}): RuleOptions {
  return ruleOptionsSchema.parse(overrides);
}

function sourceEvents(raw: unknown[] = fixture.value): SourceEvent[] {
  return raw.map(fromGraphEvent).filter((event): event is SourceEvent => event !== null);
}

/** Pretend the target already holds exactly these blocks. */
function asExisting(blocks: DesiredBlock[]): ExistingBlock[] {
  return blocks.map((block, index) => ({ ...block, ruleTag: "tag", targetId: `target-${index}` }));
}

function bySubject(subject: string) {
  const raw = fixture.value.filter((event) => event.subject === subject);
  if (raw.length === 0) throw new Error(`fixture has no event "${subject}"`);
  return raw;
}

/** The fixture as it was before the weekly occurrence of 16 Nov was moved to 17 Nov. */
function beforeMove(): unknown[] {
  return fixture.value.map((event) =>
    event.originalStart === "2026-11-16T09:00:00Z"
      ? {
          ...event,
          type: "occurrence",
          start: { dateTime: "2026-11-16T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-11-16T09:30:00.0000000", timeZone: "UTC" },
        }
      : event,
  );
}

/** The fixture as it was before the weekly occurrence of 2 Nov was cancelled. */
function beforeCancel(): unknown[] {
  const template = bySubject("FBS weekly series").find((event) => event.type === "occurrence");
  if (!template) throw new Error("no weekly occurrence in fixture");
  return [
    ...fixture.value,
    {
      ...template,
      id: "event-cancelled",
      originalStart: "2026-11-02T09:00:00Z",
      start: { dateTime: "2026-11-02T09:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-11-02T09:30:00.0000000", timeZone: "UTC" },
    },
  ];
}

describe("fromGraphEvent", () => {
  it("reads every occurrence of the fixture", () => {
    expect(sourceEvents()).toHaveLength(17);
  });

  it("keeps the identity of a moved occurrence: series and original start", () => {
    const moved = sourceEvents().find((event) => event.start === "2026-11-17T10:00:00.000Z");
    expect(moved?.occurrenceKey).toMatch(/^series:series-\d+:2026-11-16T09:00:00\.000Z$/);
  });

  it("returns UTC instants across the end of daylight saving time", () => {
    const daily = sourceEvents(bySubject("FBS daily across DST"));
    expect(daily.map((event) => event.start.slice(11, 16))).toEqual([
      "07:00",
      "07:00",
      "07:00",
      "08:00",
      "08:00",
      "08:00",
      "08:00",
    ]);
  });

  it("keeps all-day events as dates", () => {
    const [allDay] = sourceEvents(bySubject("FBS all-day"));
    expect(allDay).toMatchObject({ allDay: true, start: "2026-10-29", end: "2026-10-30" });
  });

  it("recognises blocks written by slotmirror", () => {
    const [single] = bySubject("FBS single");
    const [event] = sourceEvents([
      { ...single, singleValueExtendedProperties: [{ id: MARKER_PROPERTY_ID, value: "abc" }] },
    ]);
    expect(event?.isMirror).toBe(true);
  });
});

describe("desiredBlocks", () => {
  it("skips all-day and free events by default and keeps tentative ones", async () => {
    const blocks = await desiredBlocks(RULE, sourceEvents(), options());
    expect(blocks).toHaveLength(15);
    expect(blocks.some((block) => block.allDay)).toBe(false);
    expect(blocks.some((block) => block.showAs === "free")).toBe(false);
    expect(blocks.some((block) => block.showAs === "tentative")).toBe(true);
  });

  it("copies only times at detail level busy", async () => {
    const blocks = await desiredBlocks(RULE, sourceEvents(), options());
    expect(new Set(blocks.map((block) => block.subject))).toEqual(new Set(["Busy"]));
    expect(blocks.every((block) => block.location === "" && block.body === "")).toBe(true);
    expect(blocks.every((block) => block.isPrivate)).toBe(true);
  });

  it("copies the title, and the location only from title_location on", async () => {
    const single = sourceEvents(bySubject("FBS single"));
    const [title] = await desiredBlocks(RULE, single, options({ detailLevel: "title" }));
    expect(title).toMatchObject({ subject: "FBS single", location: "", body: "" });
    const [withLocation] = await desiredBlocks(
      RULE,
      single,
      options({ detailLevel: "title_location" }),
    );
    expect(withLocation).toMatchObject({ subject: "FBS single", location: "Test room", body: "" });
    const [full] = await desiredBlocks(RULE, single, options({ detailLevel: "full" }));
    expect(full).toMatchObject({ location: "Test room", body: "Test body" });
  });

  it("never copies details of an event the source marks private", async () => {
    const [block] = await desiredBlocks(
      RULE,
      sourceEvents(bySubject("FBS private")),
      options({ detailLevel: "full", markPrivate: false }),
    );
    expect(block).toMatchObject({ subject: "Busy", location: "", body: "", isPrivate: true });
  });

  it("skips declined events and mirrors of its own blocks", async () => {
    const [single] = bySubject("FBS single");
    const events = sourceEvents([
      { ...single, id: "declined", responseStatus: { response: "declined" } },
      {
        ...single,
        id: "mirror",
        singleValueExtendedProperties: [{ id: MARKER_PROPERTY_ID, value: "x" }],
      },
    ]);
    expect(await desiredBlocks(RULE, events, options())).toEqual([]);
  });

  it("does not put source IDs into markers", async () => {
    const blocks = await desiredBlocks(RULE, sourceEvents(), options());
    expect(blocks.every((block) => /^[0-9a-f]{32}$/.test(block.marker))).toBe(true);
  });
});

describe("hashes", () => {
  async function sha256Prefix(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  it("are the first 16 bytes of SHA-256, on a repeated run and for long contents", async () => {
    const [event] = sourceEvents(bySubject("FBS single"));
    const long = { ...event!, body: "x".repeat(1000) };
    for (const source of [event!, long]) {
      const first = await desiredBlocks(RULE, [source], options({ detailLevel: "full" }));
      const again = await desiredBlocks(RULE, [source], options({ detailLevel: "full" }));
      expect(again).toEqual(first);
      const { marker, contentHash, dedupKey, ...content } = first[0]!;
      expect(contentHash).toBe(await sha256Prefix(JSON.stringify(content)));
      expect(marker).toBe(await sha256Prefix(`${RULE}\u0000${source.occurrenceKey}`));
      expect(dedupKey).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe("planSync", () => {
  it("creates every block on the first run", async () => {
    const plan = planSync(await desiredBlocks(RULE, sourceEvents(), options()), []);
    expect(plan.stats).toEqual({ create: 15, update: 0, delete: 0, unchanged: 0 });
  });

  it("does nothing when the target already matches", async () => {
    const desired = await desiredBlocks(RULE, sourceEvents(), options());
    const plan = planSync(desired, asExisting(desired));
    expect(plan.actions).toEqual([]);
    expect(plan.stats.unchanged).toBe(15);
  });

  it("moves the block of a moved occurrence instead of deleting and recreating it", async () => {
    const before = await desiredBlocks(RULE, sourceEvents(beforeMove()), options());
    const after = await desiredBlocks(RULE, sourceEvents(), options());
    const plan = planSync(after, asExisting(before));
    expect(plan.stats).toEqual({ create: 0, update: 1, delete: 0, unchanged: 14 });
    const [action] = plan.actions;
    expect(action?.kind === "update" && action.block.start).toBe("2026-11-17T10:00:00.000Z");
  });

  it("deletes the block of a cancelled occurrence", async () => {
    const before = await desiredBlocks(RULE, sourceEvents(beforeCancel()), options());
    const after = await desiredBlocks(RULE, sourceEvents(), options());
    const plan = planSync(after, asExisting(before));
    expect(plan.stats).toEqual({ create: 0, update: 0, delete: 1, unchanged: 15 });
  });

  it("ignores a renamed occurrence at level busy and updates it at level title", async () => {
    const renamed = fixture.value.map((event) =>
      event.subject === "FBS weekly series (changed)"
        ? { ...event, subject: "Renamed again" }
        : event,
    );
    for (const [detailLevel, updates] of [
      ["busy", 0],
      ["title", 1],
    ] as const) {
      const before = await desiredBlocks(RULE, sourceEvents(), options({ detailLevel }));
      const after = await desiredBlocks(RULE, sourceEvents(renamed), options({ detailLevel }));
      expect(planSync(after, asExisting(before)).stats.update).toBe(updates);
    }
  });

  it("removes duplicate blocks of one occurrence and keeps one", async () => {
    const desired = await desiredBlocks(RULE, sourceEvents(), options());
    const [first] = desired;
    if (!first) throw new Error("no block");
    const existing = [...asExisting(desired), { ...first, ruleTag: "tag", targetId: "duplicate" }];
    const plan = planSync(desired, existing);
    expect(plan.actions).toEqual([{ kind: "delete", targetId: "duplicate", marker: first.marker }]);
  });

  it("leaves out events whose block a rule with precedence already wrote", async () => {
    const events = sourceEvents();
    const kept = await desiredBlocks("rule-a", events, options(), { scope: "user" });
    const [claimed] = kept;
    if (!claimed) throw new Error("no block");
    const copies = await desiredBlocks("rule-b", events, options(), {
      scope: "user",
      claimed: claimsFrom([claimed]),
    });
    expect(copies).toHaveLength(kept.length - 1);
    expect(copies.some((block) => block.dedupKey === claimed.dedupKey)).toBe(false);
  });

  it("gives equal blocks equal dedup keys, per user", async () => {
    const events = sourceEvents(bySubject("FBS single"));
    const [a] = await desiredBlocks("rule-a", events, options(), { scope: "user" });
    const [b] = await desiredBlocks("rule-b", events, options(), { scope: "user" });
    const [other] = await desiredBlocks("rule-a", events, options(), { scope: "other-user" });
    const [titled] = await desiredBlocks("rule-a", events, options({ detailLevel: "title" }), {
      scope: "user",
    });
    expect(a?.dedupKey).toBe(b?.dedupKey);
    expect(other?.dedupKey).not.toBe(a?.dedupKey);
    // "Busy" and the title look different, so both blocks stay.
    expect(titled?.dedupKey).not.toBe(a?.dedupKey);
  });

  it("never lets a tentative or an open block stand in for a busy or a private one", async () => {
    const [event] = sourceEvents(bySubject("FBS single"));
    if (!event) throw new Error("no event");
    const key = async (changes: Partial<SourceEvent>, overrides: Partial<RuleOptions> = {}) => {
      const [block] = await desiredBlocks(RULE, [{ ...event, ...changes }], options(overrides), {
        scope: "user",
      });
      return block?.dedupKey;
    };
    const busy = await key({ showAs: "busy" }, { skipTentative: false });
    expect(await key({ showAs: "tentative" }, { skipTentative: false })).not.toBe(busy);
    expect(await key({ showAs: "busy" }, { markPrivate: false })).not.toBe(busy);
  });

  it("updates a block without a dedup key, so that it gets one", async () => {
    const desired = await desiredBlocks(RULE, sourceEvents(), options());
    const existing = asExisting(desired).map((block) => ({ ...block, dedupKey: "" }));
    expect(planSync(desired, existing).stats).toMatchObject({ update: desired.length });
  });

  it("gives each rule its own markers, so two rules into one calendar do not collide", async () => {
    const events = sourceEvents(bySubject("FBS single"));
    const [a] = await desiredBlocks("rule-a", events, options());
    const [b] = await desiredBlocks("rule-b", events, options());
    expect(a?.marker).not.toBe(b?.marker);
  });
});

describe("legacy marker", () => {
  it("recognises blocks from before the rename, and prefers the current marker", () => {
    expect(graphMarkerValue([{ id: LEGACY_MARKER_PROPERTY_ID, value: "old" }])).toBe("old");
    expect(
      graphMarkerValue([
        { id: LEGACY_MARKER_PROPERTY_ID, value: "old" },
        { id: MARKER_PROPERTY_ID, value: "new" },
      ]),
    ).toBe("new");
    expect(graphMarkerValue([])).toBeUndefined();

    const event = (privateProperties: Record<string, string>) => ({
      id: "e",
      start: { dateTime: "2026-10-26T10:00:00Z" },
      end: { dateTime: "2026-10-26T11:00:00Z" },
      extendedProperties: { private: privateProperties },
    });
    const value = "aaaaaaaaaaaa.0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef";
    expect(googleMarker(event({ [LEGACY_GOOGLE_MARKER_KEY]: value }))?.ruleTag).toBe(
      "aaaaaaaaaaaa",
    );
  });
});

describe("category filter", () => {
  it("skips events with a listed Outlook category or Google colour, ignoring case", () => {
    const options = ruleOptionsSchema.parse({ skipCategories: ["privat", "color:11"] });
    const event = (categories: string[]) =>
      ({
        occurrenceKey: "event:x",
        start: "2026-10-26T10:00:00.000Z",
        end: "2026-10-26T11:00:00.000Z",
        allDay: false,
        showAs: "busy",
        isPrivate: false,
        declined: false,
        categories,
        subject: "x",
        location: "",
        body: "",
        isMirror: false,
      }) satisfies SourceEvent;
    expect(isIncluded(event(["Privat"]), options)).toBe(false);
    expect(isIncluded(event(["color:11"]), options)).toBe(false);
    expect(isIncluded(event(["Arbeit"]), options)).toBe(true);
    expect(isIncluded(event([]), options)).toBe(true);
  });
});

describe("buffer", () => {
  const timed: SourceEvent = {
    occurrenceKey: "event:buffer",
    start: "2026-10-27T10:00:00.000Z",
    end: "2026-10-27T11:00:00.000Z",
    allDay: false,
    showAs: "busy",
    isPrivate: false,
    declined: false,
    categories: [],
    subject: "Visit",
    location: "",
    body: "",
    isMirror: false,
  };

  async function blockOf(event: SourceEvent, overrides: Partial<RuleOptions>, rule = RULE) {
    const [block] = await desiredBlocks(rule, [event], options(overrides), { scope: "user" });
    if (!block) throw new Error("no block");
    return block;
  }

  it("starts the block earlier by bufferBefore", async () => {
    const block = await blockOf(timed, { bufferBefore: 30 });
    expect(block).toMatchObject({
      start: "2026-10-27T09:30:00.000Z",
      end: "2026-10-27T11:00:00.000Z",
    });
  });

  it("ends the block later by bufferAfter", async () => {
    const block = await blockOf(timed, { bufferAfter: 45 });
    expect(block).toMatchObject({
      start: "2026-10-27T10:00:00.000Z",
      end: "2026-10-27T11:45:00.000Z",
    });
  });

  it("applies both buffers, across midnight", async () => {
    const late = { ...timed, start: "2026-10-27T23:30:00.000Z", end: "2026-10-27T23:50:00.000Z" };
    const block = await blockOf(late, { bufferBefore: 240, bufferAfter: 15 });
    expect(block).toMatchObject({
      start: "2026-10-27T19:30:00.000Z",
      end: "2026-10-28T00:05:00.000Z",
    });
  });

  it("never widens an all-day block", async () => {
    const allDay = { ...timed, allDay: true, start: "2026-10-27", end: "2026-10-28" };
    const overrides = { skipAllDay: false, bufferBefore: 60, bufferAfter: 60 };
    const block = await blockOf(allDay, overrides);
    expect(block).toMatchObject({ allDay: true, start: "2026-10-27", end: "2026-10-28" });
    expect(block.contentHash).toBe((await blockOf(allDay, { skipAllDay: false })).contentHash);
  });

  it("keeps the blocks of rules without a buffer exactly as before", async () => {
    const block = await blockOf(timed, {});
    expect(await blockOf(timed, { bufferBefore: 0, bufferAfter: 0 })).toEqual(block);
    // Hash and dedup key as computed before buffers existed: no rule rewrites its blocks.
    expect(block.contentHash).toBe("e2017962879850ddec59cee5aabb4f7e");
    expect(block.dedupKey).toBe("74cbc6995f91445218fc104bd5fb7fbb");
  });

  it("keeps the marker of the occurrence, so a changed buffer updates the block", async () => {
    const plain = await blockOf(timed, {});
    const buffered = await blockOf(timed, { bufferBefore: 15, bufferAfter: 15 });
    expect(buffered.marker).toBe(plain.marker);
    const plan = planSync([buffered], asExisting([plain]));
    expect(plan.stats).toEqual({ create: 0, update: 1, delete: 0, unchanged: 0 });
  });

  it("plans no change on the second run with an unchanged event", async () => {
    const overrides = { bufferBefore: 20, bufferAfter: 10 };
    const first = await desiredBlocks(RULE, sourceEvents(), options(overrides));
    const created = planSync(first, []);
    expect(created.stats.create).toBe(15);
    // The target returns the times in its own notation; the plan compares instants.
    const stored = asExisting(first).map((block) => ({
      ...block,
      start: block.start.replace(".000Z", "Z"),
      end: block.end.replace(".000Z", "Z"),
    }));
    const second = await desiredBlocks(RULE, sourceEvents(), options(overrides));
    expect(planSync(second, stored)).toEqual({
      actions: [],
      stats: { create: 0, update: 0, delete: 0, unchanged: 15 },
    });
  });

  it("writes one block per event where buffered blocks overlap, and keeps them stable", async () => {
    const next = {
      ...timed,
      occurrenceKey: "event:next",
      start: "2026-10-27T11:00:00.000Z",
      end: "2026-10-27T12:00:00.000Z",
    };
    const overrides = { bufferBefore: 30, bufferAfter: 30 };
    const blocks = await desiredBlocks(RULE, [timed, next], options(overrides));
    expect(blocks.map((block) => [block.start, block.end])).toEqual([
      ["2026-10-27T09:30:00.000Z", "2026-10-27T11:30:00.000Z"],
      ["2026-10-27T10:30:00.000Z", "2026-10-27T12:30:00.000Z"],
    ]);
    const again = await desiredBlocks(RULE, [timed, next], options(overrides));
    expect(planSync(again, asExisting(blocks)).actions).toEqual([]);
  });

  it("builds the dedup key from the event's times, so a buffer does not change it", async () => {
    const none = await blockOf(timed, {}, "rule-a");
    const before = await blockOf(timed, { bufferBefore: 15 }, "rule-b");
    const both = await blockOf(timed, { bufferBefore: 30, bufferAfter: 30 }, "rule-b");
    expect(before.dedupKey).toBe(none.dedupKey);
    expect(both.dedupKey).toBe(none.dedupKey);
    // A different event at the times of the buffered block is still a different block.
    const wide = { ...timed, start: before.start };
    expect((await blockOf(wide, {}, "rule-b")).dedupKey).not.toBe(none.dedupKey);
  });

  it("leaves out an event that a block with precedence covers, buffers included", async () => {
    const write = async (claimer: Partial<RuleOptions>, own: Partial<RuleOptions>) => {
      const claimed = claimsFrom([await blockOf(timed, claimer, "rule-a")]);
      return desiredBlocks("rule-b", [timed], options(own), { scope: "user", claimed });
    };
    // The block with precedence is as wide or wider: one block, the meeting is not doubled.
    expect(await write({ bufferBefore: 30 }, { bufferBefore: 15 })).toEqual([]);
    expect(await write({ bufferBefore: 15 }, { bufferBefore: 15 })).toEqual([]);
    expect(await write({ bufferAfter: 10 }, {})).toEqual([]);
    // It is narrower: the rule writes its own block, so its buffer is not lost.
    const [own] = await write({ bufferBefore: 15 }, { bufferBefore: 30 });
    expect(own).toMatchObject({ start: "2026-10-27T09:30:00.000Z" });
    expect(await write({}, { bufferAfter: 5 })).toHaveLength(1);
  });
});

describe("planSync in a sync window", () => {
  // The sync window starts at 00:00 UTC; the read window adds the largest buffer on each side.
  const sync = {
    start: new Date("2026-10-27T00:00:00.000Z"),
    end: new Date("2026-11-26T00:00:00.000Z"),
  };
  const windows = {
    sync,
    target: {
      start: new Date("2026-10-26T00:00:00.000Z"),
      end: new Date("2026-11-27T00:00:00.000Z"),
    },
    read: {
      start: new Date("2026-10-26T20:00:00.000Z"),
      end: new Date("2026-11-26T04:00:00.000Z"),
    },
  };
  const event = (key: string, start: string, end: string, changes: Partial<SourceEvent> = {}) =>
    ({
      occurrenceKey: key,
      start,
      end,
      allDay: start.length === 10,
      showAs: "busy",
      isPrivate: false,
      declined: false,
      categories: [],
      subject: "Trip",
      location: "",
      body: "",
      isMirror: false,
      ...changes,
    }) satisfies SourceEvent;
  const vacation = event("event:vacation", "2026-10-26", "2026-11-02");
  const night = event("event:night", "2026-10-26T23:00:00.000Z", "2026-10-27T01:00:00.000Z");
  const evening = event("event:evening", "2026-10-26T21:00:00.000Z", "2026-10-26T22:00:00.000Z");

  it("deletes the block of a deleted all-day event that started yesterday", async () => {
    const written = await desiredBlocks(RULE, [vacation], options({ skipAllDay: false }));
    const plan = planSync([], asExisting(written), windows);
    expect(plan.stats).toEqual({ create: 0, update: 0, delete: 1, unchanged: 0 });
  });

  it("deletes the block of a running event that a filter now leaves out", async () => {
    const trip = event("event:trip", "2026-10-26T08:00:00.000Z", "2026-10-29T18:00:00.000Z");
    const titled = options({ detailLevel: "title", skipTentative: true });
    const written = await desiredBlocks(RULE, [trip], titled);
    expect(written[0]?.subject).toBe("Trip");
    const now = await desiredBlocks(RULE, [{ ...trip, showAs: "tentative" }], titled);
    expect(planSync(now, asExisting(written), windows).stats.delete).toBe(1);
  });

  it("deletes the block of a cancelled event across midnight", async () => {
    const written = await desiredBlocks(RULE, [night], options());
    expect(planSync([], asExisting(written), windows).stats.delete).toBe(1);
  });

  it("writes no block for an event that only the margin of the read returns", async () => {
    // The event ends at 22:00; its block with 30 minutes after it ends before the window.
    const desired = await desiredBlocks(RULE, [evening], options({ bufferAfter: 30 }));
    expect(planSync(desired, [], windows).actions).toEqual([]);
    // With 150 minutes after it, the block reaches into the window and is written.
    const reaching = await desiredBlocks(RULE, [evening], options({ bufferAfter: 150 }));
    expect(planSync(reaching, [], windows).stats.create).toBe(1);
    // A block from before the window stays untouched, as on a day the window has passed.
    const old = await desiredBlocks(RULE, [evening], options());
    const changed = await desiredBlocks(RULE, [{ ...evening, subject: "Other" }], options());
    expect(planSync(changed, asExisting(old), windows).actions).toEqual([]);
  });

  it("moves a block with its event when the buffer goes down", async () => {
    const before = await desiredBlocks(RULE, [evening], options({ bufferAfter: 240 }));
    const after = await desiredBlocks(RULE, [evening], options());
    const plan = planSync(after, asExisting(before), windows);
    expect(plan.stats).toEqual({ create: 0, update: 1, delete: 0, unchanged: 0 });
  });

  it("leaves out a block that only touches the read window", async () => {
    const zero = event("event:zero", "2026-10-26T20:00:00.000Z", "2026-10-26T20:00:00.000Z");
    const desired = await desiredBlocks(RULE, [zero], options({ bufferBefore: 30 }));
    expect(planSync(desired, [], windows).actions).toEqual([]);
  });

  // Google answers all-day events in the calendar's zone, so the times of the window do not
  // decide; the plan writes and keeps every all-day block the read returns.
  it("keeps and writes the all-day block of the local day west of UTC (UTC-4)", async () => {
    // 01:00 UTC on 27 October is 21:00 on 26 October in UTC-4.
    const today = event("event:local-today", "2026-10-26", "2026-10-27");
    const added = event("event:local-added", "2026-10-26", "2026-10-27");
    const all = options({ skipAllDay: false });
    const written = await desiredBlocks(RULE, [today], all);
    const plan = planSync(
      await desiredBlocks(RULE, [today, added], all),
      asExisting(written),
      windows,
    );
    expect(plan.stats).toEqual({ create: 1, update: 0, delete: 0, unchanged: 1 });
  });

  it("writes the all-day block of the local day east of UTC (UTC+10)", async () => {
    // 15:00 UTC on 26 October is 01:00 on 27 October in UTC+10; the sync window starts on 26.
    const east = {
      sync: { start: new Date("2026-10-26T00:00:00.000Z"), end: sync.end },
      target: { start: new Date("2026-10-25T00:00:00.000Z"), end: windows.target.end },
      read: { start: new Date("2026-10-25T20:00:00.000Z"), end: windows.read.end },
    };
    const all = options({ skipAllDay: false });
    const events = [
      event("event:local-yesterday", "2026-10-26", "2026-10-27"),
      event("event:local-today", "2026-10-27", "2026-10-28"),
    ];
    const plan = planSync(await desiredBlocks(RULE, events, all), [], east);
    expect(plan.stats).toEqual({ create: 2, update: 0, delete: 0, unchanged: 0 });
  });
});
