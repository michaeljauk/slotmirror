import * as z from "zod/mini";
import { markerValueFor, parseMarkerValue } from "./graph-events";
import { isoInstant } from "./iso-time";
import { isObject, isOptionalString } from "./quick-check";
import type { DesiredBlock, SourceEvent } from "./types";

/** Key in `extendedProperties.private` that marks blocks written by slotmirror. */
export const GOOGLE_MARKER_KEY = "slotmirrorMarker";

/** Key in `extendedProperties.private` with the dedup key of a block; see `dedupKeyFor`. */
export const GOOGLE_DEDUP_KEY = "slotmirrorDedupKey";

/**
 * The key of blocks written before the project was renamed from freebusy-sync on 2026-10-26.
 * Read, never written. TODO: remove once no deployment from before the rename runs.
 */
export const LEGACY_GOOGLE_MARKER_KEY = "freebusySyncMarker";

/** The marker value of an event: the current key wins over the legacy one. */
function markerValue(properties: Record<string, string> | undefined): string | undefined {
  return properties?.[GOOGLE_MARKER_KEY] ?? properties?.[LEGACY_GOOGLE_MARKER_KEY];
}

const eventTime = z.object({
  date: z.optional(z.string()),
  dateTime: z.optional(z.string()),
});

export const googleEventSchema = z.object({
  id: z.string(),
  status: z.optional(z.string()),
  summary: z.optional(z.string()),
  location: z.optional(z.string()),
  description: z.optional(z.string()),
  start: eventTime,
  end: eventTime,
  recurringEventId: z.optional(z.string()),
  originalStartTime: z.optional(eventTime),
  transparency: z.optional(z.string()),
  visibility: z.optional(z.string()),
  colorId: z.optional(z.string()),
  attendees: z.optional(
    z.array(z.object({ self: z.optional(z.boolean()), responseStatus: z.optional(z.string()) })),
  ),
  extendedProperties: z.optional(
    z.object({ private: z.optional(z.record(z.string(), z.string())) }),
  ),
});

export type GoogleEvent = z.infer<typeof googleEventSchema>;

/**
 * Validate a Google event against `googleEventSchema`. A quick check accepts the usual event
 * without the schema; anything else goes to the schema, which accepts it or throws its usual error.
 */
export function parseGoogleEvent(raw: unknown): GoogleEvent {
  return isGoogleEvent(raw) ? raw : googleEventSchema.parse(raw);
}

/**
 * True only if `googleEventSchema` accepts the event. It may reject events that the schema
 * accepts, never the reverse. A test compares both on many variants.
 */
function isGoogleEvent(raw: unknown): raw is GoogleEvent {
  if (!isObject(raw)) return false;
  const { originalStartTime, extendedProperties } = raw;
  return (
    typeof raw.id === "string" &&
    isOptionalString(raw.status) &&
    isOptionalString(raw.summary) &&
    isOptionalString(raw.location) &&
    isOptionalString(raw.description) &&
    isEventTime(raw.start) &&
    isEventTime(raw.end) &&
    isOptionalString(raw.recurringEventId) &&
    (originalStartTime === undefined || isEventTime(originalStartTime)) &&
    isOptionalString(raw.transparency) &&
    isOptionalString(raw.visibility) &&
    isOptionalString(raw.colorId) &&
    (raw.attendees === undefined || isAttendeeArray(raw.attendees)) &&
    (extendedProperties === undefined ||
      (isObject(extendedProperties) &&
        (extendedProperties.private === undefined || isStringRecord(extendedProperties.private))))
  );
}

function isEventTime(value: unknown): boolean {
  return isObject(value) && isOptionalString(value.date) && isOptionalString(value.dateTime);
}

/** Indexes every slot, so that a hole fails as in the schema. */
function isAttendeeArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const attendee: unknown = value[i];
    if (!isObject(attendee)) return false;
    if (attendee.self !== undefined && typeof attendee.self !== "boolean") return false;
    if (!isOptionalString(attendee.responseStatus)) return false;
  }
  return true;
}

