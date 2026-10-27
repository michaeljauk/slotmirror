import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshUserCalendars } from "../src/calendars";
import { TokenError } from "../src/providers/oauth-token";
import {
  loadEditorState,
  setDirection,
  setGroupMembership,
  setSettings,
  setSourceCalendar,
} from "../src/editor";
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
/** Accounts whose main calendar changed in Graph to a new calendar; the old one stays. */
const newMainInGraph = new Set<string>();

beforeEach(() => {
  readOnlyInGraph.clear();
  newMainInGraph.clear();
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
            isDefaultCalendar: !newMainInGraph.has(account),
            owner: { address: `${account}@owner.example` },
          },
          ...(newMainInGraph.has(account)
            ? [
                {
                  id: `${account}-new-remote`,
                  name: "New main",
                  canEdit: true,
                  isDefaultCalendar: true,
                  owner: { address: `${account}@owner.example` },
                },
              ]
            : []),
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

async function auditCount(userId: string, kind: string) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND kind = ?",
  )
    .bind(userId, kind)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A second calendar of an account, not a source yet. */
async function addCalendar(accountId: string, name: string) {
  const id = `${accountId}-${name}`;
  await env.DB.prepare(
    "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, ?, 1, 0, 0)",
  )
    .bind(id, accountId, `${id}-remote`, name)
    .run();
  return id;
}

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

