import {
  createScheduledController,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_REPEAT_MS,
  alertLockStatement,
  checkSilentRules,
  isHourlyTick,
  MAX_ALERT_RULES,
  MAX_CHECKED_RULES,
  compareAlertsAfter,
  sendAbortAlert,
  sendCompareAlert,
  SILENCE_CHECK_SUBREQUESTS,
  SILENCE_SCAN_ROWS,
  silentRuleStatements,
  SILENT_RULE_MS,
} from "../src/alerts";
import type { AccountSync } from "../src/account-sync";
import worker from "../src/index";
import type { CompareMode, CompareRunDetail } from "../src/sync/compare";
import { countingEnv, EMPTY_FAKE_SEED, noFakeNetwork, signIn, stopClock } from "./helpers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A time on one UTC day, 12 hours after midnight. No seeded row here crosses into another day. */
const NOON = Date.parse("2026-10-30T12:00:00.000Z");

function acceptAlerts() {
  const alerts: { text: string; url: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    alerts.push({ url, ...(JSON.parse(init?.body as string) as { text: string }) });
    return new Response("ok");
  });
  return alerts;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

/** A rule between two accounts. The accounts and calendars carry the prefix `name`. */
async function seedRule(name: string, userId: string) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(`${name}-from`, userId, `${name}-from@example.com`),
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'google', ?)",
    ).bind(`${name}-to`, userId, `${name}-to@example.com`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, 'r', 'Private plans')",
    ).bind(`${name}-src`, `${name}-from`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, 'r', 'Work')",
    ).bind(`${name}-dst`, `${name}-to`),
    env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES (?, ?, ?, ?)",
    ).bind(name, userId, `${name}-src`, `${name}-dst`),
  ]);
  return name;
}

async function addEvent(
  kind: string,
  at: number,
  ids: { ruleId?: string; accountId?: string; userId?: string; detail?: object },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, created_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ids.userId ?? null,
      ids.accountId ?? null,
      ids.ruleId ?? null,
      kind,
      JSON.stringify(ids.detail ?? {}),
      iso(at),
    )
    .run();
}

async function addRun(
  ruleId: string,
  at: number,
  dryRun = false,
  counts: { failed?: number; remaining?: number } = {},
): Promise<void> {
  await addEvent("sync_run", at, {
    ruleId,
    detail: { dryRun, failed: 0, remaining: 0, ...counts },
  });
}

