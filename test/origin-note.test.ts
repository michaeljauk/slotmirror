/**
 * The origin note: blocks name their source account and, on request, link the source event. The
 * note is part of the content hash, so turning it on rewrites each block once and later runs find
 * the blocks unchanged. The tests run real rule runs against a fake Graph and a fake Google that
 * keep the written blocks, in both directions between the providers.
 */
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renameAccount, setOriginNote } from "../src/editor";
import { ruleOptionsSchema } from "../src/config";
import { blockContent } from "../src/sync/plan";
import { fromGoogleEvent } from "../src/sync/google-events";
import { fromGraphEvent, GRAPH_EVENT_SELECT } from "../src/sync/graph-events";
import type { SourceEvent } from "../src/sync/types";
import type { CurrentUser } from "../src/users";
import { signIn } from "./helpers";

const NOW = Date.UTC(2026, 10, 1);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SECRET = ["Secret plan", "Room 7", "Agenda text"];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function graphTime(ms: number) {
  return { dateTime: `${iso(ms).slice(0, 19)}.0000000`, timeZone: "UTC" };
}

function graphLink(id: string): string {
  return `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(id)}&exvsurl=1&path=/calendar/item`;
}

function googleLink(id: string): string {
  return `https://www.google.com/calendar/event?eid=${btoa(`${id} src@gmail.example`)}`;
}

/**
 * Graph source events: a weekly series of `occurrences`, a moved occurrence, single events, an
 * all-day event and a private event. All carry a title, a location, a description and a link.
 */
function graphSource(occurrences = 6, singles = 3): Record<string, unknown>[] {
  const content = (id: string) => ({
    subject: SECRET[0],
    location: { displayName: SECRET[1] },
    body: { contentType: "text", content: `${SECRET[2]}\r\n` },
    bodyPreview: SECRET[2],
    webLink: graphLink(id),
    showAs: "busy",
    sensitivity: "normal",
    isCancelled: false,
  });
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < occurrences; i++) {
    const start = NOW + (i * 7 + 1) * DAY + 9 * HOUR;
    const moved = i === 2 ? 2 * HOUR : 0;
    const id = `ms-occ-${i}`;
    events.push({
      ...content(id),
      id,
      type: moved ? "exception" : "occurrence",
      seriesMasterId: "ms-series",
      originalStart: iso(start).replace(".000Z", "Z"),
      start: graphTime(start + moved),
      end: graphTime(start + moved + HOUR),
      isAllDay: false,
    });
  }
  for (let i = 0; i < singles; i++) {
    const start = NOW + (i + 2) * DAY + 14 * HOUR + i * 60_000;
    const id = `ms-single-${i}`;
    events.push({
      ...content(id),
      id,
      type: "singleInstance",
      start: graphTime(start),
      end: graphTime(start + HOUR),
      isAllDay: false,
    });
  }
  events.push({
    ...content("ms-all-day"),
    id: "ms-all-day",
    type: "singleInstance",
    start: { dateTime: "2026-11-20T00:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-21T00:00:00.0000000", timeZone: "UTC" },
    isAllDay: true,
  });
  events.push({
    ...content("ms-private"),
    id: "ms-private",
    type: "singleInstance",
    sensitivity: "private",
    start: graphTime(NOW + 10 * DAY + 8 * HOUR),
    end: graphTime(NOW + 10 * DAY + 9 * HOUR),
    isAllDay: false,
  });
  return events;
}

/** Google source events of the same kinds as `graphSource`. */
function googleSource(): Record<string, unknown>[] {
  const content = (id: string) => ({
    status: "confirmed",
    summary: SECRET[0],
    location: SECRET[1],
    description: `${SECRET[2]}\n`,
    htmlLink: googleLink(id),
  });
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < 6; i++) {
    const start = NOW + (i * 7 + 3) * DAY + 7 * HOUR;
    const moved = i === 1 ? HOUR : 0;
    const id = `g-series_${iso(start).replace(/[-:]/g, "").slice(0, 15)}Z`;
    events.push({
      ...content(id),
      id,
      recurringEventId: "g-series",
      originalStartTime: { dateTime: iso(start) },
      start: { dateTime: iso(start + moved) },
      end: { dateTime: iso(start + moved + HOUR) },
    });
  }
  for (let i = 0; i < 3; i++) {
    const start = NOW + (i + 4) * DAY + 16 * HOUR + i * 60_000;
    events.push({
      ...content(`g-single-${i}`),
      id: `g-single-${i}`,
      start: { dateTime: iso(start) },
      end: { dateTime: iso(start + HOUR) },
    });
  }
  events.push({
    ...content("g-all-day"),
    id: "g-all-day",
    start: { date: "2026-11-24" },
    end: { date: "2026-11-25" },
  });
  events.push({
    ...content("g-private"),
    id: "g-private",
    visibility: "private",
    start: { dateTime: iso(NOW + 12 * DAY + 8 * HOUR) },
    end: { dateTime: iso(NOW + 12 * DAY + 9 * HOUR) },
  });
  return events;
}

