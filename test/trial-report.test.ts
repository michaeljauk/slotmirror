import { describe, expect, it } from "vitest";
// @ts-expect-error The ?raw suffix has no type declaration.
import auditSource from "../src/audit.ts?raw";
import {
  KNOWN_KINDS,
  RULES_SQL,
  assertReadOnly,
  auditSql,
  buildReport,
  classifyErrorCode,
  collectReport,
  formatReport,
  parseSince,
  readOption,
  safeCode,
  shortRef,
  wranglerArgs,
  type AuditRow,
  type RuleRow,
} from "../scripts/trial-report-lib";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const SINCE = NOW - 7 * 86_400_000;

const rule = (id: string, extra: Partial<RuleRow> = {}): RuleRow => ({
  id,
  enabled: 1,
  accountId: "acc-1",
  needsReconnect: 0,
  sourceAccountId: "acc-src",
  sourceNeedsReconnect: 0,
  ...extra,
});

let nextId = 1;
function row(
  kind: string,
  createdAt: string,
  ruleId: string | null,
  detail: Record<string, unknown> = {},
  accountId: string | null = "acc-1",
): AuditRow {
  return { id: nextId++, ruleId, accountId, kind, detail: JSON.stringify(detail), createdAt };
}
const run = (at: string, ruleId: string, detail: Record<string, unknown> = {}) =>
  row("sync_run", at, ruleId, { dryRun: false, failed: 0, remaining: 0, duplicates: 0, ...detail });

function report(rules: RuleRow[], audit: AuditRow[], auditTruncated = false) {
  return buildReport({ rules, audit, sinceMs: SINCE, nowMs: NOW, auditTruncated });
}

describe("read-only guard", () => {
  it("accepts a SELECT and refuses everything else", () => {
    expect(assertReadOnly("SELECT 1")).toBe("SELECT 1");
    for (const sql of [
      "INSERT INTO rules VALUES (1)",
      "DELETE FROM audit_events",
      "UPDATE rules SET enabled = 0",
      "DROP TABLE rules",
      "PRAGMA writable_schema = 1",
      "WITH x AS (SELECT 1) DELETE FROM rules",
      "SELECT 1; DROP TABLE rules",
      "SELECT 1 -- ; DELETE",
      "SELECT 1 /* x */",
      "",
    ]) {
      expect(() => assertReadOnly(sql), sql).toThrow();
    }
  });

  it("builds statements that pass the guard and carry the flags", () => {
    expect(() => assertReadOnly(RULES_SQL)).not.toThrow();
    expect(() => assertReadOnly(auditSql(SINCE))).not.toThrow();
    expect(auditSql(SINCE)).toContain(`'${new Date(SINCE).toISOString()}'`);
    expect(auditSql(SINCE)).not.toContain("datetime(");
    const args = wranglerArgs(RULES_SQL, { database: "DB", remote: true, config: "x.jsonc" });
    expect(args).toContain("--remote");
    expect(args.slice(-2)).toEqual(["--config", "x.jsonc"]);
    expect(wranglerArgs(RULES_SQL, { database: "DB", remote: false })).toContain("--local");
    expect(() => wranglerArgs("DELETE FROM rules", { database: "DB", remote: true })).toThrow();
    expect(() => auditSql(SINCE, 0)).toThrow();
  });

  it("sends nothing but SELECT through the executor", () => {
    const sent: string[] = [];
    const out = collectReport(
      (args) => {
        sent.push(args[args.indexOf("--command") + 1]!);
        const rows = sent.length === 1 ? [rule("r1")] : [];
        return `⛅️ banner\n${JSON.stringify([{ results: rows, success: true }])}`;
      },
      { database: "DB", remote: false, sinceMs: SINCE, nowMs: NOW },
    );
    expect(sent).toHaveLength(2);
    expect(sent.every((sql) => /^SELECT\s/.test(sql))).toBe(true);
    expect(out.activeRules).toHaveLength(1);
  });
});

describe("parseSince", () => {
  it("reads relative and absolute values", () => {
    expect(parseSince("72h", NOW)).toBe(NOW - 72 * 3600_000);
    expect(parseSince("2d", NOW)).toBe(NOW - 2 * 86_400_000);
    expect(parseSince("2026-10-01", NOW)).toBe(Date.parse("2026-10-01"));
    expect(() => parseSince("soon", NOW)).toThrow();
  });
});

