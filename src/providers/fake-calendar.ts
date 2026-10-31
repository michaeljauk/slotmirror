import type { Provider } from "../config";
import { fromGoogleEvent, parseGoogleEvent } from "../sync/google-events";
import { fromGraphEvent, parseGraphEvent } from "../sync/graph-events";
import {
  blockStatusOf,
  type ExistingBlock,
  type ShowAs,
  type SourceEvent,
  type SyncAction,
} from "../sync/types";
import { providerErrorMessage, type BatchResult } from "../sync/throttle";
import type {
  CalendarClient,
  CalendarInfo,
  ChangeFeed,
  SourceFields,
  TimeWindow,
  Watch,
} from "./calendar-client";
import { GRAPH_BATCH_LIMIT, GraphError } from "./graph-calendar";
import { TokenError } from "./oauth-token";

/** Events per page: Graph `$top`, Google `maxResults`. See the two real clients. */
const PAGE_SIZE: Record<Provider, number> = { microsoft: 500, google: 2500 };

/** Writes per batch: Graph `$batch`, Google batch. See the two real clients. */
const BATCH_LIMIT: Record<Provider, number> = { microsoft: GRAPH_BATCH_LIMIT, google: 50 };

const DAY_MS = 86_400_000;
const HALF_HOUR_MS = 1_800_000;
const QUARTER_HOUR_MS = 900_000;

/** The providers of a simulated account. Each reads wire events in its own format. */
export const FAKE_PROVIDERS: readonly Provider[] = ["microsoft", "google"];

/** The operation that counts started alarm steps. It is no provider call. */
const STEP_OPERATION = "alarmStep";

/** A page in real size lies at this path of DEV_FAKE_FETCH_URL. See scripts/probe-sink/. */
export function fakePagePath(provider: Provider): string {
  return `pages/${provider}.json`;
}

/**
 * Parse a page as the real client does and return its number of events. The events stay unused:
 * the page exists for its CPU cost. The sync reads the simulated events.
 */
export function parseFakePage(provider: Provider, body: unknown): number {
  const page = (body ?? {}) as { value?: unknown; items?: unknown };
  const items = provider === "microsoft" ? page.value : page.items;
  if (!Array.isArray(items)) throw new Error("The fetch target served no calendar page");
  const parse = provider === "microsoft" ? parseGraphEvent : parseGoogleEvent;
  for (const item of items as unknown[]) parse(item);
  return items.length;
}

/** How many fetches of one invocation worked, and how the attempts ended. */
export interface FetchBudget {
  /** `limited`: the runtime refused a fetch. `unlimited`: every attempt worked. */
  state: "limited" | "unlimited" | "failed";
  fetches: number;
}

/**
 * Fetch `url` until the runtime refuses or `attempts` are done. Any other error is `failed`, so
 * that a broken target never looks like a limit.
 */
export async function measureFetchBudget(url: string, attempts: number): Promise<FetchBudget> {
  for (let fetches = 0; fetches < attempts; fetches++) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      if (!response.ok) return { state: "failed", fetches };
    } catch (error) {
      const refused = error instanceof Error && /too many subrequests/i.test(error.message);
      return { state: refused ? "limited" : "failed", fetches };
    }
  }
  return { state: "unlimited", fetches: attempts };
}

/** The pages a read of `items` events costs at this provider. An empty read costs one page. */
export function fakePages(items: number, provider: Provider): number {
  return Math.max(1, Math.ceil(items / PAGE_SIZE[provider]));
}

/** The variables that shape the simulation. Both matter only with DEV_FAKE_CALENDARS=1. */
export type FakeEnv = Pick<Env, "DEV_FAKE_LATENCY_MS" | "DEV_FAKE_FETCH_URL">;

/**
 * A calendar provider for load tests, only with DEV_FAKE_CALENDARS=1. Each account's blocks live
 * in the SQLite storage of its own Durable Object, so the sync engine, the queues and the RPC
 * between instances run as in production; only Graph and Google are replaced.
 *
 * Reads cost pages as at the real provider, and a target read scans the native events too. Every
 * page and every batch counts as one call. With DEV_FAKE_FETCH_URL, a call is also one real
 * `fetch`, so that the Workers subrequest limit applies as it does with a real provider. A read
 * also fetches and parses a page in real size, so that its CPU cost is real too.
 */
export class FakeCalendar implements CalendarClient {
  readonly batchLimit: number;

  private readonly latencyMs: number;
  private readonly fetchUrl: string | null;

  private readonly readsFail: () => void;

  constructor(
    private readonly sql: SqlStorage,
    private readonly provider: Provider,
    env: FakeEnv = {},
  ) {
    ensureTables(sql);
    this.readsFail = () => {
      failRead(sql);
    };
    this.batchLimit = BATCH_LIMIT[provider];
    this.latencyMs = Number(env.DEV_FAKE_LATENCY_MS ?? 0);
    this.fetchUrl = env.DEV_FAKE_FETCH_URL || null;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    await this.call("listCalendars");
    return [
      {
        id: "main",
        name: "Calendar",
        canEdit: true,
        isDefault: true,
        owned: true,
        dataOwned: true,
      },
    ];
  }

