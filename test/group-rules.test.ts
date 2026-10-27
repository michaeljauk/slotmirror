import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshUserCalendars } from "../src/calendars";
import { setDirection, setGroupMembership, setSourceCalendar } from "../src/editor";
import { BASE, signIn } from "./helpers";

interface Options {
  /** Accounts without a calendar row, as before the first calendar load. */
  withoutCalendars?: string[];
}

/**
 * A user with Microsoft accounts, each with one writable main calendar that is a source. Every
 * account has its own access token, so that the Graph mock can tell the accounts apart.
 */
async function setup(prefix: string, names: string[], options: Options = {}) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const ids: string[] = [];
  for (const name of names) {
    const id = `${prefix}-${name}`;
    ids.push(id);
    await env.DB.prepare("INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)")
      .bind(id, user.id, "microsoft", `${id}@${name}.example`)
      .run();
    if (!options.withoutCalendars?.includes(name)) {
      await env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      )
        .bind(`${id}-cal`, id, `${id}-remote`)
        .run();
    }
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(
      id,
      { refreshToken: "r", accessToken: id, accessExpiresAt: Date.now() + 3_600_000 },
      "microsoft",
    );
  }
  return { user, cookie, ids };
}

async function rulesOf(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT sc.account_id AS source, tc.account_id AS target, r.enabled, r.origin,
            json_extract(r.options, '$.detailLevel') AS level
     FROM rules r JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ? ORDER BY source, target`,
  )
    .bind(userId)
    .all<{ source: string; target: string; enabled: number; origin: string; level: string }>();
  return results;
}

async function makeReadOnly(accountId: string) {
  await env.DB.prepare("UPDATE calendars SET can_edit = 0 WHERE account_id = ?")
    .bind(accountId)
    .run();
}

/** Accounts whose main calendar Graph reports as read-only. */
const readOnlyInGraph = new Set<string>();

beforeEach(() => {
  readOnlyInGraph.clear();
  // Graph answers per account, identified by its access token. Removals read empty calendars.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = request.url;
    const account = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (url.includes("/me/calendars?")) {
      return Response.json({
        value: [
          {
            id: `${account}-remote`,
            name: "Main",
            canEdit: !readOnlyInGraph.has(account),
            isDefaultCalendar: true,
            owner: { address: `${account}@owner.example` },
          },
        ],
      });
    }
    if (url.includes("/me?")) return Response.json({ mail: `${account}@owner.example` });
    if (url.includes("calendarView")) return Response.json({ value: [] });
    return new Response("unexpected", { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const groupBusy = (source: string, target: string) =>
  expect.objectContaining({ source, target, level: "busy", enabled: 1, origin: "group" });

describe("group rules", () => {
  it("come back when the only source calendar is turned off and on again", async () => {
    const { user, ids } = await setup("gr-src", ["w", "o"]);
    const [w, o] = ids as [string, string];
    for (const id of ids) await setGroupMembership(env, user, id, true);

    await setSourceCalendar(env, user, `${w}-cal`, false);
    expect(await rulesOf(user.id)).toEqual([groupBusy(o, w)]);

    await setSourceCalendar(env, user, `${w}-cal`, true);
    expect(await rulesOf(user.id)).toEqual([groupBusy(o, w), groupBusy(w, o)]);
  });

  it("are created when the calendars of an account load after it joined", async () => {
    const { user, ids } = await setup("gr-load", ["w", "o"], { withoutCalendars: ["w"] });
    const [w, o] = ids as [string, string];
    for (const id of ids) await setGroupMembership(env, user, id, true);
    expect(await rulesOf(user.id)).toEqual([]);

    await refreshUserCalendars(env, user.id);
    expect(await rulesOf(user.id)).toEqual([groupBusy(o, w), groupBusy(w, o)]);
  });

  it("are created when a read-only target becomes writable, and keep the exceptions", async () => {
    const { user, ids } = await setup("gr-ro", ["w", "o", "g"]);
    const [w, o, g] = ids as [string, string, string];
    await makeReadOnly(o);
    for (const id of ids) await setGroupMembership(env, user, id, true);
    await setDirection(env, user, w, g, "off");
    await setDirection(env, user, g, w, "full");
    expect((await rulesOf(user.id)).some((rule) => rule.target === o)).toBe(false);

    // Graph still reports the calendar as read-only: nothing writes into it.
    readOnlyInGraph.add(o);
    await refreshUserCalendars(env, user.id);
    expect((await rulesOf(user.id)).some((rule) => rule.target === o)).toBe(false);

    readOnlyInGraph.clear();
    await refreshUserCalendars(env, user.id);
    expect(await rulesOf(user.id)).toEqual([
      groupBusy(g, o),
      expect.objectContaining({ source: g, target: w, level: "full", origin: "custom" }),
      groupBusy(o, g),
      groupBusy(o, w),
      expect.objectContaining({ source: w, target: g, enabled: 0, origin: "custom" }),
      groupBusy(w, o),
    ]);
  });

  it("are not added again by a second refresh", async () => {
    const { user, ids } = await setup("gr-idem", ["w", "o"]);
    for (const id of ids) await setGroupMembership(env, user, id, true);
    const before = await rulesOf(user.id);
    const audits = async () =>
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND kind = 'rule_created'",
        )
          .bind(user.id)
          .first<{ n: number }>()
      )?.n;
    const created = await audits();

    await refreshUserCalendars(env, user.id);
    await refreshUserCalendars(env, user.id);
    expect(await rulesOf(user.id)).toEqual(before);
    expect(await audits()).toBe(created);
  });
});

describe("concurrent requests", () => {
  it("both finish when two accounts join the group at the same time", async () => {
    const { user, ids } = await setup("race-grp", ["w", "o"]);
    const [w, o] = ids as [string, string];
    const results = await Promise.allSettled(
      ids.map((id) => setGroupMembership(env, user, id, true)),
    );
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await rulesOf(user.id)).toEqual([groupBusy(o, w), groupBusy(w, o)]);
  });

  it("both finish when the same direction is saved twice at the same time", async () => {
    const { user, ids } = await setup("race-dir", ["w", "o"]);
    const [w, o] = ids as [string, string];
    const results = await Promise.allSettled([
      setDirection(env, user, w, o, "title"),
      setDirection(env, user, w, o, "title"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await rulesOf(user.id)).toEqual([
      expect.objectContaining({ source: w, target: o, level: "title", enabled: 1 }),
    ]);
  });
});

describe("unexpected errors", () => {
  it("show a localized error page and log only the error code", async () => {
    const { cookie } = await setup("err", ["w", "o"]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("D1_ERROR: database is locked");
    });

    const response = await exports.default.fetch(`${BASE}/rules?lang=de`, {
      headers: { cookie },
    });
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Etwas ist schiefgelaufen");
    expect(errors).toHaveBeenCalledWith("Request failed", "D1_ERROR: database is locked");
  });
});

/**
 * Counts what a request costs on the Free plan. A D1 batch counts as one query against "queries
 * per Worker invocation" (developers.cloudflare.com/d1/platform/limits). Each Durable Object call
 * goes through `getByName`.
 */
function countCalls() {
  const counts = { d1: 0, durableObjects: 0 };
  type Method = (this: unknown, ...args: unknown[]) => unknown;
  const statement = Object.getPrototypeOf(env.DB.prepare("SELECT 1")) as Record<string, Method>;
  for (const method of ["run", "all", "first", "raw"]) {
    const original = statement[method];
    if (!original) throw new Error(`D1PreparedStatement has no ${method}`);
    vi.spyOn(statement, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
      counts.d1++;
      return original.apply(this, args);
    });
  }
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, "batch").mockImplementation((statements) => {
    counts.d1++;
    return batch(statements);
  });
  const getByName = env.ACCOUNT_SYNC.getByName.bind(env.ACCOUNT_SYNC);
  vi.spyOn(env.ACCOUNT_SYNC, "getByName").mockImplementation((name) => {
    counts.durableObjects++;
    return getByName(name);
  });
  return counts;
}

describe("subrequest budget", () => {
  it("keeps the quick start with five accounts well below 50 queries", async () => {
    const { user, cookie, ids } = await setup("budget", ["a", "b", "c", "d", "e"]);
    const counts = countCalls();
    const response = await exports.default.fetch(`${BASE}/rules/group/all`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie },
    });
    expect(response.status).toBe(302);
    vi.restoreAllMocks();
    expect(await rulesOf(user.id)).toHaveLength(ids.length * (ids.length - 1));
    // Session, the editor state and one batch per step; one sync request per target account.
    expect(counts.d1).toBeLessThanOrEqual(12);
    expect(counts.durableObjects).toBeLessThanOrEqual(ids.length);
  });
});