describe("error codes", () => {
  it("recognises the old message form and the new code form", () => {
    expect(classifyErrorCode("Graph GET failed: 504 timeout")).toMatchObject({
      form: "message",
      provider: "graph",
      status: 504,
    });
    expect(classifyErrorCode("graph_403_ErrorAccessDenied")).toMatchObject({
      form: "code",
      provider: "graph",
      status: 403,
    });
    expect(classifyErrorCode("google_403_rateLimitExceeded").status).toBe(403);
    expect(classifyErrorCode("token_invalid_grant").provider).toBe("token");
    expect(classifyErrorCode("Network connection lost.").form).toBe("other");
  });

  it("lists sync_failed rows of both forms as failures", () => {
    const r = report(
      [rule("r1")],
      [
        row("sync_failed", "2026-10-30T10:00:00.000Z", "r1", {
          code: "Graph GET failed: 504 timeout",
        }),
        row("sync_failed", "2026-10-30T11:00:00.000Z", "r1", { code: "graph_403_X" }),
      ],
    );
    expect(r.activeRules[0]!.failures.map((f) => f.form)).toEqual(["message", "code"]);
  });
});

describe("last successful run", () => {
  it("skips dry runs and runs with failed actions", () => {
    const r = report(
      [rule("r1")],
      [
        run("2026-10-30T08:00:00.000Z", "r1"),
        run("2026-10-30T09:00:00.000Z", "r1", { failed: 2 }),
        run("2026-10-30T10:00:00.000Z", "r1", { dryRun: true }),
      ],
    );
    const rep = r.activeRules[0]!;
    expect(rep.lastSuccessAt).toBe("2026-10-30T08:00:00.000Z");
    expect(rep.sinceSuccessMs).toBe(4 * 3600_000);
    expect(rep.failedRuns).toBe(1);
    expect(rep.dryRuns).toBe(1);
    expect(rep.notCovered).toBe(false);
  });

  it("says so when the period holds no run of a rule", () => {
    const r = report([rule("r1"), rule("r2")], [run("2026-10-30T08:00:00.000Z", "r1")]);
    const silent = r.activeRules.find((x) => x.ruleId === "r2")!;
    expect(silent.notCovered).toBe(true);
    expect(silent.lastSuccessAt).toBeNull();
    expect(formatReport(r)).toContain("the period does not cover a successful run");
  });

  it("does not list inactive rules, and counts them", () => {
    const r = report([rule("r1"), rule("r2", { enabled: 0 })], []);
    expect(r.activeRules.map((x) => x.ruleId)).toEqual(["r1"]);
    expect(r.inactiveRules).toBe(1);
  });

  it("reports the covered start when the read hit its limit", () => {
    const r = report([rule("r1")], [run("2026-10-29T08:00:00.000Z", "r1", { failed: 1 })], true);
    expect(r.coveredFromMs).toBe(Date.parse("2026-10-29T08:00:00.000Z"));
    expect(formatReport(r)).toContain("row limit");
  });
});

describe("duplicates", () => {
  it("flags two runs in a row with duplicates", () => {
    const r = report(
      [rule("r1")],
      [
        run("2026-10-30T07:00:00.000Z", "r1", { duplicates: 1 }),
        run("2026-10-30T08:00:00.000Z", "r1", { duplicates: 2 }),
      ],
    );
    expect(r.activeRules[0]!.duplicateSuspicions).toEqual([
      { at: "2026-10-30T08:00:00.000Z", previousAt: "2026-10-30T07:00:00.000Z", gapMs: 3600_000 },
    ]);
    expect(formatReport(r)).toContain("60 min apart");
  });

  it("does not flag an interrupted sequence", () => {
    const r = report(
      [rule("r1")],
      [
        run("2026-10-30T07:00:00.000Z", "r1", { duplicates: 1 }),
        run("2026-10-30T08:00:00.000Z", "r1", { duplicates: 0 }),
        run("2026-10-30T09:00:00.000Z", "r1", { duplicates: 1 }),
      ],
    );
    expect(r.activeRules[0]!.duplicateSuspicions).toEqual([]);
  });

  it("ignores a dry run inside the sequence", () => {
    const r = report(
      [rule("r1")],
      [
        run("2026-10-30T07:00:00.000Z", "r1", { duplicates: 1 }),
        run("2026-10-30T07:30:00.000Z", "r1", { dryRun: true, duplicates: 0 }),
        run("2026-10-30T08:00:00.000Z", "r1", { duplicates: 1 }),
      ],
    );
    expect(r.activeRules[0]!.duplicateSuspicions).toHaveLength(1);
  });
});