async function fillAuditLog(
  rows: number,
  at: number,
  ownerId: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
     INSERT INTO audit_events (org_id, user_id, kind, created_at)
     SELECT 'default', ?3, 'sign_in', ?2 FROM n`,
  )
    .bind(rows, iso(at), ownerId)
    .run();
}

/** `total` rules into one calendar, each from a calendar of its own. Rule IDs: `<name>-0001` on. */
async function seedManyRules(name: string, total: number, ownerId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?1, ?3, 'microsoft', ?1 || '@example.com'), (?2, ?3, 'google', ?2 || '@example.com')",
    ).bind(`${name}-from`, `${name}-to`, ownerId),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, 'r', 'Work')",
    ).bind(`${name}-dst`, `${name}-to`),
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO calendars (id, account_id, remote_id, name)
       SELECT printf('%s-src-%04d', ?2, i), ?2 || '-from', 'r' || i, 'Plans' FROM n`,
    ).bind(total, name),
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id)
       SELECT printf('%s-%04d', ?2, i), ?3, printf('%s-src-%04d', ?2, i), ?2 || '-dst' FROM n`,
    ).bind(total, name, ownerId),
  ]);
}

/** Audit rows of alerts without a rule: reports about the check itself. */
async function blindAlerts() {
  const { results } = await env.DB.prepare(
    "SELECT detail FROM audit_events WHERE rule_id IS NULL AND kind = 'alert_sent'",
  ).all<{ detail: string }>();
  return results.map((row) => JSON.parse(row.detail) as Record<string, unknown>);
}

async function sentAlerts(ruleId: string) {
  const { results } = await env.DB.prepare(
    "SELECT detail FROM audit_events WHERE rule_id = ? AND kind = 'alert_sent'",
  )
    .bind(ruleId)
    .all<{ detail: string }>();
  return results.map((row) => JSON.parse(row.detail) as Record<string, unknown>);
}

let userId: string;

beforeEach(async () => {
  noFakeNetwork();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM rules"),
    env.DB.prepare("DELETE FROM accounts"),
    env.DB.prepare("UPDATE users SET active = 1"),
  ]);
  ({
    user: { id: userId },
  } = await signIn("owner@example.com"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("silence check", () => {
  it("links the admin page without the trailing slashes of PUBLIC_URL", async () => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("slashes", userId);
    await addRun(ruleId, NOON - 4 * HOUR);

    await checkSilentRules({ ...env, PUBLIC_URL: ` ${env.PUBLIC_URL}/// ` }, NOON);

    expect(alerts[0]?.text).toContain(`${env.PUBLIC_URL}/admin`);
    expect(alerts[0]?.text).not.toContain("//admin");
  });

  it("alerts for an active rule without a run for 3 hours, without content", async () => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("silent", userId);
    await addRun(ruleId, NOON - 4 * HOUR);

    await checkSilentRules(env, NOON);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.url).toBe(env.ALERT_WEBHOOK_URL);
    expect(alerts[0]?.text).toContain(ruleId);
    expect(alerts[0]?.text).toContain(`${env.PUBLIC_URL}/admin`);
    expect(alerts[0]?.text).toContain("3 hours");
    expect(alerts[0]?.text).not.toContain("example.com");
    expect(alerts[0]?.text).not.toContain("Private plans");
    expect(await sentAlerts(ruleId)).toEqual([{ code: "rule_silent" }]);
  });

  it("counts a rule whose only entry is older than the window", async () => {
    const alerts = acceptAlerts();
    await seedRule("no-events", userId);
    await checkSilentRules(env, NOON);
    expect(alerts).toHaveLength(1);
  });

  it.each([
    ["one minute inside the window", SILENT_RULE_MS - MINUTE, 0],
    ["exactly at the limit", SILENT_RULE_MS, 0],
    ["one minute outside the window", SILENT_RULE_MS + MINUTE, 1],
  ])("treats a run %s by its time", async (_name, age, expected) => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("edge", userId);
    await addRun(ruleId, NOON - age);
    await checkSilentRules(env, NOON);
    expect(alerts).toHaveLength(expected);
  });

  it("does not count a dry run as a run", async () => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("dry", userId);
    await addRun(ruleId, NOON - HOUR, true);
    await checkSilentRules(env, NOON);
    expect(alerts).toHaveLength(1);
  });

  it("does not count a failed run as a run", async () => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("failing", userId);
    await addEvent("sync_failed", NOON - HOUR, { ruleId, detail: { code: "graph_500" } });
    await checkSilentRules(env, NOON);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain(`Runs with errors: ${ruleId}.`);
  });

  it.each([
    ["with failed actions", { failed: 2 }],
    ["with work left open", { remaining: 3 }],
  ])("does not count a finished run %s as a successful run", async (_name, counts) => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("unclean", userId);
    await addRun(ruleId, NOON - HOUR, false, counts);
    await checkSilentRules(env, NOON);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain(`Runs with errors: ${ruleId}.`);
    expect(alerts[0]?.text).not.toContain("No run:");
  });

  it("counts a rule from its last successful run, not from its last run", async () => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("older-success", userId);
    await addRun(ruleId, NOON - 4 * HOUR);
    await addRun(ruleId, NOON - HOUR, false, { failed: 1 });
    await checkSilentRules(env, NOON);
    expect(alerts).toHaveLength(1);
  });

  it("lets a successful run beside failed runs keep a rule quiet", async () => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("recovered", userId);
    await addRun(ruleId, NOON - 2 * HOUR, false, { failed: 1 });
    await addRun(ruleId, NOON - HOUR);
    await checkSilentRules(env, NOON);
    expect(alerts).toEqual([]);
  });

  it("names rules without a run apart from rules with failed runs", async () => {
    const alerts = acceptAlerts();
    await seedRule("idle", userId);
    await addRun(await seedRule("broken", userId), NOON - HOUR, false, { failed: 1 });
    await checkSilentRules(env, NOON);
    expect(alerts[0]?.text).toContain("No run: idle.");
    expect(alerts[0]?.text).toContain("Runs with errors: broken.");
  });

  it("counts a paused rule as not silent", async () => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("off", userId);
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    await checkSilentRules(env, NOON);
    expect(alerts).toEqual([]);
  });

  it.each(["from", "to"])("skips a rule whose %s account needs reconnecting", async (side) => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("paused", userId);
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
      .bind(`${ruleId}-${side}`)
      .run();
    await checkSilentRules(env, NOON);
    expect(alerts).toEqual([]);
  });

  it("skips a rule of a deactivated user", async () => {
    const alerts = acceptAlerts();
    await seedRule("inactive", userId);
    await env.DB.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(userId).run();
    await checkSilentRules(env, NOON);
    expect(alerts).toEqual([]);
  });

  it("skips a rule of a user the access policy no longer admits", async () => {
    const alerts = acceptAlerts();
    await env.DB.prepare(
      `INSERT INTO users (id, org_id, email, role) VALUES ('left', 'default', 'left@gone.example', 'member')`,
    ).run();
    await seedRule("left-rule", "left");
    await addRun(await seedRule("stays", userId), NOON - HOUR);
    await checkSilentRules(env, NOON);
    expect(alerts).toEqual([]);
  });

  it.each([
    ["rule_created", { ruleId: "fresh" }],
    ["rule_enabled", { ruleId: "fresh" }],
    // The editor turns a rule on with this kind; see `applyChoices`.
    ["rule_updated", { ruleId: "fresh" }],
    ["account_connected", { accountId: "fresh-from" }],
    ["account_resumed", { accountId: "fresh-from" }],
    ["account_connected", { accountId: "fresh-to" }],
    ["account_resumed", { accountId: "fresh-to" }],
  ])("gives a rule 3 hours after %s %j", async (kind, ids) => {
    const alerts = acceptAlerts();
    await seedRule("fresh", userId);
    await addEvent(kind, NOON - HOUR, ids);
    await checkSilentRules(env, NOON);
    expect(alerts).toEqual([]);
  });

  it("gives a rule 3 hours after its user is active again", async () => {
    const alerts = acceptAlerts();
    await seedRule("back", userId);
    await addEvent("user_reactivated", NOON - HOUR, { userId });
    await checkSilentRules(env, NOON);
    expect(alerts).toEqual([]);
  });

  it("ends that grace after 3 hours", async () => {
    const alerts = acceptAlerts();
    await seedRule("grace-over", userId);
    await addEvent("rule_created", NOON - 4 * HOUR, { ruleId: "grace-over" });
    await checkSilentRules(env, NOON);
    expect(alerts).toHaveLength(1);
  });

  it("lets an event of another rule, account or user grant no grace", async () => {
    const alerts = acceptAlerts();
    await seedRule("alone", userId);
    await addEvent("rule_created", NOON - HOUR, { ruleId: "another" });
    await addEvent("account_resumed", NOON - HOUR, { accountId: "another" });
    await addEvent("user_reactivated", NOON - HOUR, { userId: "another" });
    await checkSilentRules(env, NOON);
    expect(alerts).toHaveLength(1);
  });

  it("sends nothing and reads nothing without ALERT_WEBHOOK_URL", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const errors = vi.spyOn(console, "error");
    await seedRule("no-url", userId);
    const counted = countingEnv();
    await checkSilentRules({ ...counted.env, ALERT_WEBHOOK_URL: " " }, NOON);
    await checkSilentRules({ ...counted.env, ALERT_WEBHOOK_URL: undefined }, NOON);
    expect(fetch).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(counted.counts.d1).toBe(0);
  });
});

