/**
 * The scenario format and the driver interface of the suite. Scenarios speak of `source` and
 * `target` only. See `suite/v1/README.md` for the format and `suite/README.md` for the drivers.
 */

export type CalendarSide = "source" | "target";

export interface EventFields {
  /** A time expression; see `resolveTime`. */
  start?: string;
  end?: string;
  /** IANA zone of a wall-clock `start` and `end`, which are expressions without `Z`. */
  timeZone?: string;
  title?: string;
  location?: string;
  description?: string;
  attendees?: string[];
  availability?: "busy" | "free" | "tentative";
  visibility?: "private";
  status?: "cancelled";
  response?: "declined";
  repeat?: { every: "day" | "week"; count: number };
}

export interface Expectation {
  /** Default: the target. */
  calendar?: CalendarSide;
  /** Start and end of the time span that the check looks at. */
  window: [string, string];
  /** Instants that must be busy. With `busy` or `busyDates`, all other time must be free. */
  busy?: [string, string][];
  /** Date ranges, end exclusive, that must be busy in the time zone of the calendar. */
  busyDates?: [string, string][];
  /** Two entries with the same times are a failure. Merged entries are not. */
  noDuplicates?: boolean;
  /** Text that no field of any entry may hold. */
  forbidden?: string[];
  /** Text that at least one entry must hold. */
  required?: string[];
  /** Entries that must exist in the window. A data check needs one, or it proves nothing. */
  minEntries?: number;
}

export type Step =
  | {
      do: "write";
      calendar?: CalendarSide;
      change: "create" | "update" | "delete" | "update-occurrence" | "delete-occurrence";
      key: string;
      occurrence?: number;
      event?: EventFields;
    }
  | {
      do: "sync";
      expect: Expectation;
      /** Default 900. */
      timeoutSeconds?: number;
      /** Time to let pass after the expectation holds, before the final check. */
      settleSeconds?: number;
    }
  | ({ do: "expect" } & Expectation)
  | ({ do: "control" } & ControlAction)
  | { do: "wait-for-fault"; timeoutSeconds?: number }
  | { do: "expect-no-calls" | "expect-calls"; calendar: CalendarSide; seconds: number }
  | { do: "advance"; to: string };

export type ControlAction =
  | {
      action: "throttle-reads" | "throttle-writes";
      calendar: CalendarSide;
      retryAfterSeconds: number;
    }
  | { action: "fail-writes"; calendar: CalendarSide; status: number; actions: number }
  | { action: "refuse-token" | "reconnect" | "disconnect"; calendar: CalendarSide };

/** What a scenario needs beyond writing, reading and waiting. */
export type Capability =
  | "clock"
  | "faults"
  | "provider-calls"
  | "account-state"
  | "disconnect"
  | "detail-levels";

export const CAPABILITIES: readonly Capability[] = [
  "clock",
  "faults",
  "provider-calls",
  "account-state",
  "disconnect",
  "detail-levels",
];

export interface RuleSettings {
  /** Default 30. */
  daysAhead?: number;
  /** `both` adds a second rule from target to source. */
  direction?: "one-way" | "both";
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  /** `full` copies title, location and description of events that are not private. */
  detail?: "busy" | "full";
  workingHours?: { days: number[]; start: string; end: string; timeZone: string };
}

export interface Scenario {
  id: string;
  title: string;
  /** The item of the coverage list that the scenario belongs to. */
  covers: string;
  /** The hand-written target state in one or two sentences. */
  expectedText: string;
  /** What a run on simulated calendars cannot show for this scenario, in one sentence. */
  localLimit?: string;
  /** Zone of the `dst-spring` and `dst-fall` anchors. */
  anchorZone?: string;
  requires?: Capability[];
  calendars: Record<CalendarSide, { timeZone: string }>;
  rule?: RuleSettings;
  steps: Step[];
}

export interface Manifest {
  suite: string;
  version: string;
  frozenAt: string;
  scenarios: string[];
}

