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
  /** Blocks in the window that carry the given rule tag. */
  existingBlocks(calendarId: string, window: TimeWindow, ruleTag: string): Promise<ExistingBlock[]>;
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
  };
}

export function calendarClient(provider: Provider, accessToken: string): CalendarClient {
  return provider === "microsoft"
    ? new GraphCalendar(accessToken)
    : new GoogleCalendar(accessToken);
}