describe("repeat lock of alerts", () => {
  const now = () => Date.now();

  it("sends one alert per rule and reason, and repeats after the lock", async () => {
    const alerts = acceptAlerts();
    await seedRule("repeat", userId);
    const start = now();

    await checkSilentRules(env, start);
    await checkSilentRules(env, start + HOUR);
    await checkSilentRules(env, start + ALERT_REPEAT_MS - HOUR);
    expect(alerts).toHaveLength(1);

    // The hourly check six hours later, although the lock was written after its own tick began.
    await checkSilentRules(env, start + ALERT_REPEAT_MS);
    expect(alerts).toHaveLength(2);
  });

  it("does not let the alert of another reason lock this one", async () => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("other-reason", userId);
    await addEvent("alert_sent", now() - HOUR, { ruleId, detail: { code: "run_aborted" } });
    await checkSilentRules(env, now());
    expect(alerts).toHaveLength(1);
  });

  it("does not let the alert of another rule lock this one", async () => {
    const alerts = acceptAlerts();
    await seedRule("other-rule", userId);
    await addEvent("alert_sent", now() - HOUR, {
      ruleId: "another",
      detail: { code: "rule_silent" },
    });
    await checkSilentRules(env, now());
    expect(alerts).toHaveLength(1);
  });

  it.each([
    ["an answer of 500", () => Promise.resolve(new Response("no", { status: 500 }))],
    ["an answer of 302", () => Promise.resolve(new Response("no", { status: 302 }))],
    ["a network failure", () => Promise.reject(new TypeError("down"))],
  ])("counts nothing after %s, and the next check sends again", async (_name, answer) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(answer);
    const ruleId = await seedRule("undelivered", userId);

    await checkSilentRules(env, now());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await sentAlerts(ruleId)).toEqual([]);

    await checkSilentRules(env, now() + HOUR);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends an abort alert once per rule within the lock", async () => {
    const alerts = acceptAlerts();
    const scope = { orgId: "default", userId, accountId: "a" };
    expect(await sendAbortAlert(env, scope, ["r1"])).toEqual({ outcome: "sent", open: [] });
    expect(await sendAbortAlert(env, scope, ["r1"])).toEqual({ outcome: "off", open: [] });
    expect(await sendAbortAlert(env, scope, ["r1", "r2"])).toEqual({ outcome: "sent", open: [] });
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.text).toContain("r2");
    expect(alerts[1]?.text).not.toContain("r1");
    expect(await sentAlerts("r1")).toEqual([{ code: "run_aborted" }]);
  });

  it("keeps the abort alert open after a failed delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 503 }));
    const scope = { orgId: "default", userId, accountId: "a" };
    expect(await sendAbortAlert(env, scope, ["r1"])).toEqual({ outcome: "failed", open: ["r1"] });
    expect(await sentAlerts("r1")).toEqual([]);
  });

  it("keeps the abort lock behind thousands of newer audit rows", async () => {
    const alerts = acceptAlerts();
    const scope = { orgId: "default", userId, accountId: "a" };
    await sendAbortAlert(env, scope, ["r1"]);
    await fillAuditLog(2_500, Date.now() + MINUTE, userId);
    expect(await sendAbortAlert(env, scope, ["r1"])).toEqual({ outcome: "off", open: [] });
    expect(alerts).toHaveLength(1);
  });

  it("names the first rules of a long abort list, and leaves the others open", async () => {
    const alerts = acceptAlerts();
    const scope = { orgId: "default", userId, accountId: "a" };
    const ruleIds = Array.from({ length: MAX_ALERT_RULES + 3 }, (_, index) => `abort-${index}`);
    const { outcome, open } = await sendAbortAlert(env, scope, ruleIds);
    expect(outcome).toBe("sent");
    expect(open).toEqual(ruleIds.slice(MAX_ALERT_RULES));
    expect(alerts[0]?.text).toContain(`${ruleIds.length} rules`);
  });

  it("reads the locks through the index of alert events", async () => {
    await fillAuditLog(3_000, Date.now());
    const statement = alertLockStatement(env.DB, "default", iso(Date.now() - HOUR));
    const { meta } = await statement.run();
    expect(meta.rows_read).toBeLessThan(10);
  });

  it("sends an abort alert without content, and nothing without a URL", async () => {
    const alerts = acceptAlerts();
    const scope = { orgId: "default", userId, accountId: "a" };
    await sendAbortAlert(env, scope, ["r1"]);
    expect(alerts[0]?.text).toContain("r1");
    expect(alerts[0]?.text).not.toContain("owner@example.com");

    const counted = countingEnv();
    const off = { ...counted.env, ALERT_WEBHOOK_URL: "" };
    expect(await sendAbortAlert(off, scope, ["r2"])).toEqual({ outcome: "off", open: [] });
    expect(alerts).toHaveLength(1);
    expect(counted.counts.d1).toBe(0);
  });
});

