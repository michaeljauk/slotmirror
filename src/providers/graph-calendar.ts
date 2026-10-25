import * as z from "zod/mini";
import {
  fromGraphEvent,
  GRAPH_EVENT_SELECT,
  graphEventSchema,
  MARKER_PROPERTY_ID,
  parseMarkerValue,
} from "../sync/graph-events";
import type { DesiredBlock, ExistingBlock, SourceEvent, SyncAction } from "../sync/types";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Graph accepts at most 20 requests in one `$batch`. */
export const GRAPH_BATCH_LIMIT = 20;

/** Page size for calendarView. Fewer pages mean fewer subrequests on the Free plan. */
const PAGE_SIZE = 500;

export interface CalendarInfo {
  id: string;
  name: string;
  canEdit: boolean;
  isDefault: boolean;
  /** Mailbox that owns the calendar; differs from the account for calendars shared by others. */
  ownerAddress: string;
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

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

const pageSchema = z.object({
  value: z.array(z.unknown()),
  "@odata.nextLink": z.optional(z.string()),
});

const batchResponseSchema = z.object({
  responses: z.array(
    z.object({ id: z.string(), status: z.number(), body: z.optional(z.unknown()) }),
  ),
});

export class GraphError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Minimal Microsoft Graph calendar client on plain `fetch`, for one access token. */
export class GraphCalendar {
  constructor(private readonly accessToken: string) {}

  async listCalendars(): Promise<CalendarInfo[]> {
    const body = calendarsSchema.parse(
      await this.get(
        `${GRAPH}/me/calendars?$select=id,name,canEdit,isDefaultCalendar,owner&$top=100`,
      ),
    );
    return body.value.map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      canEdit: calendar.canEdit ?? false,
      isDefault: calendar.isDefaultCalendar ?? false,
      ownerAddress: (calendar.owner?.address ?? "").toLowerCase(),
    }));
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

  /** Blocks in the target calendar that carry a freebusy-sync marker. */
  async existingBlocks(calendarId: string, window: TimeWindow): Promise<ExistingBlock[]> {
    const blocks: ExistingBlock[] = [];
    for (const raw of await this.calendarView(calendarId, window)) {
      const event = graphEventSchema.parse(raw);
      const value = (event.singleValueExtendedProperties ?? []).find(
        (property) => property.id.toLowerCase() === MARKER_PROPERTY_ID.toLowerCase(),
      )?.value;
      const source = fromGraphEvent(raw);
      if (!value || !source) continue;
      blocks.push({
        targetId: event.id,
        ...parseMarkerValue(value),
        start: source.start,
        end: source.end,
        allDay: source.allDay,
      });
    }
    return blocks;
  }

  /**
   * Apply up to GRAPH_BATCH_LIMIT actions in one `$batch` request. Returns the IDs of failed
   * actions; the next run plans them again.
   */
  async applyBatch(calendarId: string, actions: SyncAction[]): Promise<{ failed: number }> {
    if (actions.length === 0) return { failed: 0 };
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
            body: toGraphBlock(action.block),
          };
        case "update":
          return {
            id,
            method: "PATCH",
            url: `/me/events/${encodeURIComponent(action.targetId)}`,
            headers: { "Content-Type": "application/json" },
            body: toGraphBlock(action.block),
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
    if (!response.ok)
      throw new GraphError(response.status, `Graph $batch failed: ${response.status}`);
    const body = batchResponseSchema.parse(await response.json());
    // A delete of a block that is already gone (404) is a success.
    const failed = body.responses.filter(
      (item) =>
        item.status >= 400 && !(item.status === 404 && actions[Number(item.id)]?.kind === "delete"),
    ).length;
    return { failed };
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
      $expand: `singleValueExtendedProperties($filter=id eq '${MARKER_PROPERTY_ID}')`,
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
    if (!response.ok) throw new GraphError(response.status, `Graph GET failed: ${response.status}`);
    return response.json();
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
    };
  }
}

/** Graph event body for a block. No attendees, so that no invitations are sent. */
export function toGraphBlock(block: DesiredBlock) {
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
    singleValueExtendedProperties: [
      { id: MARKER_PROPERTY_ID, value: `${block.marker}.${block.contentHash}` },
    ],
  };
}
