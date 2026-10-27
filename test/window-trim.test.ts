import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDirection } from "../src/editor";
import { MARKER_PROPERTY_ID } from "../src/sync/graph-events";
import { ruleTagFor } from "../src/sync/plan";
import fixture from "./fixtures/graph/calendar-view.json";
import { BASE, signIn } from "./helpers";

const SOURCE_CAL = "remote-trim-source";
const OTHER_SOURCE_CAL = "remote-trim-source-2";
const TARGET_CAL = "remote-trim-target";

/**
 * "Today" in these tests. It lies in the future, so that no alarm fires before a test runs it.
 * With 30 days ahead, the sync window ends at 2036-11-21T00:00Z.
 */
const NOW = new Date("2036-10-22T10:00:00Z");

interface FakeBlock {
  id: string;
  /** The rule whose tag the block carries; null for an event the user made. */
  ruleId: string | null;
  start: string;
  end: string;
  allDay?: boolean;
}

/**
 * The target calendar after `daysAhead` went from 365 to 30. Blocks of `rule` inside and beyond
 * the new window, a block of `otherRule` and an event of the user beyond it.
 */
function targetCalendar(rule: string, otherRule: string): FakeBlock[] {
  return [
    { id: "in", ruleId: rule, start: "2036-11-10T09:00:00", end: "2036-11-10T10:00:00" },
    // Starts inside the window: the source read still returns its event.
    { id: "across-end", ruleId: rule, start: "2036-11-20T23:00:00", end: "2036-11-21T01:00:00" },
    // East of UTC, the source read returns the all-day date at the window end.
    { id: "allday-at-end", ruleId: rule, start: "2036-11-21", end: "2036-11-22", allDay: true },
    { id: "at-end", ruleId: rule, start: "2036-11-21T00:00:00", end: "2036-11-21T01:00:00" },
    { id: "allday-after", ruleId: rule, start: "2036-11-22", end: "2036-11-23", allDay: true },
    { id: "out", ruleId: rule, start: "2036-12-15T09:00:00", end: "2036-12-15T10:00:00" },
    { id: "allday-out", ruleId: rule, start: "2037-03-01", end: "2037-03-02", allDay: true },
    {
      id: "other-rule",
      ruleId: otherRule,
      start: "2036-12-15T09:00:00",
      end: "2036-12-15T10:00:00",
    },
    { id: "user-event", ruleId: null, start: "2036-12-15T11:00:00", end: "2036-12-15T12:00:00" },
  ];
}

/** The blocks that the trim of `rule` deletes from `targetCalendar()`. */
const TRIMMED = ["allday-after", "allday-out", "at-end", "out"];

/** Start and end of a fake block in milliseconds; all-day dates count from midnight UTC. */
function span(block: FakeBlock): [number, number] {
  const parse = (value: string) => Date.parse(block.allDay ? `${value}T00:00:00Z` : `${value}Z`);
  return [parse(block.start), parse(block.end)];
}

/** A time as Graph returns it with `Prefer: outlook.timezone="UTC"`. */
function graphTime(value: string, allDay = false) {
  return { dateTime: `${allDay ? `${value}T00:00:00` : value}.0000000`, timeZone: "UTC" };
}

/**
 * Fake Graph with `blocks` in the target calendar. calendarView returns the blocks that overlap
 * the requested window. `graph.deleteStatus` answers deletes. Records the deleted IDs, the delete
 * requests and the windows of the target reads.
 */
