import * as z from "zod/mini";
import {
  fromGraphEvent,
  GRAPH_EVENT_SELECT,
  graphEventSchema,
  graphMarkerValue,
  LEGACY_MARKER_PROPERTY_ID,
  MARKER_PROPERTY_ID,
  markerValueFor,
  DEDUP_PROPERTY_ID,
  graphDedupKey,
  parseMarkerValue,
} from "../sync/graph-events";
import {
  EMPTY_BATCH_RESULT,
  errorReason,
  parseRetryAfter,
  providerErrorMessage,
  summarizeBatch,
  type BatchResult,
} from "../sync/throttle";
import type { DesiredBlock, ExistingBlock, SourceEvent, SyncAction } from "../sync/types";
import type {
  CalendarClient,
  CalendarInfo,
  ChangeFeed,
  TimeWindow,
  Watch,
} from "./calendar-client";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Graph accepts at most 20 requests in one `$batch`. */
export const GRAPH_BATCH_LIMIT = 20;

/** Page size for calendarView. Fewer pages mean fewer subrequests on the Free plan. */
const PAGE_SIZE = 500;

const calendarsSchema = z.object({
  value: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      canEdit: z.optional(z.boolean()),
      isDefaultCalendar: z.optional(z.boolean()),
      owner: z.optional(z.object({ address: z.optional(z.nullable(z.string())) })),
    }),
  ),
});

const meSchema = z.object({
  mail: z.optional(z.nullable(z.string())),
  userPrincipalName: z.optional(z.nullable(z.string())),
});

const pageSchema = z.object({
  value: z.array(z.unknown()),
  "@odata.nextLink": z.optional(z.string()),
});

const subscriptionSchema = z.object({ id: z.string(), expirationDateTime: z.string() });

const batchResponseSchema = z.object({
  responses: z.array(
    z.object({
      id: z.string(),
      status: z.number(),
      headers: z.optional(z.record(z.string(), z.string())),
      body: z.optional(z.unknown()),
    }),
  ),
});

export class GraphError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** From `Retry-After`, on throttled responses. */
    readonly retryAfterMs?: number,
    /** Graph `error.code`, e.g. "ApplicationThrottled". */
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** Minimal Microsoft Graph calendar client on plain `fetch`, for one access token. */
export class GraphCalendar implements CalendarClient {
  readonly batchLimit = GRAPH_BATCH_LIMIT;

  constructor(private readonly accessToken: string) {}

  async listCalendars(): Promise<CalendarInfo[]> {
    const [me, body] = await Promise.all([
      this.get(`${GRAPH}/me?$select=mail,userPrincipalName`),
      this.get(`${GRAPH}/me/calendars?$select=id,name,canEdit,isDefaultCalendar,owner&$top=100`),
    ]);
    const profile = meSchema.parse(me);
    const own = new Set(
      [profile.mail, profile.userPrincipalName].filter(Boolean).map((a) => String(a).toLowerCase()),
    );
    return calendarsSchema.parse(body).value.map((calendar) => {
      const owned = own.has((calendar.owner?.address ?? "").toLowerCase());
      return {
        id: calendar.id,
        name: calendar.name,
        canEdit: calendar.canEdit ?? false,
        isDefault: calendar.isDefaultCalendar ?? false,
        owned,
        dataOwned: owned,
      };
    });
  }

  /**
   * Every occurrence in the window, with the marker property so that our own blocks are known.
   * The full body is read only if a rule needs it (detail level "full").
   */
  async sourceEvents(
    calendarId: string,
    window: TimeWindow,
    options: { withBody?: boolean } = {},
  ): Promise<SourceEvent[]> {
    const events: SourceEvent[] = [];
    for (const raw of await this.calendarView(calendarId, window, options.withBody)) {
      const event = fromGraphEvent(raw);
      if (event) events.push(event);
    }
    return events;
  }

  /** Blocks in the target calendar that the rules with these tags wrote. */
  async existingBlocks(
    calendarId: string,
    window: TimeWindow,
    ruleTags: readonly string[],
  ): Promise<ExistingBlock[]> {
    const blocks: ExistingBlock[] = [];
    for (const raw of await this.calendarView(calendarId, window)) {
      const event = graphEventSchema.parse(raw);
      const value = graphMarkerValue(event.singleValueExtendedProperties);
      const source = fromGraphEvent(raw);
      if (!value || !source) continue;
      const parsed = parseMarkerValue(value);
      if (!ruleTags.includes(parsed.ruleTag)) continue;
      blocks.push({
        targetId: event.id,
        ...parsed,
        dedupKey: graphDedupKey(event.singleValueExtendedProperties),
        start: source.start,
        end: source.end,
        allDay: source.allDay,
      });
    }
    return blocks;
  }