describe("alert about a comparison", () => {
  const scope = () => ({ orgId: "default", userId, accountId: "a" });
  const found = (calendarId: string, deviations = 2, mode: CompareMode = "full") => ({
    calendarId,
    mode,
    scanStartedAt: "2026-10-30T10:00:00.000Z",
    deviations,
    missing: deviations,
    surplus: 0,
    mismatched: 0,
    duplicates: 0,
    hitsCapped: false,
  });

  it("names the calendars and their counts, and stores the lock per calendar", async () => {
    const alerts = acceptAlerts();
    const result = await sendCompareAlert(env, scope(), [found("cal-a"), found("cal-b", 3)]);
    expect(result).toEqual({ outcome: "sent", open: [] });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain("2 calendars");
    expect(alerts[0]?.text).toContain("cal-a (2 missing");
    expect(alerts[0]?.text).toContain("cal-b (3 missing");
  });

  it("says that a cut list gives a lower bound", async () => {
    const alerts = acceptAlerts();
    await sendCompareAlert(env, scope(), [{ ...found("cal-capped"), hitsCapped: true }]);
    expect(alerts[0]?.text).toContain("list cut off");
  });

  it("keeps a result within the lock open until the lock ends", async () => {
    const alerts = acceptAlerts();
    const now = Date.now();
    await sendCompareAlert(env, scope(), [found("cal-lock")], now);
    const newer = found("cal-lock", 5);

    const { outcome, open } = await sendCompareAlert(env, scope(), [newer], now + HOUR);

    expect(outcome).toBe("off");
    expect(open).toEqual([{ ...newer, notBefore: expect.any(Number) }]);
    const waitsFor = (open[0]?.notBefore ?? 0) - now;
    expect(waitsFor).toBeGreaterThan(ALERT_REPEAT_MS - MINUTE);
    expect(waitsFor).toBeLessThanOrEqual(ALERT_REPEAT_MS + MINUTE);
    expect(alerts).toHaveLength(1);

    const after = await sendCompareAlert(env, scope(), open, now + ALERT_REPEAT_MS + MINUTE);
    expect(after).toEqual({ outcome: "sent", open: [] });
    expect(alerts[1]?.text).toContain("cal-lock (5 missing");
  });

  it("sends a calendar without a lock, and keeps the one within its lock", async () => {
    const alerts = acceptAlerts();
    const now = Date.now();
    await sendCompareAlert(env, scope(), [found("cal-held")], now);
    const { outcome, open } = await sendCompareAlert(
      env,
      scope(),
      [found("cal-held"), found("cal-next")],
      now + HOUR,
    );
    expect(outcome).toBe("sent");
    expect(open.map((alert) => alert.calendarId)).toEqual(["cal-held"]);
    expect(alerts[1]?.text).toContain("cal-next");
    expect(alerts[1]?.text).not.toContain("cal-held");
  });

  it("keeps the waiting result open after a failed post of another calendar", async () => {
    acceptAlerts();
    const now = Date.now();
    await sendCompareAlert(env, scope(), [found("cal-held-2")], now);
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 500 }));
    const { outcome, open } = await sendCompareAlert(
      env,
      scope(),
      [found("cal-held-2"), found("cal-failed-2")],
      now + HOUR,
    );
    expect(outcome).toBe("failed");
    expect(open.map((alert) => alert.calendarId).sort()).toEqual(["cal-failed-2", "cal-held-2"]);
  });

  it("does not say that a run took place for a calendar without a rule", async () => {
    const alerts = acceptAlerts();
    await sendCompareAlert(env, scope(), [found("cal-left", 2, "leftover")]);
    expect(alerts[0]?.text).toContain("cal-left");
    expect(alerts[0]?.text).toContain("without an active rule");
    expect(alerts[0]?.text).not.toContain("successful run");
  });

  it("names both kinds of calendars apart", async () => {
    const alerts = acceptAlerts();
    await sendCompareAlert(env, scope(), [found("cal-rule"), found("cal-gone", 1, "leftover")]);
    expect(alerts[0]?.text).toContain("2 calendars");
    expect(alerts[0]?.text).toMatch(/successful run: cal-rule \(2 missing/);
    expect(alerts[0]?.text).toMatch(/without an active rule: cal-gone \(1 missing/);
  });

  it("does not let the lock of another calendar or reason stop this one", async () => {
    const alerts = acceptAlerts();
    await addEvent("alert_sent", Date.now() - HOUR, {
      detail: { code: "compare_deviation", calendarId: "cal-other" },
    });
    await addEvent("alert_sent", Date.now() - HOUR, { detail: { code: "check_blind" } });
    await sendCompareAlert(env, scope(), [found("cal-free")]);
    expect(alerts).toHaveLength(1);
  });

  it("keeps all open after a failed post, and writes no lock", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 500 }));
    const alert = found("cal-failed");
    expect(await sendCompareAlert(env, scope(), [alert])).toEqual({
      outcome: "failed",
      open: [alert],
    });
    expect(await blindAlerts()).toEqual([]);
  });

  it("names the first calendars of a long list, and leaves the others open", async () => {
    const alerts = acceptAlerts();
    const list = Array.from({ length: MAX_ALERT_RULES + 2 }, (_, index) => found(`long-${index}`));
    const { outcome, open } = await sendCompareAlert(env, scope(), list);
    expect(outcome).toBe("sent");
    expect(open).toEqual(list.slice(MAX_ALERT_RULES));
    expect(alerts[0]?.text).toContain(`${list.length} calendars`);
  });

  it("sends nothing and reads nothing without a URL", async () => {
    const { counts, env: counted } = countingEnv();
    expect(
      await sendCompareAlert({ ...counted, ALERT_WEBHOOK_URL: "" }, scope(), [found("cal-off")]),
    ).toEqual({ outcome: "off", open: [] });
    expect(counts.d1).toBe(0);
  });
});

