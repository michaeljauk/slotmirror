import type { Provider } from "../config";
import type { ExistingBlock, SourceEvent, SyncAction } from "../sync/types";
import type { BatchResult } from "../sync/throttle";
import type {
  CalendarClient,
  CalendarInfo,
  ChangeFeed,
  SourceFields,
  TimeWindow,
  Watch,
} from "./calendar-client";

/** Events per page: Graph `$top`, Google `maxResults`. See the two real clients. */
const PAGE_SIZE: Record<Provider, number> = { microsoft: 500, google: 2500 };

const DAY_MS = 86_400_000;
const HALF_HOUR_MS = 1_800_000;

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
 * `fetch`, so that the Workers subrequest limit applies as it does with a real provider.
 */
export class FakeCalendar implements CalendarClient {
  readonly batchLimit = 20;

  private readonly latencyMs: number;
  private readonly fetchUrl: string | null;

  constructor(
    private readonly sql: SqlStorage,
    private readonly provider: Provider,
    env: FakeEnv = {},
  ) {
    ensureTables(sql);
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
    const natives = this.natives(window);
    const stored = this.blocks(calendarId, window);
    await this.readPages("sourceEvents", natives.length + stored.rows.length, stored.rowsRead);
    const events = natives.map((event) => ({
      occurrenceKey: `event:${event.id}`,
      start: event.start,
      end: event.end,
      allDay: false,
      showAs: "busy" as const,
      isPrivate: event.isPrivate,
      declined: false,
      categories: [],
      subject: event.subject,
      location: "",
      body: "",
      isMirror: false,
      ...(options.withLink
        ? { link: `https://calendar.invalid/event?id=${encodeURIComponent(event.id)}` }
        : {}),
    }));
    // Blocks other rules wrote into this calendar are events too; the loop guard skips them.
    const mirrors = stored.rows.map((block) => ({
      occurrenceKey: `event:${block.targetId}`,
      start: block.start,
      end: block.end,
      allDay: false,
      showAs: "busy" as const,
      isPrivate: true,
      declined: false,
      categories: [],
      subject: "Busy",
      location: "",
      body: "",
      isMirror: true,
    }));
    return [...events, ...mirrors];
  }