  /**
   * Apply up to GRAPH_BATCH_LIMIT actions in one `$batch` request. Failed actions are counted per
   * status; the next run plans them again.
   */
  async applyBatch(
    calendarId: string,
    ruleTag: string,
    actions: SyncAction[],
  ): Promise<BatchResult> {
    if (actions.length === 0) return EMPTY_BATCH_RESULT;
    if (actions.length > GRAPH_BATCH_LIMIT) throw new Error("Batch too large");
    const requests = actions.map((action, index) => {
      const id = String(index);
      switch (action.kind) {
        case "create":
          return {
            id,
            method: "POST",
            url: `/me/calendars/${encodeURIComponent(calendarId)}/events`,
            headers: { "Content-Type": "application/json" },
            body: toGraphBlock(action.block, ruleTag),
          };
        case "update":
          return {
            id,
            method: "PATCH",
            url: `/me/events/${encodeURIComponent(action.targetId)}`,
            headers: { "Content-Type": "application/json" },
            body: toGraphBlock(action.block, ruleTag),
          };
        case "delete":
          return { id, method: "DELETE", url: `/me/events/${encodeURIComponent(action.targetId)}` };
      }
    });
    const response = await fetch(`${GRAPH}/$batch`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    });
    if (!response.ok) throw await graphError(response, "$batch");
    const body = batchResponseSchema.parse(await response.json());
    const byId = new Map(body.responses.map((item) => [item.id, item]));
    const result = summarizeBatch(actions, (index) => {
      const item = byId.get(String(index));
      return {
        status: item?.status,
        reason: item && item.status >= 400 ? errorReason(item.body) : undefined,
        retryAfterMs: parseRetryAfter(retryAfterHeader(item?.headers)),
      };
    });
    const writtenIds = actions.flatMap((action, index) => {
      const item = byId.get(String(index));
      if (!item || item.status >= 300) return [];
      if (action.kind !== "create") return [action.targetId];
      const id = (item.body as { id?: unknown } | undefined)?.id;
      return typeof id === "string" ? [id] : [];
    });
    return { ...result, writtenIds };
  }

  async watch(calendarId: string, url: string, token: string, expiresAt: number): Promise<Watch> {
    const response = await fetch(`${GRAPH}/subscriptions`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        changeType: "created,updated,deleted",
        notificationUrl: url,
        resource: `me/calendars/${calendarId}/events`,
        expirationDateTime: new Date(expiresAt).toISOString(),
        clientState: token,
      }),
    });
    if (!response.ok) throw await graphError(response, "subscribe");
    const body = subscriptionSchema.parse(await response.json());
    return { id: body.id, resourceId: null, expiresAt: Date.parse(body.expirationDateTime) };
  }

  async renew(watch: Watch, expiresAt: number): Promise<Watch | null> {
    const response = await fetch(`${GRAPH}/subscriptions/${encodeURIComponent(watch.id)}`, {
      method: "PATCH",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ expirationDateTime: new Date(expiresAt).toISOString() }),
    });
    // A subscription Graph already removed cannot be extended; the caller subscribes again.
    if (response.status === 404) return null;
    if (!response.ok) throw await graphError(response, "renew");
    const body = subscriptionSchema.parse(await response.json());
    return { ...watch, expiresAt: Date.parse(body.expirationDateTime) };
  }

  async unwatch(watch: Watch): Promise<void> {
    const response = await fetch(`${GRAPH}/subscriptions/${encodeURIComponent(watch.id)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!response.ok && response.status !== 404) throw await graphError(response, "unsubscribe");
  }

  /**
   * Graph notifications name the changed events; `AccountSync.graphChanged` queues them with the
   * notification time, and the alarm compares them with the recent writes.
   */
  changesSince(): Promise<ChangeFeed | null> {
    return Promise.resolve(null);
  }

  private async calendarView(
    calendarId: string,
    window: TimeWindow,
    withBody = false,
  ): Promise<unknown[]> {
    const params = new URLSearchParams({
      startDateTime: window.start.toISOString(),
      endDateTime: window.end.toISOString(),
      $select: withBody ? `${GRAPH_EVENT_SELECT},body` : GRAPH_EVENT_SELECT,
      $expand: `singleValueExtendedProperties($filter=id eq '${MARKER_PROPERTY_ID}' or id eq '${LEGACY_MARKER_PROPERTY_ID}' or id eq '${DEDUP_PROPERTY_ID}')`,
      $top: String(PAGE_SIZE),
    });
    let url: string | undefined =
      `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/calendarView?${params.toString()}`;
    const items: unknown[] = [];
    while (url) {
      const page = pageSchema.parse(await this.get(url));
      items.push(...page.value);
      url = page["@odata.nextLink"];
    }
    return items;
  }

  private async get(url: string): Promise<unknown> {
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) throw await graphError(response, "GET");
    return response.json();
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
    };
  }
}

async function graphError(response: Response, what: string): Promise<GraphError> {
  const reason = errorReason(await response.json().catch(() => null));
  return new GraphError(
    response.status,
    providerErrorMessage("Graph", what, response.status, reason),
    parseRetryAfter(response.headers.get("Retry-After")),
    reason,
  );
}

/** Header names in a `$batch` response keep the case Graph chose. */
function retryAfterHeader(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === "retry-after");
  return key ? headers[key] : undefined;
}

/** Graph event body for a block. No attendees, so that no invitations are sent. */
export function toGraphBlock(block: DesiredBlock, ruleTag: string) {
  const time = (value: string) =>
    block.allDay
      ? { dateTime: `${value}T00:00:00`, timeZone: "UTC" }
      : { dateTime: value.replace(/Z$/, "").replace(/\.\d{3}$/, ""), timeZone: "UTC" };
  return {
    subject: block.subject,
    start: time(block.start),
    end: time(block.end),
    isAllDay: block.allDay,
    showAs: block.showAs === "unknown" ? "busy" : block.showAs,
    sensitivity: block.isPrivate ? "private" : "normal",
    isReminderOn: false,
    responseRequested: false,
    location: { displayName: block.location },
    body: { contentType: "text", content: block.body },
    // Always set, so that an update also removes a category the rule no longer uses.
    categories: block.color ? [block.color] : [],
    singleValueExtendedProperties: [
      { id: MARKER_PROPERTY_ID, value: markerValueFor(ruleTag, block) },
      { id: DEDUP_PROPERTY_ID, value: block.dedupKey },
    ],
  };
}