describe("exceptions and calendar changes", () => {
  it("keep an explicit off when the only source calendar is turned off and on again", async () => {
    const { user, ids } = await setup("ex-off", ["a", "b", "c"]);
    const [a, b, c] = ids as [string, string, string];
    for (const id of ids) await setGroupMembership(env, user, id, true);
    await setDirection(env, user, a, b, "off");

    await setSourceCalendar(env, user, `${a}-cal`, false);
    // The kept exception writes nothing and does not show as a separate rule, also after the
    // settings rewrote the options of every rule.
    expect((await loadEditorState(env, user.id)).others).toEqual([]);
    await setSettings(env, user, {
      skipAllDay: true,
      skipTentative: false,
      markPrivate: true,
      blockTitle: "Busy",
      skipCategories: [],
    });
    expect((await loadEditorState(env, user.id)).others).toEqual([]);
    await setSourceCalendar(env, user, `${a}-cal`, true);
    const marked = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM rules WHERE user_id = ? AND json_extract(options, '$.parked') = 1",
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(marked?.n).toBe(0);
    const rules = await rulesOf(user.id);
    expect(rules.find((r) => r.source === a && r.target === b)).toMatchObject({
      enabled: 0,
      origin: "custom",
    });
    expect(rules.find((r) => r.source === a && r.target === c)).toEqual(groupBusy(a, c));
  });

  it("give a kept off way to the choice another source calendar got meanwhile", async () => {
    const { user, ids } = await setup("ex-multi", ["a", "b"]);
    const [a, b] = ids as [string, string];
    const extra = await addCalendar(a, "extra");
    await setSourceCalendar(env, user, extra, true);
    for (const id of ids) await setGroupMembership(env, user, id, true);
    await setDirection(env, user, a, b, "off");
    await setSourceCalendar(env, user, `${a}-cal`, false);
    await setDirection(env, user, a, b, "title");

    await setSourceCalendar(env, user, `${a}-cal`, true);
    const toB = (await rulesOf(user.id)).filter((r) => r.source === a && r.target === b);
    expect(toB).toEqual([
      expect.objectContaining({ level: "title", enabled: 1, origin: "custom" }),
      expect.objectContaining({ level: "title", enabled: 1, origin: "custom" }),
    ]);
  });

  it("let a later choice replace a kept off, also when the last source comes back", async () => {
    const { user, ids } = await setup("ex-later", ["a", "b"]);
    const [a, b] = ids as [string, string];
    const second = await addCalendar(a, "second");
    await setSourceCalendar(env, user, second, true);
    for (const id of ids) await setGroupMembership(env, user, id, true);
    await setDirection(env, user, a, b, "off");
    await setSourceCalendar(env, user, second, false);
    await setDirection(env, user, a, b, "busy");
    expect(await auditCount(user.id, "rule_deleted")).toBe(1);

    await setSourceCalendar(env, user, `${a}-cal`, false);
    await setSourceCalendar(env, user, `${a}-cal`, true);
    expect((await rulesOf(user.id)).filter((r) => r.source === a && r.target === b)).toEqual([
      groupBusy(a, b),
    ]);
  });

  it("copy a kept off to a calendar that becomes a source", async () => {
    const { user, ids } = await setup("ex-copyoff", ["a", "b"]);
    const [a, b] = ids as [string, string];
    const extra = await addCalendar(a, "extra");
    for (const id of ids) await setGroupMembership(env, user, id, true);
    await setDirection(env, user, a, b, "off");
    await setSourceCalendar(env, user, `${a}-cal`, false);

    await setSourceCalendar(env, user, extra, true);
    const toB = (await rulesOf(user.id)).filter((r) => r.source === a && r.target === b);
    expect(toB).toEqual([
      expect.objectContaining({ enabled: 0, origin: "custom" }),
      expect.objectContaining({ enabled: 0, origin: "custom" }),
    ]);

    // Back as a source, the kept rule gives way to the copy of the other source's rule.
    await setSourceCalendar(env, user, `${a}-cal`, true);
    expect(await auditCount(user.id, "rule_deleted")).toBe(1);
    const { results } = await env.DB.prepare(
      `SELECT r.enabled, json_extract(r.options, '$.parked') AS parked FROM rules r
       JOIN calendars sc ON sc.id = r.source_calendar_id WHERE sc.account_id = ?
         AND r.target_calendar_id = ?`,
    )
      .bind(a, `${b}-cal`)
      .all<{ enabled: number; parked: number | null }>();
    expect(results).toEqual([
      { enabled: 0, parked: null },
      { enabled: 0, parked: null },
    ]);
  });

  it("keep an old paused rule visible and do not treat it as a kept off", async () => {
    const { user, ids } = await setup("ex-paused", ["a", "b"]);
    const [a, b] = ids as [string, string];
    const extra = await addCalendar(a, "extra");
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin) VALUES ('ex-paused-rule', ?, ?, ?, '{}', 0, 'custom')",
    )
      .bind(user.id, extra, `${b}-cal`)
      .run();
    for (const id of ids) await setGroupMembership(env, user, id, true);

    const state = await loadEditorState(env, user.id);
    expect(state.others.map((other) => other.ruleId)).toEqual(["ex-paused-rule"]);
    expect((await rulesOf(user.id)).filter((r) => r.source === a && r.enabled === 1)).toEqual([
      groupBusy(a, b),
    ]);
  });

  it("add group rules next to a manual rule into another calendar of the target", async () => {
    const { user, ids } = await setup("ex-manual", ["a", "b"]);
    const [a, b] = ids as [string, string];
    const second = await addCalendar(b, "second");
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin) VALUES ('ex-manual-rule', ?, ?, ?, '{}', 1, 'custom')",
    )
      .bind(user.id, `${a}-cal`, second)
      .run();
    for (const id of ids) await setGroupMembership(env, user, id, true);

    const state = await loadEditorState(env, user.id);
    expect(state.directions.find((d) => d.from === a && d.to === b)).toMatchObject({
      choice: "busy",
      origin: "group",
    });
  });

  it("add no second set of rules when the main calendar of the target changes", async () => {
    const { user, ids } = await setup("ex-main", ["w", "o"]);
    const [w, o] = ids as [string, string];
    for (const id of ids) await setGroupMembership(env, user, id, true);

    newMainInGraph.add(o);
    await refreshUserCalendars(env, user.id);
    const intoO = await env.DB.prepare(
      `SELECT tc.remote_id AS remote FROM rules r JOIN calendars tc ON tc.id = r.target_calendar_id
       WHERE tc.account_id = ?`,
    )
      .bind(o)
      .all<{ remote: string }>();
    expect(intoO.results).toEqual([{ remote: `${o}-remote` }]);
    expect((await rulesOf(user.id)).filter((r) => r.source === w)).toHaveLength(1);
  });

  it("copy a custom rule outside the group once its target becomes writable", async () => {
    const { user, ids } = await setup("ex-copy", ["w", "o"]);
    const [w, o] = ids as [string, string];
    const extra = await addCalendar(w, "extra");
    await setDirection(env, user, w, o, "title");
    await makeReadOnly(o);
    await setSourceCalendar(env, user, extra, true);
    expect(await rulesOf(user.id)).toHaveLength(1);

    await refreshUserCalendars(env, user.id);
    expect(await rulesOf(user.id)).toEqual([
      expect.objectContaining({ source: w, target: o, level: "title", origin: "custom" }),
      expect.objectContaining({ source: w, target: o, level: "title", origin: "custom" }),
    ]);
  });
});

