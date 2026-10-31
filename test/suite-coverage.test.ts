import { describe, expect, it } from "vitest";
import { clip, evaluate, subtract, union, type ResolvedExpectation } from "../suite/lib/coverage";
import type { CalendarEntry } from "../suite/lib/scenario";

const HOUR = 3_600_000;
const BASE = Date.parse("2031-02-11T00:00:00Z");

function at(hours: number): number {
  return BASE + hours * HOUR;
}

function timed(from: number, to: number, status: "busy" | "free" = "busy"): CalendarEntry {
  return {
    start: new Date(at(from)).toISOString(),
    end: new Date(at(to)).toISOString(),
    allDay: false,
    status,
  };
}

const EXPECTATION: ResolvedExpectation = {
  window: [at(0), at(24)],
  busy: [[at(10), at(12)]],
  noDuplicates: false,
  forbidden: [],
  required: [],
  minEntries: 0,
  zone: "UTC",
};

describe("intervals", () => {
  it("merges overlapping and touching intervals and drops empty ones", () => {
    expect(
      union([
        [5, 7],
        [1, 3],
        [3, 4],
        [6, 9],
        [10, 10],
      ]),
    ).toEqual([
      [1, 4],
      [5, 9],
    ]);
  });

  it("subtracts holes from the middle and from both ends", () => {
    expect(
      subtract(
        [[0, 10]],
        [
          [-2, 1],
          [4, 5],
          [9, 12],
        ],
      ),
    ).toEqual([
      [1, 4],
      [5, 9],
    ]);
  });

  it("clips to the window and drops what lies outside", () => {
    expect(
      clip(
        [
          [0, 5],
          [8, 9],
          [20, 30],
        ],
        [4, 21],
      ),
    ).toEqual([
      [4, 5],
      [8, 9],
      [20, 21],
    ]);
  });
});

describe("evaluate", () => {
  it("accepts one merged block and two blocks for the same coverage", () => {
    expect(evaluate(EXPECTATION, [timed(10, 12)]).pass).toBe(true);
    expect(evaluate(EXPECTATION, [timed(10, 11), timed(11, 12)]).pass).toBe(true);
    expect(evaluate(EXPECTATION, [timed(10, 11.5), timed(11, 12)]).pass).toBe(true);
  });

  it("names the time that is missing and the time that is too much", () => {
    const result = evaluate(EXPECTATION, [timed(10, 11), timed(13, 14)]);
    expect(result.pass).toBe(false);
    expect(result.missing).toEqual([[at(11), at(12)]]);
    expect(result.extra).toEqual([[at(13), at(14)]]);
  });

  it("finds a shift of one minute", () => {
    const shifted = { ...timed(10, 12), end: new Date(at(12) + 60_000).toISOString() };
    expect(evaluate(EXPECTATION, [shifted]).extra).toEqual([[at(12), at(12) + 60_000]]);
  });

  it("does not count a free entry as busy", () => {
    expect(evaluate(EXPECTATION, [timed(10, 12), timed(14, 15, "free")]).pass).toBe(true);
    expect(evaluate(EXPECTATION, [timed(10, 12, "free")]).pass).toBe(false);
  });

  it("ignores what lies outside the window", () => {
    expect(evaluate(EXPECTATION, [timed(10, 12), timed(30, 31)]).pass).toBe(true);
  });

  it("refuses a window that ends before it starts", () => {
    const expectation = { ...EXPECTATION, window: [at(24), at(0)] as const };
    expect(() => evaluate(expectation, [timed(10, 12)])).toThrow("window");
  });

  it("refuses busy time that the window would cut off, so that no part stays unchecked", () => {
    for (const busy of [
      [at(30), at(31)],
      [at(23), at(25)],
      [at(-1), at(1)],
    ] as const) {
      const expectation = { ...EXPECTATION, busy: [busy] };
      expect(() => evaluate(expectation, [])).toThrow("outside the window");
    }
  });

  it("refuses busy time that ends before it starts", () => {
    const expectation = { ...EXPECTATION, busy: [[at(12), at(10)] as const] };
    expect(() => evaluate(expectation, [])).toThrow("ends before it starts");
  });

  it("reads an all-day entry at the midnights of the zone of the calendar", () => {
    const expectation = {
      ...EXPECTATION,
      zone: "Asia/Tokyo",
      window: [at(-24), at(48)] as const,
      busy: [[at(-9), at(15)] as const],
    };
    const entry = { start: "2031-02-11", end: "2031-02-12", allDay: true, status: "busy" as const };
    expect(evaluate(expectation, [entry]).pass).toBe(true);
    expect(evaluate({ ...expectation, zone: "UTC" }, [entry]).pass).toBe(false);
  });

  it("fails duplicates only if the expectation asks for it", () => {
    const entries = [timed(10, 12), timed(10, 12)];
    expect(evaluate(EXPECTATION, entries).pass).toBe(true);
    const result = evaluate({ ...EXPECTATION, noDuplicates: true }, entries);
    expect(result.duplicates).toEqual([[at(10), at(12)]]);
  });

  it("finds forbidden text in any field and without regard to case", () => {
    const entry = { ...timed(10, 12), attendees: ["Secret@Example.invalid"] };
    const result = evaluate({ ...EXPECTATION, forbidden: ["secret@example.invalid"] }, [entry]);
    expect(result.leaks).toEqual(["secret@example.invalid"]);
    expect(result.pass).toBe(false);
  });

  it("fails if no entry holds a required text", () => {
    const entry = { ...timed(10, 12), title: "Open Title" };
    const expectation = { ...EXPECTATION, required: ["open title"] };
    expect(evaluate(expectation, [entry]).pass).toBe(true);
    const result = evaluate(expectation, [timed(10, 12)]);
    expect(result).toMatchObject({ pass: false, absent: ["open title"] });
  });

  it("refuses an entry with a time that is no time", () => {
    const entry = { ...timed(10, 12), end: "soon" };
    expect(() => evaluate(EXPECTATION, [timed(10, 12), entry])).toThrow("invalid time");
    const allDay = {
      start: "2031-13-41",
      end: "2031-02-12",
      allDay: true,
      status: "busy" as const,
    };
    expect(() => evaluate(EXPECTATION, [allDay])).toThrow("invalid time");
  });

  it("refuses an entry with an unknown status", () => {
    const entry = { ...timed(10, 12), status: "tentative" } as unknown as CalendarEntry;
    expect(() => evaluate(EXPECTATION, [timed(10, 12), entry])).toThrow("unknown status");
  });

  it("does not let a data check pass on an empty calendar", () => {
    const expectation = { ...EXPECTATION, busy: null, forbidden: ["x"], minEntries: 1 };
    expect(evaluate(expectation, []).pass).toBe(false);
    expect(evaluate(expectation, [timed(3, 4)]).pass).toBe(true);
  });
});