describe("aborts, pauses, alerts, comparisons, unknown codes", () => {
  it("lists aborted runs", () => {
    const r = report([rule("r1")], [row("sync_run_aborted", "2026-10-30T06:00:00.000Z", "r1", {})]);
    expect(r.activeRules[0]!.aborts).toEqual(["2026-10-30T06:00:00.000Z"]);
  });

  it("pairs a pause with its resume and marks one over 24 hours", () => {
    const r = report(
      [rule("r1", { needsReconnect: 1 })],
      [
        row("account_paused", "2026-10-27T06:00:00.000Z", null, { code: "token_invalid_grant" }),
        row("account_resumed", "2026-10-28T08:00:00.000Z", null, { code: "token_invalid_grant" }),
        row(
          "account_paused",
          "2026-10-30T09:00:00.000Z",
          null,
          { code: "token_invalid_grant" },
          "acc-2",
        ),
      ],
    );
    expect(r.activeRules[0]!.targetPausedNow).toBe(true);
    expect(r.pauses).toHaveLength(2);
    expect(r.pauses[0]).toMatchObject({ resumedAt: "2026-10-28T08:00:00.000Z", long: true });
    expect(r.activeRules[0]!.sourcePausedNow).toBe(false);
    expect(r.pauses[1]).toMatchObject({ accountId: "acc-2", resumedAt: null, long: false });
  });

  it("lists alerts and comparisons with their numbers", () => {
    const r = report(
      [rule("r1")],
      [
        row("alert_sent", "2026-10-30T05:00:00.000Z", "r1", { code: "rule_silent" }),
        row("compare_run", "2026-10-30T04:00:00.000Z", null, {
          calendarId: "cal-1",
          mode: "daily",
          deviations: 0,
          cleared: 1,
          rounds: 2,
          clean: true,
        }),
        row("compare_failed", "2026-10-30T03:00:00.000Z", null, {
          calendarId: "cal-1",
          mode: "full",
          code: "graph_503",
        }),
      ],
    );
    expect(r.alerts).toEqual([
      { at: "2026-10-30T05:00:00.000Z", ruleId: "r1", code: "rule_silent" },
    ]);
    const text = formatReport(r);
    expect(text).toContain("deviations 0, cleared 1, rounds 2, clean true");
    expect(text).toContain(`compare_failed full calendar ${shortRef("cal-1")}: graph_503`);
    expect(text).not.toContain("cal-1");
    expect(r.unknownKinds).toEqual([]);
  });

  it("puts an unknown code in its own list", () => {
    const r = report(
      [rule("r1")],
      [
        row("sign_in", "2026-10-30T01:00:00.000Z", null),
        row("future_kind", "2026-10-30T02:00:00.000Z", "r1"),
        row("future_kind", "2026-10-30T03:00:00.000Z", "r1"),
      ],
    );
    expect(r.unknownKinds).toEqual([
      { kind: "future_kind", count: 2, lastAt: "2026-10-30T03:00:00.000Z" },
    ]);
    expect(formatReport(r)).toContain("future_kind: 2 rows");
  });

  it("prints no verdict words", () => {
    const text = formatReport(report([rule("r1")], [run("2026-10-30T08:00:00.000Z", "r1")]));
    expect(text).not.toMatch(/\b(pass|passed|fail(ed)? the|ok|healthy|all good)\b/i);
  });
});