  async sourceEvents(
    calendarId: string,
    window: TimeWindow,
    options: SourceFields = {},
  ): Promise<SourceEvent[]> {
    const natives = this.natives(calendarId, window);
    const stored = this.blockRows(calendarId, window);
    const wire = wireEvents(this.sql, calendarId, this.provider, window, options);
    await this.readPages(
      "sourceEvents",
      natives.rows.length + stored.rows.length + wire.length,
      natives.rowsRead + stored.rowsRead,
    );
    this.readsFail();
    const events = natives.rows.map((event) => ({
      occurrenceKey: `event:${event.id}`,
      start: event.start,
      end: event.end,
      allDay: event.allDay ?? false,
      showAs: event.showAs ?? "busy",
      isPrivate: event.isPrivate ?? false,
      declined: false,
      categories: [],
      subject: event.subject ?? "Meeting",
      location: "",
      body: "",
      isMirror: false,
      ...(options.withLink
        ? { link: `https://calendar.invalid/event?id=${encodeURIComponent(event.id)}` }
        : {}),
    }));
    // Blocks other rules wrote into this calendar are events too; the loop guard skips them.
    const mirrors = stored.rows.map((row) => ({
      occurrenceKey: `event:${row.id}`,
      start: row.start,
      end: row.end,
      allDay: row.all_day === 1,
      showAs: row.show_as,
      isPrivate: row.is_private === 1,
      declined: false,
      categories: [],
      subject: "Busy",
      location: "",
      body: "",
      isMirror: true,
    }));
    return [...events, ...wire, ...mirrors];
  }

  async existingBlocks(
    calendarId: string,
    window: TimeWindow,
    ruleTags: readonly string[],
  ): Promise<ExistingBlock[]> {
    const blocks = await this.readBlocks("existingBlocks", calendarId, window);
    return blocks.filter((block) => ruleTags.includes(block.ruleTag));
  }

  async allBlocks(calendarId: string, window: TimeWindow): Promise<ExistingBlock[]> {
    return this.readBlocks("allBlocks", calendarId, window);
  }