describe("open comparison alerts after a result", () => {
  const open = (calendarId: string, mode: CompareMode) =>
    ({
      calendarId,
      mode,
      scanStartedAt: "2026-10-30T10:00:00.000Z",
      deviations: 1,
      missing: 1,
      surplus: 0,
      mismatched: 0,
      duplicates: 0,
      hitsCapped: false,
    }) as const;
  const result = (calendarId: string, mode: CompareMode, fields: object = {}) =>
    ({
      ...open(calendarId, mode),
      scanStartedAt: "2026-10-30T12:00:00.000Z",
      deviations: 0,
      missing: 0,
      slices: 1,
      rounds: 1,
      expected: 3,
      unconfirmed: 0,
      cleared: 0,
      clearedHits: "",
      hits: "",
      clean: true,
      ...fields,
    }) as CompareRunDetail;

  it("adds a result with a confirmed deviation, without its lists", () => {
    const detail = result("c", "full", { deviations: 1, missing: 1, hits: "missing:x" });
    const [alert] = compareAlertsAfter([], detail);
    expect(alert).toMatchObject({ calendarId: "c", deviations: 1, missing: 1 });
    expect(JSON.stringify(alert)).not.toContain("missing:x");
  });

  it("keeps one entry per calendar, and the newest counts", () => {
    const detail = result("c", "near", { deviations: 2, missing: 2 });
    const waiting = { ...open("c", "full"), notBefore: 5 };
    expect(compareAlertsAfter([waiting, open("d", "full")], detail)).toEqual([
      open("d", "full"),
      expect.objectContaining({ calendarId: "c", deviations: 2, mode: "near" }),
    ]);
    expect(compareAlertsAfter([waiting], detail)[0]).not.toHaveProperty("notBefore");
  });

  it.each<[CompareMode, CompareMode]>([
    ["full", "full"],
    ["full", "near"],
    ["near", "near"],
    ["leftover", "leftover"],
    ["leftover", "full"],
  ])("lets a clean %s comparison end an open %s alert", (mode, openMode) => {
    expect(compareAlertsAfter([open("c", openMode)], result("c", mode))).toEqual([]);
  });

  it.each<[CompareMode, CompareMode]>([
    ["near", "full"],
    ["near", "leftover"],
    ["full", "leftover"],
  ])("does not let a clean %s comparison end an open %s alert of a wider window", (mode, wider) => {
    const queue = [open("c", wider)];
    expect(compareAlertsAfter(queue, result("c", mode))).toEqual(queue);
  });

  it("does not let a result with unconfirmed hits or a cut list end an alert", () => {
    const queue = [open("c", "full")];
    const unconfirmed = result("c", "full", { unconfirmed: 1, clean: false });
    const capped = result("c", "full", { hitsCapped: true, clean: false });
    expect(compareAlertsAfter(queue, unconfirmed)).toEqual(queue);
    expect(compareAlertsAfter(queue, capped)).toEqual(queue);
  });

  it("does not touch the alert of another calendar", () => {
    const queue = [open("d", "full")];
    expect(compareAlertsAfter(queue, result("c", "full"))).toEqual(queue);
  });
});