async function fakeGraph(blocks: FakeBlock[]) {
  const [template] = fixture.value;
  const graph = {
    deleteStatus: 204,
    retryAfter: "",
    deleted: [] as string[],
    /** IDs of every delete request, also failed ones. */
    attempted: [] as string[],
    reads: [] as { start: string; end: string }[],
  };
  const events = await Promise.all(
    blocks.map(async (block, index) => ({
      ...template,
      id: block.id,
      type: "singleInstance",
      seriesMasterId: null,
      originalStart: null,
      isAllDay: block.allDay ?? false,
      start: graphTime(block.start, block.allDay),
      end: graphTime(block.end, block.allDay),
      singleValueExtendedProperties: block.ruleId
        ? [
            {
              id: MARKER_PROPERTY_ID,
              value: `${await ruleTagFor(block.ruleId)}.${index.toString(16).padStart(32, "0")}.${"0".repeat(32)}`,
            },
          ]
        : [],
      block,
    })),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes(`/calendars/${TARGET_CAL}/calendarView`)) {
      const start = Date.parse(url.searchParams.get("startDateTime") ?? "");
      const end = Date.parse(url.searchParams.get("endDateTime") ?? "");
      graph.reads.push({
        start: url.searchParams.get("startDateTime") ?? "",
        end: url.searchParams.get("endDateTime") ?? "",
      });
      const value = events
        .filter(({ block }) => !graph.deleted.includes(block.id))
        .filter(({ block }) => {
          const [blockStart, blockEnd] = span(block);
          return blockStart < end && blockEnd > start;
        })
        .map(({ block: _block, ...event }) => event);
      return Response.json({ value });
    }
    if (url.pathname.includes("/calendarView")) return Response.json({ value: [] });
    if (url.pathname.endsWith("/$batch")) {
      const body = JSON.parse(init?.body as string) as {
        requests: { id: string; method: string; url: string }[];
      };
      const responses = body.requests.map((request) => {
        if (request.method !== "DELETE") return { id: request.id, status: 201 };
        const id = decodeURIComponent(request.url.replace("/me/events/", ""));
        graph.attempted.push(id);
        if (graph.retryAfter) {
          return { id: request.id, status: 429, headers: { "Retry-After": graph.retryAfter } };
        }
        if (graph.deleteStatus === 204) graph.deleted.push(id);
        return { id: request.id, status: graph.deleteStatus };
      });
      return Response.json({ responses });
    }
    return new Response("unexpected", { status: 500 });
  });
  return graph;
}

/**
 * One account with two source calendars and a target calendar. `rule` writes from the first
 * source with `daysAhead`, `otherRule` from the second with 365 days.
 */
async function setup(prefix: string, daysAhead: number) {
  const { user } = await signIn(`${prefix}@org.example`);
  const accountId = `${prefix}-acc`;
  const rule = `${prefix}-rule`;
  const otherRule = `${prefix}-other`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(accountId, user.id, `${prefix}@work.example`),
    ...[
      [`${prefix}-src`, SOURCE_CAL],
      [`${prefix}-src2`, OTHER_SOURCE_CAL],
      [`${prefix}-dst`, TARGET_CAL],
    ].map(([id, remote]) =>
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES (?, ?, ?, 'C', 1)",
      ).bind(id, accountId, remote),
    ),
    env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
    ).bind(rule, user.id, `${prefix}-src`, `${prefix}-dst`, JSON.stringify({ daysAhead })),
    env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
    ).bind(otherRule, user.id, `${prefix}-src2`, `${prefix}-dst`, '{"daysAhead":365}'),
  ]);
  const stub = env.ACCOUNT_SYNC.getByName(accountId);
  await stub.storeTokens(accountId, {
    refreshToken: "r",
    accessToken: "a",
    accessExpiresAt: Date.now() + 3_600_000,
  });
  const graph = await fakeGraph(targetCalendar(rule, otherRule));
  return { stub, rule, otherRule, graph };
}

function setDaysAhead(ruleId: string, daysAhead: number) {
  return env.DB.prepare(
    "UPDATE rules SET options = json_set(options, '$.daysAhead', ?) WHERE id = ?",
  )
    .bind(daysAhead, ruleId)
    .run();
}

type QueuedRemoval = { ruleId: string; attempts: number; notBefore?: number; trim?: boolean };

const removalsOf = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (_instance, state) =>
    state.storage.get<QueuedRemoval[]>("removalQueue"),
  );

