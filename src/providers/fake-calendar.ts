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

/**
 * A calendar provider for local load tests, only with DEV_FAKE_CALENDARS=1. Each account's events
 * and blocks live in the SQLite storage of its own Durable Object, so the sync engine, the queues
 * and the RPC between instances run as in production; only Graph and Google are replaced. Every
 * call is counted, so that a test can measure what a sync cycle costs.
 */
export class FakeCalendar implements CalendarClient {
  readonly batchLimit = 20;

  constructor(
    private readonly sql: SqlStorage,
    /** Simulated network time per call. */
    private readonly latencyMs = 0,
  ) {
    ensureTables(sql);
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
    await this.call("sourceEvents");
    const events = this.sql
      .exec<{ id: string; start: string; end: string; subject: string; private: number }>(
        `SELECT id, start, end, subject, private FROM fake_events
         WHERE calendar_id = ? AND end > ? AND start < ?`,
        calendarId,
        window.start.toISOString(),
        window.end.toISOString(),
      )
      .toArray()
      .map((row) => ({
        occurrenceKey: `event:${row.id}`,
        start: row.start,
        end: row.end,
        allDay: false,
        showAs: "busy" as const,
        isPrivate: row.private === 1,
        declined: false,
        categories: [],
        subject: row.subject,
        location: "",
        body: "",
        isMirror: false,
        ...(options.withLink
          ? { link: `https://calendar.invalid/event?id=${encodeURIComponent(row.id)}` }
          : {}),
      }));
    // Blocks other rules wrote into this calendar are events too; the loop guard skips them.
    const mirrors = this.blocks(calendarId, window).map((block) => ({
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
    await this.call("existingBlocks");
    return this.blocks(calendarId, window).filter((block) => ruleTags.includes(block.ruleTag));
  }

  async applyBatch(
    calendarId: string,
    ruleTag: string,
    actions: SyncAction[],
  ): Promise<BatchResult> {
    await this.call("applyBatch");
    const writtenIds: string[] = [];
    for (const action of actions) {
      if (action.kind === "delete") {
        this.sql.exec(`DELETE FROM fake_blocks WHERE id = ?`, action.targetId);
        writtenIds.push(action.targetId);
        continue;
      }
      const id = action.kind === "update" ? action.targetId : crypto.randomUUID();
      writtenIds.push(id);
      const { block } = action;
      this.sql.exec(
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
    }
    return { failed: 0, throttled: 0, statuses: {}, writtenIds };
  }

  async watch(): Promise<Watch> {
    await this.call("watch");
    return { id: crypto.randomUUID(), resourceId: null, expiresAt: Date.now() + 6 * 86_400_000 };
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

  private blocks(calendarId: string, window: TimeWindow): ExistingBlock[] {
    return this.sql
      .exec<{
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
      )
      .toArray()
      .map((row) => ({
        targetId: row.id,
        ruleTag: row.rule_tag,
        marker: row.marker,
        contentHash: row.content_hash,
        dedupKey: row.dedup_key,
        start: row.start,
        end: row.end,
        allDay: false,
      }));
  }

  private async call(operation: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO fake_calls (operation, count) VALUES (?, 1)
       ON CONFLICT (operation) DO UPDATE SET count = count + 1`,
      operation,
    );
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

function ensureTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_events (
    id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
    subject TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_blocks (
    id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, rule_tag TEXT NOT NULL, marker TEXT NOT NULL,
    content_hash TEXT NOT NULL, dedup_key TEXT NOT NULL DEFAULT '', start TEXT NOT NULL,
    end TEXT NOT NULL)`);
  // Tables from before the dedup key existed.
  if (
    !sql
      .exec(`PRAGMA table_info(fake_blocks)`)
      .toArray()
      .some((col) => col.name === "dedup_key")
  ) {
    sql.exec(`ALTER TABLE fake_blocks ADD COLUMN dedup_key TEXT NOT NULL DEFAULT ''`);
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS fake_calls (
    operation TEXT PRIMARY KEY, count INTEGER NOT NULL)`);
}

/**
 * Replace the account's simulated events: `count` meetings on weekdays over the next 90 days.
 * A seed from 1000 up carries the spread: `days * 1000 + number`, so that the capacity probe
 * can fill a longer window without a new parameter on the Durable Object.
 */
export function seedFakeEvents(sql: SqlStorage, encodedSeed: number, count: number): void {
  ensureTables(sql);
  const seed = encodedSeed % 1000;
  const days = encodedSeed >= 1000 ? Math.floor(encodedSeed / 1000) : 90;
  sql.exec(`DELETE FROM fake_events`);
  sql.exec(`DELETE FROM fake_blocks`);
  sql.exec(`DELETE FROM fake_calls`);
  let state = seed * 2654435761;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const day = new Date(today.getTime() + Math.floor(random() * days) * 86_400_000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() + 2);
    const start = new Date(day.getTime() + (7 + Math.floor(random() * 10)) * 3_600_000);
    const end = new Date(start.getTime() + (1 + Math.floor(random() * 4)) * 1_800_000);
    sql.exec(
      `INSERT INTO fake_events (id, calendar_id, start, end, subject, private) VALUES (?, 'main', ?, ?, ?, ?)`,
      `${seed}-${i}`,
      start.toISOString(),
      end.toISOString(),
      `Meeting ${seed}.${i}`,
      random() < 0.1 ? 1 : 0,
    );
  }
}

/** Calls per operation since the last seed. */
export function fakeCallCounts(sql: SqlStorage): Record<string, number> {
  ensureTables(sql);
  return Object.fromEntries(
    sql
      .exec<{ operation: string; count: number }>(`SELECT operation, count FROM fake_calls`)
      .toArray()
      .map((row) => [row.operation, row.count]),
  );
}