/** Keep only the fields that the request asked for, as the providers do. */
function graphSelected(event: Record<string, unknown>, select: string): Record<string, unknown> {
  const fields = new Set(select.split(","));
  const copy = { ...event };
  for (const field of ["webLink", "body"]) if (!fields.has(field)) delete copy[field];
  return copy;
}

function googleSelected(event: Record<string, unknown>, fields: string): Record<string, unknown> {
  const copy = { ...event };
  if (!/[(,]htmlLink[,)]/.test(fields)) delete copy.htmlLink;
  if (!/[(,]description[,)]/.test(fields)) delete copy.description;
  return copy;
}

/** Drop null fields of an object, as a PATCH with null removes a field. */
function merged(current: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else base[key] = key === "start" || key === "end" ? merged(base[key], value) : value;
  }
  return base;
}

interface Fake {
  /** Blocks in Graph calendars, by calendar remote ID. */
  graph: Map<string, Map<string, Record<string, unknown>>>;
  /** Blocks in Google calendars, by calendar remote ID. */
  google: Map<string, Map<string, Record<string, unknown>>>;
  urls: string[];
  /** Request bodies of all batches, as sent. */
  sent: string[];
  graphSource: Record<string, unknown>[];
  googleSource: Record<string, unknown>[];
}

/**
 * Fake Graph and Google. Source calendars return the given events, target calendars return what
 * the batches wrote. Graph pages calendarView by 500, as `$top` asks.
 */
function fakeProviders(sources: {
  graph?: Record<string, unknown>[];
  google?: Record<string, unknown>[];
}) {
  const fake: Fake = {
    graph: new Map(),
    google: new Map(),
    urls: [],
    sent: [],
    graphSource: sources.graph ?? graphSource(),
    googleSource: sources.google ?? googleSource(),
  };
  let next = 0;
  const graphCalendarOf = new Map<string, string>();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    fake.urls.push(url);
    const parsed = new URL(url);
    const view = /\/calendars\/([^/]+)\/calendarView/.exec(parsed.pathname);
    if (view) {
      const calendar = decodeURIComponent(view[1]!);
      const select = parsed.searchParams.get("$select") ?? "";
      const all = calendar.endsWith("-src-remote")
        ? fake.graphSource.map((event) => graphSelected(event, select))
        : [...(fake.graph.get(calendar)?.values() ?? [])];
      const skip = Number(parsed.searchParams.get("fakeSkip") ?? "0");
      const page = all.slice(skip, skip + 500);
      if (skip + 500 >= all.length) return Response.json({ value: page });
      parsed.searchParams.set("fakeSkip", String(skip + 500));
      return Response.json({ value: page, "@odata.nextLink": parsed.toString() });
    }
    const list = /\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(parsed.pathname);
    if (list && (init?.method ?? "GET") === "GET") {
      const calendar = decodeURIComponent(list[1]!);
      const fields = parsed.searchParams.get("fields") ?? "";
      const items = calendar.endsWith("-src-remote")
        ? fake.googleSource.map((event) => googleSelected(event, fields))
        : [...(fake.google.get(calendar)?.values() ?? [])];
      return Response.json({ items });
    }
    if (url.endsWith("/$batch")) {
      const text = init?.body as string;
      fake.sent.push(text);
      const { requests } = JSON.parse(text) as {
        requests: { id: string; method: string; url: string; body?: Record<string, unknown> }[];
      };
      const responses = requests.map((request) => {
        if (request.method === "POST") {
          const calendar = decodeURIComponent(
            /\/calendars\/([^/]+)\/events/.exec(request.url)![1]!,
          );
          const id = `graph-block-${next++}`;
          const store = fake.graph.get(calendar) ?? new Map();
          fake.graph.set(calendar, store);
          store.set(id, { ...request.body, id, type: "singleInstance" });
          graphCalendarOf.set(id, calendar);
          return { id: request.id, status: 201, body: { id } };
        }
        const id = decodeURIComponent(request.url.split("/").pop()!);
        const store = fake.graph.get(graphCalendarOf.get(id) ?? "");
        const current = store?.get(id);
        if (!store || !current) return { id: request.id, status: 404 };
        if (request.method === "DELETE") {
          store.delete(id);
          return { id: request.id, status: 204 };
        }
        store.set(id, { ...current, ...request.body, id });
        return { id: request.id, status: 200, body: { id } };
      });
      return Response.json({ responses });
    }
    if (url.includes("/batch/calendar/v3")) {
      const text = init?.body as string;
      fake.sent.push(text);
      const parts = text.split(/--batch_[^\r\n]*/).filter((part) => part.includes("HTTP/1.1"));
      const answers = parts.map((part) => {
        const index = /Content-ID: <item(\d+)>/.exec(part)![1]!;
        const [, method, path] = /\r\n(POST|PATCH|DELETE) (\S+) HTTP\/1\.1/.exec(part)!;
        const calendar = decodeURIComponent(/\/calendars\/([^/]+)\/events/.exec(path!)![1]!);
        const store = fake.google.get(calendar) ?? new Map();
        fake.google.set(calendar, store);
        const json = part.includes("{") ? JSON.parse(part.slice(part.indexOf("{"))) : undefined;
        let status = 200;
        let id = path!.split("/").pop()!;
        if (method === "POST") {
          id = `google-block-${next++}`;
          // Google stores no null fields, such as a `colorId` of null.
          store.set(id, { ...(merged({}, json) as object), id, status: "confirmed" });
        } else if (!store.has(id)) {
          status = 404;
        } else if (method === "DELETE") {
          store.delete(id);
          status = 204;
        } else {
          store.set(id, merged(store.get(id), json) as Record<string, unknown>);
        }
        return `--r\r\nContent-ID: <response-item${index}>\r\n\r\nHTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\n\r\n{"id":"${id}"}\r\n`;
      });
      return new Response(`${answers.join("")}--r--\r\n`, {
        headers: { "content-type": "multipart/mixed; boundary=r" },
      });
    }
    return new Response("unexpected", { status: 500 });
  });
  return fake;
}