describe("limits of the silence check", () => {
  it("sends one alert for many rules, names the first ones, and the next check the rest", async () => {
    const alerts = acceptAlerts();
    const count = MAX_ALERT_RULES + 3;
    const now = Date.now();
    for (let index = 0; index < count; index++) {
      await seedRule(`many-${String(index).padStart(2, "0")}`, userId);
    }

    await checkSilentRules(env, now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain(String(count));
    expect(alerts[0]?.text).toContain(`many-${String(MAX_ALERT_RULES - 1).padStart(2, "0")}`);
    expect(alerts[0]?.text).not.toContain(`many-${MAX_ALERT_RULES}`);

    await checkSilentRules(env, now + HOUR);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.text).toContain(`many-${MAX_ALERT_RULES}`);

    await checkSilentRules(env, now + 2 * HOUR);
    expect(alerts).toHaveLength(2);
  });

  it("names every silent rule over time, also beyond what the repeat lock can hold", async () => {
    const alerts = acceptAlerts();
    // One alert per hour, and a lock of 6 hours: the rules in the first 120 places would come back
    // before these ones had their turn.
    const total = 8 * MAX_ALERT_RULES;
    await seedManyRules("all", total, userId);
    const start = Date.now();

    for (let hour = 0; hour < 8; hour++) {
      const now = start + hour * HOUR;
      const newest = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_events")
        .first<{ id: number }>()
        .then((row) => row?.id ?? 0);
      await checkSilentRules(env, now);
      // D1 stamps a row with the real time, and this test moves through simulated hours.
      await env.DB.prepare("UPDATE audit_events SET created_at = ? WHERE id > ?")
        .bind(iso(now), newest)
        .run();
    }

    const named = new Set(alerts.flatMap(({ text }) => text.match(/all-\d{4}/g) ?? []));
    expect(named.size).toBe(total);
  });

  it("costs at most three subrequests, with an alert and many rules", async () => {
    const alerts = acceptAlerts();
    for (let index = 0; index < MAX_ALERT_RULES + 3; index++) {
      await seedRule(`cost-${index}`, userId);
    }
    const { counts, env: counted } = countingEnv();
    await checkSilentRules(counted, Date.now());
    // One read batch, one write batch, one webhook call.
    expect(counts.d1).toBe(2);
    expect(alerts).toHaveLength(1);
    expect(counts.durable).toEqual([]);
  });

  it("costs one subrequest while no rule is silent", async () => {
    const alerts = acceptAlerts();
    const ruleId = await seedRule("quiet", userId);
    await addRun(ruleId, Date.now() - HOUR);
    const { counts, env: counted } = countingEnv();
    await checkSilentRules(counted, Date.now());
    expect(counts.d1).toBe(1);
    expect(alerts).toEqual([]);
  });

  it("reports itself, and no rule, if the scan cannot cover the window", async () => {
    const alerts = acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ruleId = await seedRule("hidden-run", userId);
    // The run exists, but the limit of the scan hides it behind newer rows.
    const now = Date.now();
    await addRun(ruleId, now - 2 * HOUR);
    await fillAuditLog(SILENCE_SCAN_ROWS, now - HOUR);

    await checkSilentRules(env, now);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).not.toContain(ruleId);
    expect(alerts[0]?.text).toContain("hourly check");
    expect(alerts[0]?.text).toContain(`${env.PUBLIC_URL}/admin`);
    expect(await sentAlerts(ruleId)).toEqual([]);
    expect(await blindAlerts()).toEqual([{ code: "check_blind" }]);
  });

  it("repeats the report about itself only after the lock", async () => {
    const alerts = acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedRule("blind-repeat", userId);
    const now = Date.now();
    await fillAuditLog(SILENCE_SCAN_ROWS, now + ALERT_REPEAT_MS);

    await checkSilentRules(env, now);
    await checkSilentRules(env, now + HOUR);
    await checkSilentRules(env, now + ALERT_REPEAT_MS - HOUR);
    expect(alerts).toHaveLength(1);

    await checkSilentRules(env, now + ALERT_REPEAT_MS);
    expect(alerts).toHaveLength(2);
  });

  it("does not store the lock of a report that the webhook refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 503 }));
    await seedRule("blind-refused", userId);
    const now = Date.now();
    await fillAuditLog(SILENCE_SCAN_ROWS, now + HOUR);
    await checkSilentRules(env, now);
    expect(await blindAlerts()).toEqual([]);
  });

  /** `env` with a D1 that fails the next `failures` batches. */
  function failingBatches(failures: number): Env {
    let left = failures;
    return {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if (key === "batch") {
            return (statements: D1PreparedStatement[]) =>
              left-- > 0
                ? Promise.reject(new Error("D1_ERROR: transient"))
                : target.batch(statements);
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;
  }

  it("reports itself if D1 fails, once within the lock", async () => {
    const alerts = acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const now = Date.now();

    await checkSilentRules(failingBatches(1), now);
    await checkSilentRules(failingBatches(1), now + HOUR);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain("database");
    expect(await blindAlerts()).toEqual([{ code: "check_blind" }]);
  });

  it("still reports itself if D1 cannot tell the lock", async () => {
    const alerts = acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      ...env,
      DB: {
        batch: () => Promise.reject(new Error("D1_ERROR: down")),
        prepare: () => {
          throw new Error("D1_ERROR: down");
        },
      },
    } as unknown as Env;
    await expect(checkSilentRules(broken, Date.now())).resolves.toBeUndefined();
    expect(alerts).toHaveLength(1);
  });

  it("costs at most the reserved subrequests while it reports itself", async () => {
    const alerts = acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const now = Date.now();
    const { counts, env: counted } = countingEnv(async (sql) => {
      if (counts.d1 === 1 && sql.length > 1) throw new Error("D1_ERROR: transient");
    });
    await checkSilentRules(counted, now);
    expect(counts.d1 + alerts.length).toBe(SILENCE_CHECK_SUBREQUESTS);
  });

  it("reports itself if the access policy admits no owner of an active rule", async () => {
    const alerts = acceptAlerts();
    await env.DB.prepare(
      `INSERT INTO users (id, org_id, email, role) VALUES ('nobody', 'default', 'n@gone.example', 'member')`,
    ).run();
    const ruleId = await seedRule("nobody-rule", "nobody");
    await checkSilentRules(env, Date.now());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain("access");
    expect(alerts[0]?.text).not.toContain(ruleId);
    expect(alerts[0]?.text).not.toContain("gone.example");
    expect(await blindAlerts()).toEqual([{ code: "check_blind" }]);
  });

  it("takes turns through more rules than one check reads", async () => {
    const alerts = acceptAlerts();
    const total = MAX_CHECKED_RULES + 20;
    await seedManyRules("turn", total, userId);
    // Every rule ran, except the last one in the order of the check.
    const last = `turn-${String(total).padStart(4, "0")}`;
    const start = Math.floor(Date.now() / (total * HOUR)) * total * HOUR;
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO audit_events (org_id, rule_id, kind, detail, created_at)
       SELECT 'default', printf('turn-%04d', i), 'sync_run', '{}', ?2 FROM n`,
    )
      .bind(total - 1, iso(start + 3 * HOUR))
      .run();

    await checkSilentRules(env, start);
    expect(alerts).toEqual([]);

    await checkSilentRules(env, start + HOUR);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain(last);
  });

  it("reads only the window, and uses the org index", async () => {
    await seedRule("planned", userId);
    await fillAuditLog(2_000, NOON - HOUR);
    await fillAuditLog(3_000, NOON - 10 * HOUR);
    const [, scan] = silentRuleStatements(env.DB, NOON);
    if (!scan) throw new Error("The scan statement is missing");

    const { meta } = await scan.run();
    // D1 counts a scanned row twice: in the index walk and in the subquery. So this is the 2,000
    // rows of the window, without the 3,000 rows before it.
    expect(meta.rows_read).toBeLessThan(2 * 2_000 + 100);

    const { statement, params } = scan as unknown as { statement: string; params: unknown[] };
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${statement}`)
      .bind(...params)
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join("\n");
    expect(plan).toContain("audit_events_org_created");
    expect(plan).not.toMatch(/SCAN audit_events(?! USING)/);
  });

  it("stops at the row limit, however many rows the window holds", async () => {
    await seedRule("capped", userId);
    await fillAuditLog(SILENCE_SCAN_ROWS + 500, NOON - HOUR);
    const [, scan] = silentRuleStatements(env.DB, NOON);
    if (!scan) throw new Error("The scan statement is missing");
    const { meta } = await scan.run();
    expect(meta.rows_read).toBeLessThan(2 * SILENCE_SCAN_ROWS + 100);
  });
});

