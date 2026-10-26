import type { RuleOptions } from "../config";
import type { SourceEvent } from "./types";

/** ISO weekdays, Monday 1 to Sunday 7. With all seven the weekday filter is off. */
export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** A time of day as "HH:MM", 00:00 to 23:59. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The end of a range: a time of day, or "24:00" for the end of the day. */
export const END_OF_DAY = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

type WorkingHours = Pick<RuleOptions, "workDays" | "workStart" | "workEnd" | "workTimeZone">;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Formatters of known zones, least recently used first. Unknown names are never cached. */
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTERS = 16;

/** A formatter for a zone, or null if Intl does not know the zone. */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(zone);
  if (cached) {
    formatters.delete(zone);
    formatters.set(zone, cached);
    return cached;
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return null;
  }
  if (formatters.size >= MAX_FORMATTERS) {
    const oldest = formatters.keys().next().value;
    if (oldest !== undefined) formatters.delete(oldest);
  }
  formatters.set(zone, formatter);
  return formatter;
}

/** True if Intl knows the time zone, for example "Europe/Vienna", "europe/vienna" or "UTC". */
export function isTimeZone(zone: string): boolean {
  return zone.trim() === zone && zone !== "" && zone.length <= 64 && formatterFor(zone) !== null;
}

/**
 * The canonical name of a known time zone, as Intl resolves it: "Europe/Vienna" for
 * "europe/vienna", "America/New_York" for "US/Eastern". `Intl.supportedValuesOf` is not used: it
 * lists neither "UTC" nor aliases, so it would refuse names that Intl accepts.
 */
export function canonicalTimeZone(zone: string): string {
  return formatterFor(zone)?.resolvedOptions().timeZone ?? zone;
}

/** The field that makes working hours invalid, or null. Same rules as the options schema. */
export type WorkingHoursProblem = "days" | "time" | "order" | "zone";

export function workingHoursProblem(hours: {
  workDays: readonly number[];
  workStart: string;
  workEnd: string;
  workTimeZone: string;
}): WorkingHoursProblem | null {
  const { workDays, workStart, workEnd, workTimeZone } = hours;
  const validDays = workDays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  if (workDays.length === 0 || !validDays || new Set(workDays).size !== workDays.length) {
    return "days";
  }
  if ((workStart === "") !== (workEnd === "")) return "time";
  if (workStart !== "" && (!TIME_OF_DAY.test(workStart) || !END_OF_DAY.test(workEnd))) {
    return "time";
  }
  if (workStart !== "" && workEnd <= workStart) return "order";
  if (workTimeZone !== "" && !isTimeZone(workTimeZone)) return "zone";
  return null;
}

/** True if the rule filters by weekday or time of day. The defaults filter nothing. */
export function hasWorkingHours(options: WorkingHours): boolean {
  return options.workDays.length < ALL_WEEKDAYS.length || options.workStart !== "";
}

/**
 * Decide whether an event falls into the rule's working hours. An event counts if it overlaps the
 * window on any chosen weekday; the block is never clipped to the window. An all-day event counts
 * if one of its dates is a chosen weekday. Times are read in `workTimeZone`, or UTC without one.
 */
export function inWorkingHours(event: SourceEvent, options: WorkingHours): boolean {
  if (!hasWorkingHours(options)) return true;
  const days = new Set(options.workDays);
  if (event.allDay) return allDayInWorkingHours(event, days);

  const start = Date.parse(event.start);
  const parsedEnd = Date.parse(event.end);
  // Times the filter cannot read are mirrored, as without the filter.
  if (Number.isNaN(start) || Number.isNaN(parsedEnd)) return true;
  // An event without duration counts as one millisecond, so that it is a point in the window.
  const end = parsedEnd > start ? parsedEnd : start + 1;
  const zone = options.workTimeZone || "UTC";
  const window = options.workStart
    ? { start: minutesOf(options.workStart), end: minutesOf(options.workEnd) }
    : null;

  let day = localDate(zone, start);
  const last = localDate(zone, end - 1);
  // After the first day, eight days hold each weekday once in full, so the loop can stop there.
  for (let count = 0; day <= last && count < 9; count++, day += DAY_MS) {
    if (!days.has(isoWeekday(day))) continue;
    if (!window) return true;
    const windowStart = localInstant(zone, day, window.start);
    const windowEnd = localInstant(zone, day, window.end);
    if (start < windowEnd && end > windowStart) return true;
  }
  return false;
}

