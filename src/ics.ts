/**
 * A minimal iCalendar (RFC 5545) writer for the free/busy feed. It knows only the properties the
 * feed needs, so that no event content can reach the output by accident.
 */

/** One busy interval. `start` and `end` are ISO 8601 UTC, or YYYY-MM-DD for all-day events. */
export interface BusyEvent {
  uid: string;
  start: string;
  end: string;
  allDay: boolean;
}

export interface BusyCalendar {
  /** Calendar name that subscribing apps show. */
  name: string;
  /** The fixed title of every event, e.g. "Busy". */
  summary: string;
  /** How often apps should fetch again, in minutes. */
  refreshMinutes: number;
  events: readonly BusyEvent[];
  /** Time of rendering, for DTSTAMP. */
  now: Date;
}

const CRLF = "\r\n";

/** Escape a TEXT value (RFC 5545 3.3.11). */
export function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Fold a content line after 75 octets (RFC 5545 3.1). A continuation line starts with a space,
 * which counts toward its 75 octets. A UTF-8 sequence is never split.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let size = 0;
  let limit = 75;
  for (const char of line) {
    const bytes = utf8Length(char.codePointAt(0) ?? 0);
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
      limit = 74;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/** "2026-10-27T09:00:00.000Z" as "20261027T090000Z". */
function utcDateTime(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "");
}

/** "2026-10-27" as "20261027". */
function date(value: string): string {
  return value.slice(0, 10).replaceAll("-", "");
}

function timeProperty(name: "DTSTART" | "DTEND", value: string, allDay: boolean): string {
  return allDay ? `${name};VALUE=DATE:${date(value)}` : `${name}:${utcDateTime(value)}`;
}

/**
 * The feed as text with CRLF line endings. Each event carries times, UID, DTSTAMP, the fixed
 * title, CLASS:PRIVATE and TRANSP:OPAQUE, and nothing else.
 */
export function renderBusyCalendar(calendar: BusyCalendar): string {
  const stamp = utcDateTime(calendar.now.toISOString());
  const summary = escapeText(calendar.summary);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//slotmirror//busy feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${calendar.refreshMinutes}M`,
    `X-PUBLISHED-TTL:PT${calendar.refreshMinutes}M`,
  ];
  for (const event of calendar.events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      timeProperty("DTSTART", event.start, event.allDay),
      timeProperty("DTEND", event.end, event.allDay),
      `SUMMARY:${summary}`,
      "CLASS:PRIVATE",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}
