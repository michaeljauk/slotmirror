import { DurableObject } from "cloudflare:workers";
import { GRAPH_BATCH_LIMIT, GraphCalendar, type CalendarInfo } from "./providers/graph-calendar";
import * as microsoft from "./providers/microsoft";
import { desiredBlocks, planSync, ruleTagFor } from "./sync/plan";
import { loadRule, rulesTargetingAccount, syncWindow } from "./sync/rules";
import type { SourceEvent, SyncPlan } from "./sync/types";
import { decryptJson, encryptJson } from "./token-crypto";

export interface StoredTokens {
  refreshToken: string;
  accessToken: string;
  /** Unix milliseconds. */
  accessExpiresAt: number;
}

export interface RunResult {
  ruleId: string;
  dryRun: boolean;
  stats: SyncPlan["stats"];
  /** Actions written in this run; the rest follows in the next alarm. */
  applied: number;
  failed: number;
  remaining: number;
}

/** Wait this long after a change notification before syncing, so that bursts collapse into one run. */
const DEBOUNCE_MS = 5_000;

/** Refresh the access token this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Write batches per invocation. With reads and token refresh this stays well inside the Free plan
 * limit of 50 subrequests; a larger plan continues in the next alarm.
 */
const MAX_BATCHES_PER_RUN = 25;

/**
 * One instance per connected account (named by `accounts.id`).
 *
 * The instance owns everything that must not be written concurrently: the encrypted OAuth tokens
 * (Microsoft rotates the refresh token on every use) and the webhook subscriptions. Requests to
 * one instance run one at a time.
 *
 * A rule runs in the instance of its target account. It reads the source events from the source
 * account's instance over RPC, so each instance only ever uses its own tokens. Which blocks exist
 * is read from the target calendar itself (blocks carry a marker), so no mapping state can drift.
 */