describe("throttled and partial runs", () => {
  it("does not count a run with remaining actions as success, and counts it apart", () => {
    const r = report(
      [rule("r1")],
      [
        run("2026-10-30T08:00:00.000Z", "r1"),
        run("2026-10-30T09:00:00.000Z", "r1", { remaining: 3 }),
      ],
    );
    const rep = r.activeRules[0]!;
    expect(rep.lastSuccessAt).toBe("2026-10-30T08:00:00.000Z");
    expect(rep.partialRuns).toBe(1);
    expect(rep.failedRuns).toBe(0);
  });

  it("starts no duplicate suspicion from runs with failed or remaining actions", () => {
    for (const partial of [{ failed: 1 }, { remaining: 2 }]) {
      const r = report(
        [rule("r1")],
        [
          run("2026-10-30T07:00:00.000Z", "r1", { duplicates: 1 }),
          run("2026-10-30T08:00:00.000Z", "r1", { duplicates: 1, ...partial }),
          run("2026-10-30T09:00:00.000Z", "r1", { duplicates: 1 }),
        ],
      );
      expect(r.activeRules[0]!.duplicateSuspicions, JSON.stringify(partial)).toEqual([]);
    }
  });
});

describe("paused accounts", () => {
  it("shows source and target apart", () => {
    const r = report([rule("r1", { sourceNeedsReconnect: 1 })], []);
    const rep = r.activeRules[0]!;
    expect(rep.sourcePausedNow).toBe(true);
    expect(rep.targetPausedNow).toBe(false);
    const text = formatReport(r);
    expect(text).toContain("source account acc-src paused now");
    expect(text).not.toContain("target account acc-1 paused now");
  });
});

describe("rules without a successful run", () => {
  const reasonOf = (audit: AuditRow[]) => report([rule("r1")], audit).activeRules[0]!;

  it("tells no run, only dry runs and runs without success apart", () => {
    expect(reasonOf([]).notCoveredReason).toBe("no_runs");
    expect(
      reasonOf([run("2026-10-30T08:00:00.000Z", "r1", { dryRun: true })]).notCoveredReason,
    ).toBe("only_dry_runs");
    expect(reasonOf([run("2026-10-30T08:00:00.000Z", "r1", { failed: 1 })]).notCoveredReason).toBe(
      "no_successful_run",
    );
  });

  it("names the creation time of a new rule", () => {
    const rep = reasonOf([row("rule_created", "2026-10-30T07:00:00.000Z", "r1")]);
    expect(rep.createdAt).toBe("2026-10-30T07:00:00.000Z");
    expect(
      formatReport(report([rule("r1")], [row("rule_created", "2026-10-30T07:00:00.000Z", "r1")])),
    ).toContain("rule created 2026-10-30T07:00:00.000Z");
  });
});

describe("print safety", () => {
  it("cuts and replaces text instead of dropping it", () => {
    expect(safeCode("Graph GET failed: 504 timeout")).toBe("Graph GET failed: 504 timeout");
    expect(safeCode("user@example.com\nx")).toBe("user_example.com_x");
    expect(safeCode("a".repeat(200))).toHaveLength(80);
    expect(safeCode("")).toBe("?");
    expect(safeCode(5)).toBe("?");
  });

  it("hashes a calendar ID that holds an address", () => {
    const ref = shortRef("owner@example.com");
    expect(ref).toMatch(/^ref-[0-9a-f]{8}$/);
    expect(shortRef("owner@example.com")).toBe(ref);
    const text = formatReport(
      report(
        [rule("r1")],
        [row("compare_run", "2026-10-30T04:00:00.000Z", null, { calendarId: "owner@example.com" })],
      ),
    );
    expect(text).not.toContain("owner@");
    expect(text).toContain(ref);
  });
});

describe("options", () => {
  it("refuses a value that starts with --", () => {
    expect(readOption(["--since", "3d"], "--since")).toBe("3d");
    expect(readOption([], "--since")).toBeUndefined();
    expect(() => readOption(["--since", "--remote"], "--since")).toThrow();
    expect(() => readOption(["--since"], "--since")).toThrow();
  });

  it("reads a time without zone as UTC", () => {
    expect(parseSince("2026-10-01T10:00", NOW)).toBe(Date.parse("2026-10-01T10:00:00Z"));
    expect(parseSince("2026-10-01T10:00:00+02:00", NOW)).toBe(Date.parse("2026-10-01T08:00:00Z"));
  });
});

describe("known audit kinds", () => {
  it("covers every kind of AuditKind in src/audit.ts", () => {
    const union = /export type AuditKind =([^;]+);/.exec(auditSource)?.[1] ?? "";
    const kinds = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(kinds.length).toBeGreaterThan(20);
    expect(kinds.filter((kind) => !KNOWN_KINDS.has(kind))).toEqual([]);
  });
});
