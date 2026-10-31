import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSync } from "../src/account-sync";
import { ALERT_REPEAT_MS, type CompareAlert } from "../src/alerts";
import { COMPARE_LIMIT, latestCompares } from "../src/audit";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { describeCompare } from "../src/pages/activity";
import { FakeCalendar } from "../src/providers/fake-calendar";
import { GoogleCalendar } from "../src/providers/google-calendar";
import { GraphCalendar } from "../src/providers/graph-calendar";
import { COMPARE_TIMEOUT_MS, type CompareMode, type CompareState } from "../src/sync/compare";
import { GOOGLE_MARKER_KEY } from "../src/sync/google-events";
import { MARKER_PROPERTY_ID } from "../src/sync/graph-events";
import { markerFor, ruleTagFor } from "../src/sync/plan";
import type { ExistingBlock } from "../src/sync/types";
import { BASE, EMPTY_FAKE_SEED, noFakeNetwork, signIn, stopClock } from "./helpers";

const DAY = 86_400_000;
const CALENDAR = "main";

type Stub = DurableObjectStub<AccountSync>;

const stubs = new Set<string>();

function stubOf(accountId: string): Stub {
  stubs.add(accountId);
  return env.ACCOUNT_SYNC.getByName(accountId);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    [...stubs].map((id) =>
      runInDurableObject(stubOf(id), (_instance, state) => state.storage.deleteAlarm()),
    ),
  );
  stubs.clear();
});

beforeEach(() => {
  stopClock();
  noFakeNetwork();
});

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** Midnight UTC, `days` days from now. */
function dayStart(days: number): number {
  return Math.floor(Date.now() / DAY) * DAY + days * DAY;
}

function at(days: number, hour: number): string {
  return new Date(dayStart(days) + hour * 3_600_000).toISOString();
}

interface Setup {
  source: Stub;
  target: Stub;
  sourceId: string;
  targetId: string;
  ruleId: string;
  calendarId: string;
  userId: string;
}

const SECOND_CALENDAR = "second";

/** A second rule into the same target, from the source account's second calendar. */
async function addSecondRule(name: string, ruleId: string, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, ?, 'Second')",
    ).bind(`${name}-a-second`, `${name}-a`, SECOND_CALENDAR),
    env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(ruleId, userId, `${name}-a-second`, `${name}-b-main`, JSON.stringify({ daysAhead: 30 })),
  ]);
}

/** Two simulated accounts and a rule from the first into the second, with one meeting. */
async function setup(name: string, options: object = {}): Promise<Setup> {
  const { user } = await signIn("owner@example.com");
  const sourceId = `${name}-a`;
  const targetId = `${name}-b`;
  await env.DB.batch(
    [sourceId, targetId].flatMap((id) => [
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
      ).bind(id, user.id, `${id}@example.com`),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, ?, 'Cal')",
      ).bind(`${id}-main`, id, CALENDAR),
    ]),
  );
  const ruleId = `${name}-rule`;
  await env.DB.prepare(
    `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      ruleId,
      user.id,
      `${sourceId}-main`,
      `${targetId}-main`,
      JSON.stringify({ daysAhead: 30, ...options }),
    )
    .run();
  const source = stubOf(sourceId);
  const target = stubOf(targetId);
  for (const [id, stub] of [
    [sourceId, source],
    [targetId, target],
  ] as const) {
    await stub.storeTokens(id, {
      refreshToken: "fake",
      accessToken: "fake",
      accessExpiresAt: Date.now() + 365 * DAY,
    });
    await stub.seedFake(EMPTY_FAKE_SEED, 0);
  }
  await source.addFakeEvent({ id: "meeting", start: at(3, 10), end: at(3, 11) });
  await target.runRule(ruleId);
  // Past the source cache of the rule's read.
  advance(120_000);
  return {
    source,
    target,
    sourceId,
    targetId,
    ruleId,
    calendarId: `${targetId}-main`,
    userId: user.id,
  };
}

async function alarms(stub: Stub): Promise<number> {
  let count = 0;
  while (await runDurableObjectAlarm(stub)) count++;
  return count;
}

function stateOf(stub: Stub, calendarId: string): Promise<CompareState | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<CompareState>(`compare:${calendarId}`),
  );
}

function alarmKind(stub: Stub): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get("feedOnlyAlarm"));
}

interface CompareEvent {
  kind: string;
  detail: Record<string, string | number | boolean>;
}

async function compareEvents(accountId: string): Promise<CompareEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind, detail FROM audit_events
     WHERE account_id = ? AND kind IN ('compare_run', 'compare_failed') ORDER BY id`,
  )
    .bind(accountId)
    .all<{ kind: string; detail: string }>();
  return results.map((row) => ({
    kind: row.kind,
    detail: JSON.parse(row.detail) as CompareEvent["detail"],
  }));
}

async function failure(accountId: string): Promise<CompareEvent["detail"]> {
  const events = await compareEvents(accountId);
  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe("compare_failed");
  return (events[0] as CompareEvent).detail;
}

async function result(accountId: string): Promise<CompareEvent["detail"]> {
  const events = await compareEvents(accountId);
  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe("compare_run");
  return (events[0] as CompareEvent).detail;
}

async function fakeCalls(stub: Stub, operation: string): Promise<number> {
  return (await stub.fakeStats()).calls[operation] ?? 0;
}

/** Move the clock to an hour of the next UTC day. It stays ahead of real time; see `stopClock`. */
function clockAt(hour: number): void {
  vi.setSystemTime(dayStart(1) + hour * 3_600_000);
}

/** Let D1 refuse audit rows of a kind, as an outage does. */
async function refuseAudit(kind: string): Promise<() => Promise<void>> {
  const name = `refuse_${kind}`;
  await env.DB.prepare(
    `CREATE TRIGGER ${name} BEFORE INSERT ON audit_events WHEN NEW.kind = '${kind}'
     BEGIN SELECT RAISE(ABORT, 'refused'); END`,
  ).run();
  return async () => {
    await env.DB.prepare(`DROP TRIGGER ${name}`).run();
  };
}

/** Let a full comparison take the place of an open one during the next target read. */
function replacedDuringRead(
  target: Stub,
  calendarId: string,
  read: () => Promise<ExistingBlock[]>,
): Promise<void> {
  return runInDurableObject(target, (_instance, state) => {
    vi.spyOn(FakeCalendar.prototype, "allBlocks").mockImplementationOnce(async () => {
      const key = `compare:${calendarId}`;
      const open = await state.storage.get<CompareState>(key);
      await state.storage.put(key, {
        ...open,
        mode: "full",
        startedAt: (open?.startedAt ?? 0) + 1,
        slices: 0,
        sliceDays: 7,
      });
      return read();
    });
  });
}

/** Run a first scan to its end, so that the comparison waits for its confirmation. */
async function scanToWait(setupResult: Setup): Promise<CompareState> {
  await setupResult.target.startCompares("full");
  await alarms(setupResult.target);
  const state = await stateOf(setupResult.target, setupResult.calendarId);
  expect(state?.phase).toBe("confirming");
  return state as CompareState;
}

