import * as z from "zod/mini";
import { isoInstant } from "./iso-time";
import { isObject, isOptionalNullableString, isOptionalString, isStringArray } from "./quick-check";
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

type ExtendedProperty = { id: string; value?: string | null };

const MARKER_ID = MARKER_PROPERTY_ID.toLowerCase();
const LEGACY_MARKER_ID = LEGACY_MARKER_PROPERTY_ID.toLowerCase();
const DEDUP_ID = DEDUP_PROPERTY_ID.toLowerCase();

/** The marker value of an event: the current marker wins over the legacy one. */
export function graphMarkerValue(properties: ExtendedProperty[] | undefined): string | undefined {
  if (!properties) return undefined;
  return propertyValue(properties, MARKER_ID) ?? propertyValue(properties, LEGACY_MARKER_ID);
}

/** The dedup key of a block; empty for blocks written before it existed. */
export function graphDedupKey(properties: ExtendedProperty[] | undefined): string {
  if (!properties) return "";
  return propertyValue(properties, DEDUP_ID) ?? "";
}

/** The value of the first property with this ID, compared without case. */
function propertyValue(properties: ExtendedProperty[], lowerCaseId: string): string | undefined {
  for (const property of properties) {
    if (property.id.toLowerCase() === lowerCaseId) return property.value ?? undefined;
  }
  return undefined;
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
 * Validate a Graph event against `graphEventSchema`. A quick check accepts the usual event without
 * the schema, which costs more CPU than the conversion; anything else goes to the schema, which
 * accepts it or throws its usual error.
 */
export function parseGraphEvent(raw: unknown): GraphEvent {
  return isGraphEvent(raw) ? raw : graphEventSchema.parse(raw);
}

const GRAPH_EVENT_TYPES: ReadonlySet<unknown> = new Set(graphEventSchema.shape.type.options);

/**
 * True only if `graphEventSchema` accepts the event. It may reject events that the schema accepts,
 * never the reverse. A test compares both on many variants.
 */
function isGraphEvent(raw: unknown): raw is GraphEvent {
  if (!isObject(raw)) return false;
  const { location, body, responseStatus } = raw;
  return (
    typeof raw.id === "string" &&
    GRAPH_EVENT_TYPES.has(raw.type) &&
    isOptionalNullableString(raw.seriesMasterId) &&
    isOptionalNullableString(raw.originalStart) &&
    isDateTimeTimeZone(raw.start) &&
    isDateTimeTimeZone(raw.end) &&
    typeof raw.isAllDay === "boolean" &&
    (raw.isCancelled === undefined || typeof raw.isCancelled === "boolean") &&
    isOptionalString(raw.showAs) &&
    isOptionalString(raw.sensitivity) &&
    (raw.categories === undefined || isStringArray(raw.categories)) &&
    (responseStatus === undefined ||
      (isObject(responseStatus) && isOptionalString(responseStatus.response))) &&
    isOptionalNullableString(raw.subject) &&
    (location === undefined ||
      location === null ||
      (isObject(location) && isOptionalNullableString(location.displayName))) &&
    isOptionalNullableString(raw.bodyPreview) &&
    (body === undefined ||
      body === null ||
      (isObject(body) && isOptionalNullableString(body.content))) &&
    (raw.singleValueExtendedProperties === undefined ||
      isPropertyArray(raw.singleValueExtendedProperties))
  );
}

function isDateTimeTimeZone(value: unknown): boolean {
  return (
    isObject(value) && typeof value.dateTime === "string" && typeof value.timeZone === "string"
  );
}

function isPropertyArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const property: unknown = value[i];
    if (!isObject(property) || typeof property.id !== "string") return false;
    if (!isOptionalNullableString(property.value)) return false;
  }
  return true;
}

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
  return graphSourceEvent(parseGraphEvent(raw));
}

/** `fromGraphEvent` for an event that `parseGraphEvent` returned. */
export function graphSourceEvent(event: GraphEvent): SourceEvent | null {
  if (event.type === "seriesMaster" || event.isCancelled) return null;

  const occurrenceKey =
    event.seriesMasterId && event.originalStart
      ? `series:${event.seriesMasterId}:${isoInstant(event.originalStart)}`
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
  return isoInstant(`${value.dateTime.slice(0, 19)}Z`);
}
