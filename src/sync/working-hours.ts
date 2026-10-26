import type { RuleOptions } from "../config";
import type { SourceEvent } from "./types";

/** ISO weekdays, Monday 1 to Sunday 7. With all seven the weekday filter is off. */
export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** A time of day as "HH:MM", 00:00 to 23:59. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

type WorkingHours = Pick<RuleOptions, "workDays" | "workStart" | "workEnd" | "workTimeZone">;

const DAY_MS = 86_400_000;

/** Formatters per time zone, built once per isolate: Intl setup costs CPU time. */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
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
      formatter = null;
    }
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** True if Intl knows the time zone, for example "Europe/Vienna" or "UTC". */
export function isTimeZone(zone: string): boolean {
  return zone.trim() === zone && zone !== "" && formatterFor(zone) !== null;
}

/** The canonical spelling of a known time zone, e.g. "Europe/Vienna" for "europe/vienna". */
export function canonicalTimeZone(zone: string): string {
  return formatterFor(zone)?.resolvedOptions().timeZone ?? zone;
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

/** The wall-clock time of an instant in a zone, as if that wall clock were UTC. */
function wallClock(zone: string, instant: number): number {
  // UTC needs no Intl call; an unknown zone counts as UTC. Callers pass whole minutes.
  const formatter = zone === "UTC" ? null : formatterFor(zone);
  if (!formatter) return instant;
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

/** Instants per zone, date and minute, cached per isolate; a run reads each day many times. */
const instants = new Map<string, number>();

/**
 * The instant of a wall-clock time on a date (UTC midnight) in a zone. A time that happens twice
 * when clocks go back is the first one. A time that does not exist when clocks go forward moves
 * forward by the change, so 02:30 on the day of a one-hour change is 03:30.
 */
function localInstant(zone: string, day: number, minutes: number): number {
  const key = `${zone}|${day}|${minutes}`;
  const cached = instants.get(key);
  if (cached !== undefined) return cached;
  const local = day + minutes * 60_000;
  const offsetBefore = wallClock(zone, local - DAY_MS) - (local - DAY_MS);
  const offsetAfter = wallClock(zone, local + DAY_MS) - (local + DAY_MS);
  let instant = local - offsetBefore;
  if (offsetBefore !== offsetAfter) {
    const candidates = [local - offsetBefore, local - offsetAfter].filter(
      (candidate) => wallClock(zone, candidate) === local,
    );
    if (candidates.length > 0) instant = Math.min(...candidates);
  }
  if (instants.size >= 10_000) instants.clear();
  instants.set(key, instant);
  return instant;
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