  async existingBlocks(
    calendarId: string,
    window: TimeWindow,
    ruleTags: readonly string[],
  ): Promise<ExistingBlock[]> {
    // Both real clients list the whole calendar and filter here, so native events cost pages too.
    const natives = this.natives(window).length;
    const stored = this.blocks(calendarId, window);
    await this.readPages("existingBlocks", natives + stored.rows.length, stored.rowsRead);
    return stored.rows.filter((block) => ruleTags.includes(block.ruleTag));
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
    for (const action of actions) {
      if (action.kind === "delete") {
        const removed = this.sql.exec(`DELETE FROM fake_blocks WHERE id = ?`, action.targetId);
        removed.toArray();
        rowsWritten += removed.rowsWritten;
        if (removed.rowsWritten > 0) blocks -= 1;
        writtenIds.push(action.targetId);
        continue;
      }
      const id = action.kind === "update" ? action.targetId : crypto.randomUUID();
      writtenIds.push(id);
      const { block } = action;
      const written = this.sql.exec(
        `INSERT OR REPLACE INTO fake_blocks
         (id, calendar_id, rule_tag, marker, content_hash, dedup_key, start, end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        calendarId,
        ruleTag,
        block.marker,
        block.contentHash,
        block.dedupKey,
        block.start,
        block.end,
      );
      written.toArray();
      rowsWritten += written.rowsWritten;
      if (action.kind === "create") blocks += 1;
    }
    this.record("applyBatch", { rowsWritten, blocks });
    return { failed: 0, throttled: 0, statuses: {}, writtenIds };
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

  /** The native events in the window. They come from the seed, so they take no storage rows. */
  private natives(window: TimeWindow): FakeEvent[] {
    const seed = this.sql.exec<StoredSeed>(`SELECT * FROM fake_seed`).toArray()[0];
    return seed ? fakeEvents(seed, window) : [];
  }

  private blocks(
    calendarId: string,
    window: TimeWindow,
  ): { rows: ExistingBlock[]; rowsRead: number } {
    const cursor = this.sql.exec<{
      id: string;
      rule_tag: string;
      marker: string;
      content_hash: string;
      dedup_key: string;
      start: string;
      end: string;
    }>(
      `SELECT id, rule_tag, marker, content_hash, dedup_key, start, end FROM fake_blocks
       WHERE calendar_id = ? AND end > ? AND start < ?`,
      calendarId,
      window.start.toISOString(),
      window.end.toISOString(),
    );
    const rows = cursor.toArray().map((row) => ({
      targetId: row.id,
      ruleTag: row.rule_tag,
      marker: row.marker,
      contentHash: row.content_hash,
      dedupKey: row.dedup_key,
      start: row.start,
      end: row.end,
      allDay: false,
    }));
    return { rows, rowsRead: cursor.rowsRead };
  }

  /** One call per page, one after the other, as the real clients follow their page links. */
  private async readPages(operation: string, items: number, rowsRead: number): Promise<void> {
    const pages = fakePages(items, this.provider);
    for (let page = 0; page < pages; page++) {
      await this.call(operation, page === 0 ? rowsRead : 0);
    }
  }

  private async call(operation: string, rowsRead = 0): Promise<void> {
    await this.network();
    this.record(operation, { rowsRead });
  }

  /** What one provider call costs the Worker: a real subrequest if set up, and the wait. */
  private async network(): Promise<void> {
    if (this.fetchUrl) {
      // An error stays an error: the subrequest limit of the Workers runtime surfaces here.
      const response = await fetch(this.fetchUrl);
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`The simulated provider call got ${response.status}`);
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

interface FakeEvent {
  id: string;
  start: string;
  end: string;
  subject: string;
  isPrivate: boolean;
}

interface StoredSeed extends Record<string, SqlStorageValue> {
  account: number;
  accounts: number;
  count: number;
  start_ms: number;
  span_ms: number;
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
    const end = start + (1 + (i % 4)) * HALF_HOUR_MS;
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

function ensureTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_seed (
    id INTEGER PRIMARY KEY CHECK (id = 1), account INTEGER NOT NULL, accounts INTEGER NOT NULL,
    count INTEGER NOT NULL, start_ms INTEGER NOT NULL, span_ms INTEGER NOT NULL)`);
  // WITHOUT ROWID: a second index on the key would add a billed row to every block.
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_blocks (
    id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, rule_tag TEXT NOT NULL, marker TEXT NOT NULL,
    content_hash TEXT NOT NULL, dedup_key TEXT NOT NULL DEFAULT '', start TEXT NOT NULL,
    end TEXT NOT NULL) WITHOUT ROWID`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_calls (
    operation TEXT PRIMARY KEY, count INTEGER NOT NULL, rows_written INTEGER NOT NULL DEFAULT 0,
    rows_read INTEGER NOT NULL DEFAULT 0, blocks INTEGER NOT NULL DEFAULT 0)`);
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
  for (const table of ["fake_events", "fake_blocks", "fake_calls", "fake_seed"]) {
    sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
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

/** What the simulation counted since the last seed. */
export interface FakeStats {
  /** Calls per operation. A read counts one call per page. */
  calls: Record<string, number>;
  /** Blocks in the account's calendars. */
  blocks: number;
  /** Rows the simulation wrote and read in its own tables. A real provider costs none of them. */
  rowsWritten: number;
  rowsRead: number;
}

export function readFakeStats(sql: SqlStorage): FakeStats {
  ensureTables(sql);
  const stats: FakeStats = { calls: {}, blocks: 0, rowsWritten: 0, rowsRead: 0 };
  const rows = sql.exec<{
    operation: string;
    count: number;
    rows_written: number;
    rows_read: number;
    blocks: number;
  }>(`SELECT operation, count, rows_written, rows_read, blocks FROM fake_calls`);
  for (const row of rows) {
    stats.calls[row.operation] = row.count;
    stats.blocks += row.blocks;
    // The counter row of each call is one written row too.
    stats.rowsWritten += row.rows_written + row.count;
    stats.rowsRead += row.rows_read;
  }
  return stats;
}