export class AccountSync extends DurableObject<Env> {
  private refreshing: Promise<string> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  /** Ask for a sync soon. Repeated calls before the alarm fires do not move it. */
  async requestSync(): Promise<void> {
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null) {
      await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
    }
  }

  /** Replace the stored tokens. Called after an OAuth connect and after every refresh. */
  async storeTokens(accountId: string, tokens: StoredTokens): Promise<void> {
    const blob = await encryptJson(tokens, this.env.TOKEN_ENCRYPTION_KEY, accountId);
    this.ctx.storage.sql.exec(
      `INSERT INTO tokens (id, account_id, ciphertext, iv, access_expires_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         account_id = excluded.account_id,
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         access_expires_at = excluded.access_expires_at`,
      accountId,
      blob.ciphertext,
      blob.iv,
      tokens.accessExpiresAt,
    );
  }

  async hasTokens(): Promise<boolean> {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM tokens`).toArray().length > 0;
  }

  /** Delete tokens and subscriptions, and cancel a pending sync. */
  async forget(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // The instance can live on after deleteAll(); give it empty tables again.
    this.migrate();
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return new GraphCalendar(await this.accessToken()).listCalendars();
  }

  /** Source events of one calendar of this account. Called by the target account's instance. */
  async readSourceEvents(
    remoteCalendarId: string,
    window: { start: Date; end: Date },
    withBody: boolean,
  ): Promise<SourceEvent[]> {
    return new GraphCalendar(await this.accessToken()).sourceEvents(remoteCalendarId, window, {
      withBody,
    });
  }

  /**
   * Run one rule whose target calendar belongs to this account. With `dryRun`, plan only and
   * write nothing.
   */
  async runRule(ruleId: string, options: { dryRun?: boolean } = {}): Promise<RunResult> {
    const rule = await loadRule(this.env.DB, ruleId);
    if (!rule) throw new Error(`Rule ${ruleId} not found`);
    if (rule.target.accountId !== this.accountId()) {
      throw new Error("A rule runs in the instance of its target account");
    }
    if (rule.source.provider !== "microsoft" || rule.target.provider !== "microsoft") {
      throw new Error("Only Microsoft 365 calendars are supported so far");
    }

    const window = syncWindow(rule.options);
    const withBody = rule.options.detailLevel === "full";
    const sourceEvents =
      rule.source.accountId === this.accountId()
        ? await this.readSourceEvents(rule.source.remoteCalendarId, window, withBody)
        : await this.env.ACCOUNT_SYNC.getByName(rule.source.accountId).readSourceEvents(
            rule.source.remoteCalendarId,
            window,
            withBody,
          );

    const graph = new GraphCalendar(await this.accessToken());
    const ruleTag = await ruleTagFor(rule.id);
    const existing = await graph.existingBlocks(rule.target.remoteCalendarId, window, ruleTag);
    const plan = planSync(await desiredBlocks(rule.id, sourceEvents, rule.options), existing);

    if (options.dryRun) {
      return { ruleId, dryRun: true, stats: plan.stats, applied: 0, failed: 0, remaining: 0 };
    }

    const batches = chunk(plan.actions, GRAPH_BATCH_LIMIT);
    let applied = 0;
    let failed = 0;
    for (const batch of batches.slice(0, MAX_BATCHES_PER_RUN)) {
      const result = await graph.applyBatch(rule.target.remoteCalendarId, ruleTag, batch);
      applied += batch.length - result.failed;
      failed += result.failed;
    }
    const remaining = plan.actions.length - applied - failed;
    if (remaining > 0) {
      // Continue soon; the next run plans again from the calendars, so nothing is lost.
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    }
    return { ruleId, dryRun: false, stats: plan.stats, applied, failed, remaining };
  }

  /** Run every rule that targets this account, one after another. */
  override async alarm(): Promise<void> {
    const accountId = this.accountIdOrNull();
    if (!accountId) return;
    for (const ruleId of await rulesTargetingAccount(this.env.DB, accountId)) {
      try {
        await this.runRule(ruleId);
      } catch (error) {
        // One broken rule must not stop the others; the audit log records it (next step).
        console.error("Rule run failed", ruleId, error);
      }
    }
  }

  /** A valid access token; refreshes and stores the rotated refresh token when needed. */
  private async accessToken(): Promise<string> {
    const stored = await this.readTokens();
    if (stored.tokens.accessExpiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return stored.tokens.accessToken;
    }
    // Requests interleave while a refresh waits on the network; refresh only once.
    this.refreshing ??= this.refresh(stored.accountId, stored.tokens.refreshToken).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(accountId: string, refreshToken: string): Promise<string> {
    const response = await microsoft.refreshToken({
      clientId: this.env.MICROSOFT_CLIENT_ID,
      clientSecret: this.env.MICROSOFT_CLIENT_SECRET,
      refreshToken,
    });
    await this.storeTokens(accountId, {
      refreshToken: response.refresh_token ?? refreshToken,
      accessToken: response.access_token,
      accessExpiresAt: Date.now() + response.expires_in * 1000,
    });
    return response.access_token;
  }

  private async readTokens(): Promise<{ accountId: string; tokens: StoredTokens }> {
    const row = this.ctx.storage.sql
      .exec<{ account_id: string; ciphertext: ArrayBuffer; iv: ArrayBuffer }>(
        `SELECT account_id, ciphertext, iv FROM tokens WHERE id = 1`,
      )
      .toArray()[0];
    if (!row) throw new Error("Account has no tokens");
    const tokens = await decryptJson<StoredTokens>(
      { ciphertext: row.ciphertext, iv: row.iv },
      this.env.TOKEN_ENCRYPTION_KEY,
      row.account_id,
    );
    return { accountId: row.account_id, tokens };
  }

  private accountIdOrNull(): string | null {
    const row = this.ctx.storage.sql
      .exec<{ account_id: string }>(`SELECT account_id FROM tokens WHERE id = 1`)
      .toArray()[0];
    return row?.account_id ?? null;
  }

  private accountId(): string {
    const id = this.accountIdOrNull();
    if (!id) throw new Error("Account has no tokens");
    return id;
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const row = sql.exec<{ version: number }>(`SELECT version FROM schema_version`).toArray()[0];
    const current = row?.version ?? 0;

    for (const [index, statement] of MIGRATIONS.entries()) {
      if (index < current) continue;
      sql.exec(statement);
    }
    if (current === 0) {
      sql.exec(`INSERT INTO schema_version (version) VALUES (?)`, MIGRATIONS.length);
    } else if (current < MIGRATIONS.length) {
      sql.exec(`UPDATE schema_version SET version = ?`, MIGRATIONS.length);
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Append only. Each entry runs once, in order. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE tokens (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     account_id TEXT NOT NULL,
     ciphertext BLOB NOT NULL, -- AES-GCM, account ID as additional authenticated data
     iv BLOB NOT NULL,
     access_expires_at INTEGER NOT NULL
   );
   CREATE TABLE subscriptions (
     remote_id TEXT PRIMARY KEY,
     calendar_id TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );`,
];
