import * as z from "zod/mini";
import type { DesiredBlock, ShowAs, SourceEvent } from "./types";

const MARKER_PROPERTY_SET = "String {6c3e4a1f-6a7d-4f3e-9b8e-2f1d5c7a9e10}";

/**
 * Single-value extended property that marks blocks written by slotmirror.
 * Its value is `<ruleTag>.<marker>.<contentHash>`; see `markerValueFor`.
 */
export const MARKER_PROPERTY_ID = `${MARKER_PROPERTY_SET} Name slotmirrorMarker`;

/**
 * Single-value extended property with the dedup key of a block (see `dedupKeyFor`). It is separate
 * from the marker so that a deployment from before 2026-10-27 still reads the marker.
 */
export const DEDUP_PROPERTY_ID = `${MARKER_PROPERTY_SET} Name slotmirrorDedupKey`;

/**
 * The marker of blocks written before the project was renamed from freebusy-sync on 2026-10-26.
 * It is read so that those blocks are still updated and removed, and never written.
 * TODO: remove once no deployment from before the rename runs, at the latest before the launch.
 */
export const LEGACY_MARKER_PROPERTY_ID = `${MARKER_PROPERTY_SET} Name freebusySyncMarker`;

/** The marker value of an event: the current marker wins over the legacy one. */
export function graphMarkerValue(
  properties: { id: string; value?: string | null }[] | undefined,
): string | undefined {
  const find = (id: string) =>
    properties?.find((property) => property.id.toLowerCase() === id.toLowerCase())?.value ??
    undefined;
  return find(MARKER_PROPERTY_ID) ?? find(LEGACY_MARKER_PROPERTY_ID);
}

/** The dedup key of a block; empty for blocks written before it existed. */
export function graphDedupKey(
  properties: { id: string; value?: string | null }[] | undefined,
): string {
  const id = DEDUP_PROPERTY_ID.toLowerCase();
  return properties?.find((property) => property.id.toLowerCase() === id)?.value ?? "";
}

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

/** The marker property value of a block, the same for Graph and Google. */
export function markerValueFor(ruleTag: string, block: DesiredBlock): string {
  return `${ruleTag}.${block.marker}.${block.contentHash}`;
}

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

  const isMirror = graphMarkerValue(event.singleValueExtendedProperties) !== undefined;

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
