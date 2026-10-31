import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKER_PROPERTY_ID } from "../src/sync/graph-events";
import { ruleTagFor } from "../src/sync/plan";
import { cleanupWindow } from "../src/sync/rules";
import fixture from "./fixtures/graph/calendar-view.json";
import { BASE, signIn, stopClock } from "./helpers";

const HASH = "0123456789abcdef0123456789abcdef";

/** Source account A (calendar a-src) and target account B (calendar b-dst), one rule A -> B. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn("owner@example.com");
  const a = `${prefix}-a`;
  const b = `${prefix}-b`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(a, user.id, `${a}@example.com`),
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(b, user.id, `${b}@example.com`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES (?, ?, 'remote-a', 'A', 1)",
    ).bind(`${a}-src`, a),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES (?, ?, 'remote-b', 'B', 1)",
    ).bind(`${b}-dst`, b),
    env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES (?, ?, ?, ?)",
    ).bind(`${prefix}-rule`, user.id, `${a}-src`, `${b}-dst`),
  ]);
  for (const id of [a, b]) {
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(id, {
      refreshToken: "r",
      accessToken: `token-${id}`,
      accessExpiresAt: Date.now() + 3_600_000,
    });
  }
  return { cookie, ruleId: `${prefix}-rule`, a, b };
}

/** Target calendar with two blocks of the rule and one block of another rule. */
async function fakeTarget(ruleId: string) {
  const tag = await ruleTagFor(ruleId);
  const [template] = fixture.value;
  const block = (id: string, value: string) => ({
    ...template,
    id,
    singleValueExtendedProperties: [{ id: MARKER_PROPERTY_ID, value }],
  });
  const deletes: { url: string; token: string | null }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/calendars/remote-b/calendarView")) {
      return Response.json({
        value: [
          block("mine-1", `${tag}.${HASH}.${HASH}`),
          block("mine-2", `${tag}.${HASH.replace("0", "1")}.${HASH}`),
          block("other", `aaaaaaaaaaaa.${HASH}.${HASH}`),
        ],
      });
    }
    if (url.endsWith("/$batch")) {
      const body = JSON.parse(init?.body as string) as {
        requests: { id: string; method: string; url: string }[];
      };
      for (const request of body.requests) {
        deletes.push({ url: request.url, token: new Headers(init?.headers).get("authorization") });
      }
      return Response.json({ responses: body.requests.map((r) => ({ id: r.id, status: 204 })) });
    }
    return new Response("unexpected", { status: 500 });
  });
  return deletes;
}

/** A target calendar at UTC+1 with one block per ID. It returns what overlaps the read. */
async function targetEastOfUtc(
  ruleId: string,
  blocks: Record<string, { start: string; end: string }>,
  edgeRead?: () => Response | undefined,
) {
  const tag = await ruleTagFor(ruleId);
  const [template] = fixture.value;
  const reads: { start: string | null; end: string | null }[] = [];
  const deletes: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/calendars/remote-b/calendarView")) {
      const { searchParams } = new URL(url);
      const start = searchParams.get("startDateTime");
      const end = searchParams.get("endDateTime");
      reads.push({ start, end });
      const edgeAnswer = start === cleanupEdge() ? edgeRead?.() : undefined;
      if (edgeAnswer) return edgeAnswer;
      const returned = Object.entries(blocks).filter(([id, block]) => {
        if (deletes.includes(`/me/events/${id}`)) return false;
        // Graph filters all-day events at the midnights of the calendar's own time zone.
        const shift = block.start.length === 10 ? 3_600_000 : 0;
        return (
          Date.parse(block.start) - shift < Date.parse(end ?? "") &&
          Date.parse(block.end) - shift > Date.parse(start ?? "")
        );
      });
      return Response.json({
        value: returned.map(([id, block]) => {
          const allDay = block.start.length === 10;
          const time = (value: string) => ({
            dateTime: allDay ? `${value}T00:00:00.0000000` : value,
            timeZone: "UTC",
          });
          return {
            ...template,
            id,
            isAllDay: allDay,
            start: time(block.start),
            end: time(block.end),
            singleValueExtendedProperties: [
              { id: MARKER_PROPERTY_ID, value: `${tag}.${id.padEnd(32, "0")}.${HASH}` },
            ],
          };
        }),
      });
    }
    if (url.endsWith("/$batch")) {
      const body = JSON.parse(init?.body as string) as {
        requests: { id: string; method: string; url: string }[];
      };
      deletes.push(...body.requests.map((request) => request.url));
      return Response.json({ responses: body.requests.map((r) => ({ id: r.id, status: 204 })) });
    }
    return new Response("unexpected", { status: 500 });
  });
  return { reads, deletes };
}