describe("a scan", () => {
  it("reads one slice per alarm, and reports no deviation for a calendar in sync", async () => {
    const { source, target, targetId, calendarId } = await setup("walk");
    expect(await target.startCompares("full")).toEqual({ started: 1, open: 0, failed: 0 });
    expect(await alarmKind(target)).toBe("compare");
    const blocksBefore = await fakeCalls(target, "allBlocks");
    const eventsBefore = await fakeCalls(source, "sourceEvents");

    // 30 days less the last day are 29 days: four slices of seven, and one of a day.
    for (let step = 1; step <= 5; step++) {
      expect(await runDurableObjectAlarm(target)).toBe(true);
      expect((await fakeCalls(target, "allBlocks")) - blocksBefore).toBe(step);
      expect((await fakeCalls(source, "sourceEvents")) - eventsBefore).toBe(step);
    }
    expect(await runDurableObjectAlarm(target)).toBe(false);
    expect(await stateOf(target, calendarId)).toBeUndefined();
    expect(await result(targetId)).toMatchObject({
      calendarId,
      mode: "full",
      rounds: 1,
      slices: 5,
      expected: 1,
      missing: 0,
      surplus: 0,
      mismatched: 0,
      duplicates: 0,
      deviations: 0,
      hits: "",
      clean: true,
    });
  });

  it("finds a timed block of today that a run lost", async () => {
    clockAt(2);
    const context = await setup("today", {});
    await context.source.addFakeEvent({ id: "tonight", start: at(0, 20), end: at(0, 21) });
    advance(120_000);
    await context.target.runRule(context.ruleId);
    await context.target.injectFakeFault({ kind: "block_deleted" });
    const state = await scanToWait(context);
    expect(state.counts.missing).toBe(1);
  });

  it("finds no gap at a block without duration at the start of a slice", async () => {
    const { source, target, targetId, ruleId } = await setup("no-duration");
    await source.addFakeEvent({ id: "instant", start: at(7, 0), end: at(7, 0) });
    advance(120_000);
    await target.runRule(ruleId);
    await target.startCompares("full");
    await alarms(target);
    expect(await result(targetId)).toMatchObject({
      rounds: 1,
      expected: 2,
      deviations: 0,
      clean: true,
    });
  });

  it("stores no event in the state or the result", async () => {
    const { source, target, targetId, calendarId } = await setup("private");
    await source.addFakeEvent({
      id: "secret",
      start: at(4, 10),
      end: at(4, 11),
      subject: "Secret board meeting",
    });
    await target.startCompares("full");
    await runDurableObjectAlarm(target);
    expect(JSON.stringify(await stateOf(target, calendarId))).not.toContain("Secret");
    await alarms(target);
    expect(JSON.stringify(await compareEvents(targetId))).not.toContain("Secret");
  });

  it("does not start a sync cycle from its alarm", async () => {
    const { target } = await setup("no-cycle");
    const before = await fakeCalls(target, "applyBatch");
    const stored = async () =>
      runInDurableObject(target, (_instance, state) => state.storage.get("ruleQueue"));
    await target.startCompares("full");
    await runDurableObjectAlarm(target);
    expect(await stored()).toBeUndefined();
    expect(await fakeCalls(target, "applyBatch")).toBe(before);
  });

  it("lets a sync go first, and goes on after it", async () => {
    const { target, targetId, calendarId } = await setup("sync-first");
    await target.startCompares("full");
    await target.requestSync();
    expect(await alarmKind(target)).toBeUndefined();
    expect(await runDurableObjectAlarm(target)).toBe(true);
    expect((await stateOf(target, calendarId))?.slices).toBe(0);
    expect(await alarmKind(target)).toBe("compare");
    await alarms(target);
    expect(await result(targetId)).toMatchObject({ deviations: 0 });
  });

  it("leaves queued sync work to go first, although its alarm is due", async () => {
    const { target, targetId, ruleId, calendarId } = await setup("queue-first");
    await target.startCompares("full");
    expect(await alarmKind(target)).toBe("compare");
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("ruleQueue", [ruleId]),
    );
    expect(await runDurableObjectAlarm(target)).toBe(true);
    expect((await stateOf(target, calendarId))?.slices).toBe(0);
    await alarms(target);
    expect(await result(targetId)).toMatchObject({ deviations: 0 });
  });

  it("keeps a waiting removal's alarm after it ends", async () => {
    const { target, targetId } = await setup("removal-alarm");
    const notBefore = Date.now() + 3_600_000;
    await runInDurableObject(target, async (_instance, state) => {
      await state.storage.put("removalQueue", [
        { ruleId: "gone", remoteCalendarId: "elsewhere", attempts: 1, notBefore },
      ]);
      await state.storage.put("feedOnlyAlarm", "removal");
      await state.storage.setAlarm(notBefore);
    });
    await target.startCompares("full");
    expect(await alarmKind(target)).toBe("compare");
    for (let step = 0; step < 5; step++) await runDurableObjectAlarm(target);
    expect(await result(targetId)).toMatchObject({ deviations: 0 });
    expect(await alarmKind(target)).toBe("removal");
    const alarm = await runInDurableObject(target, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBe(notBefore);
  });

  it("allows one open comparison per calendar", async () => {
    const { target } = await setup("one-open");
    expect(await target.startCompares("full")).toEqual({ started: 1, open: 0, failed: 0 });
    expect(await target.startCompares("full")).toEqual({ started: 0, open: 1, failed: 0 });
    expect(await target.startCompares("near")).toEqual({ started: 0, open: 1, failed: 0 });
  });

  it("replaces a waiting daily comparison with a full one, and says so", async () => {
    const context = await setup("replaced");
    await context.target.injectFakeFault({
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    await context.target.startCompares("near");
    await alarms(context.target);
    expect((await stateOf(context.target, context.calendarId))?.phase).toBe("confirming");

    expect(await context.target.startCompares("full")).toEqual({
      started: 1,
      open: 0,
      failed: 0,
    });
    expect(await stateOf(context.target, context.calendarId)).toMatchObject({
      mode: "full",
      phase: "scanning",
    });
    expect(await failure(context.targetId)).toMatchObject({ mode: "near", reason: "superseded" });
  });

  it("keeps a waiting full comparison and counts it as open", async () => {
    const context = await setup("full-open");
    await context.target.injectFakeFault({
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    await scanToWait(context);
    expect(await context.target.startCompares("full")).toEqual({
      started: 0,
      open: 1,
      failed: 0,
    });
  });

  it("does not let a slice of a replaced comparison land in the new one", async () => {
    const { target, calendarId } = await setup("replaced-step");
    await target.startCompares("near");
    await replacedDuringRead(target, calendarId, () => Promise.resolve([]));
    await runDurableObjectAlarm(target);
    expect(await stateOf(target, calendarId)).toMatchObject({ mode: "full", slices: 0 });
  });

  it("does not let a failed read of a replaced comparison end the new one", async () => {
    const { target, targetId, calendarId } = await setup("replaced-fail");
    await target.startCompares("near");
    await replacedDuringRead(target, calendarId, () => Promise.reject(new Error("read failed")));
    await runDurableObjectAlarm(target);
    expect(await stateOf(target, calendarId)).toMatchObject({ mode: "full", slices: 0 });
    expect(await compareEvents(targetId)).toEqual([]);
  });

  it("does not let a too large read of a replaced comparison halve the new one", async () => {
    const { target, calendarId } = await setup("replaced-large");
    await target.startCompares("near");
    await replacedDuringRead(target, calendarId, () =>
      Promise.reject(new Error("Too many subrequests.")),
    );
    await runDurableObjectAlarm(target);
    expect(await stateOf(target, calendarId)).toMatchObject({ mode: "full", sliceDays: 7 });
  });

  it("refuses a calendar with no slice to compare", async () => {
    const { target, targetId } = await setup("no-horizon", { daysAhead: 1 });
    expect(await target.startCompares("full")).toEqual({ started: 0, open: 0, failed: 1 });
    expect((await failure(targetId)).reason).toBe("empty_horizon");
  });
});

describe("a deviation", () => {
  async function waiting(name: string, fault: Parameters<Stub["injectFakeFault"]>[0]) {
    const context = await setup(name);
    await context.target.injectFakeFault(fault);
    return { ...context, state: await scanToWait(context) };
  }

  it("is found for a deleted block", async () => {
    const { state } = await waiting("deleted", { kind: "block_deleted" });
    expect(state.counts.missing).toBe(1);
    expect(state.first?.hits).toEqual([expect.stringMatching(/^missing:[0-9a-f]{32}$/)]);
  });

  it("is found for a block moved by one minute", async () => {
    const { state } = await waiting("shifted", { kind: "block_shifted", minutes: 1 });
    expect(state.counts.mismatched).toBe(1);
  });

  it("is found for a block that is too large", async () => {
    const { state } = await waiting("stretched", { kind: "block_stretched", minutes: 30 });
    expect(state.counts.mismatched).toBe(1);
  });

  it("is found for a block with the wrong status", async () => {
    const { state } = await waiting("status", { kind: "block_status", status: "free" });
    expect(state.counts.mismatched).toBe(1);
  });

  it("is found for a block twice", async () => {
    const { state } = await waiting("doubled", { kind: "block_copied" });
    expect(state.counts.duplicates).toBe(1);
  });

  it("is found for a block of a deleted rule", async () => {
    const { state } = await waiting("orphan", {
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    expect(state.counts).toMatchObject({ surplus: 1, duplicates: 0 });
    expect(state.first?.hits).toEqual(["surplus:orphan"]);
  });

  it("is found for a block that a rule with precedence makes redundant", async () => {
    const context = await setup("cross-rule");
    const tag = await ruleTagFor(context.ruleId);
    let laterId = "";
    for (let suffix = 0; !laterId; suffix++) {
      const id = `cross-rule-later-${suffix}`;
      if ((await ruleTagFor(id)) > tag) laterId = id;
    }
    await addSecondRule("cross-rule", laterId, context.userId);
    // The same meeting in a second source: the later rule must leave it out, but wrote a block.
    await context.source.addFakeEvent({
      id: "meeting-copy",
      calendarId: SECOND_CALENDAR,
      start: at(3, 10),
      end: at(3, 11),
    });
    await context.target.injectFakeFault({
      kind: "block_copied",
      ruleTag: await ruleTagFor(laterId),
      marker: await markerFor(laterId, "event:meeting-copy"),
    });
    const state = await scanToWait(context);
    expect(state.counts).toMatchObject({ duplicates: 1, surplus: 0, missing: 0 });
  });

  it("confirms a block that a run wrote wrongly, although the kind of the hit changed", async () => {
    const { target, targetId, ruleId } = await waiting("rewritten", { kind: "block_deleted" });
    await target.runRule(ruleId);
    // A run does not repair a status, so this block stays wrong as a badly written block does.
    await target.injectFakeFault({ kind: "block_status", status: "free" });
    advance(120_000);
    await target.tick();
    await alarms(target);
    expect(await result(targetId)).toMatchObject({
      rounds: 2,
      missing: 0,
      mismatched: 1,
      deviations: 1,
      cleared: 0,
      unconfirmed: 0,
      clean: false,
    });
  });

  it("is not clean if the second scan finds something new", async () => {
    const { target, targetId, ruleId } = await waiting("new-hit", { kind: "block_deleted" });
    await target.runRule(ruleId);
    await target.injectFakeFault({
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    advance(120_000);
    await target.tick();
    await alarms(target);
    expect(await result(targetId)).toMatchObject({
      deviations: 0,
      cleared: 1,
      unconfirmed: 1,
      clean: false,
    });
  });

  it("reports a deleted and an extra block that the next run repairs", async () => {
    const context = await setup("drill");
    const { source, target, targetId, ruleId } = context;
    await source.addFakeEvent({ id: "second", start: at(4, 10), end: at(4, 11) });
    advance(120_000);
    await target.runRule(ruleId);
    await target.injectFakeFault({ kind: "block_deleted" });
    await target.injectFakeFault({ kind: "block_copied" });
    const state = await scanToWait(context);
    expect(state.counts).toMatchObject({ missing: 1, duplicates: 1 });

    await target.runRule(ruleId);
    advance(120_000);
    await target.tick();
    await alarms(target);
    const detail = await result(targetId);
    expect(detail).toMatchObject({ rounds: 2, deviations: 0, cleared: 2, hits: "" });
    expect(String(detail.clearedHits)).toMatch(/^missing:[0-9a-f]{32},duplicate:[0-9a-f]{32}$/);
  });

  it("keeps a hit of the first day of the scan after midnight UTC", async () => {
    clockAt(2);
    const context = await setup("midnight");
    const { source, target, targetId, ruleId } = context;
    await source.addFakeEvent({ id: "tonight", start: at(0, 20), end: at(0, 21) });
    advance(120_000);
    await target.runRule(ruleId);
    await target.injectFakeFault({
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    await scanToWait(context);
    clockAt(1);
    await target.runRule(ruleId);
    advance(120_000);
    await target.tick();
    await alarms(target);
    expect(await result(targetId)).toMatchObject({
      rounds: 2,
      surplus: 1,
      deviations: 1,
      cleared: 0,
    });
  });

  it("does not count before a second scan, and a run that repairs it clears it", async () => {
    const { target, targetId, ruleId, calendarId } = await waiting("cleared", {
      kind: "block_deleted",
    });
    expect(await compareEvents(targetId)).toEqual([]);

    await target.runRule(ruleId);
    advance(120_000);
    await target.tick();
    expect((await stateOf(target, calendarId))?.phase).toBe("scanning");
    await alarms(target);
    expect(await result(targetId)).toMatchObject({
      rounds: 2,
      missing: 0,
      deviations: 0,
      cleared: 1,
      clearedHits: expect.stringMatching(/^missing:[0-9a-f]{32}$/),
      unconfirmed: 0,
      hits: "",
      clean: true,
    });
  });

  it("counts if it stays after a successful run", async () => {
    const { target, targetId, ruleId } = await waiting("confirmed", {
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    await target.runRule(ruleId);
    advance(120_000);
    await target.tick();
    await alarms(target);
    expect(await result(targetId)).toMatchObject({
      rounds: 2,
      surplus: 1,
      deviations: 1,
      cleared: 0,
      hits: "surplus:orphan",
    });
  });

  it("waits for a run that began after the hit", async () => {
    const { target, calendarId } = await waiting("no-run", {
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    advance(120_000);
    await target.tick();
    expect((await stateOf(target, calendarId))?.phase).toBe("confirming");
  });

  it("takes neither a dry run nor a failed run for a successful one", async () => {
    const { target, ruleId, calendarId } = await waiting("no-good-run", {
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    await target.runRule(ruleId, { dryRun: true });
    await target.injectFakeFault({ kind: "reads_fail", error: "server" });
    const failed = await target.runRule(ruleId).then(
      () => false,
      () => true,
    );
    expect(failed).toBe(true);
    advance(120_000);
    await target.tick();
    expect((await stateOf(target, calendarId))?.phase).toBe("confirming");
  });

  it.each([
    { name: "a failed write", failed: 1, throttled: 0 },
    { name: "a throttled write", failed: 0, throttled: 1 },
  ])("takes a run with $name for no successful one", async ({ name, failed, throttled }) => {
    const { target, ruleId, calendarId } = await waiting(`write-${name.slice(2, 8)}`, {
      kind: "block_deleted",
    });
    vi.spyOn(FakeCalendar.prototype, "applyBatch").mockResolvedValue({
      failed,
      throttled,
      statuses: {},
      writtenIds: [],
    });
    const run = await target.runRule(ruleId);
    expect(run.failed + run.remaining).toBeGreaterThan(0);
    advance(120_000);
    await target.tick();
    expect((await stateOf(target, calendarId))?.phase).toBe("confirming");
  });

  it("waits for every rule of the calendar", async () => {
    const context = await setup("two-rules");
    await addSecondRule("two-rules", "two-rules-other", context.userId);
    await context.target.injectFakeFault({
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    await scanToWait(context);
    await context.target.runRule(context.ruleId);
    advance(120_000);
    await context.target.tick();
    expect((await stateOf(context.target, context.calendarId))?.phase).toBe("confirming");
    await context.target.runRule("two-rules-other");
    advance(120_000);
    await context.target.tick();
    expect((await stateOf(context.target, context.calendarId))?.phase).toBe("scanning");
  });

  it("gives up if no successful run comes within a day", async () => {
    const { target, targetId } = await waiting("timeout", {
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    advance(DAY + 1000);
    await target.tick();
    expect((await failure(targetId)).reason).toBe("timeout");
  });
});

describe("a failed comparison", () => {
  it("stops with config_changed if a rule changes during a scan", async () => {
    const { target, targetId, ruleId, calendarId } = await setup("changed-scan");
    await target.startCompares("full");
    await runDurableObjectAlarm(target);
    await env.DB.prepare("UPDATE rules SET options = ? WHERE id = ?")
      .bind(JSON.stringify({ daysAhead: 40 }), ruleId)
      .run();
    await runDurableObjectAlarm(target);
    expect((await failure(targetId)).reason).toBe("config_changed");
    expect(await stateOf(target, calendarId)).toBeUndefined();
  });

  it("stops with config_changed if a rule changes before the confirmation", async () => {
    const context = await setup("changed-wait");
    await context.target.injectFakeFault({
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    await scanToWait(context);
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(context.ruleId).run();
    await context.target.tick();
    expect((await failure(context.targetId)).reason).toBe("config_changed");
  });

  it("refuses a calendar with a queued removal", async () => {
    const { target, targetId, ruleId, calendarId } = await setup("removal");
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("removalQueue", [{ ruleId, remoteCalendarId: CALENDAR, attempts: 0 }]),
    );
    expect(await target.startCompares("full")).toEqual({ started: 0, open: 0, failed: 1 });
    expect((await failure(targetId)).reason).toBe("removal_queue");
    expect(await stateOf(target, calendarId)).toBeUndefined();
  });

  it("stops if a removal for the calendar joins the queue during a scan", async () => {
    const { target, targetId, ruleId } = await setup("removal-scan");
    await target.startCompares("full");
    await runDurableObjectAlarm(target);
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("removalQueue", [
        { ruleId, remoteCalendarId: CALENDAR, attempts: 1, notBefore: Date.now() + DAY },
      ]),
    );
    await runDurableObjectAlarm(target);
    expect((await failure(targetId)).reason).toBe("removal_queue");
  });

  it("ignores a removal for another calendar", async () => {
    const { target, targetId, ruleId } = await setup("removal-other");
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("removalQueue", [
        { ruleId, remoteCalendarId: "elsewhere", attempts: 1, notBefore: Date.now() + DAY },
      ]),
    );
    await target.startCompares("full");
    await alarms(target);
    expect((await compareEvents(targetId))[0]?.kind).toBe("compare_run");
  });

  it("stops if the target's token is lost, and never reports 0", async () => {
    const { target, targetId } = await setup("token-target");
    await target.startCompares("full");
    await target.injectFakeFault({ kind: "reads_fail", error: "token" });
    await runDurableObjectAlarm(target);
    expect(await failure(targetId)).toMatchObject({
      reason: "token_lost",
      code: "token_invalid_grant",
    });
  });

  it("stops if a source's token is lost", async () => {
    const { source, target, targetId } = await setup("token-source");
    await target.startCompares("full");
    await source.injectFakeFault({ kind: "reads_fail", error: "token" });
    await runDurableObjectAlarm(target);
    expect((await failure(targetId)).reason).toBe("token_lost");
  });

  it("stops if the target pauses during a scan", async () => {
    const { target, targetId } = await setup("paused");
    await target.startCompares("full");
    await runDurableObjectAlarm(target);
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("needsReconnect", {
        code: "invalid_grant",
        since: Date.now(),
        flagPending: false,
        alertPending: false,
        probeAt: Date.now() + DAY,
      }),
    );
    await runDurableObjectAlarm(target);
    expect(await failure(targetId)).toMatchObject({ reason: "paused", code: "invalid_grant" });
  });

  it("refuses a calendar while the target is paused", async () => {
    const { target, targetId } = await setup("paused-start");
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("needsReconnect", {
        code: "invalid_grant",
        since: Date.now(),
        flagPending: false,
        alertPending: false,
        probeAt: Date.now() + DAY,
      }),
    );
    expect(await target.startCompares("full")).toEqual({ started: 0, open: 0, failed: 1 });
    expect(await failure(targetId)).toMatchObject({ reason: "paused", code: "invalid_grant" });
  });

  it("stops a waiting comparison if the target pauses", async () => {
    const context = await setup("paused-wait");
    await context.target.injectFakeFault({
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    await scanToWait(context);
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
      .bind(context.targetId)
      .run();
    await context.target.tick();
    expect((await failure(context.targetId)).reason).toBe("paused");
  });

  it("stops if a source account needs reconnecting", async () => {
    const { sourceId, target, targetId } = await setup("paused-source");
    await target.startCompares("full");
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
      .bind(sourceId)
      .run();
    await runDurableObjectAlarm(target);
    expect((await failure(targetId)).reason).toBe("paused");
  });

  it("stops if the target throttles, and then asks it nothing during the penalty", async () => {
    const { target, targetId } = await setup("throttled");
    await target.startCompares("full");
    await target.injectFakeFault({ kind: "reads_fail", error: "throttled" });
    await runDurableObjectAlarm(target);
    expect(await failure(targetId)).toMatchObject({ reason: "throttled", code: "graph_429" });

    const before = await fakeCalls(target, "allBlocks");
    await target.startCompares("near");
    await runDurableObjectAlarm(target);
    const events = await compareEvents(targetId);
    expect(events.map((event) => event.detail.reason)).toEqual(["throttled", "throttled"]);
    expect(await fakeCalls(target, "allBlocks")).toBe(before);
  });

  it("stops if a source throttles, and asks it nothing during the penalty", async () => {
    const { source, target, targetId } = await setup("throttled-source");
    await target.startCompares("full");
    await source.injectFakeFault({ kind: "reads_fail", error: "throttled" });
    await runDurableObjectAlarm(target);
    expect((await failure(targetId)).reason).toBe("throttled");

    const before = await fakeCalls(source, "sourceEvents");
    await target.startCompares("full");
    await runDurableObjectAlarm(target);
    expect(await fakeCalls(source, "sourceEvents")).toBe(before);
    expect((await compareEvents(targetId)).map((event) => event.detail.reason)).toEqual([
      "throttled",
      "throttled",
    ]);
  });

  it("stops if a source calendar is gone", async () => {
    const { source, target, targetId } = await setup("gone");
    await target.startCompares("full");
    await source.injectFakeFault({ kind: "reads_fail", error: "gone" });
    await runDurableObjectAlarm(target);
    expect((await failure(targetId)).reason).toBe("source_unavailable");
  });

  it("stops on any other read error, with its code", async () => {
    const { target, targetId } = await setup("server");
    await target.startCompares("full");
    await target.injectFakeFault({ kind: "reads_fail", error: "server" });
    await runDurableObjectAlarm(target);
    expect(await failure(targetId)).toMatchObject({ reason: "read_failed", code: "graph_500" });
  });
});

describe("the audit row of a comparison", () => {
  it("keeps a result until D1 took it, without reading the calendars again", async () => {
    const { target, targetId, calendarId } = await setup("audit-result");
    const restore = await refuseAudit("compare_run");
    await target.startCompares("full");
    await alarms(target);
    expect(await compareEvents(targetId)).toEqual([]);
    expect(await stateOf(target, calendarId)).toMatchObject({ phase: "reporting" });

    const reads = await fakeCalls(target, "allBlocks");
    await target.tick();
    expect(await stateOf(target, calendarId)).toMatchObject({ phase: "reporting" });
    expect(await alarmKind(target)).toBeUndefined();

    await restore();
    await target.tick();
    expect(await result(targetId)).toMatchObject({ deviations: 0 });
    expect(await stateOf(target, calendarId)).toBeUndefined();
    expect(await fakeCalls(target, "allBlocks")).toBe(reads);
  });

  it("keeps a failure until D1 took it", async () => {
    const { target, targetId, ruleId, calendarId } = await setup("audit-failure");
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("removalQueue", [{ ruleId, remoteCalendarId: CALENDAR, attempts: 0 }]),
    );
    const restore = await refuseAudit("compare_failed");
    await target.startCompares("full");
    expect(await stateOf(target, calendarId)).toMatchObject({ phase: "reporting" });
    expect(await target.startCompares("full")).toEqual({ started: 0, open: 1, failed: 0 });

    await restore();
    await target.tick();
    expect((await failure(targetId)).reason).toBe("removal_queue");
    expect(await stateOf(target, calendarId)).toBeUndefined();
  });

  it("keeps the result if the account pauses while it waits", async () => {
    const { target, targetId, calendarId } = await setup("audit-paused");
    const restore = await refuseAudit("compare_run");
    await target.startCompares("full");
    await alarms(target);
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
      .bind(targetId)
      .run();
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("needsReconnect", {
        code: "invalid_grant",
        since: Date.now(),
        flagPending: false,
        alertPending: false,
        probeAt: Date.now() + DAY,
      }),
    );
    await restore();
    await target.tick();
    expect(await result(targetId)).toMatchObject({ deviations: 0 });
    expect(await stateOf(target, calendarId)).toBeUndefined();
  });
});

describe("the alarm of a step", () => {
  function diesOnce(target: Stub, calendarId: string) {
    return runInDurableObject(target, (instance, state) => {
      vi.spyOn(
        instance as unknown as { runCompareStep: () => Promise<void> },
        "runCompareStep",
      ).mockImplementationOnce(async () => {
        const stored = await state.storage.get<CompareState>(`compare:${calendarId}`);
        await state.storage.put(`compare:${calendarId}`, {
          ...stored,
          attempt: stored?.sliceStart,
        });
        throw new Error("Exceeded CPU time");
      });
    });
  }

  it("stays marked if a step dies, so that the retry halves the slice", async () => {
    const { target, calendarId } = await setup("step-dies");
    await target.startCompares("full");
    await diesOnce(target, calendarId);
    await expect(runDurableObjectAlarm(target)).rejects.toThrow("Exceeded CPU time");
    expect(await alarmKind(target)).toBe("compare");

    // The platform retries the alarm.
    await runInDurableObject(target, (_instance, state) => state.storage.setAlarm(Date.now()));
    await runDurableObjectAlarm(target);
    expect(await stateOf(target, calendarId)).toMatchObject({ sliceDays: 3, slices: 0 });
    const queue = await runInDurableObject(target, (_instance, state) =>
      state.storage.get("ruleQueue"),
    );
    expect(queue).toBeUndefined();
  });

  it("loses the mark after a step", async () => {
    const { target } = await setup("step-ends");
    await target.startCompares("full");
    const before = await target.fakeStats();
    while (await runDurableObjectAlarm(target));
    expect(await alarmKind(target)).toBeUndefined();
    expect((await target.fakeStats()).calls.applyBatch).toBe(before.calls.applyBatch);
  });

  it("keeps a mark that a tick set during the step", async () => {
    const { target } = await setup("step-tick");
    await target.startCompares("full");
    await runInDurableObject(target, (instance, state) => {
      vi.spyOn(
        instance as unknown as { runCompareStep: () => Promise<void> },
        "runCompareStep",
      ).mockImplementationOnce(async () => {
        await state.storage.put("feedOnlyAlarm", "compare");
        await state.storage.setAlarm(Date.now() + 1000);
      });
    });
    await runDurableObjectAlarm(target);
    expect(await alarmKind(target)).toBe("compare");
  });
});

describe("a calendar without a rule", () => {
  const SPARE = "spare";

  /** A writable calendar of the target account with a block of a deleted rule. */
  async function spare(context: Setup, block = true): Promise<string> {
    const id = `${context.targetId}-spare`;
    await env.DB.prepare(
      `INSERT INTO calendars (id, account_id, remote_id, name, can_edit)
       VALUES (?, ?, ?, 'Spare', 1)`,
    )
      .bind(id, context.targetId, SPARE)
      .run();
    if (block) {
      await context.target.injectFakeFault({
        kind: "block_copied",
        ruleTag: "deadbeef0000",
        marker: "orphan",
      });
      await runInDurableObject(context.target, (_instance, state) =>
        state.storage.sql.exec(
          `UPDATE fake_blocks SET calendar_id = ? WHERE marker = 'orphan'`,
          SPARE,
        ),
      );
    }
    return id;
  }

  it("is read by a full comparison, and each marked block there is surplus", async () => {
    const context = await setup("leftover");
    const { target, targetId, ruleId } = context;
    const id = await spare(context);
    expect(await target.startCompares("full")).toEqual({ started: 2, open: 0, failed: 0 });
    expect(await stateOf(target, id)).toMatchObject({ mode: "leftover", phase: "scanning" });
    await alarms(target);
    expect(await stateOf(target, id)).toMatchObject({ phase: "confirming" });
    await target.runRule(ruleId);
    advance(120_000);
    await target.tick();
    await alarms(target);
    const events = await compareEvents(targetId);
    expect(events.find((event) => event.detail.calendarId === id)?.detail).toMatchObject({
      mode: "leftover",
      expected: 0,
      surplus: 1,
      deviations: 1,
      hits: "surplus:orphan",
    });
  });

  it("reports no left-over block, and that is no comparison", async () => {
    const context = await setup("leftover-empty");
    const id = await spare(context, false);
    await context.target.startCompares("full");
    await alarms(context.target);
    const events = await compareEvents(context.targetId);
    const row = events.find((event) => event.detail.calendarId === id);
    expect(row?.detail).toMatchObject({ mode: "leftover", deviations: 0, clean: false });
  });

  it("is left out of the daily comparison", async () => {
    const context = await setup("leftover-near");
    const id = await spare(context);
    await context.target.startCompares("near");
    expect(await stateOf(context.target, id)).toBeUndefined();
  });

  it("is left out if the account cannot write into it", async () => {
    const context = await setup("leftover-readonly");
    const id = await spare(context);
    await env.DB.prepare("UPDATE calendars SET can_edit = 0 WHERE id = ?").bind(id).run();
    await context.target.startCompares("full");
    expect(await stateOf(context.target, id)).toBeUndefined();
  });

  it("is left out for a deactivated owner", async () => {
    const context = await setup("leftover-owner");
    const id = await spare(context);
    await env.DB.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(context.userId).run();
    await context.target.startCompares("full");
    await env.DB.prepare("UPDATE users SET active = 1 WHERE id = ?").bind(context.userId).run();
    expect(await stateOf(context.target, id)).toBeUndefined();
  });
});

describe("a remote calendar with two rows", () => {
  /** A second account that writes into the target's remote calendar through a row of its own. */
  async function foreignRule(context: Setup, name: string, provider: string): Promise<string> {
    const accountId = `${name}-c`;
    const ruleId = `${name}-foreign`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)",
      ).bind(accountId, context.userId, provider, `${accountId}@example.com`),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, ?, 'Cal')",
      ).bind(`${accountId}-main`, accountId, CALENDAR),
      env.DB.prepare(
        `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(ruleId, context.userId, `${context.sourceId}-main`, `${accountId}-main`, "{}"),
    ]);
    await context.target.injectFakeFault({
      kind: "block_copied",
      ruleTag: await ruleTagFor(ruleId),
      marker: "foreign",
    });
    return ruleId;
  }

  it("takes the blocks of a rule through the other row for active", async () => {
    const context = await setup("two-rows");
    await foreignRule(context, "two-rows", "microsoft");
    await context.target.startCompares("full");
    await alarms(context.target);
    expect(await result(context.targetId)).toMatchObject({
      rounds: 1,
      surplus: 0,
      deviations: 0,
      clean: true,
    });
  });

  it("does not take a calendar of another provider with the same id for the same", async () => {
    const context = await setup("two-providers");
    await foreignRule(context, "two-providers", "google");
    const state = await scanToWait(context);
    expect(state.counts.surplus).toBe(1);
  });

  it("does not take a disabled rule through the other row for active", async () => {
    const context = await setup("two-off");
    const ruleId = await foreignRule(context, "two-off", "microsoft");
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    const state = await scanToWait(context);
    expect(state.counts.surplus).toBe(1);
  });

  it("stops with config_changed if a rule through the other row changes", async () => {
    const context = await setup("two-changed");
    const ruleId = await foreignRule(context, "two-changed", "microsoft");
    await context.target.startCompares("full");
    await runDurableObjectAlarm(context.target);
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    await runDurableObjectAlarm(context.target);
    expect((await failure(context.targetId)).reason).toBe("config_changed");
  });
});

describe("a slice that is too large", () => {
  it("halves at the subrequest limit and goes on", async () => {
    const { target, targetId, calendarId } = await setup("halved");
    await target.startCompares("full");
    await target.injectFakeFault({ kind: "reads_fail", error: "subrequests" });
    await runDurableObjectAlarm(target);
    expect(await stateOf(target, calendarId)).toMatchObject({ sliceDays: 3, slices: 0 });
    await alarms(target);
    expect(await result(targetId)).toMatchObject({ deviations: 0, expected: 1 });
  });

  it("gives up if a slice of one day is too large", async () => {
    const { target, targetId } = await setup("too-large");
    await target.startCompares("full");
    await target.injectFakeFault({ kind: "reads_fail", error: "subrequests", count: 3 });
    await alarms(target);
    expect((await failure(targetId)).reason).toBe("slice_too_large");
  });

  it("halves a slice with too many events without comparing it", async () => {
    const { source, target, calendarId } = await setup("many-events");
    await source.seedFake(EMPTY_FAKE_SEED, 8000);
    await target.startCompares("full");
    await runDurableObjectAlarm(target);
    expect(await stateOf(target, calendarId)).toMatchObject({ sliceDays: 3, slices: 0, hits: [] });
  });

  it("halves a slice after a step died in it, without a read", async () => {
    const { target, calendarId } = await setup("died");
    await target.startCompares("full");
    const before = await fakeCalls(target, "allBlocks");
    await runInDurableObject(target, async (_instance, state) => {
      const stored = await state.storage.get<CompareState>(`compare:${calendarId}`);
      await state.storage.put(`compare:${calendarId}`, {
        ...stored,
        attempt: stored?.sliceStart,
      });
    });
    await runDurableObjectAlarm(target);
    expect(await stateOf(target, calendarId)).toMatchObject({ sliceDays: 3, slices: 0 });
    expect(await fakeCalls(target, "allBlocks")).toBe(before);
  });

  it("halves a slice whose reads take too many pages", async () => {
    const { user } = await signIn("owner@example.com");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('pages', ?, 'microsoft', 'pages@example.com')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES ('pages-s', 'pages', 'src', 'S'), ('pages-t', 'pages', 'dst', 'T')",
      ),
      env.DB.prepare(
        `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
         VALUES ('pages-rule', ?, 'pages-s', 'pages-t', '{}')`,
      ).bind(user.id),
    ]);
    const stub = stubOf("pages");
    await stub.storeTokens("pages", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + DAY,
    });
    let pages = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = input instanceof Request ? input.url : String(input);
      pages++;
      // The target's read ends after 41 pages. The source read has one page.
      const next = url.includes("/dst/") && pages <= 41 ? `${url}&p=${pages}` : undefined;
      return Promise.resolve(
        Response.json({ value: [], ...(next ? { "@odata.nextLink": next } : {}) }),
      );
    });
    await stub.startCompares("full");
    await runDurableObjectAlarm(stub);
    expect(pages).toBeGreaterThan(41);
    expect(await stateOf(stub, "pages-t")).toMatchObject({ sliceDays: 3, slices: 0 });
  });
});

describe("the daily comparison", () => {
  it("starts a day after the first tick, for the first slice only", async () => {
    const { target, targetId, calendarId } = await setup("near");
    await target.tick();
    expect(await stateOf(target, calendarId)).toBeUndefined();

    advance(DAY - 1000);
    await target.tick();
    expect(await stateOf(target, calendarId)).toBeUndefined();

    advance(1000);
    await target.tick();
    expect(await stateOf(target, calendarId)).toMatchObject({ mode: "near" });
    await alarms(target);
    expect(await result(targetId)).toMatchObject({ mode: "near", slices: 1, expected: 1 });
  });

  it("needs a confirmation too", async () => {
    const { target, targetId, calendarId, ruleId } = await setup("near-confirm");
    await target.tick();
    await target.injectFakeFault({
      kind: "block_copied",
      ruleTag: "deadbeef0000",
      marker: "orphan",
    });
    advance(DAY);
    await target.tick();
    await alarms(target);
    expect((await stateOf(target, calendarId))?.phase).toBe("confirming");
    await target.runRule(ruleId);
    advance(120_000);
    await target.tick();
    await alarms(target);
    expect(await result(targetId)).toMatchObject({ mode: "near", rounds: 2, deviations: 1 });
  });

  it("leaves a comparison in progress alone", async () => {
    const { target, targetId } = await setup("near-open");
    await target.tick();
    advance(DAY / 2);
    await target.startCompares("full");
    advance(DAY / 2);
    await target.tick();
    await alarms(target);
    expect(await result(targetId)).toMatchObject({ mode: "full" });
  });
});

describe("fault injection", () => {
  it("works only with simulated calendars", async () => {
    const { target } = await setup("fault-off");
    await runInDurableObject(target, async (instance) => {
      const sync = instance as unknown as AccountSync;
      const holder = instance as unknown as { env: Env };
      const original = holder.env;
      holder.env = { ...original, DEV_FAKE_CALENDARS: "" };
      try {
        await expect(sync.injectFakeFault({ kind: "block_deleted" })).rejects.toThrow(
          "Simulation is off",
        );
        await expect(sync.addFakeEvent({ id: "x", start: "a", end: "b" })).rejects.toThrow(
          "Simulation is off",
        );
      } finally {
        holder.env = original;
      }
    });
  });

  it("does not touch a calendar before it is injected", async () => {
    const { target } = await setup("fault-on");
    const rows = await runInDurableObject(target, (_instance, state) =>
      state.storage.sql.exec(`SELECT id FROM fake_blocks`).toArray(),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("the simulated calendar", () => {
  it("keeps status, privacy and all-day of a block", async () => {
    const { source, target, ruleId } = await setup("fake-fields", {
      skipAllDay: false,
      skipFree: false,
      markPrivate: false,
    });
    await source.addFakeEvent({
      id: "open-free",
      start: at(4, 10),
      end: at(4, 11),
      showAs: "free",
    });
    await source.addFakeEvent({
      id: "secret",
      start: at(5, 10),
      end: at(5, 11),
      isPrivate: true,
    });
    await source.addFakeEvent({
      id: "away",
      start: new Date(dayStart(6)).toISOString().slice(0, 10),
      end: new Date(dayStart(7)).toISOString().slice(0, 10),
      allDay: true,
    });
    advance(120_000);
    await target.runRule(ruleId);
    const rows = await runInDurableObject(target, (_instance, state) =>
      state.storage.sql
        .exec<{ show_as: string; is_private: number; all_day: number }>(
          `SELECT show_as, is_private, all_day FROM fake_blocks ORDER BY start`,
        )
        .toArray(),
    );
    expect(rows).toEqual([
      { show_as: "busy", is_private: 0, all_day: 0 },
      { show_as: "free", is_private: 0, all_day: 0 },
      { show_as: "busy", is_private: 1, all_day: 0 },
      { show_as: "busy", is_private: 0, all_day: 1 },
    ]);
    const events = await target.readSourceEvents(
      CALENDAR,
      { start: new Date(dayStart(0)), end: new Date(dayStart(30)) },
      false,
    );
    expect(events.every((event) => event.isMirror)).toBe(true);
    expect(events.map((event) => event.showAs).sort()).toEqual(["busy", "busy", "busy", "free"]);
    expect(events.filter((event) => event.isPrivate)).toHaveLength(1);
    expect(events.filter((event) => event.allDay)).toHaveLength(1);
  });
});

describe("marker scan", () => {
  const WINDOW = { start: new Date("2026-11-01"), end: new Date("2026-11-08") };

  it("returns blocks of every tag from Graph, with their status", async () => {
    const block = (id: string, tag: string, showAs: string) => ({
      id,
      type: "singleInstance",
      start: { dateTime: "2026-11-03T10:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-11-03T11:00:00.0000000", timeZone: "UTC" },
      isAllDay: false,
      showAs,
      singleValueExtendedProperties: [{ id: MARKER_PROPERTY_ID, value: `${tag}.m-${id}.hash` }],
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        Response.json({
          value: [
            block("1", "aaa", "busy"),
            block("2", "bbb", "free"),
            block("3", "ccc", "tentative"),
          ],
        }),
      ),
    );
    const graph = new GraphCalendar("token");
    const blocks = await graph.allBlocks("cal", WINDOW);
    expect(blocks.map((item) => [item.ruleTag, item.status])).toEqual([
      ["aaa", "blocked"],
      ["bbb", "free"],
      ["ccc", "blocked"],
    ]);
    expect((await graph.existingBlocks("cal", WINDOW, ["bbb"])).map((b) => b.ruleTag)).toEqual([
      "bbb",
    ]);
  });

  it("returns blocks of every tag from Google, with their status", async () => {
    const block = (id: string, tag: string, transparency: string) => ({
      id,
      start: { dateTime: "2026-11-03T10:00:00Z" },
      end: { dateTime: "2026-11-03T11:00:00Z" },
      transparency,
      extendedProperties: { private: { [GOOGLE_MARKER_KEY]: `${tag}.m-${id}.hash` } },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        Response.json({
          items: [block("1", "aaa", "opaque"), block("2", "bbb", "transparent")],
        }),
      ),
    );
    const google = new GoogleCalendar("token");
    const blocks = await google.allBlocks("cal", WINDOW);
    expect(blocks.map((item) => [item.ruleTag, item.status])).toEqual([
      ["aaa", "blocked"],
      ["bbb", "free"],
    ]);
    expect((await google.existingBlocks("cal", WINDOW, ["aaa"])).map((b) => b.ruleTag)).toEqual([
      "aaa",
    ]);
  });
});

describe("/admin", () => {
  async function admin(path: string, cookie: string, method = "GET"): Promise<Response> {
    return exports.default.fetch(`${BASE}${path}`, {
      method,
      headers: { cookie },
      redirect: "manual",
    });
  }

  it("shows the last result although newer events push it off the activity list", async () => {
    const { target, targetId } = await setup("admin-last");
    await target.startCompares("full");
    await alarms(target);
    const { cookie } = await signIn("admin@example.com");
    const { user } = await signIn("owner@example.com");
    await env.DB.batch(
      Array.from({ length: 120 }, () =>
        env.DB.prepare(
          `INSERT INTO audit_events (org_id, user_id, account_id, kind, detail)
           VALUES ('default', ?, ?, 'sync_run', '{}')`,
        ).bind(user.id, targetId),
      ),
    );
    const html = await (await admin("/admin", cookie)).text();
    expect(html).toContain(`data-compare="${targetId}-main:full"`);
    expect(html).toContain(en.activity.compareClean(1));
  });

  it("shows the last result of each mode", async () => {
    const { target, targetId } = await setup("admin-modes");
    await target.startCompares("full");
    await alarms(target);
    await target.startCompares("near");
    await alarms(target);
    const { cookie } = await signIn("admin@example.com");
    const html = await (await admin("/admin", cookie)).text();
    expect(html).toContain(`data-compare="${targetId}-main:full"`);
    expect(html).toContain(`data-compare="${targetId}-main:near"`);
  });

  it("names the reason of a failure", async () => {
    const { target, ruleId } = await setup("admin-failed");
    const { cookie } = await signIn("admin@example.com");
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("removalQueue", [{ ruleId, remoteCalendarId: CALENDAR, attempts: 0 }]),
    );
    await target.startCompares("full");
    const html = await (await admin("/admin", cookie)).text();
    expect(html).toContain("admin-failed-b@example.com");
    expect(html).toContain(en.activity.compareReasons.removal_queue);
  });

  it("starts comparisons for an admin only, and shows what it started", async () => {
    await env.DB.prepare("DELETE FROM accounts").run();
    const { target, calendarId } = await setup("admin-start");
    const { cookie } = await signIn("admin@example.com");
    const member = await signIn("owner@example.com");

    expect((await admin("/admin/compare", member.cookie, "POST")).status).toBe(404);
    expect(await stateOf(target, calendarId)).toBeUndefined();

    const response = await admin("/admin/compare", cookie, "POST");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/admin?compare=requested&started=1&open=0&failed=0",
    );
    expect(await stateOf(target, calendarId)).toMatchObject({ mode: "full" });
  });

  it("shows what a start did", async () => {
    const { cookie } = await signIn("admin@example.com");
    const path = "/admin?compare=requested&started=1&open=2&failed=3";
    expect(await (await admin(path, cookie)).text()).toContain(en.admin.compareCounts(1, 2, 3));
    const none = await (await admin("/admin?compare=requested&started=x", cookie)).text();
    expect(none).toContain(en.admin.compareCounts(0, 0, 0));
    const plain = await (await admin("/admin", cookie)).text();
    expect(plain).not.toContain(en.admin.compareCounts(0, 0, 0));
  });

  it("counts open comparisons, refused calendars and accounts that fail", async () => {
    await env.DB.prepare("DELETE FROM accounts").run();
    const open = await setup("admin-open");
    await open.target.startCompares("full");
    const refused = await setup("admin-refused");
    await runInDurableObject(refused.target, (_instance, state) =>
      state.storage.put("removalQueue", [
        { ruleId: refused.ruleId, remoteCalendarId: CALENDAR, attempts: 0 },
      ]),
    );
    const broken = await setup("admin-broken");
    await env.DB.prepare("UPDATE rules SET options = 'no json' WHERE id = ?")
      .bind(broken.ruleId)
      .run();
    const { cookie } = await signIn("admin@example.com");
    const response = await admin("/admin/compare", cookie, "POST");
    await env.DB.prepare("UPDATE rules SET options = '{}' WHERE id = ?").bind(broken.ruleId).run();
    expect(response.headers.get("location")).toBe(
      "/admin?compare=requested&started=0&open=1&failed=2",
    );
  });

  it("starts a comparison of an account without any rule", async () => {
    const context = await setup("admin-no-rule");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(context.ruleId),
      env.DB.prepare("UPDATE calendars SET can_edit = 1 WHERE id = ?").bind(context.calendarId),
    ]);
    const { cookie } = await signIn("admin@example.com");
    await admin("/admin/compare", cookie, "POST");
    expect(await stateOf(context.target, context.calendarId)).toMatchObject({ mode: "leftover" });
  });

  it("shows the last results per mode, so that one mode does not push out the other", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-m', 'M')").run();
    const rows = (mode: string, count: number) =>
      Array.from({ length: count }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO audit_events (org_id, account_id, kind, detail)
           VALUES ('org-m', 'modes', 'compare_run', ?)`,
        ).bind(JSON.stringify({ calendarId: `${mode}-${index}`, mode })),
      );
    await env.DB.batch(rows("full", 3));
    await env.DB.batch(rows("near", COMPARE_LIMIT + 5));
    const shown = await latestCompares(env.DB, "org-m");
    const modes = shown.map((row) => (JSON.parse(row.detail) as { mode: string }).mode);
    expect(modes.filter((mode) => mode === "full")).toHaveLength(3);
    expect(modes.filter((mode) => mode === "near")).toHaveLength(COMPARE_LIMIT);
  });

  it("names the excluded days, in every language", async () => {
    const { cookie } = await signIn("admin@example.com");
    const html = await (await admin("/admin", cookie)).text();
    expect(html).toContain(en.admin.compareHorizon);
    expect(de.admin.compareHorizon).not.toBe(en.admin.compareHorizon);
  });

  it("shows no result of another org", async () => {
    const { cookie } = await signIn("admin@example.com");
    await env.DB.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-c', 'C')").run();
    await env.DB.prepare(
      `INSERT INTO audit_events (org_id, account_id, kind, detail)
       VALUES ('org-c', 'other-org', 'compare_run', ?)`,
    )
      .bind(JSON.stringify({ calendarId: "other-org-cal", mode: "full", expected: 1 }))
      .run();
    const html = await (await admin("/admin", cookie)).text();
    expect(html).not.toContain("other-org-cal");
  });
});

describe("the text of a result", () => {
  function text(detail: object, t = en): string {
    return describeCompare(
      {
        id: 1,
        kind: "compare_run",
        detail: JSON.stringify(detail),
        createdAt: "",
        email: null,
      },
      t,
    );
  }

  it("is clean only for a clean result", () => {
    expect(text({ mode: "full", clean: true, expected: 3 })).toBe(en.activity.compareClean(3));
  });

  it("is not clean with an unconfirmed hit", () => {
    const line = text({ mode: "full", expected: 3, unconfirmed: 1, cleared: 1 });
    expect(line).not.toContain(en.activity.compareClean(3));
    expect(line).toContain(en.activity.compareUnconfirmed(1));
  });

  it("is not clean with a full list", () => {
    const line = text({ mode: "full", expected: 3, hitsCapped: true });
    expect(line).not.toContain(en.activity.compareClean(3));
    expect(line).toContain(en.activity.compareCapped);
  });

  it("names a run without any block", () => {
    expect(text({ mode: "full", expected: 0 })).toBe(en.activity.compareNothing);
    expect(text({ mode: "full", expected: 0 }, de)).toBe(de.activity.compareNothing);
  });

  it("names a calendar without a rule and without a block", () => {
    expect(text({ mode: "leftover", expected: 0 })).toBe(en.activity.compareNoLeftovers);
  });

  it("names what a run repaired", () => {
    const line = text({
      mode: "full",
      clean: true,
      expected: 3,
      cleared: 2,
      clearedHits: "missing:a,duplicate:b",
    });
    expect(line).toContain(en.activity.compareCleared(2, en.activity.compareFound(1, 0, 0, 1)));
  });
});

describe("the alert of a comparison", () => {
  /** A webhook that answers with `statuses` in turn, then with 200. */
  function alertWebhook(statuses: number[] = []) {
    const alerts: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== env.ALERT_WEBHOOK_URL) return new Response("unexpected", { status: 500 });
      const status = statuses[alerts.length] ?? 200;
      alerts.push((JSON.parse(init?.body as string) as { text: string }).text);
      return new Response("answer", { status });
    });
    return alerts;
  }

  async function alertRows(accountId: string) {
    const { results } = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE account_id = ? AND kind = 'alert_sent'",
    )
      .bind(accountId)
      .all<{ detail: string }>();
    return results.map((row) => JSON.parse(row.detail) as Record<string, unknown>);
  }

  const ORPHAN = { kind: "block_copied", ruleTag: "deadbeef0000", marker: "orphan" } as const;

  /** A comparison to its end: a hit, a successful run, and a second scan. */
  async function finished(name: string, fault: Parameters<Stub["injectFakeFault"]>[0]) {
    const context = await setup(name);
    await context.target.injectFakeFault(fault);
    await scanToWait(context);
    await context.target.runRule(context.ruleId);
    advance(120_000);
    await context.target.tick();
    await alarms(context.target);
    return context;
  }

  it("sends a comparison with a confirmed deviation, with IDs and numbers only", async () => {
    const alerts = alertWebhook();
    const { target, targetId, calendarId } = await finished("alert-found", ORPHAN);
    expect(await result(targetId)).toMatchObject({ deviations: 1, surplus: 1 });
    expect(alerts).toEqual([]);

    await target.tick();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(calendarId);
    expect(alerts[0]).toContain(en.activity.compareFound(0, 1, 0, 0));
    expect(alerts[0]).toContain(`${env.PUBLIC_URL}/admin`);
    expect(alerts[0]).not.toContain("orphan");
    expect(alerts[0]).not.toContain("meeting");
    expect(alerts[0]).not.toContain("@example.com");
    expect(await alertRows(targetId)).toEqual([{ code: "compare_deviation", calendarId }]);
  });

  it("sends nothing for hits that a run cleared", async () => {
    const alerts = alertWebhook();
    const { target, targetId } = await finished("alert-cleared", { kind: "block_deleted" });
    expect(await result(targetId)).toMatchObject({ deviations: 0, cleared: 1 });

    await target.tick();

    expect(alerts).toEqual([]);
    expect(await alertRows(targetId)).toEqual([]);
  });

  it("sends nothing for a hit of the second scan alone", async () => {
    const alerts = alertWebhook();
    const context = await setup("alert-new-hit");
    const { target, targetId, ruleId } = context;
    await target.injectFakeFault({ kind: "block_deleted" });
    await scanToWait(context);
    await target.runRule(ruleId);
    await target.injectFakeFault(ORPHAN);
    advance(120_000);
    await target.tick();
    await alarms(target);
    expect(await result(targetId)).toMatchObject({ deviations: 0, unconfirmed: 1 });

    await target.tick();

    expect(alerts).toEqual([]);
  });

  it("sends nothing while a hit waits for its second scan", async () => {
    const alerts = alertWebhook();
    const context = await setup("alert-waiting");
    await context.target.injectFakeFault(ORPHAN);
    await scanToWait(context);

    await context.target.tick();

    expect(alerts).toEqual([]);
  });

  it("sends nothing for a comparison that ended without a result", async () => {
    const alerts = alertWebhook();
    const context = await setup("alert-timeout");
    await context.target.injectFakeFault(ORPHAN);
    await scanToWait(context);
    advance(COMPARE_TIMEOUT_MS);

    await context.target.tick();
    await context.target.tick();

    expect((await failure(context.targetId)).reason).toBe("timeout");
    expect(alerts).toEqual([]);
  });

  it("sends the same comparison once", async () => {
    const alerts = alertWebhook();
    const { target, targetId } = await finished("alert-once", ORPHAN);

    await target.tick();
    await target.tick();
    await target.tick();

    expect(alerts).toHaveLength(1);
    expect(await alertRows(targetId)).toHaveLength(1);
  });

  it("sends one post per comparison while D1 refuses the row and the lock", async () => {
    const alerts = alertWebhook();
    const restoreRow = await refuseAudit("compare_run");
    const restoreLock = await refuseAudit("alert_sent");
    const { target, targetId, calendarId } = await finished("alert-writes-fail", ORPHAN);
    expect((await stateOf(target, calendarId))?.phase).toBe("reporting");

    await target.tick();
    await target.tick();
    await target.tick();

    expect(alerts).toHaveLength(1);
    expect(await alertRows(targetId)).toEqual([]);

    await restoreLock();
    await restoreRow();
    await target.tick();
    await target.tick();

    expect(await result(targetId)).toMatchObject({ deviations: 1 });
    expect(alerts).toHaveLength(1);
  });

  /** Another comparison to its end, on a calendar that already holds confirmed hits. */
  async function confirmAgain({ target, ruleId }: Setup) {
    await target.startCompares("full");
    await alarms(target);
    await target.runRule(ruleId);
    advance(120_000);
    await target.tick();
    await alarms(target);
  }

  /** The SQL that the Durable Object prepares from now on. */
  function recordSql(target: Stub): Promise<string[]> {
    return runInDurableObject(target, (instance) => {
      const seen: string[] = [];
      const sync = instance as unknown as { env: Env };
      const db = sync.env.DB;
      sync.env = {
        ...sync.env,
        DB: new Proxy(db, {
          get(_target, key) {
            if (key === "prepare") {
              return (sql: string) => {
                seen.push(sql);
                return db.prepare(sql);
              };
            }
            const value = Reflect.get(db, key) as unknown;
            return typeof value === "function" ? value.bind(db) : value;
          },
        }),
      };
      return seen;
    });
  }

  const queued = (target: Stub) =>
    runInDurableObject(target, (_instance, state) =>
      state.storage.get<CompareAlert[]>("compareAlerts"),
    );

  const entry = (calendarId: string, mode: CompareMode): CompareAlert => ({
    calendarId,
    mode,
    scanStartedAt: new Date(Date.now() - DAY).toISOString(),
    deviations: 1,
    missing: 1,
    surplus: 0,
    mismatched: 0,
    duplicates: 0,
    hitsCapped: false,
  });

  it("holds a newer result until the lock ends, then sends only the newest", async () => {
    const alerts = alertWebhook();
    const context = await finished("alert-held", ORPHAN);
    const { target, calendarId } = context;
    await target.tick();
    expect(alerts).toHaveLength(1);

    await target.injectFakeFault({ ...ORPHAN, marker: "orphan-2" });
    await confirmAgain(context);
    await target.tick();
    expect(alerts).toHaveLength(1);
    expect(await queued(target)).toEqual([
      expect.objectContaining({ calendarId, surplus: 2, notBefore: expect.any(Number) }),
    ]);

    await target.injectFakeFault({ ...ORPHAN, marker: "orphan-3" });
    await confirmAgain(context);
    await target.tick();
    expect(await queued(target)).toEqual([
      expect.objectContaining({ calendarId, surplus: 3, notBefore: expect.any(Number) }),
    ]);

    advance(ALERT_REPEAT_MS);
    await target.tick();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain(en.activity.compareFound(0, 3, 0, 0));
    expect(await queued(target)).toBeUndefined();
  });

  it("reads D1 once for a waiting result, and not in every tick", async () => {
    const alerts = alertWebhook();
    const context = await finished("alert-reads", ORPHAN);
    const { target } = context;
    await target.tick();
    await target.injectFakeFault({ ...ORPHAN, marker: "orphan-2" });
    await confirmAgain(context);
    const seen = await recordSql(target);

    await target.tick();
    await target.tick();
    await target.tick();

    expect(seen.filter((sql) => sql.includes("alert_sent"))).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it("lets a newer clean comparison end an open alert after a webhook outage", async () => {
    const alerts = alertWebhook([503, 503]);
    const { target, calendarId } = await setup("alert-refuted");
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("compareAlerts", [entry(calendarId, "full")]),
    );
    await target.tick();
    expect(alerts).toHaveLength(1);
    expect(await queued(target)).toHaveLength(1);

    await target.startCompares("full");
    await alarms(target);
    expect(await queued(target)).toBeUndefined();

    await target.tick();
    expect(alerts).toHaveLength(1);
  });

  it("keeps an open alert of the whole window after a clean near comparison", async () => {
    const { target, calendarId } = await setup("alert-near-clean");
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("compareAlerts", [entry(calendarId, "full")]),
    );
    await target.startCompares("near");
    await alarms(target);
    expect(await queued(target)).toHaveLength(1);
  });

  it("keeps an open alert if the newer comparison ends without a result", async () => {
    const { target, targetId, calendarId } = await setup("alert-failed-newer");
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("compareAlerts", [entry(calendarId, "full")]),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.startCompares("full");
    await target.injectFakeFault({ kind: "reads_fail", error: "server", count: 50 });
    await alarms(target);
    expect((await failure(targetId)).reason).toBe("read_failed");
    expect(await queued(target)).toHaveLength(1);
  });

  it("sends the alert once, also if the row of the comparison must wait for D1", async () => {
    const alerts = alertWebhook();
    const restore = await refuseAudit("compare_run");
    const { target, targetId, calendarId } = await finished("alert-row-waits", ORPHAN);
    await target.tick();
    expect(await compareEvents(targetId)).toEqual([]);

    await restore();
    await target.tick();
    await target.tick();

    expect(await result(targetId)).toMatchObject({ deviations: 1 });
    expect(await stateOf(target, calendarId)).toBeUndefined();
    expect(alerts).toHaveLength(1);
  });

  it("sends again in the next tick after a failed post, and counts only the 2xx", async () => {
    const alerts = alertWebhook([503, 302]);
    const { target, targetId } = await finished("alert-retry", ORPHAN);

    await target.tick();
    expect(alerts).toHaveLength(1);
    expect(await alertRows(targetId)).toEqual([]);

    await target.tick();
    expect(alerts).toHaveLength(2);
    expect(await alertRows(targetId)).toEqual([]);

    await target.tick();
    expect(alerts).toHaveLength(3);
    expect(await alertRows(targetId)).toHaveLength(1);

    await target.tick();
    expect(alerts).toHaveLength(3);
  });

  it("sends the alert of an account that pauses after the comparison", async () => {
    const alerts = alertWebhook();
    const { target, targetId } = await finished("alert-paused", ORPHAN);
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
      .bind(targetId)
      .run();

    await target.tick();

    expect(alerts.filter((text) => text.includes(`${targetId}-main`))).toHaveLength(1);
  });

  it("forgets the alert without a webhook", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { target, calendarId } = await finished("alert-off", ORPHAN);
    const queued = () =>
      runInDurableObject(target, (_instance, state) =>
        state.storage.get<{ calendarId: string }[]>("compareAlerts"),
      );
    expect((await queued())?.map((alert) => alert.calendarId)).toEqual([calendarId]);

    await runInDurableObject(target, (instance) => {
      (instance as unknown as { env: Env }).env = { ...env, ALERT_WEBHOOK_URL: "" };
    });
    await target.tick();

    expect(await queued()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("an account that goes", () => {
  it("leaves no open comparison", async () => {
    const { target, calendarId } = await setup("forget");
    await target.startCompares("full");
    await target.forget();
    expect(await stateOf(target, calendarId)).toBeUndefined();
  });

  it("starts no comparison while it retires", async () => {
    const { target } = await setup("retiring");
    await target.retire("request");
    expect(await target.startCompares("full")).toEqual({ started: 0, open: 0, failed: 0 });
  });
});
