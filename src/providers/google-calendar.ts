import * as z from "zod/mini";
import {
  fromGoogleEvent,
  googleEventFields,
  googleEventSchema,
  googleMarker,
  toGoogleBlock,
} from "../sync/google-events";
import {
  EMPTY_BATCH_RESULT,
  errorReason,
  parseRetryAfter,
  providerErrorMessage,
  summarizeBatch,
  type BatchResult,
} from "../sync/throttle";
import type { ExistingBlock, SourceEvent, SyncAction } from "../sync/types";
import type { CalendarClient, CalendarInfo, TimeWindow, Watch } from "./calendar-client";

const API = "https://www.googleapis.com/calendar/v3";
const BATCH_URL = "https://www.googleapis.com/batch/calendar/v3";

const calendarListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
      summaryOverride: z.optional(z.string()),
      accessRole: z.string(),
      primary: z.optional(z.boolean()),
    }),
  ),
  nextPageToken: z.optional(z.string()),
});

const channelSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  /** Unix milliseconds as a string. */
  expiration: z.string(),
});

const eventsPageSchema = z.object({
  items: z.optional(z.array(z.unknown())),
  nextPageToken: z.optional(z.string()),
});

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** From `Retry-After`, on throttled responses. */
    readonly retryAfterMs?: number,
    /** Google `error.errors[0].reason`, e.g. "rateLimitExceeded". */
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** Minimal Google Calendar client on plain `fetch`, for one access token. */
export class GoogleCalendar implements CalendarClient {
  /** Google accepts up to 1000 calls in one batch and recommends staying at or below 50. */
  readonly batchLimit = 50;

  constructor(private readonly accessToken: string) {}

  async listCalendars(): Promise<CalendarInfo[]> {
    const calendars: CalendarInfo[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ maxResults: "250", minAccessRole: "reader" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = calendarListSchema.parse(
        await this.get(`${API}/users/me/calendarList?${params.toString()}`),
      );
      for (const item of page.items) {
        calendars.push({
          id: item.id,
          name: item.summaryOverride ?? item.summary,
          canEdit: item.accessRole === "owner" || item.accessRole === "writer",
          isDefault: item.primary ?? false,
          owned: item.accessRole === "owner",
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return calendars;
  }

  async sourceEvents(
    calendarId: string,
    window: TimeWindow,
    options: { withBody?: boolean } = {},
  ): Promise<SourceEvent[]> {
    const events: SourceEvent[] = [];
    for (const raw of await this.listEvents(calendarId, window, options.withBody ?? false)) {
      const event = fromGoogleEvent(raw);
      if (event) events.push(event);
    }
    return events;
  }

  async existingBlocks(
    calendarId: string,
    window: TimeWindow,
    ruleTag: string,
  ): Promise<ExistingBlock[]> {
    const blocks: ExistingBlock[] = [];
    for (const raw of await this.listEvents(calendarId, window, false)) {
      const marker = googleMarker(raw);
      const source = fromGoogleEvent(raw);
      if (!marker || !source || marker.ruleTag !== ruleTag) continue;
      blocks.push({
        targetId: googleEventSchema.parse(raw).id,
        ...marker,
        start: source.start,
        end: source.end,
        allDay: source.allDay,
      });
    }
    return blocks;
  }

  async applyBatch(
    calendarId: string,
    ruleTag: string,
    actions: SyncAction[],
  ): Promise<BatchResult> {
    if (actions.length === 0) return EMPTY_BATCH_RESULT;
    if (actions.length > this.batchLimit) throw new Error("Batch too large");
    const boundary = `batch_${crypto.randomUUID()}`;
    const path = `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    const parts = actions.map((action, index) => {
      const request =
        action.kind === "create"
          ? httpPart("POST", path, toGoogleBlock(action.block, ruleTag))
          : action.kind === "update"
            ? httpPart(
                "PATCH",
                `${path}/${encodeURIComponent(action.targetId)}`,
                toGoogleBlock(action.block, ruleTag),
              )
            : httpPart("DELETE", `${path}/${encodeURIComponent(action.targetId)}`);
      return `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${index}>\r\n\r\n${request}\r\n`;
    });
    const response = await fetch(BATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": `multipart/mixed; boundary=${boundary}`,
      },
      body: `${parts.join("")}--${boundary}--\r\n`,
    });
    if (!response.ok) throw await googleError(response, "batch");
    // The body is multipart, which `text()` warns about; decode the bytes instead.
    const statuses = parseBatchStatuses(
      new TextDecoder().decode(await response.arrayBuffer()),
      response.headers.get("content-type") ?? "",
    );
    return summarizeBatch(actions, (index) => statuses.get(index) ?? { status: undefined });
  }

  async watch(calendarId: string, url: string, token: string, expiresAt: number): Promise<Watch> {
    const response = await fetch(
      `${API}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          type: "web_hook",
          address: url,
          token,
          expiration: expiresAt,
        }),
      },
    );
    if (!response.ok) throw await googleError(response, "watch");
    const body = channelSchema.parse(await response.json());
    return { id: body.id, resourceId: body.resourceId, expiresAt: Number(body.expiration) };
  }

  /** Google channels cannot be extended. */
  renew(): Promise<Watch | null> {
    return Promise.resolve(null);
  }

  async unwatch(watch: Watch): Promise<void> {
    const response = await fetch(`${API}/channels/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: watch.id, resourceId: watch.resourceId }),
    });
    if (!response.ok && response.status !== 404) throw await googleError(response, "stop");
  }

  private async listEvents(
    calendarId: string,
    window: TimeWindow,
    withBody: boolean,
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        timeMin: window.start.toISOString(),
        timeMax: window.end.toISOString(),
        singleEvents: "true",
        showDeleted: "false",
        maxResults: "2500",
        fields: googleEventFields(withBody),
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = eventsPageSchema.parse(
        await this.get(
          `${API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        ),
      );
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return items;
  }

  private async get(url: string): Promise<unknown> {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!response.ok) throw await googleError(response, "GET");
    return response.json();
  }
}

async function googleError(response: Response, what: string): Promise<GoogleApiError> {
  const reason = errorReason(await response.json().catch(() => null));
  return new GoogleApiError(
    response.status,
    providerErrorMessage("Google", what, response.status, reason),
    parseRetryAfter(response.headers.get("Retry-After")),
    reason,
  );
}

function httpPart(method: string, path: string, body?: unknown): string {
  return body === undefined
    ? `${method} ${path} HTTP/1.1\r\n\r\n`
    : `${method} ${path} HTTP/1.1\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
}

/**
 * Status and error reason per request of a multipart batch response. Google answers each part
 * with `Content-ID: <response-itemN>`, an HTTP status line and a JSON body; the order of parts is
 * not guaranteed.
 */
export function parseBatchStatuses(
  body: string,
  contentType: string,
): Map<number, { status: number; reason?: string }> {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
  const statuses = new Map<number, { status: number; reason?: string }>();
  if (!boundary) return statuses;
  for (const part of body.split(`--${boundary}`)) {
    const id = /Content-ID:\s*<response-item(\d+)>/i.exec(part)?.[1];
    const status = /HTTP\/1\.1\s+(\d{3})/.exec(part)?.[1];
    if (id === undefined || status === undefined) continue;
    const reason = Number(status) >= 400 ? errorReason(partJson(part)) : undefined;
    statuses.set(
      Number(id),
      reason ? { status: Number(status), reason } : { status: Number(status) },
    );
  }
  return statuses;
}

/** The JSON body of one batch part, or null. */
function partJson(part: string): unknown {
  const start = part.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(part.slice(start, part.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}