/**
 * A plain object with enumerable string values only, as JSON yields it. The schema copies such an
 * object unchanged; anything else goes to the schema.
 */
function isStringRecord(value: unknown): boolean {
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) return false;
    if (typeof value[key] !== "string") return false;
  }
  return true;
}

/** `fields` for events.list; keeps responses small. `description` only when a rule needs it. */
export function googleEventFields(withBody: boolean): string {
  const item = [
    "id",
    "status",
    "summary",
    "location",
    ...(withBody ? ["description"] : []),
    "start",
    "end",
    "recurringEventId",
    "originalStartTime",
    "transparency",
    "visibility",
    "colorId",
    "attendees(self,responseStatus)",
    "extendedProperties/private",
  ].join(",");
  return `nextPageToken,items(${item})`;
}

/**
 * Convert an event from events.list with `singleEvents=true` into a source event. Returns null for
 * cancelled occurrences, which Google lists with `status: cancelled`.
 */
export function fromGoogleEvent(raw: unknown): SourceEvent | null {
  return googleSourceEvent(parseGoogleEvent(raw));
}

/** `fromGoogleEvent` for an event that `parseGoogleEvent` returned. */
export function googleSourceEvent(event: GoogleEvent): SourceEvent | null {
  if (event.status === "cancelled") return null;

  const allDay = event.start.date !== undefined;
  const original = event.originalStartTime;
  const occurrenceKey =
    event.recurringEventId && original
      ? `series:${event.recurringEventId}:${toTime(original)}`
      : `event:${event.id}`;
  const self = event.attendees?.find((attendee) => attendee.self);

  return {
    occurrenceKey,
    start: toTime(event.start),
    end: toTime(event.end),
    allDay,
    showAs:
      event.transparency === "transparent"
        ? "free"
        : self?.responseStatus === "tentative"
          ? "tentative"
          : "busy",
    isPrivate: event.visibility === "private" || event.visibility === "confidential",
    declined: self?.responseStatus === "declined",
    categories: event.colorId ? [`color:${event.colorId}`] : [],
    subject: event.summary ?? "",
    location: event.location ?? "",
    body: event.description ?? "",
    isMirror: markerValue(event.extendedProperties?.private) !== undefined,
  };
}

/** Marker value and dedup key of a block, if the event is one of ours. */
export function googleMarker(raw: unknown) {
  return googleEventMarker(parseGoogleEvent(raw));
}

/** `googleMarker` for an event that `parseGoogleEvent` returned. */
export function googleEventMarker(event: GoogleEvent) {
  const properties = event.extendedProperties?.private;
  const value = markerValue(properties);
  if (value === undefined) return null;
  return { ...parseMarkerValue(value), dedupKey: properties?.[GOOGLE_DEDUP_KEY] ?? "" };
}

/** All-day events keep their date; timed events become UTC instants. */
function toTime(value: { date?: string; dateTime?: string }): string {
  if (value.date) return value.date;
  if (!value.dateTime) throw new Error("Google event time has neither date nor dateTime");
  return isoInstant(value.dateTime);
}

/** Google event body for a block. No attendees, so that no invitations are sent. */
export function toGoogleBlock(block: DesiredBlock, ruleTag: string) {
  const time = (value: string) =>
    block.allDay ? { date: value } : { dateTime: value, timeZone: "UTC" };
  return {
    summary: block.subject,
    location: block.location,
    description: block.body,
    start: time(block.start),
    end: time(block.end),
    // Google has no "tentative" or "out of office" for a plain event; anything but free blocks time.
    transparency: block.showAs === "free" ? "transparent" : "opaque",
    visibility: block.isPrivate ? "private" : "default",
    reminders: { useDefault: false, overrides: [] },
    // null on an update removes a colour the rule no longer uses; invalid IDs never reach Google.
    colorId: block.color && /^(?:[1-9]|1[01])$/.test(block.color) ? block.color : null,
    extendedProperties: {
      private: {
        [GOOGLE_MARKER_KEY]: markerValueFor(ruleTag, block),
        [GOOGLE_DEDUP_KEY]: block.dedupKey,
      },
    },
  };
}
