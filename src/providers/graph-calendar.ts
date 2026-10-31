import * as z from "zod/mini";
import {
  fromGraphEvent,
  graphEventSelect,
  graphMarkerValue,
  graphSourceEvent,
  parseGraphEvent,
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
import {
  blockStatusOf,
  type DesiredBlock,
  type ExistingBlock,
  type SourceEvent,
  type SyncAction,
} from "../sync/types";
import type {
  CalendarClient,
  CalendarInfo,
  ChangeFeed,
  SourceFields,
  TimeWindow,
  Watch,
} from "./calendar-client";
import {
  BATCH_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  providerFetch,
  TIMEOUT_REASON,
  TIMEOUT_STATUS,
} from "./provider-fetch";

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
  "@odata.nextLink": z.optional(z.string()),
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

const subscriptionListSchema = z.object({
  value: z.array(
    z.object({
      id: z.string(),
      resource: z.optional(z.nullable(z.string())),
      notificationUrl: z.optional(z.nullable(z.string())),
    }),
  ),
  "@odata.nextLink": z.optional(z.string()),
});

const mailSchema = z.object({ mail: z.optional(z.nullable(z.string())) });

const scheduleSchema = z.object({
  value: z.array(
    z.object({
      error: z.optional(z.nullable(z.object({ responseCode: z.optional(z.nullable(z.string())) }))),
      workingHours: z.optional(
        z.nullable(
          z.object({
            timeZone: z.optional(
              z.nullable(z.object({ name: z.optional(z.nullable(z.string())) })),
            ),
          }),
        ),
      ),
    }),
  ),
});

/**
 * A zone name that a write can use: a Windows or IANA name. Graph also reports "Customized Time
 * Zone" and URIs such as `tzone://Microsoft/Custom`, which an event cannot carry.
 */
const USABLE_ZONE = /^[A-Za-z0-9][A-Za-z0-9 .+/_()-]{0,99}$/;

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

  constructor(
    private readonly accessToken: string,
    /** Called for every read request, so for every page; see `calendarClient`. */
    private readonly onRead: () => void = () => {},
  ) {}

  async listCalendars({ complete = false }: { complete?: boolean } = {}): Promise<CalendarInfo[]> {
    const [me, body] = await Promise.all([
      this.get(`${GRAPH}/me?$select=mail,userPrincipalName`),
      this.get(`${GRAPH}/me/calendars?$select=id,name,canEdit,isDefaultCalendar,owner&$top=100`),
    ]);
    const profile = meSchema.parse(me);
    const own = new Set(
      [profile.mail, profile.userPrincipalName].filter(Boolean).map((a) => String(a).toLowerCase()),
    );
    const page = calendarsSchema.parse(body);
    const listed = [...page.value];
    let next = complete ? page["@odata.nextLink"] : undefined;
    while (next) {
      const more = calendarsSchema.parse(await this.get(next));
      listed.push(...more.value);
      next = more["@odata.nextLink"];
    }
    return listed.map((calendar) => {
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
   * The full body is read only if a rule needs it (detail level "full"), and so is the web link.
   */
  async sourceEvents(
    calendarId: string,
    window: TimeWindow,
    options: SourceFields = {},
  ): Promise<SourceEvent[]> {
    const events: SourceEvent[] = [];
    for (const raw of await this.calendarView(calendarId, window, options)) {
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
    return (await this.allBlocks(calendarId, window)).filter((block) =>
      ruleTags.includes(block.ruleTag),
    );
  }

  /** Blocks in the target calendar with any tag. */
  async allBlocks(calendarId: string, window: TimeWindow): Promise<ExistingBlock[]> {
    const blocks: ExistingBlock[] = [];
    for (const raw of await this.calendarView(calendarId, window)) {
      const event = parseGraphEvent(raw);
      const value = graphMarkerValue(event.singleValueExtendedProperties);
      const source = graphSourceEvent(event);
      if (!value || !source) continue;
      blocks.push({
        targetId: event.id,
        ...parseMarkerValue(value),
        dedupKey: graphDedupKey(event.singleValueExtendedProperties),
        start: source.start,
        end: source.end,
        allDay: source.allDay,
        status: blockStatusOf(source.showAs),
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
    allDayZone = "UTC",
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
            body: toGraphBlock(action.block, ruleTag, allDayZone),
          };
        case "update":
          return {
            id,
            method: "PATCH",
            url: `/me/events/${encodeURIComponent(action.targetId)}`,
            headers: { "Content-Type": "application/json" },
            body: toGraphBlock(action.block, ruleTag, allDayZone),
          };
        case "delete":
          return { id, method: "DELETE", url: `/me/events/${encodeURIComponent(action.targetId)}` };
      }
    });
    const response = await graphFetch(
      `${GRAPH}/$batch`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      },
      "$batch",
      BATCH_TIMEOUT_MS,
    );
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

  /**
   * The zone of the mailbox, from the working hours in `getSchedule`. `mailboxSettings` is the direct
   * source, but it needs `MailboxSettings.Read`, and a new scope forces each account to reconnect.
   * `getSchedule` needs the SMTP address. An account can store its sign-in name, which can differ,
   * so `address` applies only if the profile has no `mail`. Each of the two calls counts as a read.
   * `getSchedule` has no `Prefer` header: that header decides the zone that Graph reports in other
   * fields, for example `originalStartTimeZone`.
   *
   * An `error` for the schedule or a body of another form throws: neither says that the mailbox has
   * no usable zone. No code here can tell a lasting error from a short one, so all count as failed.
   */
  async mailboxZone(address: string): Promise<string | null> {
    const { mail } = mailSchema.parse(await this.get(`${GRAPH}/me?$select=mail`));
    this.onRead();
    const time = (at: number) => ({
      dateTime: new Date(at).toISOString().slice(0, 19),
      timeZone: "UTC",
    });
    const response = await graphFetch(
      `${GRAPH}/me/calendar/getSchedule`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schedules: [mail || address],
          startTime: time(Date.now()),
          endTime: time(Date.now() + 3_600_000),
          availabilityViewInterval: 60,
        }),
      },
      "getSchedule",
    );
    if (!response.ok) throw await graphError(response, "getSchedule");
    const [schedule] = scheduleSchema.parse(await response.json()).value;
    if (schedule?.error) {
      const reason = errorReason({ error: { code: schedule.error.responseCode } });
      const message = providerErrorMessage("Graph", "getSchedule", response.status, reason);
      throw new GraphError(response.status, message, undefined, reason);
    }
    const name = schedule?.workingHours?.timeZone?.name;
    return name && USABLE_ZONE.test(name) && !/custom/i.test(name) ? name : null;
  }

  /**
   * A subscribe that timed out can exist at Graph, with an ID that no one knows. Graph then refuses
   * each later subscribe with 409 until that subscription expires, and the calendar has no watch
   * for days. So a 409 removes that subscription and subscribes once more. It is replaced, not
   * adopted, because the new one carries the current token and expiry.
   */
  async watch(calendarId: string, url: string, token: string, expiresAt: number): Promise<Watch> {
    let response = await this.subscribe(calendarId, url, token, expiresAt);
    if (response.status === 409) {
      const refused = await graphError(response, "subscribe");
      const leftBehind = await this.subscriptionsFor(calendarId, url);
      if (leftBehind.length === 0) throw refused;
      for (const id of leftBehind) await this.unwatch({ id, resourceId: null, expiresAt: 0 });
      response = await this.subscribe(calendarId, url, token, expiresAt);
    }
    if (!response.ok) throw await graphError(response, "subscribe");
    const body = subscriptionSchema.parse(await response.json());
    return { id: body.id, resourceId: null, expiresAt: Date.parse(body.expirationDateTime) };
  }

  private subscribe(
    calendarId: string,
    url: string,
    token: string,
    expiresAt: number,
  ): Promise<Response> {
    return graphFetch(
      `${GRAPH}/subscriptions`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          changeType: "created,updated,deleted",
          notificationUrl: url,
          resource: `me/calendars/${calendarId}/events`,
          expirationDateTime: new Date(expiresAt).toISOString(),
          clientState: token,
        }),
      },
      "subscribe",
    );
  }

  /**
   * IDs of this deployment's subscriptions for a calendar. The notification URL tells them from
   * those of another deployment with the same app. Only the calendar ID of `resource` counts,
   * because Graph can return the path in another form.
   */
  private async subscriptionsFor(calendarId: string, url: string): Promise<string[]> {
    const ids: string[] = [];
    let next: string | undefined = `${GRAPH}/subscriptions`;
    while (next) {
      const page = subscriptionListSchema.parse(await this.get(next));
      for (const item of page.value) {
        if (item.notificationUrl === url && item.resource?.includes(calendarId)) ids.push(item.id);
      }
      next = page["@odata.nextLink"];
    }
    return ids;
  }

  async renew(watch: Watch, expiresAt: number): Promise<Watch | null> {
    const response = await graphFetch(
      `${GRAPH}/subscriptions/${encodeURIComponent(watch.id)}`,
      {
        method: "PATCH",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ expirationDateTime: new Date(expiresAt).toISOString() }),
      },
      "renew",
    );
    // A subscription Graph already removed cannot be extended; the caller subscribes again.
    if (response.status === 404) return null;
    if (!response.ok) throw await graphError(response, "renew");
    const body = subscriptionSchema.parse(await response.json());
    return { ...watch, expiresAt: Date.parse(body.expirationDateTime) };
  }

  async unwatch(watch: Watch): Promise<void> {
    const response = await graphFetch(
      `${GRAPH}/subscriptions/${encodeURIComponent(watch.id)}`,
      { method: "DELETE", headers: this.headers() },
      "unsubscribe",
    );
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
    fields: SourceFields = {},
  ): Promise<unknown[]> {
    const params = new URLSearchParams({
      startDateTime: window.start.toISOString(),
      endDateTime: window.end.toISOString(),
      $select: graphEventSelect(fields),
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
    this.onRead();
    const response = await graphFetch(url, { headers: this.headers() }, "GET");
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

/** `providerFetch` for Graph. A timeout is a GraphError, in the message format of the others. */
function graphFetch(
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<Response> {
  return providerFetch(
    url,
    init,
    timeoutMs,
    () =>
      new GraphError(
        TIMEOUT_STATUS,
        providerErrorMessage("Graph", what, TIMEOUT_STATUS, TIMEOUT_REASON),
        undefined,
        TIMEOUT_REASON,
      ),
  );
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

/**
 * Graph event body for a block. No attendees, so that no invitations are sent. An all-day block
 * needs `allDayZone`: Graph keeps the instant of the write, so a block in another zone than the
 * mailbox lies beside the local day. A read under UTC returns the same dates for each zone.
 */
export function toGraphBlock(block: DesiredBlock, ruleTag: string, allDayZone = "UTC") {
  const time = (value: string) =>
    block.allDay
      ? { dateTime: `${value}T00:00:00`, timeZone: allDayZone }
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