/** A resolved time: a date for an all-day event, or a wall-clock time in an IANA zone. */
export type EventTime = { date: string } | { dateTime: string; timeZone: string };

/** An event as a driver gets it: every time is resolved, and no expression is left. */
export interface ResolvedEvent extends Omit<EventFields, "start" | "end" | "timeZone"> {
  start?: EventTime;
  end?: EventTime;
}

export interface CalendarChange {
  change: "create" | "update" | "delete" | "update-occurrence" | "delete-occurrence";
  key: string;
  occurrence?: number;
  event?: ResolvedEvent;
}

/** One event or block as a calendar shows it. */
export interface CalendarEntry {
  /** ISO instant, or YYYY-MM-DD with `allDay`. */
  start: string;
  end: string;
  allDay: boolean;
  status: "busy" | "free";
  title?: string;
  location?: string;
  description?: string;
  attendees?: string[];
  /** The ID in the calendar. A live run needs it to name an entry that may stay. */
  id?: string;
  /**
   * Who wrote the entry: `suite` if it holds the suite marker, `tool` for a block of the tool under
   * test. With any other value or none, the entry is foreign. A live run refuses to start on
   * foreign entries.
   */
  owner?: "suite" | "tool";
}

export interface DriverSetup {
  scenario: Pick<Scenario, "id" | "calendars" | "rule">;
  direction: string;
}

/** The mark of every event that the suite writes. An adapter deletes nothing without it. */
export const SUITE_MARKER = "calendar-sync-conformance-suite";

/**
 * Thrown by `prepare` if the tool cannot run a scenario, for example without a buffer setting. The
 * scenario then counts as `not_run`, not as a failure.
 */
export class UnsupportedScenario extends Error {}

/** Thrown if a run must not go on, for example on a calendar with foreign entries. */
export class SuiteAbort extends Error {}

/** The tool under test. A driver for another tool implements this interface and nothing else. */
export interface SuiteDriver {
  readonly name: string;
  /** `real-time` for real calendars. `simulated-clock` if the calendars or the clock are not real. */
  readonly mode: "real-time" | "simulated-clock";
  /** `adapter` if an outside program stated `mode`. The suite cannot verify that. Default `driver`. */
  readonly modeSource?: "driver" | "adapter";
  /** The IDs of foreign entries that the checks do not see. Default 0. */
  readonly allowForeign?: number;
  /** The time between two reads while a run waits. A latency value lies on this grid. */
  readonly pollMs?: number;
  readonly capabilities: ReadonlySet<Capability>;
  /** Scenario runs per direction, for example of the two calendar systems of a pair. */
  readonly directions: readonly string[];
  /** Milliseconds since the epoch, on the clock of the run. */
  now(): number;
  /** Start from two calendars without events and the rule of the scenario. */
  prepare(setup: DriverSetup): Promise<void>;
  write(calendar: CalendarSide, change: CalendarChange): Promise<void>;
  read(calendar: CalendarSide, window: { start: string; end: string }): Promise<CalendarEntry[]>;
  /**
   * Let the tool work until `until` holds or `timeoutSeconds` passed. Without `until`, wait the
   * whole time. Returns true if `until` held.
   */
  waitForSync(wait: { until?: () => Promise<boolean>; timeoutSeconds: number }): Promise<boolean>;
  /** Needs `clock`: move the clock to an instant. */
  advance?(to: number): Promise<void>;
  /** Needs `faults`, `account-state` or `disconnect`, by action. */
  control?(action: ControlAction): Promise<void>;
  /** Needs `faults` or `account-state`: true if every injected fault has fired. */
  faultsFired?(): Promise<boolean>;
  /** Needs `provider-calls`: all calls so far to the calendar system of one side. */
  providerCalls?(calendar: CalendarSide): Promise<number>;
  /** Remove what the scenario left behind. */
  cleanup(): Promise<void>;
}
