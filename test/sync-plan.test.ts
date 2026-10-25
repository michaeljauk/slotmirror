import { describe, expect, it } from "vitest";
import { ruleOptionsSchema, type RuleOptions } from "../src/config";
import { fromGraphEvent, MARKER_PROPERTY_ID } from "../src/sync/graph-events";
import { desiredBlocks, planSync } from "../src/sync/plan";
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

  it("recognises blocks written by freebusy-sync", () => {
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

  it("gives each rule its own markers, so two rules into one calendar do not collide", async () => {
    const events = sourceEvents(bySubject("FBS single"));
    const [a] = await desiredBlocks("rule-a", events, options());
    const [b] = await desiredBlocks("rule-b", events, options());
    expect(a?.marker).not.toBe(b?.marker);
  });
});
