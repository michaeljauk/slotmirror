/**
 * All-day blocks on Outlook lie in the time zone of the mailbox. A block in UTC lies beside the
 * local day: one hour at CET, and eight hours at Pacific time. The tests run the real Graph client
 * against a `fetch` spy. The responses have the form of a live Graph read: under
 * `Prefer: outlook.timezone="UTC"`, an all-day event always reads as midnight of its date.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oneCallAtATime } from "../src/providers/calendar-client";
import { GoogleCalendar } from "../src/providers/google-calendar";
import { GraphCalendar } from "../src/providers/graph-calendar";
import { signIn, stopClock } from "./helpers";

const ZONE = "W. Europe Standard Time";
const DAY = 86_400_000;
/** Longer than a failed lookup counts, and much shorter than the day of an answer. */
const LATER = 60 * 60_000;

type Raw = Record<string, unknown>;
type Request = { id: string; method: string; url: string; body?: Raw };
type DateTime = { dateTime: string; timeZone: string };

const dateIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

/** An all-day event in the form of a live read. */
function allDayEvent(id: string, first: string, last: string): Raw {
  return {
    id,
    type: "singleInstance",
    isAllDay: true,
    showAs: "busy",
    start: { dateTime: `${first}T00:00:00.0000000`, timeZone: "UTC" },
    end: { dateTime: `${last}T00:00:00.0000000`, timeZone: "UTC" },
  };
}

function timedEvent(id: string, day: string): Raw {
  return {
    id,
    type: "singleInstance",
    isAllDay: false,
    showAs: "busy",
    start: { dateTime: `${day}T09:00:00.0000000`, timeZone: "UTC" },
    end: { dateTime: `${day}T10:00:00.0000000`, timeZone: "UTC" },
  };
}

/** The block as a later read returns it: the dates of the write, at midnight, in UTC. */
function asRead(id: string, body: Raw): Raw {
  const read = (time: unknown) => ({
    dateTime: `${(time as DateTime).dateTime.slice(0, 19)}.0000000`,
    timeZone: "UTC",
  });
  return { ...body, id, type: "singleInstance", start: read(body.start), end: read(body.end) };
}

/** A mailbox behind the `fetch` spy. Each field can change between runs. */
function mailbox() {
  const state = {
    schedule: (): Response =>
      Response.json({
        value: [{ scheduleId: "x", workingHours: { timeZone: { name: ZONE } } }],
      }),
    source: [] as Raw[],
    blocks: new Map<string, Raw>(),
    /** Extra pages of the target read. */
    targetPages: 0,
    /** Overrides the status of a request in a batch, for example to refuse it with 400. */
    writeStatus: (_request: Request): number | undefined => undefined,
    /** The primary SMTP address in `/me`. It differs from a sign-in name with another domain. */
    mail: "primary@work.example" as string | null,
    me: undefined as (() => Response) | undefined,
    nextBlock: 0,
    scheduleCalls: [] as { body: Raw; headers: Headers }[],
    batches: [] as Request[][],
  };
  /** One request of a `$batch`, with the effect that Graph gives its method. */
  const answer = (request: Request) => {
    const status = state.writeStatus(request);
    if (status !== undefined && status >= 400) {
      return { id: request.id, status, body: { error: { code: "ErrorInvalidRequest" } } };
    }
    const id = decodeURIComponent(request.url.split("/").at(-1) ?? "");
    switch (request.method) {
      case "POST": {
        const created = `block-${state.nextBlock++}`;
        state.blocks.set(created, asRead(created, request.body ?? {}));
        return { id: request.id, status: 201, body: { id: created } };
      }
      case "PATCH":
        if (!state.blocks.has(id)) return { id: request.id, status: 404 };
        state.blocks.set(id, asRead(id, request.body ?? {}));
        return { id: request.id, status: 200, body: { id } };
      case "DELETE":
        return { id: request.id, status: state.blocks.delete(id) ? 204 : 404 };
      default:
        return { id: request.id, status: 405 };
    }
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/me/calendar/getSchedule")) {
      state.scheduleCalls.push({
        body: JSON.parse(init?.body as string) as Raw,
        headers: new Headers(init?.headers),
      });
      return state.schedule();
    }
    if (url.endsWith("/me?$select=mail")) {
      return state.me?.() ?? Response.json({ mail: state.mail });
    }
    if (url.endsWith("/$batch")) {
      const { requests } = JSON.parse(init?.body as string) as { requests: Request[] };
      state.batches.push(requests);
      return Response.json({ responses: requests.map(answer) });
    }
    if (url.includes("/calendars/source/")) return Response.json({ value: state.source });
    if (url.includes("/calendars/target/")) {
      const page = Number(new URL(url).searchParams.get("page") ?? 0);
      return Response.json({
        value: page === 0 ? [...state.blocks.values()] : [],
        ...(page < state.targetPages
          ? {
              "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/calendars/target/calendarView?page=${page + 1}`,
            }
          : {}),
      });
    }
    return new Response("unexpected", { status: 500 });
  });
  return state;
}