const TOKENS = { refreshToken: "r", accessToken: "a", accessExpiresAt: NOW + 30 * DAY };

/**
 * Four accounts of one user: a Microsoft and a Google source, a Microsoft and a Google target.
 * Rule "mg" mirrors Microsoft into Google, rule "gm" Google into Microsoft.
 */
async function setup(prefix: string, options: { mg?: object; gm?: object } = {}) {
  const { user } = await signIn("owner@example.com");
  const accounts = [
    [`${prefix}-ms-src`, "microsoft", `${prefix}-src@work.example`, null],
    [`${prefix}-g-src`, "google", `${prefix}-src@gmail.example`, "Private"],
    [`${prefix}-ms-dst`, "microsoft", `${prefix}-dst@work.example`, null],
    [`${prefix}-g-dst`, "google", `${prefix}-dst@gmail.example`, null],
  ] as const;
  await env.DB.batch([
    ...accounts.flatMap(([id, provider, email, name]) => [
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email, display_name) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, user.id, provider, email, name),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES (?, ?, ?, 'Cal', 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
    ]),
    env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      `${prefix}-mg`,
      user.id,
      `${prefix}-ms-src-cal`,
      `${prefix}-g-dst-cal`,
      JSON.stringify(options.mg ?? {}),
    ),
    env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      `${prefix}-gm`,
      user.id,
      `${prefix}-g-src-cal`,
      `${prefix}-ms-dst-cal`,
      JSON.stringify(options.gm ?? {}),
    ),
  ]);
  for (const [id, provider] of accounts) {
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(id, TOKENS, provider);
  }
  const run = async () => ({
    mg: await env.ACCOUNT_SYNC.getByName(`${prefix}-g-dst`).runRule(`${prefix}-mg`),
    gm: await env.ACCOUNT_SYNC.getByName(`${prefix}-ms-dst`).runRule(`${prefix}-gm`),
  });
  return { user, run };
}

/** Descriptions of the blocks in the Google target and the Microsoft target. */
function bodies(fake: Fake, prefix: string) {
  const google = [...(fake.google.get(`${prefix}-g-dst-remote`)?.values() ?? [])].map(
    (event) => event.description as string,
  );
  const graph = [...(fake.graph.get(`${prefix}-ms-dst-remote`)?.values() ?? [])].map(
    (event) => (event.body as { content: string }).content,
  );
  return { mg: google.sort(), gm: graph.sort() };
}