const alarmOf = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (_instance, state) => ({
    at: await state.storage.getAlarm(),
    kind: await state.storage.get("feedOnlyAlarm"),
  }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("trimming a shrunk window", () => {
  it("removes exactly the rule's blocks beyond the new window end", async () => {
    const { stub, rule, graph } = await setup("trim-exact", 30);

    await stub.queueRemoval(rule, TARGET_CAL, { trim: true });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // Blocks inside the window, another rule's block and the user's event stay.
    expect(graph.deleted.sort()).toEqual(TRIMMED);
    expect(await removalsOf(stub)).toBeUndefined();
  });

  it("keeps the blocks that a raised daysAhead wants again", async () => {
    const { stub, rule, graph } = await setup("trim-raised", 30);
    graph.deleteStatus = 500;
    await stub.queueRemoval(rule, TARGET_CAL, { trim: true });
    await runDurableObjectAlarm(stub);
    expect((await removalsOf(stub))?.[0]).toMatchObject({ ruleId: rule, attempts: 1, trim: true });
    const failedAttempts = graph.attempted.length;

    // The user raises the window again before the retry.
    await setDaysAhead(rule, 365);
    graph.deleteStatus = 204;
    await runDurableObjectAlarm(stub);

    expect(graph.attempted.length).toBe(failedAttempts);
    expect(graph.deleted).toEqual([]);
    expect(await removalsOf(stub)).toBeUndefined();
  });

  it("trims only beyond a partly raised window", async () => {
    const { stub, rule, graph } = await setup("trim-partly", 30);
    // 60 days ahead: the window ends at 2036-12-21, after the timed block "out".
    await setDaysAhead(rule, 60);
    await stub.queueRemoval(rule, TARGET_CAL, { trim: true });
    await runDurableObjectAlarm(stub);
    expect(graph.deleted).toEqual(["allday-out"]);
  });

  it("retries the trim of a rule that still writes into the calendar", async () => {
    // A trim's rule stays enabled; the check for a revived rule must not drop the trim.
    const { stub, rule, graph } = await setup("trim-retry", 30);
    graph.deleteStatus = 500;
    await stub.queueRemoval(rule, TARGET_CAL, { trim: true });
    await runDurableObjectAlarm(stub);
    expect((await removalsOf(stub))?.[0]).toMatchObject({ attempts: 1, trim: true });

    graph.deleteStatus = 204;
    await runDurableObjectAlarm(stub);
    expect(graph.deleted.sort()).toEqual(TRIMMED);
    expect(await removalsOf(stub)).toBeUndefined();
  });

  it("keeps a trim and a removal of the same rule apart", async () => {
    const { stub, rule } = await setup("trim-both", 30);
    await stub.queueRemoval(rule, TARGET_CAL, { trim: true });
    await stub.queueRemoval(rule, TARGET_CAL);
    await stub.queueRemoval(rule, TARGET_CAL, { trim: true });
    expect(await removalsOf(stub)).toEqual([
      { ruleId: rule, remoteCalendarId: TARGET_CAL, attempts: 0, trim: true },
      { ruleId: rule, remoteCalendarId: TARGET_CAL, attempts: 0 },
    ]);
  });

  it("drops the trim of a deleted rule without a provider call", async () => {
    const { stub, rule, graph } = await setup("trim-gone", 30);
    await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(rule).run();
    await stub.queueRemoval(rule, TARGET_CAL, { trim: true });
    await runDurableObjectAlarm(stub);
    expect(graph.reads).toEqual([]);
    expect(graph.attempted.length).toBe(0);
    expect(await removalsOf(stub)).toBeUndefined();
  });

  it("waits for Retry-After and keeps the job a trim", async () => {
    const { stub, rule, graph } = await setup("trim-throttle", 30);
    graph.retryAfter = "60";
    await stub.queueRemoval(rule, TARGET_CAL, { trim: true });
    await runDurableObjectAlarm(stub);

    // Throttling is no failed attempt.
    expect(await removalsOf(stub)).toEqual([
      { ruleId: rule, remoteCalendarId: TARGET_CAL, attempts: 0, trim: true },
    ]);
    const { at } = await alarmOf(stub);
    expect((at ?? 0) - Date.now()).toBeGreaterThan(55_000);
    expect((at ?? 0) - Date.now()).toBeLessThanOrEqual(60_000);

    graph.retryAfter = "";
    await runDurableObjectAlarm(stub);
    expect(graph.deleted.sort()).toEqual(TRIMMED);
  });

  it("backs off a trim whose deletes keep failing, and gives up after the last attempt", async () => {
    const { stub, rule, graph } = await setup("trim-backoff", 30);
    graph.deleteStatus = 403;
    await stub.queueRemoval(rule, TARGET_CAL, { trim: true });
    const waits: number[] = [];
    for (let attempt = 1; attempt < 5; attempt++) {
      await runDurableObjectAlarm(stub);
      const [job] = (await removalsOf(stub)) ?? [];
      expect(job).toMatchObject({ ruleId: rule, attempts: attempt, trim: true });
      waits.push((job?.notBefore ?? 0) - Date.now());
      expect(await alarmOf(stub)).toEqual({ at: job?.notBefore, kind: "removal" });
    }
    expect(waits.map((wait) => Math.round(wait / 60_000))).toEqual([1, 10, 120, 720]);

    await runDurableObjectAlarm(stub);
    expect(await removalsOf(stub)).toBeUndefined();
  });

  it("does not hold the alarm: rules run while a trim waits, and a done trim does not return", async () => {
    const { stub, rule, otherRule, graph } = await setup("trim-alarm", 30);
    // Rule runs delete blocks inside their windows, whose source events this fake lacks.
    const trimAttempts = () => graph.attempted.filter((id) => TRIMMED.includes(id)).length;
    const trimReads = () =>
      graph.reads.filter((read) => read.start === "2036-11-21T00:00:00.000Z").length;
    graph.deleteStatus = 500;
    await stub.queueRemoval(rule, TARGET_CAL, { trim: true });
    await runDurableObjectAlarm(stub);
    expect(trimAttempts()).toBe(TRIMMED.length);

    // The trim waits a minute; a requested cycle runs the rules meanwhile.
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(trimAttempts()).toBe(TRIMMED.length);
    const runs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE rule_id IN (?, ?) AND kind = 'sync_run'",
    )
      .bind(rule, otherRule)
      .first<{ n: number }>();
    expect(runs?.n).toBe(1);

    // Once the trim is done, its job is gone and no alarm waits for it.
    graph.deleteStatus = 204;
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await runDurableObjectAlarm(stub);
    expect(graph.deleted.filter((id) => TRIMMED.includes(id)).sort()).toEqual(TRIMMED);
    expect(await removalsOf(stub)).toBeUndefined();
    expect((await alarmOf(stub)).kind).not.toBe("removal");
    const reads = trimReads();
    for (let alarm = 0; alarm < 3; alarm++) await runDurableObjectAlarm(stub);
    expect(trimReads()).toBe(reads);
  });
});