  async applyBatch(
    calendarId: string,
    ruleTag: string,
    actions: SyncAction[],
  ): Promise<BatchResult> {
    // The request comes first: a batch whose request fails writes nothing.
    await this.network();
    const writtenIds: string[] = [];
    let rowsWritten = 0;
    let blocks = 0;
    const refused = refusedWrites(this.sql, actions.length);
    for (const action of actions.slice(refused?.actions ?? 0)) {
      if (action.kind === "delete") {
        const removed = this.sql.exec(`DELETE FROM fake_blocks WHERE id = ?`, action.targetId);
        removed.toArray();
        rowsWritten += removed.rowsWritten;
        if (removed.rowsWritten > 0) blocks -= 1;
        else deleteOwnEvent(this.sql, calendarId, action.targetId);
        writtenIds.push(action.targetId);
        continue;
      }
      const id = action.kind === "update" ? action.targetId : crypto.randomUUID();
      writtenIds.push(id);
      const { block } = action;
      const { marker, contentHash, dedupKey, start, end, showAs, isPrivate, allDay, ...content } =
        block;
      const written = this.sql.exec(
        `INSERT OR REPLACE INTO fake_blocks
         (id, calendar_id, rule_tag, marker, content_hash, dedup_key, start, end, show_as,
          is_private, all_day, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        calendarId,
        ruleTag,
        marker,
        contentHash,
        dedupKey,
        start,
        end,
        showAs,
        isPrivate ? 1 : 0,
        allDay ? 1 : 0,
        JSON.stringify(content),
      );
      written.toArray();
      rowsWritten += written.rowsWritten;
      if (action.kind === "create") blocks += 1;
    }
    this.record("applyBatch", { rowsWritten, blocks });
    return { failed: 0, throttled: 0, statuses: {}, writtenIds, ...refused?.outcome };
  }

  async watch(): Promise<Watch> {
    await this.call("watch");
    return { id: crypto.randomUUID(), resourceId: null, expiresAt: Date.now() + 6 * DAY_MS };
  }

  async renew(watch: Watch, expiresAt: number): Promise<Watch | null> {
    await this.call("renew");
    return { ...watch, expiresAt };
  }

  async unwatch(): Promise<void> {
    await this.call("unwatch");
  }

  changesSince(): Promise<ChangeFeed | null> {
    return Promise.resolve(null);
  }

  /** The seeded events and the events that a test added, in the window. */
  private natives(calendarId: string, window: TimeWindow): { rows: FakeEvent[]; rowsRead: number } {
    // The seed computes its events, so they take no storage rows.
    const seed = this.sql.exec<StoredSeed>(`SELECT * FROM fake_seed`).toArray()[0];
    const cursor = this.sql.exec<{
      id: string;
      start: string;
      end: string;
      subject: string;
      private: number;
      show_as: ShowAs;
      all_day: number;
    }>(
      `SELECT id, start, end, subject, private, show_as, all_day FROM fake_events
       WHERE calendar_id = ? AND end > ? AND start < ?`,
      calendarId,
      window.start.toISOString(),
      window.end.toISOString(),
    );
    const added = cursor.toArray().map((row) => ({
      id: row.id,
      start: row.start,
      end: row.end,
      subject: row.subject,
      showAs: row.show_as,
      isPrivate: row.private === 1,
      allDay: row.all_day === 1,
    }));
    const seeded = seed ? fakeEvents(seed, window) : [];
    return { rows: [...seeded, ...added], rowsRead: cursor.rowsRead };
  }

  private blockRows(
    calendarId: string,
    window: TimeWindow,
  ): { rows: BlockRow[]; rowsRead: number } {
    const cursor = this.sql.exec<BlockRow>(
      `SELECT * FROM fake_blocks WHERE calendar_id = ? AND end > ? AND start < ?`,
      calendarId,
      window.start.toISOString(),
      window.end.toISOString(),
    );
    const rows = cursor.toArray();
    return { rows, rowsRead: cursor.rowsRead };
  }

  private blocks(rows: BlockRow[]): ExistingBlock[] {
    return rows.map((row) => ({
      targetId: row.id,
      ruleTag: row.rule_tag,
      marker: row.marker,
      contentHash: row.content_hash,
      dedupKey: row.dedup_key,
      start: row.start,
      end: row.end,
      allDay: row.all_day === 1,
      status: blockStatusOf(row.show_as),
    }));
  }

  /**
   * Read the blocks of a calendar. Both real clients list the whole calendar and filter here, so
   * native events cost pages too.
   */
  private async readBlocks(
    operation: string,
    calendarId: string,
    window: TimeWindow,
  ): Promise<ExistingBlock[]> {
    const natives = this.natives(calendarId, window);
    const stored = this.blockRows(calendarId, window);
    await this.readPages(
      operation,
      natives.rows.length + stored.rows.length,
      natives.rowsRead + stored.rowsRead,
    );
    this.readsFail();
    return this.blocks(stored.rows);
  }

  /** One call per page, one after the other, as the real clients follow their page links. */
  private async readPages(operation: string, items: number, rowsRead: number): Promise<void> {
    const pages = fakePages(items, this.provider);
    for (let page = 0; page < pages; page++) {
      await this.network(true);
      this.record(operation, { rowsRead: page === 0 ? rowsRead : 0 });
    }
  }

  private async call(operation: string, rowsRead = 0): Promise<void> {
    await this.network();
    this.record(operation, { rowsRead });
  }

  /** What one provider call costs the Worker: a real subrequest if set up, and the wait. */
  private async network(page = false): Promise<void> {
    if (this.fetchUrl) {
      // An error stays an error: the subrequest limit of the Workers runtime surfaces here.
      const url = page ? new URL(fakePagePath(this.provider), this.fetchUrl).href : this.fetchUrl;
      const response = await fetch(url);
      if (!response.ok) {
        await response.arrayBuffer();
        throw new Error(`The simulated provider call got ${response.status}`);
      }
      if (page) parseFakePage(this.provider, await response.json());
      else await response.arrayBuffer();
    }
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }

  private record(
    operation: string,
    { rowsWritten = 0, rowsRead = 0, blocks = 0 }: Partial<Record<UsageField, number>>,
  ): void {
    this.sql.exec(
      `INSERT INTO fake_calls (operation, count, rows_written, rows_read, blocks)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT (operation) DO UPDATE SET
         count = count + 1,
         rows_written = rows_written + excluded.rows_written,
         rows_read = rows_read + excluded.rows_read,
         blocks = blocks + excluded.blocks`,
      operation,
      rowsWritten,
      rowsRead,
      blocks,
    );
  }
}

type UsageField = "rowsWritten" | "rowsRead" | "blocks";

interface StoredSeed extends Record<string, SqlStorageValue> {
  account: number;
  accounts: number;
  count: number;
  start_ms: number;
  span_ms: number;
  /** The first events of the seed that a burst of changes moved. */
  shifted: number;
}

/**
 * The account's events, computed from the seed. They spread evenly over the span, and every
 * account of the seed takes its own time slots, so that no two events of a seed look the same.
 * The dedup rule would otherwise merge the events of two sources into one block.
 */
function fakeEvents(seed: StoredSeed, window: TimeWindow): FakeEvent[] {
  const step = seed.span_ms / (seed.count * seed.accounts);
  const from = window.start.getTime();
  const to = window.end.getTime();
  const events: FakeEvent[] = [];
  for (let i = 0; i < seed.count; i++) {
    const start = seed.start_ms + Math.floor((i * seed.accounts + seed.account - 1) * step);
    const shift = i < seed.shifted ? QUARTER_HOUR_MS : 0;
    const end = start + (1 + (i % 4)) * HALF_HOUR_MS + shift;
    if (end <= from || start >= to) continue;
    events.push({
      id: `${seed.account}-${i}`,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      subject: `Meeting ${seed.account}.${i}`,
      isPrivate: i % 10 === 0,
    });
  }
  return events;
}

type BlockRow = {
  id: string;
  calendar_id: string;
  rule_tag: string;
  marker: string;
  content_hash: string;
  dedup_key: string;
  start: string;
  end: string;
  show_as: ShowAs;
  is_private: number;
  all_day: number;
  content: string;
};

function ensureTables(sql: SqlStorage): void {
  // Events that a test adds one by one. The seed stores none of its events here.
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_events (
    id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
    subject TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 0,
    show_as TEXT NOT NULL DEFAULT 'busy', all_day INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_seed (
    id INTEGER PRIMARY KEY CHECK (id = 1), account INTEGER NOT NULL, accounts INTEGER NOT NULL,
    count INTEGER NOT NULL, start_ms INTEGER NOT NULL, span_ms INTEGER NOT NULL,
    shifted INTEGER NOT NULL DEFAULT 0)`);
  // WITHOUT ROWID: a second index on the key would add a billed row to every block.
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_blocks (
    id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, rule_tag TEXT NOT NULL, marker TEXT NOT NULL,
    content_hash TEXT NOT NULL, dedup_key TEXT NOT NULL DEFAULT '', start TEXT NOT NULL,
    end TEXT NOT NULL, show_as TEXT NOT NULL DEFAULT 'busy',
    is_private INTEGER NOT NULL DEFAULT 1, all_day INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '{}') WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_calls (
    operation TEXT PRIMARY KEY, count INTEGER NOT NULL, rows_written INTEGER NOT NULL DEFAULT 0,
    rows_read INTEGER NOT NULL DEFAULT 0, blocks INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_faults (
    id INTEGER PRIMARY KEY AUTOINCREMENT, error TEXT NOT NULL, count INTEGER NOT NULL,
    retry_after_ms INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_write_faults (
    id INTEGER PRIMARY KEY AUTOINCREMENT, status INTEGER NOT NULL, actions INTEGER,
    retry_after_ms INTEGER)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_wire_events (
    id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, spec TEXT NOT NULL)`);
  // Tables from before these columns existed.
  addColumns(sql, "fake_events", {
    show_as: `TEXT NOT NULL DEFAULT 'busy'`,
    all_day: `INTEGER NOT NULL DEFAULT 0`,
  });
  addColumns(sql, "fake_blocks", {
    dedup_key: `TEXT NOT NULL DEFAULT ''`,
    show_as: `TEXT NOT NULL DEFAULT 'busy'`,
    is_private: `INTEGER NOT NULL DEFAULT 1`,
    all_day: `INTEGER NOT NULL DEFAULT 0`,
    content: `TEXT NOT NULL DEFAULT '{}'`,
  });
  addColumns(sql, "fake_faults", { retry_after_ms: `INTEGER` });
  addColumns(sql, "fake_calls", {
    rows_written: `INTEGER NOT NULL DEFAULT 0`,
    rows_read: `INTEGER NOT NULL DEFAULT 0`,
    blocks: `INTEGER NOT NULL DEFAULT 0`,
  });
}

function addColumns(sql: SqlStorage, table: string, wanted: Record<string, string>): void {
  const present = sql
    .exec(`PRAGMA table_info(${table})`)
    .toArray()
    .map((row) => row.name);
  for (const [column, type] of Object.entries(wanted)) {
    if (!present.includes(column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** How the next provider reads of a simulated account fail. */
type FakeReadError = "throttled" | "server" | "gone" | "token" | "subrequests";

/**
 * A fault for a comparison test. The `block_` faults change the block with the earliest start. A
 * copy keeps the marker and the tag, unless the fault names others.
 */
export type FakeFault =
  | { kind: "block_deleted" }
  | { kind: "block_shifted"; minutes: number }
  | { kind: "block_stretched"; minutes: number }
  | { kind: "block_status"; status: ShowAs }
  | { kind: "block_copied"; ruleTag?: string; marker?: string }
  | { kind: "reads_fail"; error: FakeReadError; count?: number; retryAfterMs?: number }
  /** The next write batch refuses its first `actions` writes, or all of them without a number. */
  | { kind: "writes_fail"; status: number; actions?: number; retryAfterMs?: number };

/** The error that a provider read gives, as the real adapter and the token client throw it. */
function readError(error: FakeReadError, retryAfterMs = 1000): Error {
  const graph = (status: number) =>
    new GraphError(
      status,
      providerErrorMessage("Graph", "fake read", status, undefined),
      retryAfterMs,
    );
  if (error === "throttled") return graph(429);
  if (error === "server") return graph(500);
  if (error === "gone") return graph(404);
  if (error === "token") return new TokenError("invalid_grant");
  return new Error("Too many subrequests.");
}

/** Throw the next injected read fault, if any. */
function failRead(sql: SqlStorage): void {
  const fault = sql
    .exec<{ id: number; error: FakeReadError; count: number; retry_after_ms: number | null }>(
      `SELECT id, error, count, retry_after_ms FROM fake_faults ORDER BY id LIMIT 1`,
    )
    .toArray()[0];
  if (!fault) return;
  if (fault.count > 1) {
    sql.exec(`UPDATE fake_faults SET count = count - 1 WHERE id = ?`, fault.id);
  } else {
    sql.exec(`DELETE FROM fake_faults WHERE id = ?`, fault.id);
  }
  throw readError(fault.error, fault.retry_after_ms ?? undefined);
}

/** The writes that the next write fault refuses, and the outcome that a real batch reports. */
function refusedWrites(
  sql: SqlStorage,
  batchSize: number,
): { actions: number; outcome: Omit<BatchResult, "writtenIds"> } | null {
  const fault = sql
    .exec<{ id: number; status: number; actions: number | null; retry_after_ms: number | null }>(
      `SELECT id, status, actions, retry_after_ms FROM fake_write_faults ORDER BY id LIMIT 1`,
    )
    .toArray()[0];
  if (!fault) return null;
  sql.exec(`DELETE FROM fake_write_faults WHERE id = ?`, fault.id);
  const actions = Math.min(fault.actions ?? batchSize, batchSize);
  const statuses = { [String(fault.status)]: actions };
  const throttled = fault.status === 429 || fault.status === 503;
  const outcome = throttled
    ? {
        failed: 0,
        throttled: actions,
        statuses,
        ...(fault.retry_after_ms === null ? {} : { retryAfterMs: fault.retry_after_ms }),
      }
    : { failed: actions, throttled: 0, statuses };
  return { actions, outcome };
}

/** True if an injected read or write fault waits for its turn. */
export function fakeFaultsLeft(sql: SqlStorage): boolean {
  ensureTables(sql);
  const counts = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM fake_faults UNION ALL SELECT COUNT(*) FROM fake_write_faults`,
    )
    .toArray();
  return counts.some((row) => row.n > 0);
}

function plusMinutes(time: string, minutes: number): string {
  return new Date(Date.parse(time) + minutes * 60_000).toISOString();
}

/** Apply a fault to this account's simulated calendar. */
export function injectFakeFault(sql: SqlStorage, fault: FakeFault): void {
  ensureTables(sql);
  if (fault.kind === "reads_fail") {
    sql.exec(
      `INSERT INTO fake_faults (error, count, retry_after_ms) VALUES (?, ?, ?)`,
      fault.error,
      fault.count ?? 1,
      fault.retryAfterMs ?? null,
    );
    return;
  }
  if (fault.kind === "writes_fail") {
    sql.exec(
      `INSERT INTO fake_write_faults (status, actions, retry_after_ms) VALUES (?, ?, ?)`,
      fault.status,
      fault.actions ?? null,
      fault.retryAfterMs ?? null,
    );
    return;
  }
  const block = sql.exec<BlockRow>(`SELECT * FROM fake_blocks ORDER BY start LIMIT 1`).toArray()[0];
  if (!block) throw new Error("Simulation has no block");
  switch (fault.kind) {
    case "block_deleted":
      sql.exec(`DELETE FROM fake_blocks WHERE id = ?`, block.id);
      break;
    case "block_shifted":
      sql.exec(
        `UPDATE fake_blocks SET start = ?, end = ? WHERE id = ?`,
        plusMinutes(block.start, fault.minutes),
        plusMinutes(block.end, fault.minutes),
        block.id,
      );
      break;
    case "block_stretched":
      sql.exec(
        `UPDATE fake_blocks SET end = ? WHERE id = ?`,
        plusMinutes(block.end, fault.minutes),
        block.id,
      );
      break;
    case "block_status":
      sql.exec(`UPDATE fake_blocks SET show_as = ? WHERE id = ?`, fault.status, block.id);
      break;
    case "block_copied":
      sql.exec(
        `INSERT INTO fake_blocks
         (id, calendar_id, rule_tag, marker, content_hash, dedup_key, start, end, show_as,
          is_private, all_day, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        block.calendar_id,
        fault.ruleTag ?? block.rule_tag,
        fault.marker ?? block.marker,
        block.content_hash,
        block.dedup_key,
        block.start,
        block.end,
        block.show_as,
        block.is_private,
        block.all_day,
        block.content,
      );
      break;
  }
}

/** One simulated event, for a test that needs a certain status, privacy or all-day flag. */
export interface FakeEvent {
  id: string;
  /** Default: the calendar "main". */
  calendarId?: string;
  start: string;
  end: string;
  subject?: string;
  showAs?: ShowAs;
  isPrivate?: boolean;
  allDay?: boolean;
}

export function addFakeEvent(sql: SqlStorage, event: FakeEvent): void {
  ensureTables(sql);
  sql.exec(
    `INSERT OR REPLACE INTO fake_events
     (id, calendar_id, start, end, subject, private, show_as, all_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.calendarId ?? "main",
    event.start,
    event.end,
    event.subject ?? "Meeting",
    event.isPrivate ? 1 : 0,
    event.showAs ?? "busy",
    event.allDay ? 1 : 0,
  );
}

const FAKE_TABLES = [
  "fake_events",
  "fake_blocks",
  "fake_calls",
  "fake_seed",
  "fake_faults",
  "fake_write_faults",
  "fake_wire_events",
];

/** A date, or a wall-clock time in an IANA zone. */
export type FakeTime = { date: string } | { dateTime: string; timeZone: string };

/** The fields of an event that a calendar user can set. */
export interface FakeWireFields {
  start?: FakeTime;
  end?: FakeTime;
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

/**
 * An event stored in provider-independent form. A read turns it into the wire format of the
 * account's provider and through the real parser, so that all-day dates, zones, series, status and
 * privacy pass the same code as with a real provider. The events of `addFakeEvent` skip the parser.
 */
export interface FakeWireEvent extends FakeWireFields {
  id: string;
  /** Provider reads filter all-day events at the midnights of this zone. */
  calendarZone: string;
  /** Changed occurrences of a series by index; null for a deleted one. */
  exceptions?: Record<string, FakeWireFields | null>;
}

/** The change of one event, as a user makes it in a calendar. */
export interface FakeWireChange {
  change: "create" | "update" | "delete" | "update-occurrence" | "delete-occurrence";
  key: string;
  occurrence?: number;
  event?: FakeWireFields;
}

function storedWireEvents(sql: SqlStorage, calendarId?: string): FakeWireEvent[] {
  const rows =
    calendarId === undefined
      ? sql.exec<{ spec: string }>(`SELECT spec FROM fake_wire_events`)
      : sql.exec<{ spec: string }>(
          `SELECT spec FROM fake_wire_events WHERE calendar_id = ?`,
          calendarId,
        );
  return rows.toArray().map((row) => JSON.parse(row.spec) as FakeWireEvent);
}

function storeWireEvent(sql: SqlStorage, event: FakeWireEvent): void {
  sql.exec(
    `INSERT OR REPLACE INTO fake_wire_events (id, calendar_id, spec) VALUES (?, 'main', ?)`,
    event.id,
    JSON.stringify(event),
  );
}

/**
 * Delete an event that is no block, as a real provider deletes any event by its ID. An ID of the
 * form `<series>-<index>` is one occurrence of a series. A sync must never get here: see the
 * scenario `disconnect-target`.
 */
function deleteOwnEvent(sql: SqlStorage, calendarId: string, id: string): void {
  sql.exec(`DELETE FROM fake_events WHERE id = ? AND calendar_id = ?`, id, calendarId).toArray();
  const stored = sql.exec(
    `DELETE FROM fake_wire_events WHERE id = ? AND calendar_id = ?`,
    id,
    calendarId,
  );
  stored.toArray();
  if (stored.rowsWritten > 0) return;
  for (const event of storedWireEvents(sql, calendarId)) {
    const index = id.startsWith(`${event.id}-`) ? id.slice(event.id.length + 1) : "";
    if (!/^\d+$/.test(index)) continue;
    storeWireEvent(sql, { ...event, exceptions: { ...event.exceptions, [index]: null } });
  }
}

/** Apply a change to the wire events of an account's main calendar. */
export function changeFakeWireEvent(
  sql: SqlStorage,
  change: FakeWireChange,
  calendarZone: string,
): void {
  ensureTables(sql);
  const stored = storedWireEvents(sql).find((event) => event.id === change.key);
  if (change.change === "create") {
    storeWireEvent(sql, { ...change.event, id: change.key, calendarZone });
    return;
  }
  if (!stored) throw new Error(`The simulation has no event ${change.key}`);
  if (change.change === "delete") {
    sql.exec(`DELETE FROM fake_wire_events WHERE id = ?`, change.key);
    return;
  }
  if (change.change === "update") {
    storeWireEvent(sql, { ...stored, ...change.event });
    return;
  }
  const value = change.change === "delete-occurrence" ? null : (change.event ?? {});
  const exceptions = { ...stored.exceptions, [String(change.occurrence)]: value };
  storeWireEvent(sql, { ...stored, exceptions });
}

function isDate(time: FakeTime): time is { date: string } {
  return "date" in time;
}

/** The offset of a zone at an instant, in milliseconds. */
function zoneOffsetMs(zone: string, instant: number): number {
  const format = new Intl.DateTimeFormat("sv-SE", {
    timeZone: zone,
    dateStyle: "short",
    timeStyle: "medium",
  });
  const wall = Date.parse(`${format.format(instant).replace(" ", "T")}Z`);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant of a time. A date is the local midnight that starts it in `zone`. */
function instantOf(time: FakeTime, zone: string): number {
  const wall = Date.parse(isDate(time) ? `${time.date}T00:00:00Z` : `${time.dateTime}Z`);
  const timeZone = isDate(time) ? zone : time.timeZone;
  return wall - zoneOffsetMs(timeZone, wall - zoneOffsetMs(timeZone, wall));
}

/** A time some days later. A wall-clock time stays the same, as in a real series. */
function daysLater(time: FakeTime, days: number): FakeTime {
  if (isDate(time)) {
    const moved = Date.parse(`${time.date}T00:00:00Z`) + days * DAY_MS;
    return { date: new Date(moved).toISOString().slice(0, 10) };
  }
  const moved = Date.parse(`${time.dateTime}Z`) + days * DAY_MS;
  return { ...time, dateTime: new Date(moved).toISOString().slice(0, 19) };
}

interface WireOccurrence {
  fields: FakeWireFields & { start: FakeTime; end: FakeTime };
  /** Index in the series; null for a single event. */
  index: number | null;
  changed: boolean;
  originalStart: FakeTime;
}

/** The occurrences of an event, without the deleted ones. */
function occurrencesOf(event: FakeWireEvent): WireOccurrence[] {
  const { start, end } = event;
  if (!start || !end) throw new Error(`The simulated event ${event.id} has no times`);
  if (!event.repeat) {
    return [
      { fields: { ...event, start, end }, index: null, changed: false, originalStart: start },
    ];
  }
  const step = event.repeat.every === "week" ? 7 : 1;
  const occurrences: WireOccurrence[] = [];
  for (let index = 0; index < event.repeat.count; index++) {
    const exception = event.exceptions?.[String(index)];
    if (exception === null) continue;
    const originalStart = daysLater(start, index * step);
    occurrences.push({
      fields: {
        ...event,
        start: originalStart,
        end: daysLater(end, index * step),
        ...exception,
      },
      index,
      changed: exception !== undefined,
      originalStart,
    });
  }
  return occurrences;
}

function occurrenceSpan(occurrence: WireOccurrence, zone: string): { start: number; end: number } {
  const { start, end } = occurrence.fields;
  return { start: instantOf(start, zone), end: instantOf(end, zone) };
}

function wireId(event: FakeWireEvent, occurrence: WireOccurrence): string {
  return occurrence.index === null ? event.id : `${event.id}-${occurrence.index}`;
}

/** A Graph event as `calendarView` returns it with `Prefer: outlook.timezone="UTC"`. */
export function graphWireEvent(
  event: FakeWireEvent,
  occurrence: WireOccurrence,
  zone: string,
): unknown {
  const { fields, index, changed, originalStart } = occurrence;
  const time = (value: FakeTime) => ({
    dateTime: isDate(value)
      ? `${value.date}T00:00:00.0000000`
      : `${new Date(instantOf(value, zone)).toISOString().slice(0, 19)}.0000000`,
    timeZone: "UTC",
  });
  return {
    id: wireId(event, occurrence),
    type: index === null ? "singleInstance" : changed ? "exception" : "occurrence",
    seriesMasterId: index === null ? null : event.id,
    originalStart: index === null ? null : new Date(instantOf(originalStart, zone)).toISOString(),
    start: time(fields.start),
    end: time(fields.end),
    isAllDay: isDate(fields.start),
    isCancelled: fields.status === "cancelled",
    showAs: fields.availability ?? "busy",
    sensitivity: fields.visibility ?? "normal",
    categories: [],
    responseStatus: { response: fields.response ?? "organizer" },
    subject: fields.title ?? "Meeting",
    location: { displayName: fields.location ?? "" },
    bodyPreview: fields.description ?? "",
    attendees: (fields.attendees ?? []).map((address) => ({
      type: "required",
      emailAddress: { address },
    })),
  };
}

/** A Google event as events.list returns it with `singleEvents=true`. */
function googleWireEvent(
  event: FakeWireEvent,
  occurrence: WireOccurrence,
  zone: string,
  withBody: boolean,
): unknown {
  const { fields, index, originalStart } = occurrence;
  const time = (value: FakeTime) => {
    if (isDate(value)) return { date: value.date };
    const instant = instantOf(value, zone);
    return { dateTime: new Date(instant).toISOString(), timeZone: value.timeZone };
  };
  const answer = fields.response ?? (fields.availability === "tentative" ? "tentative" : undefined);
  return {
    id: wireId(event, occurrence),
    status: fields.status ?? "confirmed",
    summary: fields.title ?? "Meeting",
    location: fields.location ?? "",
    ...(withBody ? { description: fields.description ?? "" } : {}),
    start: time(fields.start),
    end: time(fields.end),
    ...(index === null
      ? {}
      : { recurringEventId: event.id, originalStartTime: time(originalStart) }),
    transparency: fields.availability === "free" ? "transparent" : "opaque",
    visibility: fields.visibility ?? "default",
    attendees: [
      ...(fields.attendees ?? []).map((email) => ({ email, responseStatus: "accepted" })),
      ...(answer ? [{ self: true, responseStatus: answer }] : []),
    ],
  };
}

/** The wire events in a window, read through the real parser of the provider. */
function wireEvents(
  sql: SqlStorage,
  calendarId: string,
  provider: Provider,
  window: TimeWindow,
  options: SourceFields,
): SourceEvent[] {
  const events: SourceEvent[] = [];
  for (const event of storedWireEvents(sql, calendarId)) {
    for (const occurrence of occurrencesOf(event)) {
      const span = occurrenceSpan(occurrence, event.calendarZone);
      if (span.end <= window.start.getTime() || span.start >= window.end.getTime()) continue;
      const parsed =
        provider === "microsoft"
          ? fromGraphEvent(graphWireEvent(event, occurrence, event.calendarZone))
          : fromGoogleEvent(
              googleWireEvent(event, occurrence, event.calendarZone, options.withBody === true),
            );
      if (parsed) events.push(parsed);
    }
  }
  return events;
}

/** One event or block of a simulated calendar, as a calendar user sees it. */
export interface FakeCalendarEntry {
  start: string;
  end: string;
  allDay: boolean;
  status: "busy" | "free";
  title: string;
  location: string;
  description: string;
  attendees: string[];
}

/** All wire events and blocks of an account's calendars. Cancelled events are gone from view. */
export function readFakeCalendar(sql: SqlStorage): FakeCalendarEntry[] {
  ensureTables(sql);
  const entries: FakeCalendarEntry[] = [];
  for (const event of storedWireEvents(sql)) {
    for (const occurrence of occurrencesOf(event)) {
      const { fields } = occurrence;
      if (fields.status === "cancelled") continue;
      const allDay = isDate(fields.start);
      const span = occurrenceSpan(occurrence, event.calendarZone);
      entries.push({
        start: isDate(fields.start) ? fields.start.date : new Date(span.start).toISOString(),
        end: isDate(fields.end) ? fields.end.date : new Date(span.end).toISOString(),
        allDay,
        status: fields.availability === "free" ? "free" : "busy",
        title: fields.title ?? "Meeting",
        location: fields.location ?? "",
        description: fields.description ?? "",
        attendees: fields.attendees ?? [],
      });
    }
  }
  for (const row of sql.exec<BlockRow>(`SELECT * FROM fake_blocks`).toArray()) {
    // `content` keeps every field that has no column, so that a field the engine should not write
    // shows here too. Of the columns, only the times, the status and the all-day flag come back.
    const { subject, location, body, attendees, ...other } = JSON.parse(row.content) as {
      subject?: string;
      location?: string;
      body?: string;
      attendees?: string[];
    };
    entries.push({
      ...other,
      start: row.start,
      end: row.end,
      allDay: row.all_day === 1,
      status: blockStatusOf(row.show_as) === "free" ? "free" : "busy",
      title: subject ?? "",
      location: location ?? "",
      description: body ?? "",
      attendees: attendees ?? [],
    });
  }
  return entries;
}

/** Which of how many seeded accounts this is, and the days its events spread over. */
export interface FakeSeed {
  account: number;
  accounts: number;
  days: number;
}

/**
 * Reset the account's calendar to `count` meetings. The seed stores one row: the Free plan allows
 * 100,000 written rows per day, and storing the events would spend that on the setup. Tables go
 * with DROP, because a DELETE bills every row.
 *
 * The meetings start tomorrow, so that a run across midnight UTC keeps all of them in its window.
 */
export function seedFakeEvents(sql: SqlStorage, seed: FakeSeed, count: number): void {
  for (const table of FAKE_TABLES) sql.exec(`DROP TABLE IF EXISTS ${table}`);
  ensureTables(sql);
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  sql.exec(
    `INSERT INTO fake_seed (id, account, accounts, count, start_ms, span_ms)
     VALUES (1, ?, ?, ?, ?, ?)`,
    seed.account,
    seed.accounts,
    count,
    seed.days > 1 ? today + DAY_MS : today,
    Math.max(seed.days - 1, 1) * DAY_MS,
  );
}

/** Move the end of the first `count` meetings, so that their mirrors need an update. */
export function shiftFakeEvents(sql: SqlStorage, count: number): void {
  ensureTables(sql);
  sql.exec(`UPDATE fake_seed SET shifted = ?`, count);
}

/** Count one alarm step that starts a rule. */
export function recordFakeStep(sql: SqlStorage): void {
  ensureTables(sql);
  sql.exec(
    `INSERT INTO fake_calls (operation, count) VALUES (?, 1)
     ON CONFLICT (operation) DO UPDATE SET count = count + 1`,
    STEP_OPERATION,
  );
}

/** What the simulation counted since the last seed. */
export interface FakeStats {
  /** Calls per operation. A read counts one call per page. */
  calls: Record<string, number>;
  /** Alarm steps that started a rule. Each must end in one audit row. */
  startedSteps: number;
  /** Stored rows per calendar; null unless the caller asked, because the count bills every row. */
  storedBlocks: number[] | null;
  /** Blocks in the account's calendars. */
  blocks: number;
  /** Rows the simulation wrote and read in its own tables. A real provider costs none of them. */
  rowsWritten: number;
  rowsRead: number;
}

export function readFakeStats(sql: SqlStorage, countBlocks = false): FakeStats {
  ensureTables(sql);
  const stats: FakeStats = {
    calls: {},
    startedSteps: 0,
    storedBlocks: null,
    blocks: 0,
    rowsWritten: 0,
    rowsRead: 0,
  };
  const rows = sql.exec<{
    operation: string;
    count: number;
    rows_written: number;
    rows_read: number;
    blocks: number;
  }>(`SELECT operation, count, rows_written, rows_read, blocks FROM fake_calls`);
  for (const row of rows) {
    if (row.operation === STEP_OPERATION) stats.startedSteps = row.count;
    else stats.calls[row.operation] = row.count;
    stats.blocks += row.blocks;
    // The counter row of each call is one written row too.
    stats.rowsWritten += row.rows_written + row.count;
    stats.rowsRead += row.rows_read;
  }
  if (countBlocks) {
    const counts = sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM fake_blocks GROUP BY calendar_id`,
    );
    stats.storedBlocks = counts.toArray().map((row) => row.n);
    stats.rowsRead += counts.rowsRead;
  }
  return stats;
}