function stats(result: { stats: Record<string, number> }) {
  const { create, update, delete: deleted } = result.stats;
  return { create, update, delete: deleted };
}

const NO_CHANGE = { create: 0, update: 0, delete: 0 };

/** Ids of the included source events: default options skip the free and the all-day ones. */
const MS_COPIES = graphSource()
  .filter((event) => !event.isAllDay)
  .map((event) => event.id as string);
const G_COPIES = googleSource()
  .filter((event) => !(event.start as { date?: string }).date)
  .map((event) => event.id as string);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("origin note", () => {
  it("rewrites every copy once when turned on, then leaves them alone", async () => {
    const fake = fakeProviders({});
    const { user, run } = await setup("on");
    const first = await run();
    expect(stats(first.mg)).toEqual({ create: MS_COPIES.length, update: 0, delete: 0 });
    expect(stats(first.gm)).toEqual({ create: G_COPIES.length, update: 0, delete: 0 });
    expect(bodies(fake, "on").mg.every((body) => body === "")).toBe(true);

    const on = { showOrigin: true, linkOrigin: true };
    expect(await setOriginNote(env, user, "on-ms-src", on, "de")).toBe(true);
    expect(await setOriginNote(env, user, "on-g-src", on, "en")).toBe(true);

    const second = await run();
    expect(stats(second.mg)).toEqual({ create: 0, update: MS_COPIES.length, delete: 0 });
    expect(stats(second.gm)).toEqual({ create: 0, update: G_COPIES.length, delete: 0 });
    // Each occurrence of a series links its own event; the account has no name, so its address.
    expect(bodies(fake, "on").mg).toEqual(
      MS_COPIES.map((id) => `Aus: on-src@work.example (Microsoft)\n${graphLink(id)}`).sort(),
    );
    expect(bodies(fake, "on").gm).toEqual(
      G_COPIES.map((id) => `From: Private (Google)\n${googleLink(id)}`).sort(),
    );

    for (let i = 0; i < 2; i++) {
      const again = await run();
      expect(stats(again.mg)).toEqual(NO_CHANGE);
      expect(stats(again.gm)).toEqual(NO_CHANGE);
      expect(again.mg.stats.unchanged).toBe(MS_COPIES.length);
      expect(again.gm.stats.unchanged).toBe(G_COPIES.length);
    }
  });

  it("removes the note again when turned off", async () => {
    const fake = fakeProviders({});
    const { user, run } = await setup("off");
    await setOriginNote(env, user, "off-ms-src", { showOrigin: true, linkOrigin: false }, "en");
    await setOriginNote(env, user, "off-g-src", { showOrigin: true, linkOrigin: true }, "en");
    await run();
    expect(bodies(fake, "off").mg[0]).toBe("From: off-src@work.example (Microsoft)");

    const off = { showOrigin: false, linkOrigin: false };
    await setOriginNote(env, user, "off-ms-src", off, "en");
    await setOriginNote(env, user, "off-g-src", off, "en");
    const removed = await run();
    expect(stats(removed.mg)).toEqual({ create: 0, update: MS_COPIES.length, delete: 0 });
    expect(stats(removed.gm)).toEqual({ create: 0, update: G_COPIES.length, delete: 0 });
    expect([...bodies(fake, "off").mg, ...bodies(fake, "off").gm].every((b) => b === "")).toBe(
      true,
    );
    const again = await run();
    expect(stats(again.mg)).toEqual(NO_CHANGE);
    expect(stats(again.gm)).toEqual(NO_CHANGE);
  });

  it("appends the note to the copied description at detail level full", async () => {
    const fake = fakeProviders({});
    const full = { detailLevel: "full" };
    const { user, run } = await setup("full", { mg: full, gm: full });
    const on = { showOrigin: true, linkOrigin: true };
    await setOriginNote(env, user, "full-ms-src", on, "en");
    await setOriginNote(env, user, "full-g-src", on, "en");
    await run();
    const { mg, gm } = bodies(fake, "full");
    // The private event gets no description, only the note.
    expect(mg).toEqual(
      MS_COPIES.map((id) =>
        id === "ms-private"
          ? `From: full-src@work.example (Microsoft)\n${graphLink(id)}`
          : `Agenda text\n\nFrom: full-src@work.example (Microsoft)\n${graphLink(id)}`,
      ).sort(),
    );
    expect(gm).toContain(`Agenda text\n\nFrom: Private (Google)\n${googleLink("g-single-0")}`);
    const again = await run();
    expect(stats(again.mg)).toEqual(NO_CHANGE);
    expect(stats(again.gm)).toEqual(NO_CHANGE);
  });

  it("writes the note into all-day copies", async () => {
    const fake = fakeProviders({});
    const allDay = { skipAllDay: false };
    const { user, run } = await setup("allday", { mg: allDay, gm: allDay });
    await run();
    const on = { showOrigin: true, linkOrigin: true };
    await setOriginNote(env, user, "allday-ms-src", on, "en");
    await setOriginNote(env, user, "allday-g-src", on, "en");
    const second = await run();
    expect(second.mg.stats.update).toBe(MS_COPIES.length + 1);
    expect(second.gm.stats.update).toBe(G_COPIES.length + 1);
    const googleAllDay = [...fake.google.get("allday-g-dst-remote")!.values()].find(
      (event) => (event.start as { date?: string }).date === "2026-11-20",
    );
    expect(googleAllDay?.description).toBe(
      `From: allday-src@work.example (Microsoft)\n${graphLink("ms-all-day")}`,
    );
    const graphAllDay = [...fake.graph.get("allday-ms-dst-remote")!.values()].find(
      (event) => event.isAllDay === true,
    );
    expect((graphAllDay!.body as { content: string }).content).toBe(
      `From: Private (Google)\n${googleLink("g-all-day")}`,
    );
    const again = await run();
    expect(stats(again.mg)).toEqual(NO_CHANGE);
    expect(stats(again.gm)).toEqual(NO_CHANGE);
  });

  it("rewrites the note once when the source account gets a new name", async () => {
    const fake = fakeProviders({});
    const { user, run } = await setup("rename");
    const on = { showOrigin: true, linkOrigin: false };
    await setOriginNote(env, user, "rename-ms-src", on, "en");
    await setOriginNote(env, user, "rename-g-src", on, "en");
    await run();
    await renameAccount(env, user, "rename-ms-src", "Work");
    await renameAccount(env, user, "rename-g-src", "");

    const renamed = await run();
    expect(stats(renamed.mg)).toEqual({ create: 0, update: MS_COPIES.length, delete: 0 });
    expect(stats(renamed.gm)).toEqual({ create: 0, update: G_COPIES.length, delete: 0 });
    expect(new Set(bodies(fake, "rename").mg)).toEqual(new Set(["From: Work (Microsoft)"]));
    // Without a name, the note shows the address.
    expect(new Set(bodies(fake, "rename").gm)).toEqual(
      new Set(["From: rename-src@gmail.example (Google)"]),
    );
    const again = await run();
    expect(stats(again.mg)).toEqual(NO_CHANGE);
    expect(stats(again.gm)).toEqual(NO_CHANGE);
  });

  it("adds no event content at detail level busy or title", async () => {
    const fake = fakeProviders({});
    const { user, run } = await setup("content", { mg: { detailLevel: "title" } });
    const on = { showOrigin: true, linkOrigin: true };
    await setOriginNote(env, user, "content-ms-src", on, "en");
    await setOriginNote(env, user, "content-g-src", on, "en");
    await run();
    const google = [...fake.google.get("content-g-dst-remote")!.values()];
    for (const event of google) {
      expect(event.location).toBe("");
      expect(event.description).toMatch(/^From: content-src@work\.example \(Microsoft\)\nhttps:/);
    }
    // At "title", the private event still shows only "Busy".
    expect(google.filter((event) => event.summary === "Busy")).toHaveLength(1);
    const graph = [...fake.graph.get("content-ms-dst-remote")!.values()];
    expect(graph.every((event) => event.subject === "Busy")).toBe(true);
    // Neither the location nor the description of an event leaves the source.
    for (const text of fake.sent) {
      expect(text).not.toContain(SECRET[1]);
      expect(text).not.toContain(SECRET[2]);
    }
  });

  it("reads the link only for rules that write it", async () => {
    const fake = fakeProviders({});
    const { user, run } = await setup("reads");
    await run();
    const sourceReads = () =>
      fake.urls.filter((url) => url.includes("-src-remote")).map((url) => new URL(url));
    const [graphRead, googleRead] = [
      sourceReads().find((url) => url.pathname.includes("calendarView"))!,
      sourceReads().find((url) => url.pathname.includes("/events"))!,
    ];
    // Options off: the reads are as before the option existed.
    expect(graphRead.searchParams.get("$select")).toBe(GRAPH_EVENT_SELECT);
    expect(googleRead.searchParams.get("fields")).not.toContain("htmlLink");

    fake.urls.length = 0;
    await setOriginNote(env, user, "reads-ms-src", { showOrigin: true, linkOrigin: false }, "en");
    await setOriginNote(env, user, "reads-g-src", { showOrigin: true, linkOrigin: false }, "en");
    await run();
    expect(sourceReads().every((url) => !url.toString().includes("Link"))).toBe(true);

    fake.urls.length = 0;
    await setOriginNote(env, user, "reads-ms-src", { showOrigin: true, linkOrigin: true }, "en");
    await setOriginNote(env, user, "reads-g-src", { showOrigin: true, linkOrigin: true }, "en");
    await run();
    const select = sourceReads()
      .find((url) => url.pathname.includes("calendarView"))!
      .searchParams.get("$select");
    expect(select).toBe(`${GRAPH_EVENT_SELECT},webLink`);
    expect(
      sourceReads()
        .find((url) => url.pathname.includes("/events"))!
        .searchParams.get("fields"),
    ).toContain("htmlLink");
  });

  it("keeps source reads with and without the link apart", async () => {
    const fake = fakeProviders({});
    const { user, run } = await setup("cache");
    // A second rule from the same source calendar writes the note without the link.
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
       VALUES ('cache-plain', ?, 'cache-ms-src-cal', 'cache-ms-dst-cal', '{"showOrigin":true}')`,
    )
      .bind(user.id)
      .run();
    await env.DB.prepare(
      `UPDATE rules SET options = '{"showOrigin":true,"linkOrigin":true}' WHERE id = 'cache-mg'`,
    ).run();
    // The rule without the link reads first; the source instance caches what it read.
    await env.ACCOUNT_SYNC.getByName("cache-ms-dst").runRule("cache-plain");
    await run();
    const plain = [...fake.graph.get("cache-ms-dst-remote")!.values()]
      .map((event) => (event.body as { content: string }).content)
      .filter((body) => body.includes("Microsoft"));
    expect(new Set(plain)).toEqual(new Set(["From: cache-src@work.example (Microsoft)"]));
    expect(bodies(fake, "cache").mg).toEqual(
      MS_COPIES.map((id) => `From: cache-src@work.example (Microsoft)\n${graphLink(id)}`).sort(),
    );
  });

  it("ignores the link without the note", async () => {
    const fake = fakeProviders({});
    const { run } = await setup("linkonly", { mg: { linkOrigin: true }, gm: { linkOrigin: true } });
    await run();
    const { mg, gm } = bodies(fake, "linkonly");
    expect([...mg, ...gm].every((body) => body === "")).toBe(true);
    expect(fake.urls.some((url) => url.includes("Link"))).toBe(false);
  });

  it("never logs the note or the link and keeps them out of the audit log", async () => {
    fakeProviders({});
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    const { user, run } = await setup("logs");
    const on = { showOrigin: true, linkOrigin: true };
    await setOriginNote(env, user, "logs-ms-src", on, "en");
    await setOriginNote(env, user, "logs-g-src", on, "en");
    await run();
    await run();
    const { results } = await env.DB.prepare(
      "SELECT kind, detail FROM audit_events WHERE user_id = ?",
    )
      .bind(user.id)
      .all<{ kind: string; detail: string }>();
    expect(results.some((row) => row.kind === "rule_updated")).toBe(true);
    const text = JSON.stringify([logged.map(String), results]);
    for (const needle of ["From:", "logs-src@", "Private", "itemid", "eid=", "https://"]) {
      expect(text).not.toContain(needle);
    }
  });
});

describe("setOriginNote", () => {
  async function optionsOf(prefix: string): Promise<Record<string, unknown>[]> {
    const { results } = await env.DB.prepare(
      "SELECT options FROM rules WHERE id IN (?, ?) ORDER BY id",
    )
      .bind(`${prefix}-gm`, `${prefix}-mg`)
      .all<{ options: string }>();
    return results.map((row) => JSON.parse(row.options) as Record<string, unknown>);
  }

  it("writes nothing for invalid input or another user's account", async () => {
    fakeProviders({});
    const { user } = await setup("invalid");
    const before = await optionsOf("invalid");
    const batch = vi.spyOn(env.DB, "batch");
    const stranger: CurrentUser = { ...user, id: "someone-else" };
    expect(
      await setOriginNote(
        env,
        user,
        "invalid-ms-src",
        { showOrigin: false, linkOrigin: true },
        "en",
      ),
    ).toBe(false);
    expect(
      await setOriginNote(
        env,
        user,
        "invalid-ms-src",
        { showOrigin: "yes", linkOrigin: false } as never,
        "en",
      ),
    ).toBe(false);
    expect(
      await setOriginNote(
        env,
        user,
        "invalid-ms-src",
        { showOrigin: true, linkOrigin: false },
        "xx" as never,
      ),
    ).toBe(false);
    expect(
      await setOriginNote(
        env,
        stranger,
        "invalid-ms-src",
        { showOrigin: true, linkOrigin: true },
        "en",
      ),
    ).toBe(false);
    expect(batch).not.toHaveBeenCalled();
    expect(await optionsOf("invalid")).toEqual(before);
  });

  it("sets both options for every rule of the source in one batch and keeps other options", async () => {
    fakeProviders({});
    const { user } = await setup("batch", { mg: { blockColor: "7", parked: true } });
    // A second target calendar: the source now has two rules.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES ('batch-extra-cal', 'batch-ms-dst', 'batch-extra', 'Extra', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES ('batch-extra', ?, 'batch-ms-src-cal', 'batch-extra-cal')",
      ).bind(user.id),
    ]);
    const batch = vi.spyOn(env.DB, "batch");
    expect(
      await setOriginNote(env, user, "batch-ms-src", { showOrigin: true, linkOrigin: true }, "de"),
    ).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
    const { results } = await env.DB.prepare(
      "SELECT id, options FROM rules WHERE user_id = ? AND id LIKE 'batch-%' ORDER BY id",
    )
      .bind(user.id)
      .all<{ id: string; options: string }>();
    const byId = Object.fromEntries(results.map((row) => [row.id, JSON.parse(row.options)]));
    expect(byId["batch-mg"]).toEqual({
      blockColor: "7",
      parked: true,
      showOrigin: true,
      linkOrigin: true,
      originLocale: "de",
    });
    expect(byId["batch-extra"]).toMatchObject({ showOrigin: true, linkOrigin: true });
    // Rules from the other source keep their options.
    expect(byId["batch-gm"]).toEqual({});
    // Setting the same again writes nothing.
    batch.mockClear();
    await setOriginNote(env, user, "batch-ms-src", { showOrigin: true, linkOrigin: true }, "de");
    expect(batch).not.toHaveBeenCalled();
    // Another language alone changes the note.
    await setOriginNote(env, user, "batch-ms-src", { showOrigin: true, linkOrigin: true }, "en");
    expect(batch).toHaveBeenCalledTimes(1);
    const stored = await env.DB.prepare("SELECT options FROM rules WHERE id = 'batch-mg'").first<{
      options: string;
    }>();
    expect(JSON.parse(stored!.options)).toMatchObject({ originLocale: "en" });
  });
});

describe("origin note content", () => {
  const event: SourceEvent = {
    occurrenceKey: "event:x",
    start: "2026-11-02",
    end: "2026-11-03",
    allDay: true,
    showAs: "busy",
    isPrivate: false,
    declined: false,
    categories: [],
    subject: "Offsite",
    location: "Lake",
    body: "  \n",
    isMirror: false,
    link: "https://example.invalid/event?id=x",
  };

  it("leaves the block as before while the option is off", () => {
    const options = ruleOptionsSchema.parse({ detailLevel: "full", linkOrigin: true });
    expect(blockContent(event, options, "From: A (Google)")).toEqual(blockContent(event, options));
    expect(blockContent(event, options).body).toBe("  \n");
  });

  it("takes only https links from the providers", () => {
    const graph = (webLink: unknown) => fromGraphEvent({ ...graphSource(1, 0)[0], webLink })?.link;
    const google = (htmlLink: unknown) => fromGoogleEvent({ ...googleSource()[0], htmlLink })?.link;
    expect(graph(graphLink("a"))).toBe(graphLink("a"));
    expect(google(googleLink("a"))).toBe(googleLink("a"));
    for (const bad of ["javascript:alert(1)", "http://example.com/x", "https://a b", "", null]) {
      expect(graph(bad)).toBeUndefined();
      if (bad !== null) expect(google(bad)).toBeUndefined();
    }
    expect(graph(undefined)).toBeUndefined();
    expect(
      Object.keys(fromGraphEvent({ ...graphSource(1, 0)[0], webLink: undefined })!),
    ).not.toContain("link");
  });

  it("writes only the note for a blank description at detail level full", () => {
    const options = ruleOptionsSchema.parse({ detailLevel: "full", showOrigin: true });
    expect(blockContent(event, options, "From: A (Google)").body).toBe("From: A (Google)");
  });
});

describe("free plan budget", () => {
  it("spreads the rewrite of 1200 copies over alarms within 50 subrequests each", async () => {
    const many = graphSource(1200, 0).filter((event) => event.type !== "singleInstance");
    expect(many).toHaveLength(1200);
    const fake = fakeProviders({ graph: many });
    const { user } = await signIn("owner@example.com");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('budget', ?, 'microsoft', 'budget@work.example')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES ('budget-src', 'budget', 'budget-src-remote', 'Work', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES ('budget-dst', 'budget', 'budget-dst-remote', 'Blocks', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES ('budget-rule', ?, 'budget-src', 'budget-dst', ?)",
      ).bind(user.id, JSON.stringify({ daysAhead: 365 })),
    ]);
    const stub = env.ACCOUNT_SYNC.getByName("budget");
    await stub.storeTokens("budget", TOKENS, "microsoft");

    /** Run alarms until the rule has no work left; returns the subrequests of each alarm. */
    async function alarms(): Promise<{ fetches: number; d1: number; durableObjects: number }[]> {
      const counts = [];
      for (let i = 0; i < 10; i++) {
        const before = fake.urls.length;
        const d1 = countD1();
        const ran = await runDurableObjectAlarm(stub);
        counts.push({ fetches: fake.urls.length - before, ...d1.stop() });
        if (!ran) break;
      }
      return counts;
    }

    await stub.requestSync();
    await alarms();
    expect(fake.graph.get("budget-dst-remote")?.size).toBe(1200);

    await setOriginNote(env, user, "budget", { showOrigin: true, linkOrigin: true }, "en");
    const writesBefore = fake.sent.length;
    const counts = await alarms();
    const busy = counts.filter((count) => count.fetches > 0);
    // 1200 PATCHes in batches of 20 need 60 batches; at most 25 fit into one alarm.
    expect(busy.length).toBeGreaterThanOrEqual(3);
    for (const count of counts) {
      // Subrequests: provider calls and calls to other Durable Objects. D1 has its own limit.
      expect(count.fetches + count.durableObjects).toBeLessThanOrEqual(50);
      expect(count.d1).toBeLessThanOrEqual(50);
    }
    expect(fake.sent.length - writesBefore).toBe(60);
    const blocks = [...fake.graph.get("budget-dst-remote")!.values()];
    expect(
      blocks.every((block) =>
        (block.body as { content: string }).content.startsWith(
          "From: budget@work.example (Microsoft)\nhttps://",
        ),
      ),
    ).toBe(true);

    // The next cycle finds every copy unchanged.
    const sentBefore = fake.sent.length;
    await stub.requestSync();
    await alarms();
    expect(fake.sent.length).toBe(sentBefore);
  });
});

/**
 * Count D1 queries and Durable Object stubs from now until `stop()`, through the prototypes, so
 * that calls inside the Durable Object count too. A D1 batch counts as one query.
 */
function countD1() {
  const counts = { d1: 0, durableObjects: 0 };
  type Method = (this: unknown, ...args: unknown[]) => unknown;
  const spy = (target: Record<string, Method>, method: string, key: keyof typeof counts) => {
    const original = target[method];
    if (!original) throw new Error(`No method ${method}`);
    return vi.spyOn(target, method).mockImplementation(function (this: unknown, ...args) {
      counts[key]++;
      return original.apply(this, args);
    });
  };
  const statement = Object.getPrototypeOf(env.DB.prepare("SELECT 1")) as Record<string, Method>;
  const spies = [
    ...["run", "all", "first", "raw"].map((method) => spy(statement, method, "d1")),
    spy(Object.getPrototypeOf(env.DB) as Record<string, Method>, "batch", "d1"),
    spy(
      Object.getPrototypeOf(env.ACCOUNT_SYNC) as Record<string, Method>,
      "getByName",
      "durableObjects",
    ),
  ];
  return {
    stop() {
      for (const item of spies) item.mockRestore();
      return counts;
    },
  };
}
