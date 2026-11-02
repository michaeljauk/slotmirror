import type { CalendarEntry } from "./scenario.ts";
import { localMidnight } from "./time.ts";

/**
 * Coverage as a union of intervals. This file is the oracle of the suite. It reads what the
 * calendar shows and imports nothing from the tool under test, so that it cannot share a fault
 * with the tool.
 */

/** Start and end in milliseconds. The end is exclusive. */
export type Interval = readonly [number, number];

/** The sorted union of intervals. Touching intervals merge. Empty intervals drop out. */
export function union(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** The parts of `from` that `remove` does not cover. Both lists must be unions. */
export function subtract(from: readonly Interval[], remove: readonly Interval[]): Interval[] {
  const left: Interval[] = [];
  for (const [start, end] of from) {
    let cursor = start;
    for (const [removeStart, removeEnd] of remove) {
      if (removeEnd <= cursor) continue;
      if (removeStart >= end) break;
      if (removeStart > cursor) left.push([cursor, removeStart]);
      cursor = Math.max(cursor, removeEnd);
    }
    if (cursor < end) left.push([cursor, end]);
  }
  return left;
}

export function clip(intervals: readonly Interval[], window: Interval): Interval[] {
  return intervals
    .map(([start, end]): Interval => [Math.max(start, window[0]), Math.min(end, window[1])])
    .filter(([start, end]) => end > start);
}

/** The time an entry takes. An all-day entry runs from midnight to midnight in the zone. */
export function entryInterval(entry: CalendarEntry, zone: string): Interval {
  if (entry.allDay) {
    return [
      localMidnight(entry.start.slice(0, 10), zone),
      localMidnight(entry.end.slice(0, 10), zone),
    ];
  }
  return [Date.parse(entry.start), Date.parse(entry.end)];
}

export interface ResolvedExpectation {
  window: Interval;
  /** Instants. Null if the expectation does not check coverage. */
  busy: Interval[] | null;
  noDuplicates: boolean;
  forbidden: string[];
  required: string[];
  minEntries: number;
  /** Zone of the calendar that the check reads. */
  zone: string;
}

/**
 * The faults of a target state that `clip` would hide. Busy time outside the window would drop out,
 * and that part of the target state would stay unchecked.
 */
export function expectationFaults(window: Interval, busy: readonly Interval[] | null): string[] {
  const time = ([start, end]: Interval) =>
    `${new Date(start).toISOString()} to ${new Date(end).toISOString()}`;
  if (window[0] >= window[1]) return [`the window ends before it starts: ${time(window)}`];
  return (busy ?? []).flatMap((interval) => {
    if (interval[0] >= interval[1]) return [`busy time ends before it starts: ${time(interval)}`];
    if (interval[0] >= window[0] && interval[1] <= window[1]) return [];
    return [`busy time lies outside the window: ${time(interval)}`];
  });
}

export interface Evaluation {
  pass: boolean;
  observedBusy: Interval[];
  /** Time that must be busy and is free. */
  missing: Interval[];
  /** Time that must be free and is busy. */
  extra: Interval[];
  duplicates: Interval[];
  /** Forbidden texts that an entry holds. */
  leaks: string[];
  /** Required texts that no entry holds. */
  absent: string[];
  entries: number;
}

/**
 * Refuse an entry that the oracle cannot read. A time that is no time would drop out of the union,
 * and a status that is neither busy nor free would count as free: both would read as free time.
 */
function assertReadable(entry: CalendarEntry, zone: string): void {
  if (entry.status !== "busy" && entry.status !== "free") {
    throw new Error(`An entry has the unknown status ${String(entry.status)}`);
  }
  const [start, end] = entry.allDay
    ? [Date.parse(entry.start.slice(0, 10)), Date.parse(entry.end.slice(0, 10))]
    : entryInterval(entry, zone);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`An entry has an invalid time: ${entry.start} to ${entry.end}`);
  }
}

/** Compare what a calendar shows with the hand-written target state. */
export function evaluate(
  expectation: ResolvedExpectation,
  entries: readonly CalendarEntry[],
): Evaluation {
  const { window, zone } = expectation;
  const [fault] = expectationFaults(window, expectation.busy);
  if (fault) throw new Error(`The target state is wrong: ${fault}`);
  for (const entry of entries) assertReadable(entry, zone);
  const inWindow = entries.filter((entry) => {
    const [start, end] = entryInterval(entry, zone);
    return end > window[0] && start < window[1];
  });
  const busyEntries = inWindow.filter((entry) => entry.status === "busy");
  const intervals = busyEntries.map((entry) => entryInterval(entry, zone));
  const observedBusy = union(clip(intervals, window));
  const expected = expectation.busy === null ? null : union(clip(expectation.busy, window));
  const missing = expected ? subtract(expected, observedBusy) : [];
  const extra = expected ? subtract(observedBusy, expected) : [];
  const duplicates = expectation.noDuplicates ? sameTimes(intervals) : [];
  const text = inWindow.map((entry) => JSON.stringify(entry).toLowerCase());
  const leaks = expectation.forbidden.filter((value) =>
    text.some((field) => field.includes(value.toLowerCase())),
  );
  const absent = expectation.required.filter(
    (value) => !text.some((field) => field.includes(value.toLowerCase())),
  );
  return {
    pass:
      missing.length === 0 &&
      extra.length === 0 &&
      duplicates.length === 0 &&
      leaks.length === 0 &&
      absent.length === 0 &&
      inWindow.length >= expectation.minEntries,
    observedBusy,
    missing,
    extra,
    duplicates,
    leaks,
    absent,
    entries: inWindow.length,
  };
}

function sameTimes(intervals: readonly Interval[]): Interval[] {
  const seen = new Set<string>();
  const repeated = new Map<string, Interval>();
  for (const interval of intervals) {
    const key = interval.join("/");
    if (seen.has(key)) repeated.set(key, interval);
    seen.add(key);
  }
  return [...repeated.values()];
}