describe("joining the group", () => {
  it("does not adopt a busy rule that a concurrent request customised", async () => {
    const { user, ids } = await setup("adopt-race", ["w", "o"]);
    const [w, o] = ids as [string, string];
    await setGroupMembership(env, user, w, true);
    await setDirection(env, user, w, o, "busy");
    // Between the read of the editor state and the write batch, another tab changes its window.
    const batch = env.DB.batch.bind(env.DB);
    let calls = 0;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (++calls === 3) {
        await env.DB.prepare(
          "UPDATE rules SET options = json_set(options, '$.daysAhead', 7)",
        ).run();
      }
      return batch(statements);
    });

    await setGroupMembership(env, user, o, true);
    expect((await rulesOf(user.id)).find((r) => r.source === w)).toMatchObject({
      origin: "custom",
    });
  });
});

describe("leaving the group", () => {
  it("deletes group rules into an old main calendar too", async () => {
    const { user, ids } = await setup("leave-old", ["w", "o"]);
    const [w, o] = ids as [string, string];
    for (const id of ids) await setGroupMembership(env, user, id, true);
    newMainInGraph.add(o);
    await refreshUserCalendars(env, user.id);
    expect((await rulesOf(user.id)).some((r) => r.source === w && r.target === o)).toBe(true);

    await setGroupMembership(env, user, w, false);
    expect((await rulesOf(user.id)).filter((r) => r.origin === "group")).toEqual([]);
  });

  it("cleans up group rules left over while the account is out of the group", async () => {
    const { user, ids } = await setup("leave-retry", ["w", "o"]);
    const [w] = ids as [string, string];
    for (const id of ids) await setGroupMembership(env, user, id, true);
    await env.DB.prepare("UPDATE accounts SET in_block_group = 0 WHERE id = ?").bind(w).run();

    await setGroupMembership(env, user, w, false);
    expect(await rulesOf(user.id)).toEqual([]);
  });

  it("logs each deleted rule once when the same account leaves twice at the same time", async () => {
    const { user, ids } = await setup("leave-race", ["w", "o"]);
    const [w] = ids as [string, string];
    for (const id of ids) await setGroupMembership(env, user, id, true);

    await Promise.all([
      setGroupMembership(env, user, w, false),
      setGroupMembership(env, user, w, false),
    ]);
    expect(await rulesOf(user.id)).toEqual([]);
    expect(await auditCount(user.id, "rule_deleted")).toBe(2);
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
    // The losing request inserted nothing, so it logs nothing.
    expect(await auditCount(user.id, "rule_created")).toBe(2);
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
  it("log no message of errors that can quote input or name the user", async () => {
    const { cookie } = await setup("err-quiet", ["w", "o"]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const error of [
      new SyntaxError("Unexpected token in 'Dentist with Alice'"),
      new TokenError("invalid_grant", "AADSTS70000 for alice@work.example"),
      // A TokenError after the Durable Object boundary: a plain Error with the own `code`.
      Object.assign(new Error("invalid_grant: AADSTS50173 for user alice@work.example"), {
        code: "invalid_grant",
      }),
      new Error("Failed for alice@work.example"),
    ]) {
      vi.spyOn(env.DB, "prepare").mockImplementation(() => {
        throw error;
      });
      const response = await exports.default.fetch(`${BASE}/rules`, { headers: { cookie } });
      expect(response.status).toBe(500);
    }
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain("Dentist");
    expect(logged).not.toContain("alice@");
    expect(logged).toContain("SyntaxError");
    expect(logged).toContain("invalid_grant");
  });

  it("show a localized error page, and a short text to the editor script", async () => {
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
    // A D1 message is logged: it holds no bound values. The stack is only its frames.
    expect(errors).toHaveBeenCalledWith(
      "Request failed",
      "Error",
      "D1_ERROR: database is locked",
      expect.stringMatching(/^\s*at /),
    );

    const fragment = await exports.default.fetch(`${BASE}/rules/direction/check?lang=de`, {
      method: "POST",
      headers: { cookie, "x-fragment": "1" },
    });
    expect(fragment.status).toBe(500);
    expect(await fragment.text()).toBe(
      "Die Anfrage ist fehlgeschlagen. Bitte gleich noch einmal versuchen.",
    );
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
