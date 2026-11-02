import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_RETENTION_DAYS,
  purgeAuditEvents,
  recordAudit,
  recordAuditChecked,
  RUN_OUTCOME_SCAN_ROWS,
  runOutcomeStatement,
  runsWithOutcome,
} from "../src/audit";

async function insertAt(daysAgo: number, kind = "sign_in"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events (org_id, kind, created_at)
     VALUES ('retention-org', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))`,
  )
    .bind(kind, `-${daysAgo} days`)
    .run();
}

describe("audit log", () => {
  it("never throws when the insert fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // `kind` is NOT NULL; a null kind makes the insert fail.
    await recordAudit(env.DB, { orgId: "o", kind: null as never });
    expect(error).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("reports a written event, a failed insert and an insert that wrote no row", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recordAuditChecked(env.DB, { orgId: "checked", kind: "sync_run" })).toBe(true);
    expect(await recordAuditChecked(env.DB, { orgId: "o", kind: null as never })).toBe(false);
    expect(error).toHaveBeenCalled();
    await env.DB.prepare(
      `CREATE TRIGGER ignore_checked BEFORE INSERT ON audit_events WHEN NEW.org_id = 'ignored'
       BEGIN SELECT RAISE(IGNORE); END`,
    ).run();
    try {
      expect(await recordAuditChecked(env.DB, { orgId: "ignored", kind: "sync_run" })).toBe(false);
    } finally {
      await env.DB.prepare("DROP TRIGGER ignore_checked").run();
      vi.restoreAllMocks();
    }
  });

  it("deletes only rows older than the retention period", async () => {
    await insertAt(AUDIT_RETENTION_DAYS + 1, "old");
    await insertAt(AUDIT_RETENTION_DAYS - 1, "recent");
    await insertAt(0, "today");

    await purgeAuditEvents(env.DB);

    const { results } = await env.DB.prepare(
      "SELECT kind FROM audit_events WHERE org_id = 'retention-org' ORDER BY kind",
    ).all<{ kind: string }>();
    expect(results.map((row) => row.kind)).toEqual(["recent", "today"]);
  });
});

describe("run outcomes", () => {
  const run = (runId: string, ruleId = "rule-1") => ({
    ruleId,
    runId,
    startedAt: Date.now() - 60_000,
  });

  async function insertEvent(kind: string, runId: string, ruleId = "rule-1", userId = "user-1") {
    await env.DB.prepare(
      `INSERT INTO audit_events (org_id, user_id, rule_id, kind, detail) VALUES ('o', ?, ?, ?, ?)`,
    )
      .bind(userId, ruleId, kind, JSON.stringify({ runId }))
      .run();
  }

  it("finds each kind of outcome by run", async () => {
    await insertEvent("sync_run", "finished");
    await insertEvent("sync_failed", "failed");
    await insertEvent("sync_run_aborted", "aborted");
    const runs = ["finished", "failed", "aborted", "unknown"].map((runId) => run(runId));
    expect(await runsWithOutcome(env.DB, "user-1", runs)).toEqual(
      new Set(["finished", "failed", "aborted"]),
    );
  });

  it("ignores other kinds, other rules, other users and earlier events", async () => {
    await insertEvent("account_paused", "other-kind");
    await insertEvent("sync_run", "other-rule", "rule-2");
    await insertEvent("sync_run", "other-user", "rule-1", "user-2");
    await insertEvent("sync_run", "too-early");
    const late = { ...run("too-early"), startedAt: Date.now() + 3_600_000 };
    const runs = [run("other-kind"), run("other-rule"), run("other-user"), late];
    expect(await runsWithOutcome(env.DB, "user-1", runs)).toEqual(new Set());
  });

  it("reads a bounded number of rows", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < ?)
       INSERT INTO audit_events (org_id, user_id, kind) SELECT 'o', 'busy-user', 'sign_in' FROM counter`,
    )
      .bind(RUN_OUTCOME_SCAN_ROWS * 3)
      .run();

    const [result] = await env.DB.batch([
      runOutcomeStatement(env.DB, "busy-user", run("not-there")),
    ]);

    expect(result?.results).toEqual([]);
    expect(result?.meta.rows_read).toBeGreaterThan(0);
    expect(result?.meta.rows_read).toBeLessThanOrEqual(RUN_OUTCOME_SCAN_ROWS + 1);
  });
});
