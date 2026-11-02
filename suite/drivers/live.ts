import {
  SUITE_MARKER,
  SuiteAbort,
  UnsupportedScenario,
  type CalendarChange,
  type CalendarEntry,
  type CalendarSide,
  type Capability,
  type ControlAction,
  type DriverSetup,
  type SuiteDriver,
} from "../lib/scenario.ts";

/**
 * The time between two reads of the target while the run waits for a sync. A latency sample ends at
 * the first read that shows the block, so it can be this much too high.
 */
const POLL_MS = 10_000;
const DAY_MS = 86_400_000;
/** The span that the lock reads. It holds the sync window of every scenario and the days before. */
const LOCK_DAYS_BACK = 35;
const LOCK_DAYS_AHEAD = 400;
/** The only values of `owner` that are no foreign entry. */
const OWNERS: readonly unknown[] = ["suite", "tool"];

const isForeign = (entry: CalendarEntry) => !OWNERS.includes(entry.owner);
const isObject = (value: unknown) => typeof value === "object" && value !== null;

/**
 * A foreign entry and the key that the lock keeps it under: calendar, owner, and ID or times. The
 * key holds the owner, so an entry with a new owner counts as gone.
 */
type ForeignEntry = CalendarEntry & { key: string };

function foreignEntry(calendar: CalendarSide, entry: CalendarEntry): ForeignEntry {
  const identity = entry.id ?? `${entry.start}/${entry.end}`;
  return { ...entry, key: JSON.stringify([calendar, entry.owner, identity]) };
}

export type AdapterRequest =
  | { op: "describe" }
  | ({ op: "prepare"; marker: string } & DriverSetup)
  | { op: "write"; calendar: CalendarSide; change: CalendarChange; marker: string }
  | { op: "read"; calendar: CalendarSide; window: { start: string; end: string } }
  | { op: "control"; control: ControlAction }
  | { op: "faults-fired" }
  | { op: "provider-calls"; calendar: CalendarSide }
  | { op: "cleanup"; marker: string };

export interface AdapterDescription {
  name: string;
  /**
   * Required. `simulated-clock` if the calendars or the clock of the adapter are not real. The suite
   * cannot verify this statement, so a result gives `modeSource: "adapter"`.
   */
  mode: SuiteDriver["mode"];
  /** Default `["forward"]`. */
  directions?: string[];
  capabilities?: Capability[];
}

/**
 * The answer of an adapter. `unsupported` turns the scenario into `not_run`. `value` carries the
 * result of the operation. On an error the adapter ends with an exit code other than 0: the suite
 * cannot tell an empty list from a read that failed.
 */
export interface AdapterResponse {
  unsupported?: string;
  value?: unknown;
}

export type Adapter = (request: AdapterRequest) => Promise<AdapterResponse>;

/**
 * The stdout of an adapter, where no output is an empty answer. The output can hold calendar data,
 * so the error does not repeat it.
 */
export function parseAdapterAnswer(op: AdapterRequest["op"], stdout: string): AdapterResponse {
  if (!stdout.trim()) return {};
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    answer = null;
  }
  if (!isObject(answer) || Array.isArray(answer)) {
    throw new SuiteAbort(`The adapter gave no JSON object on ${op}.`);
  }
  return answer as AdapterResponse;
}

export interface LiveOptions {
  pollMs?: number;
  /** IDs of foreign entries that may stay in the calendars. The checks do not see them. */
  allowForeign?: readonly string[];
}

/**
 * The scaffold for a run against real calendars. It holds no credentials and no calendar IDs:
 * every calendar access goes to an adapter from outside, so it works for any tool. The clock is the
 * real clock, so scenarios that need `clock` stay `not_run`.
 *
 * A lock protects real calendars: the adapter deletes only entries with `SUITE_MARKER`, and no
 * `prepare` reaches it while a calendar holds a foreign entry that `allowForeign` does not name. A
 * foreign entry must then stay until the run ends, also one that came during a scenario. So the lock
 * reads both calendars before and after every `prepare` and before every `cleanup`. It reads them
 * after a `cleanup` only if it keeps a foreign entry.
 */
export class LiveDriver implements SuiteDriver {
  mode: SuiteDriver["mode"] = "real-time";
  readonly modeSource = "adapter";
  readonly pollMs: number;
  name = "live";
  capabilities: ReadonlySet<Capability> = new Set();
  directions: readonly string[] = ["forward"];

  private readonly adapter: Adapter;
  private readonly named: ReadonlySet<string>;
  /** The keys of the foreign entries that any read saw in this run. */
  private readonly kept = new Set<string>();
  /** True between a `prepare` that passed the lock and its `cleanup`. */
  private prepared = false;

  constructor(adapter: Adapter, { pollMs = POLL_MS, allowForeign = [] }: LiveOptions = {}) {
    this.adapter = adapter;
    this.pollMs = pollMs;
    this.named = new Set(allowForeign);
  }

  get allowForeign(): number {
    return this.named.size;
  }