describe("changing daysAhead in the editor", () => {
  /** A user with two accounts and a busy rule from the first into the second. */
  async function editorSetup(prefix: string) {
    const { user, cookie } = await signIn(`${prefix}@org.example`);
    for (const id of [`${prefix}-w`, `${prefix}-o`]) {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
        ).bind(id, user.id, `${id}@work.example`),
        env.DB.prepare(
          "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
        ).bind(`${id}-cal`, id, `${id}-remote`),
      ]);
      await env.ACCOUNT_SYNC.getByName(id).storeTokens(id, {
        refreshToken: "r",
        accessToken: "a",
        accessExpiresAt: Date.now() + 3_600_000,
      });
    }
    await setDirection(env, user, `${prefix}-w`, `${prefix}-o`, "busy");
    const ruleId = (
      await env.DB.prepare("SELECT id FROM rules WHERE user_id = ?")
        .bind(user.id)
        .first<{ id: string }>()
    )?.id;
    const save = (daysAhead: string) =>
      exports.default.fetch(`${BASE}/rules/choices`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ settings: "1", "settings.daysAhead": daysAhead }),
      });
    return { ruleId, target: env.ACCOUNT_SYNC.getByName(`${prefix}-o`), save };
  }

  it("queues a trim when daysAhead goes down, and none when it goes up", async () => {
    const { ruleId, target, save } = await editorSetup("trim-editor");

    expect((await save("180")).status).toBe(204);
    expect(await removalsOf(target)).toBeUndefined();

    expect((await save("30")).status).toBe(204);
    expect(await removalsOf(target)).toEqual([
      { ruleId, remoteCalendarId: "trim-editor-o-remote", attempts: 0, trim: true },
    ]);
  });
});
