import type { Provider } from "../config";
import type { BatchResult } from "../sync/throttle";
import type { ExistingBlock, SourceEvent, SyncAction } from "../sync/types";
import { GoogleCalendar } from "./google-calendar";
import { GraphCalendar } from "./graph-calendar";

export interface CalendarInfo {
  id: string;
  name: string;
  canEdit: boolean;
  isDefault: boolean;
  /**
   * True if the account owns the calendar. Only owned calendars are offered as targets, so that a
   * calendar shared by a colleague with edit rights never receives blocks by accident.
   */
  owned: boolean;
}

/** A change subscription at the provider: a Graph subscription or a Google channel. */
export interface Watch {
  id: string;
  /** Google's resource ID, needed to stop a channel; null for Graph. */
  resourceId: string | null;
  /** Unix milliseconds. */
  expiresAt: number;
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

/**
 * One adapter per provider. The sync engine only talks to this interface; the account's provider
 * decides which adapter it gets.
 */
export interface CalendarClient {
  /** Writes per batch request. */
  readonly batchLimit: number;
  listCalendars(): Promise<CalendarInfo[]>;
  /** Every occurrence in the window, series expanded, with our own blocks recognisable. */
  sourceEvents(
    calendarId: string,
    window: TimeWindow,
    options?: { withBody?: boolean },
  ): Promise<SourceEvent[]>;
  /** Blocks in the window that carry one of the given rule tags. */
  existingBlocks(
    calendarId: string,
    window: TimeWindow,
    ruleTags: readonly string[],
  ): Promise<ExistingBlock[]>;
  /**
   * Ask the provider to call `url` when events of the calendar change. `token` comes back with
   * every notification, so that the Worker can tell real ones from forged ones.
   */
  watch(calendarId: string, url: string, token: string, expiresAt: number): Promise<Watch>;
  /** Extend a watch. Null if the provider cannot extend one; then watch again and stop the old one. */
  renew(watch: Watch, expiresAt: number): Promise<Watch | null>;
  /** Stop a watch. A watch that is already gone counts as stopped. */
  unwatch(watch: Watch): Promise<void>;
  /** Apply up to `batchLimit` actions; already deleted blocks count as success. */
  applyBatch(calendarId: string, ruleTag: string, actions: SyncAction[]): Promise<BatchResult>;
}

/**
 * The same client, but each call waits until the previous one finished. `run` queues the calls.
 */
export function oneCallAtATime(
  client: CalendarClient,
  run: <T>(call: () => Promise<T>) => Promise<T>,
): CalendarClient {
  return {
    batchLimit: client.batchLimit,
    listCalendars: () => run(() => client.listCalendars()),
    sourceEvents: (...args) => run(() => client.sourceEvents(...args)),
    existingBlocks: (...args) => run(() => client.existingBlocks(...args)),
    applyBatch: (...args) => run(() => client.applyBatch(...args)),
    watch: (...args) => run(() => client.watch(...args)),
    renew: (...args) => run(() => client.renew(...args)),
    unwatch: (...args) => run(() => client.unwatch(...args)),
  };
}

export function calendarClient(provider: Provider, accessToken: string): CalendarClient {
  return provider === "microsoft"
    ? new GraphCalendar(accessToken)
    : new GoogleCalendar(accessToken);
}