/** One Outlook account with a source and a target calendar, and a rule between them. */
async function setup(prefix: string, options: Raw = {}) {
  const { user } = await signIn(`${prefix}@org.example`);
  const account = `${prefix}-account`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(account, user.id, `${prefix}@work.example`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'source', 'Main', 1, 1, 1)",
    ).bind(`${prefix}-source`, account),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'target', 'Blocks', 1, 0, 0)",
    ).bind(`${prefix}-target`, account),
    env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      `${prefix}-rule`,
      user.id,
      `${prefix}-source`,
      `${prefix}-target`,
      JSON.stringify(options),
    ),
  ]);
  const sync = env.ACCOUNT_SYNC.getByName(account);
  await sync.storeTokens(
    account,
    { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + 100 * DAY },
    "microsoft",
  );
  /** A run after the source cache of the last one ended. */
  const run = async (dryRun = false) => {
    vi.setSystemTime(Date.now() + 10 * 60_000);
    return sync.runRule(`${prefix}-rule`, { dryRun });
  };
  const failures = async () => {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE account_id = ? AND kind = 'sync_failed'",
    )
      .bind(account)
      .first<{ count: number }>();
    return row?.count ?? 0;
  };
  return { run, failures, email: `${prefix}@work.example` };
}

const writes = (requests: Request[] | undefined) => (requests ?? []).map((item) => item.body ?? {});
const zoneOf = (body: Raw | undefined) => (body?.start as DateTime | undefined)?.timeZone;
const refuseWhen = (refused: (request: Request) => boolean) => (request: Request) =>
  refused(request) ? 400 : undefined;