/**
 * A target calendar with one block per ID. It answers each read in pages of 24 blocks, and the
 * edge read with `edgeRead`. A `$batch` deletes its blocks. It counts the requests per alarm.
 */
async function pagedTarget(
  ruleId: string,
  count: number,
  edgeRead = () => Response.json({ value: [] }),
) {
  const tag = await ruleTagFor(ruleId);
  const [template] = fixture.value;
  const blocks = Array.from({ length: count }, (_, index) => {
    const id = `block-${index}`;
    const value = `${tag}.${id.padEnd(32, "0")}.${HASH}`;
    return { ...template, id, singleValueExtendedProperties: [{ id: MARKER_PROPERTY_ID, value }] };
  });
  const counts = { requests: 0, batches: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    counts.requests++;
    if (url.includes("/calendars/remote-b/calendarView")) {
      const { searchParams } = new URL(url);
      if (searchParams.get("startDateTime") === cleanupEdge()) return edgeRead();
      const page = Number(searchParams.get("page") ?? 0);
      const value = blocks.slice(page * 24, (page + 1) * 24);
      if (blocks.length <= (page + 1) * 24) return Response.json({ value });
      searchParams.set("page", String(page + 1));
      const next = `${url.split("?")[0]}?${searchParams.toString()}`;
      return Response.json({ value, "@odata.nextLink": next });
    }
    if (url.endsWith("/$batch")) {
      counts.batches++;
      const { requests } = JSON.parse(init?.body as string) as {
        requests: { id: string; url: string }[];
      };
      for (const { url: path } of requests) {
        blocks.splice(
          blocks.findIndex(({ id }) => path.endsWith(`/${id}`)),
          1,
        );
      }
      return Response.json({ responses: requests.map(({ id }) => ({ id, status: 204 })) });
    }
    return new Response("unexpected", { status: 500 });
  });
  return { blocks, counts };
}

/** The start of the edge read of a removal, one day before the cleanup window. */
function cleanupEdge(): string {
  return new Date(cleanupWindow().start.getTime() - 86_400_000).toISOString();
}

function post(path: string, cookie: string) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
}

/** The mark of the pending alarm; "removal" if the alarm is the removal's own. */
function alarmKind(stub: DurableObjectStub): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get("feedOnlyAlarm"));
}

function removalsOf(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<{ ruleId: string; attempts: number; notBefore?: number }[]>("removalQueue"),
  );
}

function alarmAt(stub: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

function cycleOwed(stub: DurableObjectStub): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get("fullCycleRequested"));
}

/** Run the next attempt of a waiting removal. A full cycle owed runs first, in its own alarm. */
async function retryRemoval(stub: DurableObjectStub) {
  if ((await alarmKind(stub)) !== "removal") await runDurableObjectAlarm(stub);
  expect(await alarmKind(stub)).toBe("removal");
  await runDurableObjectAlarm(stub);
}

/** Replace the removal's attempts, as if earlier attempts failed. */
async function seedAttempts(stub: DurableObjectStub, attempts: number) {
  await runInDurableObject(stub, async (_instance, state) => {
    const queue = await state.storage.get<{ attempts: number }[]>("removalQueue");
    await state.storage.put(
      "removalQueue",
      queue?.map((job) => ({ ...job, attempts })),
    );
  });
}

