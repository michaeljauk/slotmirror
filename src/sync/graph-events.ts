import * as z from "zod/mini";
import type { ShowAs, SourceEvent } from "./types";

/**
 * Single-value extended property that marks blocks written by slotmirror.
 * Its value is `<ruleTag>.<marker>.<contentHash>`. The name keeps the project's former name,
 * freebusy-sync: existing blocks carry it, and a new name would make the sync miss them.
 */
export const MARKER_PROPERTY_ID =
  "String {6c3e4a1f-6a7d-4f3e-9b8e-2f1d5c7a9e10} Name freebusySyncMarker";

const dateTimeTimeZone = z.object({ dateTime: z.string(), timeZone: z.string() });

/** The fields of a Graph event that the sync reads. Request them with `$select`. */
export const graphEventSchema = z.object({
  id: z.string(),
  type: z.enum(["singleInstance", "occurrence", "exception", "seriesMaster"]),
  seriesMasterId: z.optional(z.nullable(z.string())),
  originalStart: z.optional(z.nullable(z.string())),
  start: dateTimeTimeZone,
  end: dateTimeTimeZone,
  isAllDay: z.boolean(),
  isCancelled: z.optional(z.boolean()),
  showAs: z.optional(z.string()),
  sensitivity: z.optional(z.string()),
  categories: z.optional(z.array(z.string())),
  responseStatus: z.optional(z.object({ response: z.optional(z.string()) })),
  subject: z.optional(z.nullable(z.string())),
  location: z.optional(z.nullable(z.object({ displayName: z.optional(z.nullable(z.string())) }))),
  bodyPreview: z.optional(z.nullable(z.string())),
  body: z.optional(z.nullable(z.object({ content: z.optional(z.nullable(z.string())) }))),
  singleValueExtendedProperties: z.optional(
    z.array(z.object({ id: z.string(), value: z.optional(z.nullable(z.string())) })),
  ),
});

export type GraphEvent = z.infer<typeof graphEventSchema>;

/**
 * `$select` for calendarView requests; the sync needs exactly these fields. Do not shorten it
 * casually: with short field lists (2 to 4 fields, tested 2026-10-25) Graph silently omits the
 * expanded marker property, and every block would look missing. This list returns it.
 */
export const GRAPH_EVENT_SELECT = [
  "id",
  "type",
  "seriesMasterId",
  "originalStart",
  "start",
  "end",
  "isAllDay",
  "isCancelled",
  "showAs",
  "sensitivity",
  "categories",
  "responseStatus",
  "subject",
  "location",
  "bodyPreview",
].join(",");

/**
 * Split a marker property value. Values from before rule tags existed have two parts; they
 * belong to no rule and are left alone.
 */
export function parseMarkerValue(value: string): {
  ruleTag: string;
  marker: string;
  contentHash: string;
} {
  const parts = value.split(".");
  if (parts.length !== 3) return { ruleTag: "", marker: parts[0] ?? "", contentHash: "" };
  const [ruleTag = "", marker = "", contentHash = ""] = parts;
  return { ruleTag, marker, contentHash };
}

const SHOW_AS: Record<string, ShowAs> = {
  free: "free",
  tentative: "tentative",
  busy: "busy",
  oof: "oof",
  workingElsewhere: "workingElsewhere",
};

/**
 * Convert a Graph event from `calendarView` (requested with `Prefer: outlook.timezone="UTC"`)
 * into a source event. Returns null for series masters and cancelled occurrences, which
 * calendarView does not normally return but must never be mirrored.
 */
export function fromGraphEvent(raw: unknown): SourceEvent | null {
  const event = graphEventSchema.parse(raw);
  if (event.type === "seriesMaster" || event.isCancelled) return null;

  const occurrenceKey =
    event.seriesMasterId && event.originalStart
      ? `series:${event.seriesMasterId}:${new Date(event.originalStart).toISOString()}`
      : `event:${event.id}`;

  const isMirror = (event.singleValueExtendedProperties ?? []).some(
    (property) => property.id.toLowerCase() === MARKER_PROPERTY_ID.toLowerCase(),
  );

  return {
    occurrenceKey,
    start: toTime(event.start, event.isAllDay),
    end: toTime(event.end, event.isAllDay),
    allDay: event.isAllDay,
    showAs: SHOW_AS[event.showAs ?? ""] ?? "unknown",
    isPrivate: event.sensitivity === "private" || event.sensitivity === "confidential",
    declined: event.responseStatus?.response === "declined",
    categories: event.categories ?? [],
    subject: event.subject ?? "",
    location: event.location?.displayName ?? "",
    body: event.body?.content ?? event.bodyPreview ?? "",
    isMirror,
  };
}

/** Graph returns `2026-10-27T13:00:00.0000000` in the requested zone (UTC). */
function toTime(value: { dateTime: string; timeZone: string }, allDay: boolean): string {
  if (allDay) return value.dateTime.slice(0, 10);
  if (value.timeZone !== "UTC") {
    throw new Error(`Expected UTC times from Graph, got ${value.timeZone}`);
  }
  return new Date(`${value.dateTime.slice(0, 19)}Z`).toISOString();
}