  /** Ask the adapter what it can do. */
  async start(): Promise<this> {
    const { value } = await this.adapter({ op: "describe" });
    const description = value as AdapterDescription;
    if (description.mode !== "real-time" && description.mode !== "simulated-clock") {
      throw new SuiteAbort("The adapter must name its mode: real-time or simulated-clock.");
    }
    this.mode = description.mode;
    this.name = `live:${description.name}`;
    this.capabilities = new Set(description.capabilities ?? []);
    this.directions = description.directions ?? ["forward"];
    return this;
  }

  private async call(request: AdapterRequest): Promise<unknown> {
    const { unsupported, value } = await this.adapter(request);
    if (unsupported) throw new UnsupportedScenario(unsupported);
    return value;
  }

  now(): number {
    return Date.now();
  }

  private async entries(
    calendar: CalendarSide,
    window: { start: string; end: string },
  ): Promise<CalendarEntry[]> {
    const value = await this.call({ op: "read", calendar, window });
    if (!Array.isArray(value) || !value.every(isObject)) {
      throw new SuiteAbort(`The adapter gave no list of entries for the ${calendar} calendar.`);
    }
    return value as CalendarEntry[];
  }

  /** The entries of both calendars that neither the suite nor the tool wrote. */
  private async foreignEntries(): Promise<ForeignEntry[]> {
    const window = {
      start: new Date(this.now() - LOCK_DAYS_BACK * DAY_MS).toISOString(),
      end: new Date(this.now() + LOCK_DAYS_AHEAD * DAY_MS).toISOString(),
    };
    try {
      const sides = await Promise.all(
        (["source", "target"] as const).map(async (calendar) =>
          (await this.entries(calendar, window))
            .filter(isForeign)
            .map((entry) => foreignEntry(calendar, entry)),
        ),
      );
      return sides.flat();
    } catch (error) {
      if (error instanceof SuiteAbort) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new SuiteAbort(`The lock cannot read the calendars: ${reason}`);
    }
  }

  /** An entry of the lock that is gone, has a new owner, or is no longer foreign stops the run. */
  private checkKept(foreign: readonly ForeignEntry[]): void {
    const left = new Set(foreign.map((entry) => entry.key));
    if ([...this.kept].some((key) => !left.has(key))) {
      throw new SuiteAbort(
        "The adapter deleted a foreign entry or changed its owner. It must keep unmarked entries.",
      );
    }
  }

  /** Check the entries of the lock, and add the ones that came since the last read. */
  private keepForeign(foreign: readonly ForeignEntry[]): void {
    this.checkKept(foreign);
    for (const { key } of foreign) this.kept.add(key);
  }

  async prepare(setup: DriverSetup): Promise<void> {
    const foreign = await this.foreignEntries();
    const unnamed = foreign.filter((entry) => !entry.id || !this.named.has(entry.id));
    if (unnamed.length > 0) {
      const ids = unnamed.map((entry) => entry.id ?? "without ID").join(", ");
      throw new SuiteAbort(
        `${unnamed.length} foreign entries in the calendars: ${ids}. ` +
          "Use empty test calendars, or name the entries with --allow-foreign.",
      );
    }
    this.keepForeign(foreign);
    await this.call({ op: "prepare", ...setup, marker: SUITE_MARKER });
    this.keepForeign(await this.foreignEntries());
    this.prepared = true;
  }

  async write(calendar: CalendarSide, change: CalendarChange): Promise<void> {
    await this.call({ op: "write", calendar, change, marker: SUITE_MARKER });
  }

  async read(
    calendar: CalendarSide,
    window: { start: string; end: string },
  ): Promise<CalendarEntry[]> {
    const entries = await this.entries(calendar, window);
    // This read covers a part of the time, so it adds entries to the lock and checks none.
    for (const entry of entries.filter(isForeign)) {
      this.kept.add(foreignEntry(calendar, entry).key);
    }
    return entries.filter((entry) => !isForeign(entry) || !entry.id || !this.named.has(entry.id));
  }

  async waitForSync(wait: {
    until?: () => Promise<boolean>;
    timeoutSeconds: number;
  }): Promise<boolean> {
    const deadline = this.now() + wait.timeoutSeconds * 1000;
    for (;;) {
      if (wait.until && (await wait.until())) return true;
      const left = deadline - this.now();
      if (left <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(left, this.pollMs)));
    }
  }

  async control(control: ControlAction): Promise<void> {
    await this.call({ op: "control", control });
  }

  async faultsFired(): Promise<boolean> {
    return (await this.call({ op: "faults-fired" })) === true;
  }

  async providerCalls(calendar: CalendarSide): Promise<number> {
    return (await this.call({ op: "provider-calls", calendar })) as number;
  }

  /**
   * Without a `prepare` that passed the lock, the adapter must not touch the calendars. A scenario
   * can bring a foreign entry that no `prepare` saw, so the lock reads again before the adapter
   * deletes anything. If that read fails or an entry is gone, the adapter gets no `cleanup`.
   */
  async cleanup(): Promise<void> {
    if (!this.prepared) return;
    this.prepared = false;
    this.keepForeign(await this.foreignEntries());
    await this.call({ op: "cleanup", marker: SUITE_MARKER });
    if (this.kept.size > 0) this.keepForeign(await this.foreignEntries());
  }
}