/** All-day events carry dates without a zone; the end date is exclusive. */
function allDayInWorkingHours(event: SourceEvent, days: ReadonlySet<number>): boolean {
  const first = Date.parse(`${event.start.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${event.end.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(first)) return true;
  const last = Number.isNaN(end) || end <= first ? first : end - DAY_MS;
  for (let day = first, count = 0; day <= last && count < 7; day += DAY_MS, count++) {
    if (days.has(isoWeekday(day))) return true;
  }
  return false;
}

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** ISO weekday of a date given as UTC midnight. */
function isoWeekday(day: number): number {
  return new Date(day).getUTCDay() || 7;
}

/** The offset of a zone at an instant, in milliseconds, read from Intl. One Intl call. */
function intlOffset(zone: string, instant: number): number {
  const formatter = formatterFor(zone);
  if (!formatter) return 0;
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wallClock = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return wallClock - instant;
}

/**
 * Offsets of a zone in one UTC week: `before` until the instant `change`, `after` from then on.
 * Without a change in the week, `change` is Infinity. A week holds at most one change; no zone
 * changes its offset twice within seven days.
 */
interface WeekOffsets {
  before: number;
  after: number;
  change: number;
}

/**
 * Offsets per zone, cached per isolate: by boundary instant and by week number. A run then needs
 * about one Intl call per week and a few per change, not several per event.
 */
const boundaryOffsets = new Map<string, Map<number, number>>();
const weekOffsets = new Map<string, Map<number, WeekOffsets>>();
const MAX_CACHED_PER_ZONE = 2_000;

/** The cache of one zone. A full cache starts again, so that memory stays bounded. */
function cacheOf<T>(caches: Map<string, Map<number, T>>, zone: string): Map<number, T> {
  let cache = caches.get(zone);
  if (!cache || cache.size >= MAX_CACHED_PER_ZONE) {
    if (!cache && caches.size >= MAX_FORMATTERS) caches.clear();
    cache = new Map();
    caches.set(zone, cache);
  }
  return cache;
}

function boundaryOffset(zone: string, instant: number): number {
  const cache = cacheOf(boundaryOffsets, zone);
  let offset = cache.get(instant);
  if (offset === undefined) {
    offset = intlOffset(zone, instant);
    cache.set(instant, offset);
  }
  return offset;
}

function offsetsOfWeek(zone: string, week: number): WeekOffsets {
  const cache = cacheOf(weekOffsets, zone);
  const cached = cache.get(week);
  if (cached) return cached;
  const start = week * WEEK_MS;
  const before = boundaryOffset(zone, start);
  const after = boundaryOffset(zone, start + WEEK_MS);
  let change = Number.POSITIVE_INFINITY;
  if (before !== after) {
    // Search the minute of the change: the offset at `low` is `before`, at `high` it is not.
    let low = start;
    let high = start + WEEK_MS;
    while (high - low > MINUTE_MS) {
      const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
      if (intlOffset(zone, middle) === before) low = middle;
      else high = middle;
    }
    change = high;
  }
  const offsets = { before, after, change };
  cache.set(week, offsets);
  return offsets;
}

/** The offset of a zone at an instant, in milliseconds. UTC and unknown zones have none. */
function offsetAt(zone: string, instant: number): number {
  if (zone === "UTC") return 0;
  const offsets = offsetsOfWeek(zone, Math.floor(instant / WEEK_MS));
  return instant < offsets.change ? offsets.before : offsets.after;
}

/**
 * The instant of a wall-clock time on a date (UTC midnight) in a zone. A time that happens twice
 * when clocks go back is the first one. A time that does not exist when clocks go forward moves
 * forward by the change, so 02:30 on the day of a one-hour change is 03:30. Minute 1440 is the
 * start of the next day.
 */
function localInstant(zone: string, day: number, minutes: number): number {
  const local = day + minutes * MINUTE_MS;
  const offsetBefore = offsetAt(zone, local - DAY_MS);
  const offsetAfter = offsetAt(zone, local + DAY_MS);
  if (offsetBefore === offsetAfter) return local - offsetBefore;
  const candidates = [local - offsetBefore, local - offsetAfter].filter(
    (candidate) => candidate + offsetAt(zone, candidate) === local,
  );
  return candidates.length > 0 ? Math.min(...candidates) : local - offsetBefore;
}

/** The date (as UTC midnight) of an instant in a zone. */
function localDate(zone: string, instant: number): number {
  // Offsets stay within a day, so the date is the UTC date or one next to it.
  const utcDay = Math.floor(instant / DAY_MS) * DAY_MS;
  for (const day of [utcDay + DAY_MS, utcDay]) {
    if (localInstant(zone, day, 0) <= instant) return day;
  }
  return utcDay - DAY_MS;
}
