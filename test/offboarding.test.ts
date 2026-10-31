import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSync } from "../src/account-sync";
import { CleanupNotQueued, removeAccounts, setUserActive } from "../src/offboarding";
import { BASE, EMPTY_FAKE_SEED, noFakeNetwork, signIn, stopClock } from "./helpers";

/**
 * The paths of an offboarding, through the real routes, alarms and `client()`. The simulated
 * calendars replace only Graph and Google, so `fetch` is replaced only for the token endpoint.
 */

const DAY = 86_400_000;
const CALENDAR = "main";

type Stub = DurableObjectStub<AccountSync>;

/** Methods that a test replaces and still calls, private ones too. */
type Method = (this: AccountSync, ...args: unknown[]) => Promise<unknown>;
const methods = AccountSync.prototype as unknown as Record<
  "cancelRetire" | "retire" | "ruleWritesAgain" | "runRemoval" | "stopWatches",
  Method
>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const stubs = new Set<string>();

function stubOf(accountId: string): Stub {
  stubs.add(accountId);
  return env.ACCOUNT_SYNC.getByName(accountId);
}

beforeEach(() => {
  stopClock();
  noFakeNetwork();
});

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

function at(days: number, hour: number): string {
  return new Date(Math.floor(Date.now() / DAY) * DAY + days * DAY + hour * 3_600_000).toISOString();
}

/** A simulated account with one calendar. */
async function addAccount(userId: string, id: string): Promise<Stub> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(id, userId, `${id}@example.com`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, ?, 'Cal')",
    ).bind(`${id}-main`, id, CALENDAR),
  ]);
  const stub = stubOf(id);
  await stub.storeTokens(id, {
    refreshToken: "fake",
    accessToken: "fake",
    accessExpiresAt: Date.now() + 365 * DAY,
  });
  await stub.seedFake(EMPTY_FAKE_SEED, 0);
  return stub;
}