beforeEach(() => {
  stopClock();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an all-day block on Outlook", () => {
  it("lies in the zone of the mailbox, and a timed block stays in UTC", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-write");
    const first = dateIn(3);
    const end = dateIn(4);
    graph.source = [allDayEvent("a", first, end), timedEvent("t", dateIn(5))];

    expect((await run()).applied).toBe(2);

    const [written] = graph.batches;
    const allDay = writes(written).find((body) => body.isAllDay === true);
    const timed = writes(written).find((body) => body.isAllDay === false);
    expect(allDay?.start).toEqual({ dateTime: `${first}T00:00:00`, timeZone: ZONE });
    expect(allDay?.end).toEqual({ dateTime: `${end}T00:00:00`, timeZone: ZONE });
    expect(zoneOf(timed)).toBe("UTC");

    expect(graph.scheduleCalls).toHaveLength(1);
    const [call] = graph.scheduleCalls;
    expect(call?.body.schedules).toEqual(["primary@work.example"]);
    expect(call?.headers.get("Authorization")).toBe("Bearer a");
    // A `Prefer` zone changes what Graph reports; see `originalStartTimeZone`.
    expect(call?.headers.has("Prefer")).toBe(false);
  });

  it("keeps the zone when a PATCH moves the block, and keeps the block", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-patch");
    const first = dateIn(3);
    const end = dateIn(6);
    graph.source = [allDayEvent("a", first, dateIn(4))];
    await run();
    const [id] = graph.blocks.keys();

    graph.source = [allDayEvent("a", first, end)];
    const moved = await run();

    expect(moved.stats).toMatchObject({ create: 0, update: 1, delete: 0 });
    expect(moved).toMatchObject({ applied: 1, failed: 0 });
    const [patch] = graph.batches[1] ?? [];
    expect(patch?.method).toBe("PATCH");
    expect(patch?.url).toContain(`/me/events/${id ?? "none"}`);
    expect(patch?.body?.start).toEqual({ dateTime: `${first}T00:00:00`, timeZone: ZONE });
    expect(patch?.body?.end).toEqual({ dateTime: `${end}T00:00:00`, timeZone: ZONE });
    expect([...graph.blocks.keys()]).toEqual([id]);
    expect((await run()).stats).toMatchObject({ update: 0, unchanged: 1 });
  });

  it("creates no update in the next runs, and no second lookup", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-stable");
    graph.source = [allDayEvent("a", dateIn(3), dateIn(6))];
    await run();
    const again = await run();
    expect(again.stats).toEqual({ create: 0, update: 0, delete: 0, unchanged: 1 });
    expect(await run()).toMatchObject({ applied: 0, failed: 0 });
    expect(graph.batches).toHaveLength(1);
    expect(graph.scheduleCalls).toHaveLength(1);
  });

  it("leaves a block alone that an earlier version wrote in UTC", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-old");
    graph.schedule = () => new Response("down", { status: 500 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    await run();
    expect(zoneOf(writes(graph.batches[0])[0])).toBe("UTC");

    graph.schedule = () =>
      Response.json({ value: [{ workingHours: { timeZone: { name: ZONE } } }] });
    vi.setSystemTime(Date.now() + 2 * DAY);
    const later = await run();
    expect(later.stats).toMatchObject({ update: 0, delete: 0 });
    expect(graph.batches).toHaveLength(1);
  });
});