beforeEach(stopClock);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("cleanup", () => {
  it("deleting a rule removes only its own blocks, with the target account's token", async () => {
    const { cookie, ruleId, b } = await setup("del");
    const deletes = await fakeTarget(ruleId);

    expect((await post(`/rules/${ruleId}/delete`, cookie)).status).toBe(302);
    // The request only queues the removal; the target account's alarm does it.
    expect(deletes).toHaveLength(0);
    expect(await runDurableObjectAlarm(env.ACCOUNT_SYNC.getByName(b))).toBe(true);
    expect(deletes.map((d) => d.url).sort()).toEqual(["/me/events/mine-1", "/me/events/mine-2"]);
    expect(deletes.every((d) => d.token === `Bearer token-${b}`)).toBe(true);
    expect(
      await env.DB.prepare("SELECT 1 FROM rules WHERE id = ?").bind(ruleId).first(),
    ).toBeNull();
  });

  it("removes the block of the day before in a target east of UTC, and keeps older blocks", async () => {
    const { cookie, ruleId, b } = await setup("edge");
    const day = (offset: number) => new Date(cleanupWindow().start.getTime() + offset * 86_400_000);
    const date = (offset: number) => day(offset).toISOString().slice(0, 10);
    const { reads, deletes } = await targetEastOfUtc(ruleId, {
      "day-before": { start: date(-1), end: date(0) },
      "ends-at-midnight": {
        start: new Date(day(0).getTime() - 3_600_000).toISOString(),
        end: day(0).toISOString(),
      },
      today: { start: date(0), end: date(1) },
      "past-all-day": { start: date(-2), end: date(-1) },
      "past-timed": {
        start: new Date(day(0).getTime() - 7_200_000).toISOString(),
        end: new Date(day(0).getTime() - 3_600_000).toISOString(),
      },
    });

    await post(`/rules/${ruleId}/delete`, cookie);
    await runDurableObjectAlarm(env.ACCOUNT_SYNC.getByName(b));

    // A target east of UTC returns the day before only from a read that starts one day earlier.
    expect(reads.map((read) => read.start)).toEqual([day(0).toISOString(), day(-1).toISOString()]);
    expect(reads[1]?.end).toBe(day(1).toISOString());
    expect(deletes.sort()).toEqual([
      "/me/events/day-before",
      "/me/events/ends-at-midnight",
      "/me/events/today",
    ]);
  });

  /** A removal whose target read returns these blocks and whose edge read gets this answer. */
  async function removalWithEdge(
    prefix: string,
    edgeRead: () => Response | undefined,
    { visibleBlocks = true } = {},
  ) {
    const { cookie, ruleId, b } = await setup(prefix);
    const day = (offset: number) => new Date(cleanupWindow().start.getTime() + offset * 86_400_000);
    const date = (offset: number) => day(offset).toISOString().slice(0, 10);
    const { reads, deletes } = await targetEastOfUtc(
      ruleId,
      visibleBlocks
        ? { today: { start: date(0), end: date(1) }, tomorrow: { start: date(1), end: date(2) } }
        : {},
      edgeRead,
    );
    await post(`/rules/${ruleId}/delete`, cookie);
    const stub = env.ACCOUNT_SYNC.getByName(b);
    await runDurableObjectAlarm(stub);
    return { ruleId, stub, reads, deletes, queue: (await removalsOf(stub)) ?? [] };
  }

  const brokenEdge = () => new Response("broken", { status: 500 });

  it("removes the other blocks and keeps the job if the edge read fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ruleId, reads, deletes, queue } = await removalWithEdge("edge-broken", brokenEdge);
    expect(reads).toHaveLength(2);
    expect(deletes.sort()).toEqual(["/me/events/today", "/me/events/tomorrow"]);
    // The block at the edge may still be there, and no later run reads that far back.
    expect(queue).toEqual([expect.objectContaining({ ruleId, attempts: 1 })]);
    expect(Math.round(((queue[0]?.notBefore ?? 0) - Date.now()) / 60_000)).toBe(1);
    expect(error).toHaveBeenCalled();
  });

  it("removes the block at the edge once a later edge read works", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { cookie, ruleId, b } = await setup("edge-later");
    const day = (offset: number) => new Date(cleanupWindow().start.getTime() + offset * 86_400_000);
    const date = (offset: number) => day(offset).toISOString().slice(0, 10);
    let edgeDown = true;
    const { deletes } = await targetEastOfUtc(
      ruleId,
      {
        "day-before": { start: date(-1), end: date(0) },
        today: { start: date(0), end: date(1) },
      },
      () => (edgeDown ? brokenEdge() : undefined),
    );
    await post(`/rules/${ruleId}/delete`, cookie);
    const stub = env.ACCOUNT_SYNC.getByName(b);

    await runDurableObjectAlarm(stub);
    expect(deletes).toEqual(["/me/events/today"]);

    edgeDown = false;
    await retryRemoval(stub);
    expect(deletes).toEqual(["/me/events/today", "/me/events/day-before"]);
    expect(await removalsOf(stub)).toBeUndefined();
  });

  it("ends the job after the last attempt if only the edge read keeps failing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ruleId, stub, reads, deletes } = await removalWithEdge("edge-gone", brokenEdge, {
      visibleBlocks: false,
    });
    const waits: number[] = [];
    for (let attempt = 1; attempt < 5; attempt++) {
      if (attempt > 1) await retryRemoval(stub);
      const [job] = (await removalsOf(stub)) ?? [];
      expect(job).toMatchObject({ ruleId, attempts: attempt });
      waits.push((job?.notBefore ?? 0) - Date.now());
    }
    expect(waits.map((wait) => Math.round(wait / 60_000))).toEqual([1, 10, 120, 720]);

    await retryRemoval(stub);
    expect(await removalsOf(stub)).toBeUndefined();
    // Each of the five attempts made its main read and its edge read.
    expect(reads).toHaveLength(10);
    expect(deletes).toEqual([]);
    expect(await cycleOwed(stub)).toBe(true);
  });

  it("owes the full cycle at once if a step removed blocks and then waits for its edge read", async () => {
    // The removed blocks may have hidden blocks of other rules. The retry can come hours later.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { stub } = await removalWithEdge("edge-cycle", brokenEdge);
    expect(await cycleOwed(stub)).toBe(true);
    expect(await alarmKind(stub)).toBeUndefined();

    // The cycle runs while the removal waits, and the removal's own alarm follows.
    await runDurableObjectAlarm(stub);
    expect(await cycleOwed(stub)).toBeUndefined();
    expect(await removalsOf(stub)).toHaveLength(1);
    expect(await alarmKind(stub)).toBe("removal");
  });

  it("owes the full cycle if an earlier step removed blocks and a later step waits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { cookie, ruleId, b } = await setup("cycle-later");
    const { blocks } = await pagedTarget(ruleId, 600);
    await post(`/rules/${ruleId}/delete`, cookie);
    const stub = env.ACCOUNT_SYNC.getByName(b);
    await runDurableObjectAlarm(stub);
    expect(blocks).toHaveLength(160);

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("down", { status: 500 }),
    );
    await runDurableObjectAlarm(stub);
    expect((await removalsOf(stub))?.[0]).toMatchObject({ ruleId, attempts: 1 });
    expect(await cycleOwed(stub)).toBe(true);
  });

  it("forgets a retiring account after the last attempt of a lasting edge failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ruleId, stub, deletes } = await removalWithEdge("edge-retiring", brokenEdge);
    await stub.retire("request");
    for (let attempt = 2; attempt < 5; attempt++) {
      await retryRemoval(stub);
      expect((await removalsOf(stub))?.[0]).toMatchObject({ ruleId, attempts: attempt });
      expect(await stub.hasTokens()).toBe(true);
    }

    await retryRemoval(stub);
    expect(await removalsOf(stub)).toBeUndefined();
    expect(deletes.sort()).toEqual(["/me/events/today", "/me/events/tomorrow"]);
    await runDurableObjectAlarm(stub);
    expect(await stub.hasTokens()).toBe(false);
  });

  /** A rule with a failed edge read, whose two blocks answer the deletes with `deleted`. */
  async function brokenEdgeTarget(
    prefix: string,
    deleted: (id: string, index: number) => { id: string; status: number },
  ) {
    const { cookie, ruleId, b } = await setup(prefix);
    const tag = await ruleTagFor(ruleId);
    const [template] = fixture.value;
    const block = (id: string) => ({
      ...template,
      id,
      singleValueExtendedProperties: [
        { id: MARKER_PROPERTY_ID, value: `${tag}.${id.padEnd(32, "0")}.${HASH}` },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/calendars/remote-b/calendarView")) {
        const start = new URL(url).searchParams.get("startDateTime");
        if (start === cleanupEdge()) return brokenEdge();
        return Response.json({ value: [block("first"), block("second")] });
      }
      if (url.endsWith("/$batch")) {
        const { requests } = JSON.parse(init?.body as string) as { requests: { id: string }[] };
        return Response.json({ responses: requests.map(({ id }, index) => deleted(id, index)) });
      }
      return new Response("unexpected", { status: 500 });
    });
    await post(`/rules/${ruleId}/delete`, cookie);
    return { ruleId, stub: env.ACCOUNT_SYNC.getByName(b) };
  }

  it("goes on without a cost while blocks fall, and counts once none is left", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { cookie, ruleId, b } = await setup("edge-paged");
    const { blocks } = await pagedTarget(ruleId, 600, brokenEdge);
    await post(`/rules/${ruleId}/delete`, cookie);
    const stub = env.ACCOUNT_SYNC.getByName(b);
    await seedAttempts(stub, 2);

    // Blocks are left: the job goes on at once, and the count neither grows nor starts again.
    await runDurableObjectAlarm(stub);
    expect(blocks).toHaveLength(160);
    const [step] = (await removalsOf(stub)) ?? [];
    expect(step).toMatchObject({ ruleId, attempts: 2 });
    expect(step?.notBefore).toBeUndefined();

    // No block is left, so only the edge read is open: this step is a failed attempt.
    await runDurableObjectAlarm(stub);
    expect(blocks).toHaveLength(0);
    const [last] = (await removalsOf(stub)) ?? [];
    expect(last).toMatchObject({ ruleId, attempts: 3 });
    expect(Math.round(((last?.notBefore ?? 0) - Date.now()) / 60_000)).toBe(120);
    expect(await cycleOwed(stub)).toBe(true);
  });

  it("removes all visible blocks before the last attempt ends the job", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { cookie, ruleId, b } = await setup("edge-last");
    const { blocks } = await pagedTarget(ruleId, 600, brokenEdge);
    await post(`/rules/${ruleId}/delete`, cookie);
    const stub = env.ACCOUNT_SYNC.getByName(b);
    await seedAttempts(stub, 4);

    await runDurableObjectAlarm(stub);
    expect(blocks).toHaveLength(160);
    expect((await removalsOf(stub))?.[0]).toMatchObject({ ruleId, attempts: 4 });

    await runDurableObjectAlarm(stub);
    expect(blocks).toHaveLength(0);
    expect(await removalsOf(stub)).toBeUndefined();
    expect(await cycleOwed(stub)).toBe(true);
  });

  it("counts a failed attempt if no block fell and its edge read failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ruleId, stub } = await brokenEdgeTarget("edge-stuck", (id) => ({ id, status: 500 }));

    await runDurableObjectAlarm(stub);
    const [job] = (await removalsOf(stub)) ?? [];
    expect(job).toMatchObject({ ruleId, attempts: 1 });
    expect(Math.round(((job?.notBefore ?? 0) - Date.now()) / 60_000)).toBe(1);
  });

  it("keeps the attempts if a throttled step removed blocks and its edge read failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ruleId, stub } = await brokenEdgeTarget("edge-both", (id, index) =>
      index === 0
        ? { id, status: 204 }
        : ({ id, status: 429, headers: { "Retry-After": "7" } } as { id: string; status: number }),
    );
    await seedAttempts(stub, 2);

    await runDurableObjectAlarm(stub);
    const [job] = (await removalsOf(stub)) ?? [];
    // Throttling costs no attempt, and the failed edge read does not start the count again.
    expect(job).toMatchObject({ ruleId, attempts: 2 });
    expect(job?.notBefore).toBeUndefined();
    expect(await alarmAt(stub)).toBe(Date.now() + 7_000);
  });

  it("waits and uses up no attempt if the edge read is throttled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ruleId, deletes, queue } = await removalWithEdge(
      "edge-busy",
      () => new Response("busy", { status: 429, headers: { "Retry-After": "7" } }),
    );
    expect(deletes).toEqual([]);
    expect(queue).toEqual([expect.objectContaining({ ruleId, attempts: 0 })]);
  });

  it("counts the reads against the delete batches and goes on in the next step", async () => {
    const { cookie, ruleId, b } = await setup("paged");
    const { blocks, counts } = await pagedTarget(ruleId, 600);
    await post(`/rules/${ruleId}/delete`, cookie);
    const stub = env.ACCOUNT_SYNC.getByName(b);

    // 25 pages and the edge read leave 22 of the 25 batches, 440 of the 600 blocks.
    await runDurableObjectAlarm(stub);
    expect(counts).toEqual({ requests: 48, batches: 22 });
    expect(blocks).toHaveLength(160);
    const queue = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ attempts: number }[]>("removalQueue"),
    );
    expect(queue).toEqual([expect.objectContaining({ attempts: 0 })]);

    // 160 blocks on 7 pages: the next step has room for the rest.
    counts.requests = 0;
    await runDurableObjectAlarm(stub);
    expect(counts.requests).toBeLessThan(50);
    expect(blocks).toHaveLength(0);
  });

  /** The detail of the result event of a removal in this account. */
  async function cleanupResult(accountId: string) {
    const row = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE account_id = ? AND kind = 'cleanup_finished'",
    )
      .bind(accountId)
      .first<{ detail: string }>();
    return JSON.parse(row?.detail ?? "null") as unknown;
  }

  it("counts the blocks of all steps in the result of a disconnect", async () => {
    const { cookie, ruleId, b } = await setup("result-steps");
    await pagedTarget(ruleId, 600);
    await post(`/accounts/${b}/disconnect`, cookie);
    const stub = env.ACCOUNT_SYNC.getByName(b);

    await runDurableObjectAlarm(stub);
    expect(await cleanupResult(b)).toBeNull();
    await runDurableObjectAlarm(stub);
    expect(await cleanupResult(b)).toEqual({ result: "removed", removed: 600 });
  });

  it("reports the blocks left after the last attempt of a removal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ruleId, stub } = await brokenEdgeTarget("result-left", (id) => ({ id, status: 500 }));
    await stub.queueRemovals([{ ruleId, remoteCalendarId: "remote-b" }], {
      offboarding: { orgId: "default", userId: "some-user" },
    });
    await seedAttempts(stub, 4);

    await runDurableObjectAlarm(stub);
    expect(await removalsOf(stub)).toBeUndefined();
    expect(await cleanupResult("result-left-b")).toEqual({
      result: "incomplete",
      removed: 0,
      left: 2,
    });
  });

  it("disconnecting the source account removes the blocks it caused in the other account", async () => {
    const { cookie, ruleId, a, b } = await setup("disc");
    const deletes = await fakeTarget(ruleId);

    expect((await post(`/accounts/${a}/disconnect`, cookie)).status).toBe(302);
    // The other account removes the blocks in its alarm; the disconnected one then retires.
    expect(deletes).toHaveLength(0);
    await runDurableObjectAlarm(env.ACCOUNT_SYNC.getByName(b));
    await runDurableObjectAlarm(env.ACCOUNT_SYNC.getByName(a));
    expect(deletes).toHaveLength(2);
    expect(deletes.every((d) => d.token === `Bearer token-${b}`)).toBe(true);
    expect(
      await env.DB.prepare("SELECT 1 FROM rules WHERE id = ?").bind(ruleId).first(),
    ).toBeNull();
    expect(await env.ACCOUNT_SYNC.getByName(a).hasTokens()).toBe(false);
  });

  it("deletes the rule at once and retries the removal while the provider is down", async () => {
    const { cookie, ruleId, b } = await setup("fail");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("down", { status: 503 }),
    );

    expect((await post(`/rules/${ruleId}/delete`, cookie)).status).toBe(302);
    expect(
      await env.DB.prepare("SELECT 1 FROM rules WHERE id = ?").bind(ruleId).first(),
    ).toBeNull();
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE rule_id = ? AND kind = 'rule_deleted'",
    )
      .bind(ruleId)
      .first<{ detail: string }>();
    expect(JSON.parse(audit?.detail ?? "{}")).toEqual({ cleanup: "queued" });

    const stub = env.ACCOUNT_SYNC.getByName(b);
    await runDurableObjectAlarm(stub);
    const queue = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ ruleId: string; attempts: number }[]>("removalQueue"),
    );
    // 503 counts as throttling: the job waits for Retry-After and uses up no attempt.
    expect(queue).toEqual([expect.objectContaining({ ruleId, attempts: 0 })]);
  });
});