async function addRule(userId: string, ruleId: string, sourceId: string, targetId: string) {
  await env.DB.prepare(
    `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(ruleId, userId, `${sourceId}-main`, `${targetId}-main`, '{"daysAhead":30}')
    .run();
}

/** Two simulated accounts and a rule from the first into the second, with one block written. */
async function setup(name: string, email = "owner@example.com") {
  const { user, cookie } = await signIn(email);
  const sourceId = `${name}-a`;
  const targetId = `${name}-b`;
  const ruleId = `${name}-rule`;
  const source = await addAccount(user.id, sourceId);
  const target = await addAccount(user.id, targetId);
  await addRule(user.id, ruleId, sourceId, targetId);
  await source.addFakeEvent({ id: "meeting", start: at(3, 10), end: at(3, 11) });
  await target.runRule(ruleId);
  expect(await blocksIn(target)).toBe(1);
  return { user, cookie, source, target, sourceId, targetId, ruleId };
}

function blocksIn(stub: Stub): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => {
    const [row] = state.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM fake_blocks")
      .toArray();
    return row?.n ?? 0;
  });
}

function post(path: string, cookie: string) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
}

function removalsOf(stub: Stub) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<{ ruleId: string; attempts: number; notBefore?: number }[]>("removalQueue"),
  );
}

function alarmAt(stub: Stub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function eventsOf(accountId: string, kind: string) {
  const { results } = await env.DB.prepare(
    "SELECT user_id, account_id, rule_id, detail FROM audit_events WHERE account_id = ? AND kind = ? ORDER BY id",
  )
    .bind(accountId, kind)
    .all<{ user_id: string; account_id: string; rule_id: string | null; detail: string }>();
  return results.map((row) => ({ ...row, detail: JSON.parse(row.detail) as object }));
}

async function ruleEnabled(ruleId: string): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT enabled FROM rules WHERE id = ?")
    .bind(ruleId)
    .first<{ enabled: number }>();
  return row?.enabled;
}

async function rowExists(table: "accounts" | "rules" | "users", id: string): Promise<boolean> {
  return (await env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first()) !== null;
}

function retiringFlag(stub: Stub): Promise<boolean | string | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<boolean | string>("retiring"),
  );
}

function cycleOwed(stub: Stub): Promise<boolean | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<boolean>("fullCycleRequested"),
  );
}

function retirementCheck(stub: Stub): Promise<{ id: string; endedAt: number } | undefined> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get("retirementCheck"));
}

/** Let the stopped clock run. */
function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** The object itself, for a call during its own D1 read. */
function objectOf(stub: Stub): Promise<AccountSync> {
  return runInDurableObject(stub, (instance) => instance as unknown as AccountSync);
}

async function needsReconnect(accountId: string): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT needs_reconnect AS flag FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ flag: number }>();
  return row?.flag;
}

/** Pause the account, as after a refused token. */
function pause(stub: Stub) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.put("needsReconnect", {
      code: "invalid_grant",
      since: Date.now(),
      flagPending: false,
      alertPending: false,
      probeAt: Date.now() + DAY,
    }),
  );
}

/** Give the account an expired access token and pause it, as after a refused refresh. */
async function pauseWithExpiredToken(stub: Stub, accountId: string): Promise<void> {
  await stub.storeTokens(accountId, {
    refreshToken: "fake",
    accessToken: "fake",
    accessExpiresAt: 0,
  });
  await pause(stub);
}

/** Answer every token request. Fails a test that reaches another address. */
function tokenEndpoint(answer: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/oauth2/v2.0/token")) return answer();
    throw new Error("unexpected request");
  });
}

/** A feed that shows one calendar. */
async function addFeed(userId: string, feedId: string, calendarId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO feeds (id, user_id, token_hash, uid_salt) VALUES (?, ?, ?, ?)",
    ).bind(feedId, userId, `hash-${feedId}`, `salt-${feedId}`),
    env.DB.prepare("INSERT INTO feed_calendars (feed_id, calendar_id) VALUES (?, ?)").bind(
      feedId,
      calendarId,
    ),
  ]);
}

async function feedExists(feedId: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM feeds WHERE id = ?").bind(feedId).first()) !== null;
}

async function userEvents(userId: string, kind: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND kind = ?",
  )
    .bind(userId, kind)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function patchActive(userId: string, value: boolean) {
  return exports.default.fetch(`${BASE}/scim/v2/Users/${userId}`, {
    method: "PATCH",
    headers: {
      authorization: "Bearer test-scim-token",
      "content-type": "application/scim+json",
    },
    body: JSON.stringify({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value }],
    }),
  });
}

/** Run the alarms of a waiting removal up to its end. */
async function runAttempts(stub: Stub, attempts: number): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) await runDurableObjectAlarm(stub);
}

/** `env` with a hook that runs while a request stands between queueing and deleting the rows. */
function envWithHook(beforeRowDelete: () => Promise<void>): Env {
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.startsWith("DELETE FROM accounts")) return statement;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                run: async () => {
                  await beforeRowDelete();
                  return bound.run();
                },
              };
            },
          };
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? (value.bind(target) as unknown) : value;
    },
  });
  return new Proxy(env, {
    get: (target, property) => (property === "DB" ? db : Reflect.get(target, property)),
  });
}

/** `base` with a D1 that refuses the queries that `refuses` picks. */
function envWithRefusal(refuses: (query: string) => boolean, base: Env = env): Env {
  const db = new Proxy(base.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          if (refuses(query)) throw new Error("D1_ERROR: refused");
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? (value.bind(target) as unknown) : value;
    },
  });
  return new Proxy(base, {
    get: (target, property) => (property === "DB" ? db : Reflect.get(target, property)),
  });
}

/** `base` with a D1 that calls `after` once a query's answer is there, before the caller gets it. */
function envWithRead(base: Env, start: string, after: () => Promise<void> | undefined): Env {
  const db = new Proxy(base.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.startsWith(start)) return statement;
          return {
            bind: (...values: unknown[]) => ({
              first: async () => {
                const answer: unknown = await statement.bind(...values).first();
                await after();
                return answer;
              },
            }),
          };
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? (value.bind(target) as unknown) : value;
    },
  });
  return new Proxy(base, {
    get: (target, property) => (property === "DB" ? db : Reflect.get(target, property)),
  });
}

/** Give the Durable Object another `env`. A request's `env` does not reach the object. */
function changeObjectEnv(stub: Stub, change: (base: Env) => Env): Promise<void> {
  return runInDurableObject(stub, (instance) => {
    const object = instance as unknown as { env: Env };
    object.env = change(object.env);
  });
}

/** `retire()` stores its state, and then the answer gets lost. */
function retireStoresAndFails() {
  const original = methods.retire;
  vi.spyOn(console, "error").mockImplementation(() => {});
  return vi.spyOn(methods, "retire").mockImplementationOnce(async function (
    this: AccountSync,
    ...args: unknown[]
  ) {
    await original.apply(this, args);
    throw new Error("Network connection lost.");
  });
}

/** A token endpoint that accepts the stored refresh token, as a tick's probe needs it. */
function tokenWorks() {
  return tokenEndpoint(() =>
    Response.json({ access_token: "fake", refresh_token: "fake", expires_in: 3600 }),
  );
}

describe("disconnecting the account that holds the blocks", () => {
  it("removes the blocks, stores the result, and only then forgets the tokens", async () => {
    const { cookie, target, targetId, ruleId, user } = await setup("same");

    expect((await post(`/accounts/${targetId}/disconnect`, cookie)).status).toBe(302);
    expect(await target.hasTokens()).toBe(true);
    await runDurableObjectAlarm(target);

    expect(await blocksIn(target)).toBe(0);
    expect(await target.hasTokens()).toBe(true);
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([
      {
        user_id: user.id,
        account_id: targetId,
        rule_id: ruleId,
        detail: { result: "removed", removed: 1 },
      },
    ]);
    await runDurableObjectAlarm(target);
    expect(await target.hasTokens()).toBe(false);
  });

  it("records no promise in the event of the request", async () => {
    const { cookie, targetId } = await setup("same-audit");
    await post(`/accounts/${targetId}/disconnect`, cookie);
    expect((await eventsOf(targetId, "account_disconnected"))[0]?.detail).toEqual({ rules: 1 });
  });
});

describe("disconnecting the account that the blocks come from", () => {
  it("removes the blocks in the other account, which stays", async () => {
    const { cookie, source, target, sourceId, targetId, ruleId, user } = await setup("other");

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(302);
    await runDurableObjectAlarm(target);
    await runDurableObjectAlarm(source);

    expect(await blocksIn(target)).toBe(0);
    expect(await source.hasTokens()).toBe(false);
    expect(await target.hasTokens()).toBe(true);
    expect(await rowExists("accounts", targetId)).toBe(true);
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([
      {
        user_id: user.id,
        account_id: targetId,
        rule_id: ruleId,
        detail: { result: "removed", removed: 1 },
      },
    ]);
  });

  it("finishes after a reconnect of the paused other account", async () => {
    const { cookie, target, sourceId, targetId } = await setup("other-paused");
    await pause(target);

    await post(`/accounts/${sourceId}/disconnect`, cookie);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(1);
    expect(await removalsOf(target)).toHaveLength(1);
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([]);

    await target.storeTokens(targetId, {
      refreshToken: "fake",
      accessToken: "fake",
      accessExpiresAt: Date.now() + DAY,
    });
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
  });
});

describe("a refused token", () => {
  it("keeps trying, stores the result, and forgets the tokens after the last attempt", async () => {
    const { cookie, target, targetId, ruleId } = await setup("refused");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "token", count: 5 });

    await post(`/accounts/${targetId}/disconnect`, cookie);
    await runDurableObjectAlarm(target);
    const [job] = (await removalsOf(target)) ?? [];
    expect(job).toMatchObject({ ruleId, attempts: 1 });
    expect(Math.round(((job?.notBefore ?? 0) - Date.now()) / 60_000)).toBe(1);
    expect(await alarmAt(target)).toBe(job?.notBefore);
    expect(await target.hasTokens()).toBe(true);
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([]);

    await runAttempts(target, 4);
    expect(await removalsOf(target)).toBeUndefined();
    expect(await target.hasTokens()).toBe(true);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "token_refused",
      removed: 0,
    });

    await runDurableObjectAlarm(target);
    expect(await target.hasTokens()).toBe(false);
  });

  it("removes the blocks if the refusal ends before the last attempt", async () => {
    const { cookie, target, targetId } = await setup("refused-short");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "token", count: 2 });

    await post(`/accounts/${targetId}/disconnect`, cookie);
    await runAttempts(target, 3);

    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
  });

  it("does not forget an account that was paused before the disconnect", async () => {
    const { cookie, target, targetId } = await setup("refused-paused");
    vi.spyOn(console, "error").mockImplementation(() => {});
    tokenEndpoint(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await pauseWithExpiredToken(target, targetId);
    await post(`/accounts/${targetId}/disconnect`, cookie);

    await runDurableObjectAlarm(target);
    expect(await target.hasTokens()).toBe(true);
    expect((await removalsOf(target))?.[0]?.attempts).toBe(1);
    // The alarm of a paused account stops, but a retiring account still owes its attempts.
    expect(await alarmAt(target)).toBe((await removalsOf(target))?.[0]?.notBefore);
  });

  it("removes the blocks if the token of a paused account works again", async () => {
    const { cookie, target, targetId } = await setup("refused-recovers");
    const tokens = tokenEndpoint(() =>
      Response.json({ access_token: "fake", refresh_token: "fake", expires_in: 3600 }),
    );
    await pauseWithExpiredToken(target, targetId);

    await post(`/accounts/${targetId}/disconnect`, cookie);
    await runDurableObjectAlarm(target);

    expect(tokens).toHaveBeenCalledOnce();
    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
    await runDurableObjectAlarm(target);
    expect(await target.hasTokens()).toBe(false);
  });
});

describe("a provider that keeps failing", () => {
  it("reports an incomplete removal after the last attempt", async () => {
    const { cookie, target, targetId } = await setup("failing");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "server", count: 5 });

    await post(`/accounts/${targetId}/disconnect`, cookie);
    await runAttempts(target, 5);

    expect(await removalsOf(target)).toBeUndefined();
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "incomplete",
      removed: 0,
    });
  });
});

describe("a throttled removal", () => {
  it("waits through the alarm, uses up no attempt, and keeps the tokens", async () => {
    const { cookie, target, targetId, ruleId } = await setup("throttled");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "throttled" });

    await post(`/accounts/${targetId}/disconnect`, cookie);
    await runDurableObjectAlarm(target);
    expect((await removalsOf(target))?.[0]).toMatchObject({ ruleId, attempts: 0 });
    expect(await alarmAt(target)).toBe(Date.now() + 2_000);
    expect(await blocksIn(target)).toBe(1);
    expect(await target.hasTokens()).toBe(true);
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([]);

    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
    await runDurableObjectAlarm(target);
    expect(await target.hasTokens()).toBe(false);
  });
});

describe("a removal that cannot be queued", () => {
  function queueingFails() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    return vi
      .spyOn(AccountSync.prototype, "queueRemovals")
      .mockRejectedValueOnce(new Error("Network connection lost."));
  }

  it("keeps the account, its rule and its tokens, so that the user can try again", async () => {
    const { cookie, source, target, sourceId, targetId, ruleId } = await setup("no-queue");
    queueingFails();

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);

    expect(await rowExists("accounts", sourceId)).toBe(true);
    expect(await rowExists("rules", ruleId)).toBe(true);
    expect(await ruleEnabled(ruleId)).toBe(1);
    expect(await eventsOf(sourceId, "account_disconnected")).toEqual([]);
    expect((await eventsOf(sourceId, "account_disconnect_failed"))[0]?.detail).toEqual({
      rules: 1,
      cleanupFailed: 1,
    });
    const retiring = runInDurableObject(source, (_instance, state) =>
      state.storage.get("retiring"),
    );
    expect(await retiring).toBeUndefined();

    // The retry goes the normal way.
    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(302);
    expect(await rowExists("accounts", sourceId)).toBe(false);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
  });

  it("keeps a rule off whose account retires from an earlier request", async () => {
    const { cookie, source, sourceId, ruleId } = await setup("no-queue-retiring");
    await source.retire("earlier");
    queueingFails();

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await retiringFlag(source)).toBe("earlier");
  });

  it("keeps a rule off if no answer tells whether its account retires", async () => {
    const { cookie, sourceId, ruleId } = await setup("no-queue-unknown");
    vi.spyOn(AccountSync.prototype, "retiring").mockRejectedValueOnce(new Error("lost"));
    queueingFails();

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);

    expect(await ruleEnabled(ruleId)).toBe(0);
  });

  it("counts every rule of a target account that fails", async () => {
    const { user, cookie, sourceId, targetId } = await setup("no-queue-count");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, 'second', 'Second')",
    )
      .bind(`${sourceId}-second`, sourceId)
      .run();
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
       VALUES ('no-queue-count-2', ?, ?, ?, '{"daysAhead":30}')`,
    )
      .bind(user.id, `${sourceId}-second`, `${targetId}-main`)
      .run();
    const spy = queueingFails();

    await post(`/accounts/${sourceId}/disconnect`, cookie);

    expect(spy).toHaveBeenCalledOnce();
    expect((await eventsOf(sourceId, "account_disconnect_failed"))[0]?.detail).toEqual({
      rules: 2,
      cleanupFailed: 2,
    });
  });

  it("keeps a paused rule paused", async () => {
    const { cookie, sourceId, ruleId } = await setup("no-queue-paused");
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    queueingFails();
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    expect(await ruleEnabled(ruleId)).toBe(0);
  });

  it("leaves the blocks of another rule if its removal was queued in the failed request", async () => {
    const { user, cookie, sourceId, ruleId } = await setup("no-queue-part");
    const thirdId = "no-queue-part-c";
    const secondRule = "no-queue-part-rule-2";
    const third = await addAccount(user.id, thirdId);
    await addRule(user.id, secondRule, sourceId, thirdId);
    await third.runRule(secondRule);
    // The first target account fails; the second one gets its job.
    queueingFails();

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);
    expect(await removalsOf(third)).toHaveLength(1);
    await runDurableObjectAlarm(third);

    expect(await removalsOf(third)).toBeUndefined();
    expect(await blocksIn(third)).toBe(1);
    expect(await ruleEnabled(ruleId)).toBe(1);
    expect(await ruleEnabled(secondRule)).toBe(1);
    expect(await eventsOf(thirdId, "cleanup_finished")).toEqual([]);
  });

  it("keeps a user whose removal cannot be queued", async () => {
    const { cookie, user, sourceId } = await setup("no-queue-user");
    queueingFails();

    const response = await post("/account/delete", cookie);

    expect(response.status).toBe(500);
    expect(await rowExists("users", user.id)).toBe(true);
    expect(await rowExists("accounts", sourceId)).toBe(true);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=0");
  });

  it("tells a SCIM client to try again", async () => {
    const { user } = await setup("no-queue-scim");
    queueingFails();

    const response = await exports.default.fetch(`${BASE}/scim/v2/Users/${user.id}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-scim-token" },
    });

    expect(response.status).toBe(500);
    expect(await rowExists("users", user.id)).toBe(true);
  });
});

describe("a retirement that fails after the queueing", () => {
  function retireFails() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    return vi
      .spyOn(AccountSync.prototype, "retire")
      .mockRejectedValueOnce(new Error("Network connection lost."));
  }

  it("runs the rules again and keeps the blocks, so that the user can try again", async () => {
    const { cookie, source, target, sourceId, targetId, ruleId } = await setup("no-retire");
    retireFails();

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);

    expect(await rowExists("accounts", sourceId)).toBe(true);
    expect(await ruleEnabled(ruleId)).toBe(1);
    expect(await eventsOf(sourceId, "account_disconnected")).toEqual([]);
    expect((await eventsOf(sourceId, "account_disconnect_failed"))[0]?.detail).toEqual({
      rules: 1,
      retireFailed: true,
    });
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(1);
    expect(await source.hasTokens()).toBe(true);

    // The retry goes the normal way.
    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(302);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
  });

  it("reports only the accounts that stay and deletes a feed that lost its calendars", async () => {
    const { user, sourceId, targetId } = await setup("no-retire-two");
    const thirdId = "no-retire-two-c";
    const keptRule = "no-retire-two-kept";
    await addAccount(user.id, thirdId);
    await addRule(user.id, keptRule, targetId, thirdId);
    await addFeed(user.id, "no-retire-two-feed", `${sourceId}-main`);
    const original = methods.retire;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(methods, "retire")
      .mockImplementationOnce(function (this: AccountSync, ...args: unknown[]) {
        return original.apply(this, args);
      })
      .mockRejectedValueOnce(new Error("Network connection lost."));

    await expect(removeAccounts(env, user, [sourceId, targetId])).rejects.toThrow(
      "Network connection lost.",
    );

    expect(await rowExists("accounts", sourceId)).toBe(false);
    expect(await rowExists("accounts", targetId)).toBe(true);
    expect(await eventsOf(sourceId, "account_disconnected")).toHaveLength(1);
    expect(await eventsOf(sourceId, "account_disconnect_failed")).toEqual([]);
    expect(await eventsOf(targetId, "account_disconnected")).toEqual([]);
    expect(await eventsOf(targetId, "account_disconnect_failed")).toHaveLength(1);
    expect(await ruleEnabled(keptRule)).toBe(1);
    expect(await feedExists("no-retire-two-feed")).toBe(false);
  });
});

describe("a retirement that was stored before its answer got lost", () => {
  it("ends the retirement, keeps the tokens, and the retry goes the normal way", async () => {
    const { cookie, source, target, sourceId, targetId, ruleId } = await setup("lost");
    retireStoresAndFails();

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);

    expect(await retiringFlag(source)).toBeUndefined();
    expect(await ruleEnabled(ruleId)).toBe(1);
    expect((await eventsOf(sourceId, "account_disconnect_failed"))[0]?.detail).toEqual({
      rules: 1,
      retireFailed: true,
    });
    await runDurableObjectAlarm(source);
    await runDurableObjectAlarm(target);
    expect(await source.hasTokens()).toBe(true);
    expect(await blocksIn(target)).toBe(1);
    expect(await needsReconnect(sourceId)).toBe(0);

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(302);
    await runDurableObjectAlarm(target);
    // The full cycle started new watches: one alarm stops them, the next forgets the tokens.
    await runAttempts(source, 2);
    expect(await blocksIn(target)).toBe(0);
    expect(await source.hasTokens()).toBe(false);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
  });

  it("keeps the blocks of the account that was to go", async () => {
    const { cookie, target, targetId, ruleId } = await setup("lost-target");
    retireStoresAndFails();

    expect((await post(`/accounts/${targetId}/disconnect`, cookie)).status).toBe(500);
    await runDurableObjectAlarm(target);
    await runDurableObjectAlarm(target);

    expect(await target.hasTokens()).toBe(true);
    expect(await blocksIn(target)).toBe(1);
    expect(await ruleEnabled(ruleId)).toBe(1);
    expect(await removalsOf(target)).toBeUndefined();
  });

  it("keeps the rules off if the cancel fails too, and the account shows up", async () => {
    const { cookie, source, target, sourceId, ruleId } = await setup("lost-twice");
    retireStoresAndFails();
    vi.spyOn(methods, "cancelRetire").mockRejectedValueOnce(new Error("Network connection lost."));

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await eventsOf(sourceId, "account_disconnect_failed")).toHaveLength(1);
    await runDurableObjectAlarm(target);
    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(false);
    expect(await needsReconnect(sourceId)).toBe(1);

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(302);
    expect(await rowExists("accounts", sourceId)).toBe(false);
  });

  it("keeps the rules off if nothing was stored and the cancel fails", async () => {
    const { cookie, source, sourceId, ruleId } = await setup("lost-nothing");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(methods, "retire").mockRejectedValueOnce(new Error("Network connection lost."));
    vi.spyOn(methods, "cancelRetire").mockRejectedValueOnce(new Error("Network connection lost."));

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await source.hasTokens()).toBe(true);
    expect(await eventsOf(sourceId, "account_disconnect_failed")).toHaveLength(1);
    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(302);
    expect(await rowExists("accounts", sourceId)).toBe(false);
  });

  it("shows the account as needing a reconnect if the tokens went before the cancel", async () => {
    const { cookie, source, sourceId, ruleId } = await setup("lost-late");
    const cancel = methods.cancelRetire;
    retireStoresAndFails();
    vi.spyOn(methods, "cancelRetire").mockImplementationOnce(async function (
      this: AccountSync,
      ...args: unknown[]
    ) {
      await this.alarm();
      await cancel.apply(this, args);
    });

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);

    expect(await source.hasTokens()).toBe(false);
    expect(await rowExists("accounts", sourceId)).toBe(true);
    expect(await needsReconnect(sourceId)).toBe(1);
    expect(await ruleEnabled(ruleId)).toBe(1);
  });

  it("does not forget the tokens if a cancel arrives while the watches stop", async () => {
    const { source, sourceId } = await setup("lost-watches");
    await source.retire("request");
    vi.spyOn(methods, "stopWatches").mockImplementationOnce(async function (this: AccountSync) {
      await this.cancelRetire("request");
    });

    await runDurableObjectAlarm(source);

    expect(await source.hasTokens()).toBe(true);
    expect(await needsReconnect(sourceId)).toBe(1);

    tokenWorks();
    await source.tick();
    expect(await needsReconnect(sourceId)).toBe(0);
  });

  it("keeps the rules off if the object's D1 fails the cancel", async () => {
    const { cookie, source, sourceId, ruleId } = await setup("lost-select");
    retireStoresAndFails();
    await changeObjectEnv(source, (base) =>
      envWithRefusal((query) => query.startsWith("SELECT 1 AS found"), base),
    );

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await retiringFlag(source)).toBeTruthy();
  });

  it("runs the rules that do not touch an account with an unclear retirement", async () => {
    const { user, source, target, sourceId, ruleId } = await setup("lost-other");
    const thirdId = "lost-other-c";
    const thirdRule = "lost-other-third";
    await addAccount(user.id, thirdId);
    await addRule(user.id, thirdRule, thirdId, "lost-other-b");
    retireStoresAndFails();
    vi.spyOn(methods, "cancelRetire").mockRejectedValueOnce(new Error("Network connection lost."));

    await expect(removeAccounts(env, user, [sourceId, thirdId])).rejects.toThrow("lost");

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await ruleEnabled(thirdRule)).toBe(1);
    expect(await retiringFlag(source)).toBeTruthy();
    expect(await cycleOwed(target)).toBe(true);
  });
});

describe("cancelling a retirement", () => {
  it("can run twice, and does nothing on an account that does not retire", async () => {
    const { source } = await setup("cancel");
    await source.cancelRetire("request");
    expect(await cycleOwed(source)).toBeUndefined();

    await source.retire("request");
    await source.cancelRetire("request");
    await source.cancelRetire("request");

    expect(await retiringFlag(source)).toBeUndefined();
    expect(await source.hasTokens()).toBe(true);
  });

  it("owes a full cycle and allows a new try to stop the watches", async () => {
    const { source } = await setup("cancel-cycle");
    await runInDurableObject(source, (_instance, state) => state.storage.put("watchesTried", true));
    await source.retire("request");

    await source.cancelRetire("request");

    expect(await cycleOwed(source)).toBe(true);
    expect(await alarmAt(source)).not.toBeNull();
    const tried = runInDurableObject(source, (_instance, state) =>
      state.storage.get("watchesTried"),
    );
    expect(await tried).toBeUndefined();
  });

  it("leaves an account whose row is gone to its retirement", async () => {
    const { user, source, sourceId } = await setup("cancel-gone");
    await source.retire("request");
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(sourceId).run();

    await source.cancelRetire("request");

    expect(await retiringFlag(source)).toBe("request");
    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(false);
    expect(await rowExists("users", user.id)).toBe(true);
  });
});

describe("a cancel of an older request", () => {
  it("does not end the retirement of a newer request", async () => {
    const { source, sourceId } = await setup("generation");
    await source.retire("older");
    await source.retire("newer");

    await source.cancelRetire("older");
    expect(await retiringFlag(source)).toBe("newer");

    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(sourceId).run();
    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(false);
  });

  it("does not end a retirement that started during its D1 read", async () => {
    const { source, sourceId } = await setup("generation-read");
    await source.retire("older");
    let self: AccountSync | undefined;
    await runInDurableObject(source, (instance) => {
      self = instance as unknown as AccountSync;
    });
    await changeObjectEnv(source, (base) =>
      envWithRead(base, "SELECT 1 AS found", () => self?.retire("newer")),
    );

    await source.cancelRetire("older");

    expect(await retiringFlag(source)).toBe("newer");
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(sourceId).run();
    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(false);
  });

  it("stays without effect once the retirement ended", async () => {
    const { source } = await setup("generation-twice");
    await source.retire("older");
    await source.cancelRetire("older");
    await source.cancelRetire("older");
    await source.retire("newer");
    await source.cancelRetire("older");
    expect(await retiringFlag(source)).toBe("newer");
  });
});

describe("a caller of a version without generations", () => {
  it("starts a retirement that has a generation of its own", async () => {
    const { source } = await setup("old-retire");

    await source.retire();
    const first = await retiringFlag(source);
    expect(first).toEqual(expect.any(String));

    await source.retire();
    const second = await retiringFlag(source);
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    await source.cancelRetire(second as string);
    expect(await retiringFlag(source)).toBeUndefined();
  });

  it("ends no retirement with a cancel", async () => {
    const { source } = await setup("old-cancel");
    await source.retire("request");

    await source.cancelRetire();

    expect(await retiringFlag(source)).toBe("request");
    expect(await retirementCheck(source)).toBeUndefined();
  });
});

describe("a retirement that ended before the row went", () => {
  it("runs to its end if a delete landed after the cancel read the row", async () => {
    const { source, sourceId } = await setup("late-delete");
    await source.retire("request");
    await source.cancelRetire("request");
    expect(await retiringFlag(source)).toBeUndefined();
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(sourceId).run();

    await runDurableObjectAlarm(source);

    expect(await source.hasTokens()).toBe(false);
  });

  it("runs to its end if a reconnect came before the delete landed", async () => {
    const { source, sourceId } = await setup("late-reconnect");
    await source.retire("request");
    await source.storeTokens(sourceId, {
      refreshToken: "fake",
      accessToken: "fake",
      accessExpiresAt: Date.now() + DAY,
    });
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(sourceId).run();

    await runDurableObjectAlarm(source);

    expect(await source.hasTokens()).toBe(false);
  });

  it("stays ended if the row stays, and stops checking after the wait", async () => {
    const { source } = await setup("late-row");
    await source.retire("request");
    await source.cancelRetire("request");

    await runDurableObjectAlarm(source);
    expect(await retirementCheck(source)).toBeDefined();
    expect(await alarmAt(source)).toBe(Date.now() + 60_000);

    advance(59_999);
    await runDurableObjectAlarm(source);
    expect(await retirementCheck(source)).toBeDefined();

    advance(1);
    await runDurableObjectAlarm(source);

    expect(await retirementCheck(source)).toBeUndefined();
    expect(await retiringFlag(source)).toBeUndefined();
    expect(await source.hasTokens()).toBe(true);
  });

  it("runs to its end if the delete landed after the first check read the row", async () => {
    const { source, sourceId } = await setup("late-after-read");
    await source.retire("request");
    await source.cancelRetire("request");

    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(true);
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(sourceId).run();
    advance(60_000);
    // The first alarm set watches. One alarm stops them, and the next one forgets the tokens.
    await runAttempts(source, 2);

    expect(await source.hasTokens()).toBe(false);
  });

  it("counts a read that started before the wait ended as too early", async () => {
    const { source } = await setup("late-slow-read");
    await source.retire("request");
    await source.cancelRetire("request");
    advance(59_000);
    await changeObjectEnv(source, (base) =>
      envWithRead(base, "SELECT 1 AS found", () => {
        advance(2_000);
        return undefined;
      }),
    );

    await runDurableObjectAlarm(source);

    expect(await retirementCheck(source)).toBeDefined();
  });

  it("keeps the check of an end that came during the read", async () => {
    const { source, sourceId } = await setup("late-new-end");
    await source.retire("request");
    await source.cancelRetire("request");
    advance(60_000);
    const self = await objectOf(source);
    let reconnect = true;
    await changeObjectEnv(source, (base) =>
      envWithRead(base, "SELECT 1 AS found", () => {
        if (!reconnect) return undefined;
        reconnect = false;
        return self.storeTokens(sourceId, {
          refreshToken: "fresh",
          accessToken: "fake",
          accessExpiresAt: Date.now() + DAY,
        });
      }),
    );

    await runDurableObjectAlarm(source);
    expect(await retirementCheck(source)).toBeDefined();

    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(sourceId).run();
    await runAttempts(source, 2);
    expect(await source.hasTokens()).toBe(false);
  });

  it("does not replace the generation of a retirement that started later", async () => {
    const { user, target, targetId, ruleId } = await setup("late-new-retire");
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    await target.retire("older");
    await target.cancelRetire("older");
    await target.retire("newer");
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(targetId).run();

    await runDurableObjectAlarm(target);

    expect(await retiringFlag(target)).toBe("newer");
  });

  it("does not replace a generation that arrived during the read", async () => {
    const { user, target, targetId, ruleId } = await setup("late-retire-read");
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    await target.retire("older");
    await target.cancelRetire("older");
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(targetId).run();
    const self = await objectOf(target);
    await changeObjectEnv(target, (base) =>
      envWithRead(base, "SELECT 1 AS found", () => self.retire("newer")),
    );

    await runDurableObjectAlarm(target);

    expect(await retiringFlag(target)).toBe("newer");
  });

  it("keeps its alarm if D1 fails the check, and checks again", async () => {
    const { source, sourceId } = await setup("late-outage");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await source.retire("request");
    await source.cancelRetire("request");
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(sourceId).run();
    let outage = true;
    await changeObjectEnv(source, (base) =>
      envWithRefusal((query) => outage && query.startsWith("SELECT 1 AS found"), base),
    );

    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(true);
    expect(await alarmAt(source)).toBe(Date.now() + 60_000);

    outage = false;
    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(false);
  });
});

describe("a D1 outage during the check of an ended retirement", () => {
  /** A retirement that ended, and a D1 that refuses every read of the check. */
  async function endedInOutage(name: string, jobs: boolean) {
    const context = await setup(name);
    const { user, source, target, ruleId } = context;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = jobs ? target : source;
    if (jobs) {
      await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
      await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
        offboarding: { orgId: user.orgId, userId: user.id },
      });
    }
    await stub.retire("request");
    await stub.cancelRetire("request");
    const outage = { on: true };
    await changeObjectEnv(stub, (base) =>
      envWithRefusal((query) => outage.on && query.startsWith("SELECT 1 AS found"), base),
    );
    return { ...context, stub, outage };
  }

  it("waits a minute, although a queued job is due at once", async () => {
    const { target, outage } = await endedInOutage("outage-job", true);
    expect((await removalsOf(target))?.[0]?.notBefore).toBeUndefined();

    await runDurableObjectAlarm(target);
    expect(await alarmAt(target)).toBe(Date.now() + 60_000);

    advance(60_000);
    await runDurableObjectAlarm(target);
    expect(await alarmAt(target)).toBe(Date.now() + 60_000);

    outage.on = false;
    advance(60_000);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
  });

  it("waits a minute, although the retry of a sync request is due", async () => {
    const { source } = await endedInOutage("outage-retry", false);
    await runInDurableObject(source, (_instance, state) =>
      state.storage.put("syncRequestRetry", { attempts: 1, at: Date.now() - 1 }),
    );

    await runDurableObjectAlarm(source);

    expect(await alarmAt(source)).toBe(Date.now() + 60_000);
  });

  it("keeps an alarm that lies further ahead", async () => {
    const { target } = await endedInOutage("outage-later", true);
    const notBefore = Date.now() + 3_600_000;
    await runInDurableObject(target, async (_instance, state) => {
      const queue = (await state.storage.get<object[]>("removalQueue")) ?? [];
      await state.storage.put(
        "removalQueue",
        queue.map((job) => ({ ...job, notBefore })),
      );
    });

    await runDurableObjectAlarm(target);

    expect(await alarmAt(target)).toBe(notBefore);
  });
});

describe("a D1 outage at the end of a retirement", () => {
  it("keeps the tokens and an alarm, and forgets the tokens once D1 answers", async () => {
    const { user, source, sourceId } = await setup("outage");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await removeAccounts(env, user, [sourceId]);
    let outage = true;
    await changeObjectEnv(source, (base) =>
      envWithRefusal((query) => outage && query.startsWith("UPDATE accounts"), base),
    );

    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(true);
    expect(await alarmAt(source)).toBe(Date.now() + 60_000);

    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(true);
    expect(await alarmAt(source)).toBe(Date.now() + 60_000);

    outage = false;
    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(false);
    expect(await alarmAt(source)).toBeNull();
  });

  it("still lets the platform retry the alarm of an account that does not retire", async () => {
    const { target, ruleId } = await setup("outage-other");
    await target.queueRemoval(ruleId, CALENDAR);
    vi.spyOn(methods, "runRemoval").mockRejectedValueOnce(new Error("D1_ERROR: refused"));

    const alarm = runInDurableObject(target, (instance) =>
      (instance as unknown as AccountSync).alarm(),
    );

    await expect(alarm).rejects.toThrow("D1_ERROR");
  });
});

describe("a removal that is queued while the tokens are about to go", () => {
  it("runs first, and the tokens go after it", async () => {
    const { user, target, targetId, ruleId } = await setup("late-job");
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    await target.retire("request");
    vi.spyOn(methods, "stopWatches").mockImplementationOnce(async function (this: AccountSync) {
      await this.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
        offboarding: { orgId: user.orgId, userId: user.id },
      });
    });

    await runDurableObjectAlarm(target);

    expect(await target.hasTokens()).toBe(true);
    expect(await removalsOf(target)).toHaveLength(1);
    expect(await alarmAt(target)).not.toBeNull();

    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    expect(await target.hasTokens()).toBe(true);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });

    await runDurableObjectAlarm(target);
    expect(await target.hasTokens()).toBe(false);
  });
});

describe("a retry that arrives while an alarm reads a rule from D1", () => {
  /** Hold the alarm after its D1 read. The input gate stays open, as during the real answer. */
  function holdRuleRead() {
    const original = methods.ruleWritesAgain;
    const state = { read: false, released: false };
    vi.spyOn(methods, "ruleWritesAgain").mockImplementationOnce(async function (
      this: AccountSync,
      ...args: unknown[]
    ) {
      const answer = await original.apply(this, args);
      state.read = true;
      while (!state.released) await sleep(1);
      return answer;
    });
    return state;
  }

  async function waitFor(ready: () => boolean): Promise<void> {
    while (!ready()) await sleep(1);
  }

  it("keeps the job, so that the blocks go and the result reaches the log", async () => {
    const { user, target, sourceId, targetId, ruleId } = await setup("read-race");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A failed request left a job that has tried once, and its rule runs again.
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    await target.injectFakeFault({ kind: "reads_fail", error: "server", count: 1 });
    await runDurableObjectAlarm(target);
    expect((await removalsOf(target))?.[0]?.attempts).toBe(1);
    await env.DB.prepare("UPDATE rules SET enabled = 1 WHERE id = ?").bind(ruleId).run();

    const held = holdRuleRead();
    const alarm = runDurableObjectAlarm(target);
    await waitFor(() => held.read);
    await removeAccounts(env, user, [sourceId]);
    held.released = true;
    await alarm;

    expect(await removalsOf(target)).toHaveLength(1);
    await runAttempts(target, 3);
    expect(await removalsOf(target)).toBeUndefined();
    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
  });

  it("drops a job that no request touched during the read", async () => {
    const { user, target, ruleId } = await setup("read-quiet");
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    const held = holdRuleRead();
    const alarm = runDurableObjectAlarm(target);
    await waitFor(() => held.read);
    held.released = true;
    await alarm;

    expect(await removalsOf(target)).toBeUndefined();
    expect(await blocksIn(target)).toBe(1);
    expect(await cycleOwed(target)).toBe(true);
  });

  it("owes no full cycle for a job that a request queued again during the read", async () => {
    const { user, target, ruleId } = await setup("read-requeued");
    const context = { offboarding: { orgId: user.orgId, userId: user.id } };
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], context);
    const held = holdRuleRead();
    const alarm = runDurableObjectAlarm(target);
    await waitFor(() => held.read);
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], context);
    held.released = true;
    await alarm;

    expect(await removalsOf(target)).toHaveLength(1);
    expect(await cycleOwed(target)).toBeUndefined();
  });
});

describe("a reconnect of a retiring account", () => {
  async function retiringWithJob(name: string) {
    const context = await setup(name);
    const { user, target, ruleId } = context;
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    await target.retire("request");
    return context;
  }

  const fresh = () => ({
    refreshToken: "fresh",
    accessToken: "fake",
    accessExpiresAt: Date.now() + DAY,
  });

  it("keeps the new tokens and finishes the queued removal", async () => {
    const { target, targetId } = await retiringWithJob("reconnect");

    await target.storeTokens(targetId, fresh());

    expect(await retiringFlag(target)).toBeUndefined();
    expect(await removalsOf(target)).toHaveLength(1);
    await runAttempts(target, 3);
    expect(await target.hasTokens()).toBe(true);
    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
  });

  it("keeps a removal that waits after a failed attempt", async () => {
    const { target, targetId } = await retiringWithJob("reconnect-wait");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "server", count: 1 });
    await runDurableObjectAlarm(target);
    expect((await removalsOf(target))?.[0]?.attempts).toBe(1);

    await target.storeTokens(targetId, fresh());
    await runAttempts(target, 3);

    expect(await target.hasTokens()).toBe(true);
    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
  });

  it("does not lose new tokens that arrive while the watches stop", async () => {
    const { source, sourceId } = await setup("reconnect-race");
    await source.retire("request");
    vi.spyOn(methods, "stopWatches").mockImplementationOnce(async function (this: AccountSync) {
      await this.storeTokens(sourceId, fresh());
    });

    await runDurableObjectAlarm(source);

    expect(await source.hasTokens()).toBe(true);
    expect(await needsReconnect(sourceId)).toBe(1);

    tokenWorks();
    await source.tick();
    expect(await needsReconnect(sourceId)).toBe(0);
  });
});

describe("a row that cannot be deleted after the retirement", () => {
  it("cancels the retirement, reports the accounts that stay and deletes an empty feed", async () => {
    const { user, source, target, sourceId, targetId } = await setup("no-delete");
    const thirdId = "no-delete-c";
    const keptRule = "no-delete-kept";
    await addAccount(user.id, thirdId);
    await addRule(user.id, keptRule, targetId, thirdId);
    await addFeed(user.id, "no-delete-feed", `${sourceId}-main`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    let deletes = 0;
    const hooked = envWithHook(async () => {
      deletes += 1;
      if (deletes === 2) throw new Error("D1_ERROR: refused");
    });

    await expect(removeAccounts(hooked, user, [sourceId, targetId])).rejects.toThrow("D1_ERROR");

    expect(await rowExists("accounts", sourceId)).toBe(false);
    expect(await rowExists("accounts", targetId)).toBe(true);
    expect(await retiringFlag(source)).toBeTruthy();
    expect(await retiringFlag(target)).toBeUndefined();
    expect(await eventsOf(sourceId, "account_disconnect_failed")).toEqual([]);
    expect((await eventsOf(targetId, "account_disconnect_failed"))[0]?.detail).toEqual({
      rules: 2,
      retireFailed: true,
    });
    expect(await ruleEnabled(keptRule)).toBe(1);
    expect(await feedExists("no-delete-feed")).toBe(false);
  });

  it("lets the tokens go if the delete landed and only its answer got lost", async () => {
    const { user, source, sourceId } = await setup("no-delete-landed");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hooked = envWithHook(async () => {
      await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(sourceId).run();
      throw new Error("D1_ERROR: answer lost");
    });

    await expect(removeAccounts(hooked, user, [sourceId])).rejects.toThrow("D1_ERROR");

    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(false);
  });
});

describe("a failure while the rules start again", () => {
  it("keeps the error of the retirement if the rules cannot start", async () => {
    const { user, source, sourceId, ruleId } = await setup("resume-fails");
    retireStoresAndFails();
    let updates = 0;
    const refusing = envWithRefusal((query) => {
      if (!query.startsWith("UPDATE rules")) return false;
      updates += 1;
      return updates === 2;
    });

    await expect(removeAccounts(refusing, user, [sourceId])).rejects.toThrow(
      "Network connection lost.",
    );

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await retiringFlag(source)).toBeUndefined();
    expect(await eventsOf(sourceId, "account_disconnect_failed")).toHaveLength(1);
  });

  it("keeps the queueing error if the rules cannot start", async () => {
    const { user, sourceId, ruleId } = await setup("resume-fails-queue");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "queueRemovals").mockRejectedValueOnce(new Error("lost"));
    let updates = 0;
    const refusing = envWithRefusal((query) => {
      if (!query.startsWith("UPDATE rules")) return false;
      updates += 1;
      return updates === 2;
    });

    await expect(removeAccounts(refusing, user, [sourceId])).rejects.toBeInstanceOf(
      CleanupNotQueued,
    );

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await eventsOf(sourceId, "account_disconnect_failed")).toHaveLength(1);
  });

  it("keeps the error of the retirement if the feeds cannot be deleted", async () => {
    const { user, source, sourceId, ruleId } = await setup("feeds-fail");
    retireStoresAndFails();
    const refusing = envWithRefusal((query) => query.includes("FROM feeds f"));

    await expect(removeAccounts(refusing, user, [sourceId])).rejects.toThrow(
      "Network connection lost.",
    );

    expect(await ruleEnabled(ruleId)).toBe(1);
    expect(await retiringFlag(source)).toBeUndefined();
  });

  it("writes the block again if the removal and a full cycle ran during the request", async () => {
    const { user, target, sourceId } = await setup("resume-cycle");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hooked = envWithHook(async () => {
      await runDurableObjectAlarm(target);
      await runDurableObjectAlarm(target);
      expect(await blocksIn(target)).toBe(0);
      throw new Error("D1_ERROR: refused");
    });

    await expect(removeAccounts(hooked, user, [sourceId])).rejects.toThrow("D1_ERROR");

    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(1);
  });

  it("starts no cycle in an account that went earlier in the request", async () => {
    const { user, target, sourceId, targetId } = await setup("resume-gone");
    const thirdId = "resume-gone-c";
    await addAccount(user.id, thirdId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = vi.spyOn(AccountSync.prototype, "requestSync");
    let retires = 0;
    const original = methods.retire;
    vi.spyOn(methods, "retire").mockImplementation(async function (
      this: AccountSync,
      ...args: unknown[]
    ) {
      retires += 1;
      if (retires === 2) throw new Error("Network connection lost.");
      await original.apply(this, args);
    });

    await expect(removeAccounts(env, user, [targetId, thirdId])).rejects.toThrow("lost");

    expect(sync).not.toHaveBeenCalled();
    expect(await rowExists("accounts", sourceId)).toBe(true);
    expect(await cycleOwed(target)).toBeUndefined();
  });
});

describe("a deactivation whose removal keeps failing", () => {
  it("reports the result after the last attempt", async () => {
    const { user, target, targetId, ruleId } = await setup("deactivate-fail", "fail@org.example");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "server", count: 5 });

    expect((await patchActive(user.id, false)).status).toBe(200);
    await runAttempts(target, 5);

    expect(await removalsOf(target)).toBeUndefined();
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([
      {
        user_id: user.id,
        account_id: targetId,
        rule_id: ruleId,
        detail: { result: "incomplete", removed: 0 },
      },
    ]);
  });
});

describe("a deactivation whose removal cannot be queued", () => {
  function queueingFails() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    return vi
      .spyOn(AccountSync.prototype, "queueRemovals")
      .mockRejectedValueOnce(new Error("Network connection lost."));
  }

  it("tells a SCIM client to try again, and the retry queues the removal", async () => {
    const { user, target, targetId, ruleId } = await setup("deactivate", "deactivate@org.example");
    await addFeed(user.id, "deactivate-feed", `${targetId}-main`);
    queueingFails();

    expect((await patchActive(user.id, false)).status).toBe(500);
    expect(await removalsOf(target)).toBeUndefined();
    expect(await feedExists("deactivate-feed")).toBe(false);
    expect(await userEvents(user.id, "user_deactivated")).toBe(1);

    expect((await patchActive(user.id, false)).status).toBe(200);
    expect(await removalsOf(target)).toEqual([expect.objectContaining({ ruleId })]);
    expect(await userEvents(user.id, "user_deactivated")).toBe(1);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
  });

  it("throws the error of a removal that was not queued", async () => {
    const { user } = await setup("deactivate-throw", "deactivate-throw@org.example");
    queueingFails();
    await expect(setUserActive(env, user, false, "scim")).rejects.toBeInstanceOf(CleanupNotQueued);
  });

  it("does not revive a user that is active already", async () => {
    const { user } = await setup("deactivate-active");
    const sync = vi.spyOn(AccountSync.prototype, "requestSync");

    await setUserActive(env, user, true, "scim");

    expect(sync).not.toHaveBeenCalled();
    expect(await userEvents(user.id, "user_reactivated")).toBe(0);
  });
});

describe("a comparison on a retiring account", () => {
  it("does not replace the wait of a removal", async () => {
    const { cookie, target, targetId } = await setup("compare");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await target.startCompares("full")).started).toBe(1);
    await target.injectFakeFault({ kind: "reads_fail", error: "server", count: 5 });

    await post(`/accounts/${targetId}/disconnect`, cookie);
    await runDurableObjectAlarm(target);

    const [job] = (await removalsOf(target)) ?? [];
    expect(job?.attempts).toBe(1);
    expect(await alarmAt(target)).toBe(job?.notBefore);
  });
});

describe("a removal while the request still runs", () => {
  it("goes on with a second step, because the rule is stopped before the queueing", async () => {
    const { user, source, target, sourceId, targetId, ruleId } = await setup("race");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "throttled" });
    const hooked = envWithHook(async () => {
      await runDurableObjectAlarm(target);
      expect((await removalsOf(target))?.[0]).toMatchObject({ ruleId, started: true });
      await runDurableObjectAlarm(target);
    });

    await removeAccounts(hooked, user, [sourceId]);

    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
    await runDurableObjectAlarm(source);
    expect(await source.hasTokens()).toBe(false);
  });

  it("does not write the blocks again in the full cycle after the removal", async () => {
    const { user, target, sourceId } = await setup("race-cycle");
    const hooked = envWithHook(async () => {
      await runDurableObjectAlarm(target);
      expect(await blocksIn(target)).toBe(0);
      await runDurableObjectAlarm(target);
    });

    await removeAccounts(hooked, user, [sourceId]);

    expect(await blocksIn(target)).toBe(0);
  });
});

describe("a removal without tokens", () => {
  it("reports the blocks it cannot remove", async () => {
    const { user } = await signIn("owner@example.com");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = stubOf("no-tokens");

    await stub.queueRemovals([{ ruleId: "gone-rule", remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    await runDurableObjectAlarm(stub);

    expect(await removalsOf(stub)).toBeUndefined();
    expect(await eventsOf("no-tokens", "cleanup_finished")).toEqual([
      {
        user_id: user.id,
        account_id: "no-tokens",
        rule_id: "gone-rule",
        detail: { result: "no_tokens", removed: 0 },
      },
    ]);
  });
});

describe("the activity page", () => {
  it("shows what a removal did and what is left to do", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    const detail = JSON.stringify({ result: "token_refused", removed: 2, left: 1 });
    await env.DB.prepare(
      "INSERT INTO audit_events (org_id, user_id, kind, detail) VALUES (?, ?, 'cleanup_finished', ?)",
    )
      .bind(user.orgId, user.id, detail)
      .run();

    const page = await exports.default.fetch(`${BASE}/activity`, { headers: { cookie } });

    expect(await page.text()).toContain(
      "2 blocks removed, 1 block left, the provider refused the tokens, delete the rest by hand",
    );
  });
});

describe("a job that is queued already", () => {
  it("takes over the offboarding, so that its result reaches the log", async () => {
    const { user, target, targetId, ruleId } = await setup("requeue");
    await target.queueRemoval(ruleId, CALENDAR);
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    expect(await removalsOf(target)).toHaveLength(1);
    await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(ruleId).run();

    await runDurableObjectAlarm(target);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
  });

  it("takes over the offboarding while a step of the job runs", async () => {
    const { user, target, targetId, ruleId } = await setup("requeue-step");
    await target.queueRemoval(ruleId, CALENDAR);
    await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(ruleId).run();
    type Step = (this: AccountSync, ...args: unknown[]) => Promise<unknown>;
    const steps = AccountSync.prototype as unknown as { removeRuleBlocks: Step };
    const original = steps.removeRuleBlocks;
    vi.spyOn(steps, "removeRuleBlocks").mockImplementationOnce(async function (
      this: AccountSync,
      ...args: unknown[]
    ) {
      await this.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
        offboarding: { orgId: user.orgId, userId: user.id },
      });
      return original.apply(this, args);
    });

    await runDurableObjectAlarm(target);

    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
  });

  it("keeps the count of earlier steps if a retry queues the job again", async () => {
    const { user, target, ruleId } = await setup("requeue-count");
    const offboarding = { orgId: user.orgId, userId: user.id };
    const rules = [{ ruleId, remoteCalendarId: CALENDAR }];
    await target.queueRemovals(rules, { offboarding });
    await runInDurableObject(target, async (_instance, state) => {
      const queue = await state.storage.get<{ offboarding: object }[]>("removalQueue");
      await state.storage.put(
        "removalQueue",
        queue?.map((job) => ({ ...job, offboarding: { ...job.offboarding, removed: 7 } })),
      );
    });

    await target.queueRemovals(rules, { offboarding });

    expect(await removalsOf(target)).toEqual([
      expect.objectContaining({ offboarding: { ...offboarding, removed: 7 } }),
    ]);
  });

  it("writes no result for a removal outside an offboarding", async () => {
    const { target, targetId, ruleId } = await setup("no-offboarding");
    await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(ruleId).run();
    await target.queueRemoval(ruleId, CALENDAR);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([]);
  });
});
