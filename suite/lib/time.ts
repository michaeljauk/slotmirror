import type { EventTime } from "./scenario.ts";

/**
 * Time expressions of the scenarios. The suite resolves them itself, with `Intl` only, so that it
 * shares no time code with the tool under test.
 */

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
/** A daylight saving anchor lies this far ahead, so that a whole scenario fits behind `now`. */
const ANCHOR_LEAD_DAYS = 8;
const ANCHOR_SEARCH_DAYS = 380;

export type AnchorName = "today" | "week" | "dst-spring" | "dst-fall";

/** Dates at UTC midnight, in milliseconds. */
export type Anchors = Partial<Record<AnchorName, number>>;

const EXPRESSION = /^(today|week|dst-spring|dst-fall)(?:([+-]\d+)d)?(?:@(\d{2}):(\d{2})(Z)?)?$/;

function utcDay(instant: number): number {
  return Math.floor(instant / DAY_MS) * DAY_MS;
}

function formatDate(day: number): string {
  return new Date(day).toISOString().slice(0, 10);
}

/** The offset of a zone at an instant, in milliseconds. */
export function zoneOffset(zone: string, instant: number): number {
  const parts: Record<string, number> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  for (const part of format.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant of the local midnight that starts a date in a zone. */
export function localMidnight(date: string, zone: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`);
  // A second round finds the offset that holds at the instant itself, across a change.
  const first = wall - zoneOffset(zone, wall);
  return wall - zoneOffset(zone, first);
}

/** The first Monday at least a week after `now`. */
function nextFullWeek(now: number): number {
  const earliest = utcDay(now) + WEEK_DAYS * DAY_MS;
  const weekday = new Date(earliest).getUTCDay() || 7;
  return earliest + ((8 - weekday) % WEEK_DAYS) * DAY_MS;
}

/** The first date after the lead on which the offset of a zone rises or falls. */
function nextChange(now: number, zone: string, kind: "spring" | "fall"): number {
  const first = utcDay(now) + ANCHOR_LEAD_DAYS * DAY_MS;
  for (let i = 0; i < ANCHOR_SEARCH_DAYS; i++) {
    const day = first + i * DAY_MS;
    const before = zoneOffset(zone, day);
    const after = zoneOffset(zone, day + DAY_MS);
    if (kind === "spring" ? after > before : after < before) return day;
  }
  throw new Error(`The zone ${zone} has no ${kind} change`);
}

export function resolveAnchors(now: number, anchorZone?: string): Anchors {
  const anchors: Anchors = { today: utcDay(now), week: nextFullWeek(now) };
  if (anchorZone) {
    anchors["dst-spring"] = nextChange(now, anchorZone, "spring");
    anchors["dst-fall"] = nextChange(now, anchorZone, "fall");
  }
  return anchors;
}

interface Parsed {
  day: number;
  time: { hours: string; minutes: string; utc: boolean } | null;
}

function parse(expression: string, anchors: Anchors): Parsed {
  const match = EXPRESSION.exec(expression);
  if (!match) throw new Error(`Invalid time expression: ${expression}`);
  const [, name, days, hours, minutes, utc] = match;
  const anchor = anchors[name as AnchorName];
  if (anchor === undefined) throw new Error(`The anchor of ${expression} needs an anchorZone`);
  return {
    day: anchor + Number(days ?? 0) * DAY_MS,
    time: hours === undefined ? null : { hours, minutes: minutes ?? "00", utc: utc === "Z" },
  };
}

/** True if the expression has the form of a time expression. It resolves no anchor. */
export function isTimeExpression(expression: string): boolean {
  return EXPRESSION.test(expression);
}

/** An instant from an expression that ends in `Z`. */
export function instantOf(expression: string, anchors: Anchors): number {
  const { day, time } = parse(expression, anchors);
  if (!time?.utc) throw new Error(`Expected a UTC time: ${expression}`);
  return Date.UTC(1970, 0, 1, Number(time.hours), Number(time.minutes)) + day;
}

/** A date from an expression without a time. */
export function dateOf(expression: string, anchors: Anchors): string {
  const { day, time } = parse(expression, anchors);
  if (time) throw new Error(`Expected a date: ${expression}`);
  return formatDate(day);
}

/** The resolved time of an event. */
export function resolveTime(expression: string, anchors: Anchors, zone?: string): EventTime {
  const { day, time } = parse(expression, anchors);
  if (!time) return { date: formatDate(day) };
  if (!time.utc && !zone) throw new Error(`A wall-clock time needs a zone: ${expression}`);
  return {
    dateTime: `${formatDate(day)}T${time.hours}:${time.minutes}:00`,
    timeZone: time.utc ? "UTC" : (zone as string),
  };
}