describe("hourly check in the cron handler", () => {
  it("takes the first tick of an hour, whatever the exact second", () => {
    expect(isHourlyTick(Date.parse("2026-10-30T12:00:00.000Z"))).toBe(true);
    expect(isHourlyTick(Date.parse("2026-10-30T12:09:59.000Z"))).toBe(true);
    expect(isHourlyTick(Date.parse("2026-10-30T12:10:00.000Z"))).toBe(false);
    expect(isHourlyTick(Date.parse("2026-10-30T12:50:00.000Z"))).toBe(false);
  });

  /** The start of the current hour plus `minutes`, so that the purge keeps the seeded rows. */
  const inThisHour = (minutes: number) => Math.floor(Date.now() / HOUR) * HOUR + minutes * MINUTE;

  it("runs the check at the top of the hour", async () => {
    const alerts = acceptAlerts();
    await seedRule("cron", userId);
    await worker.scheduled(
      createScheduledController({ scheduledTime: inThisHour(0), cron: "*/10 * * * *" }),
      env,
    );
    expect(alerts).toHaveLength(1);
  });

  it("does not run the check on the other ticks", async () => {
    const alerts = acceptAlerts();
    await seedRule("cron-later", userId);
    await worker.scheduled(
      createScheduledController({ scheduledTime: inThisHour(20), cron: "*/10 * * * *" }),
      env,
    );
    expect(alerts).toEqual([]);
  });

  it("still ticks the accounts if the check fails", async () => {
    const alerts = acceptAlerts();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedRule("cron-broken", userId);
    const stub = env.ACCOUNT_SYNC.getByName("cron-broken-to");
    await stub.storeTokens("cron-broken-to", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + HOUR,
    });
    const failing = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, key) {
          if (key === "batch") return () => Promise.reject(new Error("D1_ERROR: transient"));
          const value = Reflect.get(target, key) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;

    await worker.scheduled(
      createScheduledController({ scheduledTime: inThisHour(0), cron: "*/10 * * * *" }),
      failing,
    );

    expect(JSON.stringify(errors.mock.calls)).toContain("Silence check failed");
    expect(alerts).toHaveLength(1);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  });

  async function seedAccounts(count: number) {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO accounts (id, user_id, provider, email)
       SELECT 'tick-' || i, ?2, 'google', 'tick-' || i || '@example.com' FROM n`,
    )
      .bind(count, userId)
      .run();
  }

  /** Runs one cron invocation over `count` accounts, and returns how many got a tick. */
  async function ticksOf(count: number, scheduledTime: number, url: string | undefined) {
    acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedAccounts(count);
    let ticks = 0;
    const counting = {
      ...env,
      ALERT_WEBHOOK_URL: url,
      ACCOUNT_SYNC: {
        getByName: () => ({
          tick: () => {
            ticks += 1;
            return Promise.resolve();
          },
        }),
      },
    } as unknown as Env;
    await worker.scheduled(
      createScheduledController({ scheduledTime, cron: "*/10 * * * *" }),
      counting,
    );
    return ticks;
  }

  // One read of the accounts and one purge of the audit log stay outside the ticks.
  const FREE_TICKS = 50 - 2;
  const CRON_MS = 10 * MINUTE;
  const THREE_HOURS_OF_TICKS = 18;

  /** A rule from one shared source into each account of `seedAccounts`. */
  async function seedTargetRules(count: number) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO accounts (id, user_id, provider, email)
         VALUES ('tick-source', ?, 'microsoft', 'source@example.com')`,
      ).bind(userId),
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO calendars (id, account_id, remote_id, name)
         SELECT 'tick-src-' || i, 'tick-source', 'r' || i, 'Plans' FROM n`,
      ).bind(count),
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO calendars (id, account_id, remote_id, name)
         SELECT 'tick-dst-' || i, 'tick-' || i, 'r', 'Work' FROM n`,
      ).bind(count),
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id)
         SELECT 'tick-rule-' || i, ?2, 'tick-src-' || i, 'tick-dst-' || i FROM n`,
      ).bind(count, userId),
    ]);
  }

  function runStatement(ruleId: string, at: number): D1PreparedStatement {
    return env.DB.prepare(
      `INSERT INTO audit_events (org_id, rule_id, kind, detail, created_at)
       VALUES ('default', ?, 'sync_run', '{"dryRun":false,"failed":0,"remaining":0}', ?)`,
    ).bind(ruleId, iso(at));
  }

  it("keeps the old limit of subrequests on a tick without the check", async () => {
    expect(await ticksOf(60, inThisHour(20), env.ALERT_WEBHOOK_URL)).toBe(FREE_TICKS);
  });

  it("gives the subrequests of the check up from the ticks of the same invocation", async () => {
    expect(await ticksOf(60, inThisHour(0), env.ALERT_WEBHOOK_URL)).toBe(
      FREE_TICKS - SILENCE_CHECK_SUBREQUESTS,
    );
  });

  it("gives up no ticks without a webhook, because the check then costs nothing", async () => {
    expect(await ticksOf(60, inThisHour(0), undefined)).toBe(FREE_TICKS);
  });

  /** An `env` whose Durable Objects call `onTick` with the account and take no subrequest. */
  function tickingEnv(onTick: (accountId: string) => void, base: Env = env): Env {
    return {
      ...base,
      ACCOUNT_SYNC: {
        getByName: (id: string) => ({
          tick: () => {
            onTick(id);
            return Promise.resolve();
          },
        }),
      },
    } as unknown as Env;
  }

  /** The time of the invocation `index` after the top of this hour. */
  const cronTime = (index: number) => inThisHour(0) + index * CRON_MS;

  function cron(scheduledTime: number, target: Env) {
    return worker.scheduled(
      createScheduledController({ scheduledTime, cron: "*/10 * * * *" }),
      target,
    );
  }

  it.each([
    [49, 20],
    [60, 20],
    [100, 30],
  ])("gives each of %i accounts a turn at least every %i minutes", async (count, minutes) => {
    acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedAccounts(count);
    const times = new Map<string, number[]>();
    let now = 0;
    const counting = tickingEnv((id) => times.set(id, [...(times.get(id) ?? []), now]));

    for (let index = 0; index < THREE_HOURS_OF_TICKS; index++) {
      now = cronTime(index);
      await cron(now, counting);
    }

    expect(times.size).toBe(count);
    const end = cronTime(THREE_HOURS_OF_TICKS);
    for (const [id, ticks] of times) {
      const gaps = [ticks[0] ?? end, ...ticks, end].map(
        (time, index, all) => (all[index + 1] ?? time) - time,
      );
      expect([id, Math.max(...gaps) <= minutes * MINUTE]).toEqual([id, true]);
    }
  });

  it("gives the account behind the limit its turn in the next invocation", async () => {
    acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedAccounts(FREE_TICKS + 1);
    const ticked = new Set<string>();
    const counting = tickingEnv((id) => ticked.add(id));
    await cron(cronTime(1), counting);
    await cron(cronTime(2), counting);
    expect(ticked.size).toBe(FREE_TICKS + 1);
  });

  it("ticks an account at most once per invocation, across the end of the list", async () => {
    acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedAccounts(FREE_TICKS + 7);
    for (let index = 0; index < 6; index++) {
      const ticks: string[] = [];
      await cron(
        cronTime(index),
        tickingEnv((id) => ticks.push(id)),
      );
      expect(new Set(ticks).size).toBe(ticks.length);
    }
  });

  it("stays inside the subrequests of an invocation while it rotates and alerts", async () => {
    const alerts = acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedAccounts(100);
    await seedRule("over-budget", userId);
    const { counts, env: counted } = countingEnv();
    let ticks = 0;
    await cron(
      cronTime(0),
      tickingEnv(() => {
        ticks += 1;
      }, counted),
    );
    expect(alerts).toHaveLength(1);
    expect(counts.d1 + alerts.length + ticks).toBeLessThanOrEqual(50);
  });

  // Runs the real `AccountSync.tick`, full cycle and audit rows. D1 stamps a row with the real time,
  // so the test moves each new row to the simulated time. A watch keeps the tick from polling the
  // rule, so that only the full cycle runs it.
  it.each(["aaa", "zzz"])(
    "keeps the real cycle of account %s inside the 3 hours while it rotates",
    async (name) => {
      stopClock();
      const alerts = acceptAlerts();
      vi.spyOn(console, "error").mockImplementation(() => {});
      await seedAccounts(100);
      const ruleId = await seedRule(name, userId);
      const start = inThisHour(0) + HOUR;
      await env.DB.prepare("UPDATE calendars SET watched_until = ?")
        .bind(start + 24 * HOUR)
        .run();
      const stubs = [`${name}-from`, `${name}-to`].map((id) => env.ACCOUNT_SYNC.getByName(id));
      for (const [index, stub] of stubs.entries()) {
        const id = index === 0 ? `${name}-from` : `${name}-to`;
        await stub.storeTokens(id, {
          refreshToken: "fake",
          accessToken: "fake",
          accessExpiresAt: Date.now() + 1_000 * HOUR,
        });
        await stub.seedFake(EMPTY_FAKE_SEED, 0);
      }
      const target = stubs[1] as DurableObjectStub<AccountSync>;

      const stamped = async (at: number, work: () => Promise<unknown>) => {
        const newest = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_events")
          .first<{ id: number }>()
          .then((row) => row?.id ?? 0);
        vi.setSystemTime(at);
        await work();
        await env.DB.prepare("UPDATE audit_events SET created_at = ? WHERE id > ?")
          .bind(iso(at), newest)
          .run();
      };
      await stamped(start - MINUTE, () => target.runRule(ruleId));

      const cycles: number[] = [];
      for (let index = 0; index < 8 * 6; index++) {
        const now = start + index * CRON_MS;
        await stamped(now, () => cron(now, env));
        await stamped(now + 5_000, async () => {
          while (await runDurableObjectAlarm(target));
        });
        const at = await runInDurableObject(target, (_instance, state) =>
          state.storage.get<number>("fullCycleAt"),
        );
        if (at !== undefined && at !== cycles.at(-1)) cycles.push(at);
      }

      for (const stub of stubs) {
        await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
      }
      expect(cycles.length).toBeGreaterThanOrEqual(5);
      const steps = cycles.slice(1).map((at, index) => at - (cycles[index] ?? 0));
      expect(Math.max(...steps)).toBeLessThanOrEqual(90 * MINUTE);
      expect(alerts).toEqual([]);
    },
    // Forty-eight real cron and alarm steps: about 3 s alone, over 30 s on a loaded machine.
    120_000,
  );

  it("reports no rule as silent because its account waited for its turn", async () => {
    const alerts = acceptAlerts();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const count = 100;
    await seedAccounts(count);
    await seedTargetRules(count);
    const start = cronTime(0);
    const lastCycle = new Map<string, number>();
    await env.DB.batch(
      Array.from({ length: count }, (_, index) => {
        lastCycle.set(`tick-${index + 1}`, start - MINUTE);
        return runStatement(`tick-rule-${index + 1}`, start - MINUTE);
      }),
    );

    // As `AccountSync.tick`: a full cycle starts once its hour is over, a moment after the tick.
    let now = 0;
    let due: string[] = [];
    const ticking = tickingEnv((id) => {
      if (now - (lastCycle.get(id) ?? 0) < HOUR) return;
      lastCycle.set(id, now + 5_000);
      due.push(id);
    });
    for (let index = 0; index < 12 * 6; index++) {
      now = cronTime(index);
      due = [];
      await cron(now, ticking);
      if (due.length > 0) {
        await env.DB.batch(
          due.map((id) => runStatement(id.replace("tick-", "tick-rule-"), now + 5_000)),
        );
      }
    }

    expect(alerts).toEqual([]);
    const { longest } = (await env.DB.prepare(
      `SELECT MAX(gap) AS longest FROM (
         SELECT unixepoch(created_at) - unixepoch(LAG(created_at) OVER (
           PARTITION BY rule_id ORDER BY created_at)) AS gap
         FROM audit_events WHERE kind = 'sync_run')`,
    ).first<{ longest: number }>()) ?? { longest: 0 };
    expect(longest * 1_000).toBeLessThanOrEqual(90 * MINUTE + 5_000);
    expect(longest * 1_000).toBeLessThan(SILENT_RULE_MS);
  });
});