describe("the lookup of the mailbox zone", () => {
  it("costs nothing for a rule without all-day writes", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-none");
    graph.source = [timedEvent("t", dateIn(5))];
    await run();
    expect(graph.batches).toHaveLength(1);
    expect(graph.scheduleCalls).toEqual([]);
  });

  it("costs nothing for a rule that skips all-day events", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-skip", { skipAllDay: true });
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4)), timedEvent("t", dateIn(5))];
    await run();
    expect(graph.scheduleCalls).toEqual([]);
  });

  it("costs nothing in a preview", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-dry");
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    await run(true);
    expect(graph.scheduleCalls).toEqual([]);
  });

  it("costs nothing if the run only deletes all-day blocks", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-delete");
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    await run();
    graph.source = [];
    vi.setSystemTime(Date.now() + 2 * DAY);
    const removal = await run();
    expect(removal.stats.delete).toBe(1);
    expect(graph.scheduleCalls).toHaveLength(1);
  });

  it("asks for the primary address, because the sign-in name can differ from it", async () => {
    const graph = mailbox();
    const { run, email } = await setup("zone-mail");
    graph.mail = "first.last@work.example";
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    await run();
    expect(email).not.toBe(graph.mail);
    expect(graph.scheduleCalls[0]?.body.schedules).toEqual(["first.last@work.example"]);
  });

  for (const mail of [null, ""]) {
    it(`asks for the account address if the profile has the mail ${JSON.stringify(mail)}`, async () => {
      const graph = mailbox();
      const { run, email } = await setup(`zone-nomail-${String(mail)}`);
      graph.mail = mail;
      graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
      await run();
      expect(graph.scheduleCalls[0]?.body.schedules).toEqual([email]);
    });
  }

  it("runs once per day", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-daily");
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    await run();
    vi.setSystemTime(Date.now() + LATER);
    graph.source.push(allDayEvent("b", dateIn(5), dateIn(6)));
    await run();
    expect(graph.batches).toHaveLength(2);
    expect(graph.scheduleCalls).toHaveLength(1);
    expect(zoneOf(writes(graph.batches[1])[0])).toBe(ZONE);

    vi.setSystemTime(Date.now() + DAY);
    graph.source.push(allDayEvent("c", dateIn(7), dateIn(8)));
    await run();
    expect(graph.scheduleCalls).toHaveLength(2);
  });

  const UNUSABLE: [string, () => Response][] = [
    ["no working hours", () => Response.json({ value: [{ scheduleId: "x" }] })],
    ["no schedule", () => Response.json({ value: [] })],
    [
      "a custom zone",
      () =>
        Response.json({
          value: [{ workingHours: { timeZone: { name: "Customized Time Zone" } } }],
        }),
    ],
    [
      "a zone URI",
      () =>
        Response.json({
          value: [{ workingHours: { timeZone: { name: "tzone://Microsoft/Utc" } } }],
        }),
    ],
    [
      "an empty name",
      () => Response.json({ value: [{ workingHours: { timeZone: { name: "" } } }] }),
    ],
  ];

  /** A failure says nothing about the mailbox. Unlike an answer above, it counts only briefly. */
  const FAILED: [string, () => Response][] = [
    ["a body that is no JSON", () => new Response("<html>", { status: 200 })],
    ["a body of another form", () => Response.json({ value: "none" })],
    ["an error for the schedule", () => Response.json({ value: [{ error: { message: "no" } }] })],
    ["a refused call", () => Response.json({ error: { code: "Forbidden" } }, { status: 403 })],
    ["a server error", () => new Response("down", { status: 500 })],
    ["a gateway timeout", () => new Response("late", { status: 504 })],
    [
      "a network error",
      () => {
        throw new TypeError("network");
      },
    ],
  ];

  for (const [name, schedule] of UNUSABLE) {
    it(`falls back to UTC for ${name}, and the run goes on`, async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const graph = mailbox();
      const { run, failures } = await setup(`zone-bad-${name.replaceAll(" ", "-")}`);
      graph.schedule = schedule;
      graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
      expect(await run()).toMatchObject({ applied: 1, failed: 0, remaining: 0 });
      expect(zoneOf(writes(graph.batches[0])[0])).toBe("UTC");
      expect(await failures()).toBe(0);

      // The answer counts for the day, unlike a failed lookup.
      vi.setSystemTime(Date.now() + LATER);
      graph.source.push(allDayEvent("b", dateIn(5), dateIn(6)));
      await run();
      expect(graph.scheduleCalls).toHaveLength(1);
    });
  }

  for (const [name, schedule] of FAILED) {
    it(`falls back to UTC for ${name}, and asks again soon`, async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const graph = mailbox();
      const { run, failures } = await setup(`zone-failed-${name.replaceAll(" ", "-")}`);
      const working = graph.schedule;
      graph.schedule = schedule;
      graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
      expect(await run()).toMatchObject({ applied: 1, failed: 0, remaining: 0 });
      expect(zoneOf(writes(graph.batches[0])[0])).toBe("UTC");
      expect(await failures()).toBe(0);

      // The next run of a busy mailbox makes no second call to a service with a fault.
      graph.schedule = working;
      graph.source.push(allDayEvent("b", dateIn(5), dateIn(6)));
      await run();
      expect(graph.scheduleCalls).toHaveLength(1);
      expect(zoneOf(writes(graph.batches[1])[0])).toBe("UTC");

      // After the short wait, a block lies in the zone again, far before the next day.
      graph.source.push(allDayEvent("c", dateIn(7), dateIn(8)));
      await run();
      expect(graph.scheduleCalls).toHaveLength(2);
      expect(zoneOf(writes(graph.batches[2])[0])).toBe(ZONE);
    });
  }

  for (const [name, schedule] of FAILED) {
    it(`keeps an expired zone for ${name}, and asks again soon`, async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const graph = mailbox();
      const { run, failures } = await setup(`zone-expired-${name.replaceAll(" ", "-")}`);
      graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
      await run();
      expect(zoneOf(writes(graph.batches[0])[0])).toBe(ZONE);

      vi.setSystemTime(Date.now() + DAY);
      graph.schedule = schedule;
      graph.source.push(allDayEvent("b", dateIn(5), dateIn(6)));
      expect(await run()).toMatchObject({ applied: 1, failed: 0, remaining: 0 });
      expect(graph.scheduleCalls).toHaveLength(2);
      expect(zoneOf(writes(graph.batches[1])[0])).toBe(ZONE);
      expect(await failures()).toBe(0);

      // The failure counts briefly: the next run keeps the zone and makes no call.
      graph.source.push(allDayEvent("c", dateIn(7), dateIn(8)));
      await run();
      expect(graph.scheduleCalls).toHaveLength(2);
      expect(zoneOf(writes(graph.batches[2])[0])).toBe(ZONE);

      // After the short wait, a new answer replaces the zone.
      const moved = "Pacific Standard Time";
      graph.schedule = () =>
        Response.json({ value: [{ workingHours: { timeZone: { name: moved } } }] });
      graph.source.push(allDayEvent("d", dateIn(9), dateIn(10)));
      await run();
      expect(graph.scheduleCalls).toHaveLength(3);
      expect(zoneOf(writes(graph.batches[3])[0])).toBe(moved);
    });
  }

  it("logs the code of a schedule error, and not its text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const graph = mailbox();
    const { run } = await setup("zone-schedule-log");
    graph.schedule = () =>
      Response.json({
        value: [{ error: { responseCode: "ErrorX", message: "text about someone" } }],
      });
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    await run();
    expect(JSON.stringify(log.mock.calls)).toContain("ErrorX");
    expect(JSON.stringify(log.mock.calls)).not.toContain("someone");
  });

  it("treats a failed read of the profile like a failed lookup, and asks again soon", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const graph = mailbox();
    const { run } = await setup("zone-me-failed");
    const me = vi.fn(() => new Response("down", { status: 500 }));
    graph.me = me;
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    expect(await run()).toMatchObject({ applied: 1, failed: 0, remaining: 0 });
    expect(graph.scheduleCalls).toEqual([]);
    expect(zoneOf(writes(graph.batches[0])[0])).toBe("UTC");

    // The next run of a busy mailbox makes no second call.
    graph.me = undefined;
    graph.source.push(allDayEvent("b", dateIn(5), dateIn(6)));
    await run();
    expect(me).toHaveBeenCalledOnce();
    expect(graph.scheduleCalls).toEqual([]);
    expect(zoneOf(writes(graph.batches[1])[0])).toBe("UTC");

    // After the short wait, the lookup runs in full and the block lies in the zone.
    graph.source.push(allDayEvent("c", dateIn(7), dateIn(8)));
    await run();
    expect(graph.scheduleCalls).toHaveLength(1);
    expect(zoneOf(writes(graph.batches[2])[0])).toBe(ZONE);
  });

  it("waits for a throttled read of the profile, and writes nothing in UTC", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-me-throttled");
    graph.me = () => new Response("slow", { status: 429, headers: { "Retry-After": "120" } });
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    const result = await run();
    expect(result).toMatchObject({ applied: 0, failed: 0, remaining: 1, retryAfterMs: 120_000 });
    expect(graph.batches).toEqual([]);
    expect(graph.scheduleCalls).toEqual([]);

    // A throttled read says nothing about the zone, so the next run asks again.
    graph.me = undefined;
    expect(await run()).toMatchObject({ applied: 1, failed: 0, remaining: 0 });
    expect(graph.scheduleCalls).toHaveLength(1);
    expect(zoneOf(writes(graph.batches[0])[0])).toBe(ZONE);
  });

  it("waits for a throttled lookup through the alarm, and writes nothing in UTC", async () => {
    const graph = mailbox();
    const { run, failures } = await setup("zone-throttled");
    const working = graph.schedule;
    graph.schedule = () => new Response("slow", { status: 429, headers: { "Retry-After": "120" } });
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    const result = await run();
    expect(result).toMatchObject({ applied: 0, failed: 0, remaining: 1 });
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(graph.batches).toEqual([]);
    expect(await failures()).toBe(0);

    // A throttled answer says nothing about the zone, so the next run asks again.
    graph.schedule = working;
    await run();
    expect(graph.scheduleCalls).toHaveLength(2);
    expect(zoneOf(writes(graph.batches[0])[0])).toBe(ZONE);
  });

  it("uses UTC for the day after Graph refuses a write in the zone", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-refused");
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    graph.writeStatus = refuseWhen(() => true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run()).toMatchObject({ applied: 0, failed: 1 });
    expect(log).toHaveBeenCalledOnce();

    graph.writeStatus = () => undefined;
    vi.setSystemTime(Date.now() + LATER);
    expect(await run()).toMatchObject({ applied: 1, failed: 0 });
    expect(zoneOf(writes(graph.batches[1])[0])).toBe("UTC");
    expect(graph.scheduleCalls).toHaveLength(1);
  });

  it("uses UTC for the day after Graph refuses a PATCH in the zone", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-refused-patch");
    vi.spyOn(console, "error").mockImplementation(() => {});
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    await run();
    graph.writeStatus = refuseWhen(({ method }) => method === "PATCH");
    graph.source = [allDayEvent("a", dateIn(3), dateIn(6))];
    expect(await run()).toMatchObject({ applied: 0, failed: 1 });

    graph.writeStatus = () => undefined;
    expect(await run()).toMatchObject({ applied: 1, failed: 0 });
    const [patch] = graph.batches[2] ?? [];
    expect(patch?.method).toBe("PATCH");
    expect(zoneOf(patch?.body)).toBe("UTC");
  });

  it("keeps the zone if another all-day write of the batch passes", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-mixed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = dateIn(5);
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4)), allDayEvent("b", refused, dateIn(6))];
    const startDay = (body: Raw | undefined) => (body?.start as DateTime | undefined)?.dateTime;
    graph.writeStatus = refuseWhen(({ body }) => startDay(body)?.startsWith(refused) === true);
    expect(await run()).toMatchObject({ applied: 1, failed: 1 });
    expect(log).not.toHaveBeenCalled();

    graph.writeStatus = () => undefined;
    graph.source.push(allDayEvent("c", dateIn(7), dateIn(8)));
    expect(await run()).toMatchObject({ applied: 2, failed: 0 });
    expect(writes(graph.batches[1]).map(zoneOf)).toEqual([ZONE, ZONE]);
    expect(graph.scheduleCalls).toHaveLength(1);
  });

  it("uses UTC for the day if only a timed write of the batch passes", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-mixed-timed");
    vi.spyOn(console, "error").mockImplementation(() => {});
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4)), timedEvent("t", dateIn(5))];
    graph.writeStatus = refuseWhen(({ body }) => body?.isAllDay === true);
    expect(await run()).toMatchObject({ applied: 1, failed: 1 });

    graph.writeStatus = () => undefined;
    await run();
    expect(writes(graph.batches[1]).map(zoneOf)).toEqual(["UTC"]);
    expect(graph.scheduleCalls).toHaveLength(1);
  });

  it("writes the next batch of the run in UTC after Graph refuses the zone", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-refused-batches");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    graph.source = Array.from({ length: 25 }, (_, index) =>
      allDayEvent(`a${index}`, dateIn(index + 3), dateIn(index + 4)),
    );
    graph.writeStatus = refuseWhen(({ body }) => zoneOf(body) === ZONE);
    expect(await run()).toMatchObject({ applied: 5, failed: 20, remaining: 0 });
    expect(new Set(writes(graph.batches[0]).map(zoneOf))).toEqual(new Set([ZONE]));
    expect(new Set(writes(graph.batches[1]).map(zoneOf))).toEqual(new Set(["UTC"]));
    expect(log).toHaveBeenCalledOnce();
  });

  it("logs a refused all-day write without the content of the event", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-refused-log", { detailLevel: "full" });
    graph.source = [{ ...allDayEvent("a", dateIn(3), dateIn(4)), subject: "Secret offsite" }];
    graph.writeStatus = refuseWhen(() => true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await run();
    expect(JSON.stringify(log.mock.calls)).toContain("ErrorInvalidRequest");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Secret");
  });

  it("keeps the zone after a 400 for a timed block", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-timed-400");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4)), timedEvent("t", dateIn(5))];
    graph.writeStatus = refuseWhen(({ body }) => body?.isAllDay === false);
    expect(await run()).toMatchObject({ applied: 1, failed: 1 });
    expect(log).not.toHaveBeenCalled();

    graph.writeStatus = () => undefined;
    graph.source.push(allDayEvent("b", dateIn(6), dateIn(7)));
    await run();
    const allDay = writes(graph.batches[1]).find((body) => body.isAllDay === true);
    expect(zoneOf(allDay)).toBe(ZONE);
    expect(graph.scheduleCalls).toHaveLength(1);
  });

  it("keeps the zone after a 400 for a delete", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-delete-400");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    await run();

    graph.source = [allDayEvent("b", dateIn(5), dateIn(6))];
    graph.writeStatus = refuseWhen(({ method }) => method === "DELETE");
    expect(await run()).toMatchObject({ applied: 1, failed: 1 });
    expect(log).not.toHaveBeenCalled();

    graph.writeStatus = () => undefined;
    graph.source.push(allDayEvent("c", dateIn(7), dateIn(8)));
    await run();
    const allDay = writes(graph.batches[2]).find((body) => body.isAllDay === true);
    expect(zoneOf(allDay)).toBe(ZONE);
  });

  it("keeps the zone after a 500 for an all-day write", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-write-500");
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    graph.writeStatus = () => 500;
    expect(await run()).toMatchObject({ applied: 0, failed: 1 });

    graph.writeStatus = () => undefined;
    await run();
    expect(zoneOf(writes(graph.batches[1])[0])).toBe(ZONE);
  });

  it("counts in the provider requests of the step", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-budget");
    // 1 source read and 44 target pages leave three requests of 48. The lookup takes two.
    graph.targetPages = 43;
    graph.source = Array.from({ length: 30 }, (_, index) =>
      allDayEvent(`a${index}`, dateIn(index + 3), dateIn(index + 4)),
    );
    const result = await run();
    expect(graph.scheduleCalls).toHaveLength(1);
    // Without the lookup, the budget allows the two batches of this plan.
    expect(graph.batches).toHaveLength(1);
    expect(result.remaining).toBe(10);
  });

  it("stays out of a step without a request left, and does not store the answer", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-full");
    // 1 source read and 45 target pages leave two requests of 48. The lookup takes two, and the
    // batch that always runs would be one request too many.
    graph.targetPages = 44;
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    expect(await run()).toMatchObject({ applied: 1 });
    expect(graph.scheduleCalls).toEqual([]);
    expect(zoneOf(writes(graph.batches[0])[0])).toBe("UTC");

    graph.targetPages = 0;
    graph.source.push(allDayEvent("b", dateIn(5), dateIn(6)));
    await run();
    expect(graph.scheduleCalls).toHaveLength(1);
  });

  it("keeps an expired zone in a step without a request left", async () => {
    const graph = mailbox();
    const { run } = await setup("zone-full-expired");
    graph.source = [allDayEvent("a", dateIn(3), dateIn(4))];
    await run();

    vi.setSystemTime(Date.now() + DAY);
    graph.targetPages = 44;
    graph.source.push(allDayEvent("b", dateIn(5), dateIn(6)));
    expect(await run()).toMatchObject({ applied: 1 });
    expect(graph.scheduleCalls).toHaveLength(1);
    expect(zoneOf(writes(graph.batches[1])[0])).toBe(ZONE);

    // The skip stores nothing, so the next step with requests left asks.
    graph.targetPages = 0;
    graph.source.push(allDayEvent("c", dateIn(7), dateIn(8)));
    await run();
    expect(graph.scheduleCalls).toHaveLength(2);
  });

  it("exists only at Graph, and waits for its turn like every provider call", async () => {
    mailbox();
    const queued = vi.fn();
    const run = <T>(call: () => Promise<T>) => {
      queued();
      return call();
    };
    const graph = oneCallAtATime(new GraphCalendar("t"), run);
    await expect(graph.mailboxZone?.("a@work.example")).resolves.toBe(ZONE);
    expect(queued).toHaveBeenCalledOnce();
    expect("mailboxZone" in oneCallAtATime(new GoogleCalendar("t"), run)).toBe(false);
  });
});
