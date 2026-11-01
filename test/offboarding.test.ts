import {
  createScheduledController,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSync } from "../src/account-sync";
import worker from "../src/index";
import { purgeAuditEvents } from "../src/audit";
import { CRON_TICK_MS } from "../src/alerts";
import {
  CLEANUP_DEADLINE_MS,
  HOLD_LEASE_MS,
  JOBLESS_TOMBSTONE_MS,
  noteTombstoneProgress,
  ownCleanups,
} from "../src/cleanup";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { i18nFor } from "../src/i18n";
import {
  CleanupNotQueued,
  HOLD_SWEEP_RULES,
  HOLD_SWEEP_SUBREQUESTS,
  heldRulesStatement,
  releaseHeldRules,
  type HeldRule,
  removeAccounts,
  setUserActive,
} from "../src/offboarding";
import { ruleTagFor } from "../src/sync/plan";
import { syncWindow } from "../src/sync/rules";
import type { RuleOptions } from "../src/config";
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
      left: 1,
      estimated: true,
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
      left: 1,
      estimated: true,
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

  it("ends the job of another rule that the failed request queued, and the rule writes back", async () => {
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
    expect(await blocksIn(third)).toBe(0);
    expect(await ruleEnabled(ruleId)).toBe(1);
    expect(await ruleEnabled(secondRule)).toBe(1);
    expect((await eventsOf(thirdId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "removed",
      removed: 1,
    });
    await runDurableObjectAlarm(third);
    expect(await blocksIn(third)).toBe(1);
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

  it("runs the rules again, so that the blocks come back and the user can try again", async () => {
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
    expect(await blocksIn(target)).toBe(0);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(1);
    expect(await source.hasTokens()).toBe(true);

    // The retry goes the normal way.
    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(302);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished")).at(-1)?.detail).toEqual({
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
    expect(await blocksIn(target)).toBe(0);
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
    expect((await eventsOf(targetId, "cleanup_finished")).at(-1)?.detail).toEqual({
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
    const { cookie, source, sourceId, ruleId } = await setup("late-watch");
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
    // A job of a rule change has tried once, and its rule runs again.
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    await target.queueRemoval(ruleId, CALENDAR);
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
    const { target, ruleId } = await setup("read-quiet");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.queueRemoval(ruleId, CALENDAR);
    await target.injectFakeFault({ kind: "reads_fail", error: "server", count: 1 });
    await runDurableObjectAlarm(target);
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
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.queueRemoval(ruleId, CALENDAR);
    await target.injectFakeFault({ kind: "reads_fail", error: "server", count: 1 });
    await runDurableObjectAlarm(target);
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
        detail: { result: "incomplete", removed: 0, left: 1, estimated: true },
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
      expect.objectContaining({
        offboarding: { ...offboarding, removed: 7, since: expect.any(Number) as number },
      }),
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

interface Tombstone {
  user_id: string;
  org_id: string;
  rule_id: string;
  rule_tag: string;
  remote_calendar_id: string | null;
  calendar_name: string | null;
  block_title: string | null;
  state: string;
  removed: number;
  blocks_left: number | null;
  left_estimated: number;
  window_start: string | null;
  window_end: string | null;
  deadline_at: string | null;
  finished_at: string | null;
}

function tombstoneOf(accountId: string): Promise<Tombstone | null> {
  return env.DB.prepare("SELECT * FROM cleanup_tombstones WHERE account_id = ?")
    .bind(accountId)
    .first<Tombstone>();
}

function reportsOf(stub: Stub) {
  return runInDurableObject(stub, (_instance, state) => state.storage.get("cleanupReports"));
}

async function holdsOf(ruleId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM rule_holds WHERE rule_id = ?")
    .bind(ruleId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function page(path: string, cookie: string): Promise<string> {
  return (await exports.default.fetch(`${BASE}${path}`, { headers: { cookie } })).text();
}

/** Let the leases of all holds run out and run the step of the cron. */
async function sweepHolds(): Promise<number> {
  advance(HOLD_LEASE_MS);
  return sweepNow();
}

async function sweepNow(budget?: number): Promise<number> {
  const { results } = await heldRulesStatement(env, Date.now(), budget).all<HeldRule>();
  return releaseHeldRules(env, results, Date.now(), budget);
}

/**
 * Run the cron at minute 30 of the next hour. The ticks of the first 10 minutes of an hour also
 * pay for the silence check, and the accounts of earlier tests can then use up the budget.
 */
async function cronAt(scheduledTime: number): Promise<void> {
  vi.setSystemTime(scheduledTime);
  await worker.scheduled(createScheduledController({ scheduledTime }), env);
}

function runCron(): Promise<void> {
  const hour = 3_600_000;
  return cronAt(Math.ceil(Date.now() / hour) * hour + hour / 2);
}

/** Set the flag of a paused account, as a tick reads it. */
function flagReconnect(accountId: string) {
  return env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
    .bind(accountId)
    .run();
}

describe("a tombstone", () => {
  it("exists before the retirement, with owner, calendar, marker and period", async () => {
    const { user, cookie, targetId, ruleId } = await setup("stone");
    const original = methods.retire;
    let before: Tombstone | null = null;
    vi.spyOn(methods, "retire").mockImplementationOnce(async function (
      this: AccountSync,
      ...args: unknown[]
    ) {
      before = await tombstoneOf(targetId);
      await original.apply(this, args);
    });

    await post(`/accounts/${targetId}/disconnect`, cookie);

    expect(before).toMatchObject({
      user_id: user.id,
      org_id: user.orgId,
      rule_id: ruleId,
      rule_tag: await ruleTagFor(ruleId),
      remote_calendar_id: CALENDAR,
      calendar_name: "Cal",
      block_title: "Busy",
      state: "open",
      removed: 0,
      blocks_left: null,
    });
    const stone = await tombstoneOf(targetId);
    expect(stone?.window_start).toBe(
      syncWindow({ daysAhead: 30 } as RuleOptions).start.toISOString(),
    );
    expect(stone?.window_end).toBe(syncWindow({ daysAhead: 30 } as RuleOptions).end.toISOString());
  });

  it("outlives the row and the tokens of the account, with the end state", async () => {
    const { cookie, target, targetId } = await setup("stone-end");

    await post(`/accounts/${targetId}/disconnect`, cookie);
    expect(await rowExists("accounts", targetId)).toBe(false);
    await runDurableObjectAlarm(target);
    expect(await tombstoneOf(targetId)).toMatchObject({ state: "removed", removed: 1 });
    await runDurableObjectAlarm(target);

    expect(await target.hasTokens()).toBe(false);
    const stone = await tombstoneOf(targetId);
    expect(stone).toMatchObject({ state: "removed", removed: 1, blocks_left: 0 });
    expect(stone?.finished_at).not.toBeNull();
    // Nothing is left to find, so the name of the calendar goes too.
    expect(stone).toMatchObject({ calendar_name: null, block_title: null });
  });

  it("outlives the user", async () => {
    const { cookie, target, targetId, user } = await setup("stone-user", "stone-user@org.example");

    await post("/account/delete", cookie);
    expect(await rowExists("users", user.id)).toBe(false);
    await runDurableObjectAlarm(target);

    expect(await tombstoneOf(targetId)).toMatchObject({ user_id: user.id, state: "removed" });
  });

  it("notes the progress of a step that leaves blocks", async () => {
    const { user, target, targetId, ruleId } = await setup("stone-step");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await removeAccounts(env, user, [targetId]);
    const steps = AccountSync.prototype as unknown as { removeRuleBlocks: Method };
    vi.spyOn(steps, "removeRuleBlocks").mockResolvedValueOnce({
      removed: 2,
      remaining: 3,
      throttled: false,
      edgeReadFailed: false,
    });

    await runDurableObjectAlarm(target);

    expect(await removalsOf(target)).toEqual([expect.objectContaining({ ruleId })]);
    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "open",
      removed: 2,
      blocks_left: 3,
    });
  });

  it("keeps the job if the progress cannot be written", async () => {
    const { user, target, sourceId, ruleId } = await setup("stone-step-d1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await removeAccounts(env, user, [sourceId]);
    const steps = AccountSync.prototype as unknown as { removeRuleBlocks: Method };
    vi.spyOn(steps, "removeRuleBlocks").mockResolvedValueOnce({
      removed: 2,
      remaining: 3,
      throttled: false,
      edgeReadFailed: false,
    });
    await changeObjectEnv(target, (base) =>
      envWithRefusal((query) => query.startsWith("UPDATE cleanup_tombstones"), base),
    );

    await runDurableObjectAlarm(target);

    expect(await removalsOf(target)).toEqual([expect.objectContaining({ ruleId })]);
  });

  it("keeps its progress if a retry of the request finds it open", async () => {
    const { user, target, targetId } = await setup("stone-retry", "stone-retry@org.example");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await setUserActive(env, user, false, "scim");
    const steps = AccountSync.prototype as unknown as { removeRuleBlocks: Method };
    vi.spyOn(steps, "removeRuleBlocks").mockResolvedValueOnce({
      removed: 2,
      remaining: 3,
      throttled: false,
      edgeReadFailed: false,
    });
    await runDurableObjectAlarm(target);

    await setUserActive(env, user, false, "scim");

    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "open",
      removed: 2,
      blocks_left: 3,
    });
  });

  it("appears for a job that a version without tombstones queued", async () => {
    const { user, target, targetId, ruleId } = await setup("stone-old");
    await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(ruleId).run();
    await runInDurableObject(target, async (_instance, state) => {
      await state.storage.put("removalQueue", [
        {
          ruleId,
          remoteCalendarId: CALENDAR,
          attempts: 0,
          offboarding: { orgId: user.orgId, userId: user.id, removed: 0 },
        },
      ]);
      await state.storage.setAlarm(Date.now() + 1000);
    });

    await runDurableObjectAlarm(target);

    expect(await blocksIn(target)).toBe(0);
    expect(await tombstoneOf(targetId)).toMatchObject({
      user_id: user.id,
      rule_tag: await ruleTagFor(ruleId),
      calendar_name: null,
      state: "removed",
      removed: 1,
    });
  });

  it("starts again for a new offboarding after an end state", async () => {
    const { user, target, targetId, ruleId } = await setup(
      "stone-again",
      "stone-again@org.example",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "server", count: 5 });
    await setUserActive(env, user, false, "scim");
    await runAttempts(target, 5);
    expect((await tombstoneOf(targetId))?.state).toBe("incomplete");

    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    await removeAccounts(env, user, [targetId]);

    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "open",
      blocks_left: null,
      finished_at: null,
    });
  });

  it("goes after the retention period", async () => {
    const { cookie, target, targetId } = await setup("stone-old-row");
    await post(`/accounts/${targetId}/disconnect`, cookie);
    await runDurableObjectAlarm(target);
    await env.DB.prepare(
      `UPDATE cleanup_tombstones SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-91 days')
       WHERE account_id = ?`,
    )
      .bind(targetId)
      .run();

    await purgeAuditEvents(env.DB);

    expect(await tombstoneOf(targetId)).toBeNull();
  });
});

describe("a refused token before any count", () => {
  /** Disconnect the account that holds the blocks, and refuse every read. No read ever counts. */
  async function refused(name: string) {
    const context = await setup(name);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await context.target.injectFakeFault({ kind: "reads_fail", error: "token", count: 5 });
    await post(`/accounts/${context.targetId}/disconnect`, context.cookie);
    return context;
  }

  it("names the blocks left from the last run, as an estimate", async () => {
    const { target, targetId } = await refused("left");

    await runAttempts(target, 5);

    expect(await blocksIn(target)).toBe(1);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "token_refused",
      removed: 0,
      left: 1,
      estimated: true,
    });
    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "token_refused",
      blocks_left: 1,
      left_estimated: 1,
    });
  });

  it("subtracts the blocks that earlier steps removed", async () => {
    const { target, targetId } = await refused("left-removed");
    await runInDurableObject(target, async (_instance, state) => {
      const queue = await state.storage.get<{ offboarding: object }[]>("removalQueue");
      await state.storage.put(
        "removalQueue",
        queue?.map((job) => ({ ...job, offboarding: { ...job.offboarding, removed: 1 } })),
      );
    });

    await runAttempts(target, 5);

    expect(await tombstoneOf(targetId)).toMatchObject({ removed: 1, blocks_left: 0 });
  });

  it("ignores a dry run", async () => {
    const { target, targetId, ruleId } = await refused("left-dry");
    await env.DB.prepare(
      `INSERT INTO audit_events (org_id, account_id, rule_id, kind, detail)
       VALUES ('default', ?, ?, 'sync_run', '{"dryRun":true,"create":9,"update":0,"unchanged":0}')`,
    )
      .bind(targetId, ruleId)
      .run();

    await runAttempts(target, 5);

    expect((await tombstoneOf(targetId))?.blocks_left).toBe(1);
  });

  it("prefers the count of a read over the last run", async () => {
    const { target, targetId } = await refused("left-read");
    await runInDurableObject(target, async (_instance, state) => {
      const queue = await state.storage.get<{ offboarding: object }[]>("removalQueue");
      await state.storage.put(
        "removalQueue",
        queue?.map((job) => ({ ...job, offboarding: { ...job.offboarding, left: 7 } })),
      );
    });

    await runAttempts(target, 5);

    expect(await tombstoneOf(targetId)).toMatchObject({ blocks_left: 7, left_estimated: 0 });
  });

  it("states that no count exists if no run left one", async () => {
    const { cookie, target, targetId, ruleId } = await refused("left-none");
    await env.DB.prepare("DELETE FROM audit_events WHERE rule_id = ?").bind(ruleId).run();

    await runAttempts(target, 5);

    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "token_refused",
      removed: 0,
    });
    expect((await tombstoneOf(targetId))?.blocks_left).toBeNull();
    expect(await page("/cleanup", cookie)).toContain(en.cleanup.unknownCount);
  });

  it("shows the rest per target calendar, also in the provider path without a mock", async () => {
    const { cookie, target, targetId, ruleId } = await refused("left-page");
    await runAttempts(target, 5);

    const text = await page("/cleanup", cookie);

    const window = syncWindow({ daysAhead: 30 } as RuleOptions);
    expect(text).toContain("Cal");
    expect(text).toContain(en.cleanup.aboutCount(1));
    expect(text).toContain(await ruleTagFor(ruleId));
    expect(text).toContain(en.cleanup.reasons.token_refused);
    expect(text).toContain(en.cleanup.reconnectDoesNotHelp);
    const { formatDate } = i18nFor("en");
    expect(text).toContain(
      en.cleanup.period(
        formatDate(window.start.toISOString()),
        formatDate(window.end.toISOString()),
      ),
    );
    expect(await tombstoneOf(targetId)).not.toBeNull();
    expect(await target.hasTokens()).toBe(true);
  });
});

describe("a job on a paused account", () => {
  async function waiting(name: string, email?: string) {
    const context = await setup(name, email);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await pause(context.target);
    await flagReconnect(context.targetId);
    return context;
  }

  it("waits for a reconnect until the deadline", async () => {
    const { cookie, target, sourceId, targetId, ruleId } = await waiting("deadline-wait");

    await post(`/accounts/${sourceId}/disconnect`, cookie);
    advance(CLEANUP_DEADLINE_MS - 60_000);
    await target.tick();

    expect(await removalsOf(target)).toEqual([expect.objectContaining({ ruleId })]);
    const stone = await tombstoneOf(targetId);
    expect(stone?.state).toBe("open");
    const { formatDate } = i18nFor("en");
    expect(await page("/cleanup", (await signIn("owner@example.com")).cookie)).toContain(
      en.cleanup.running(formatDate(stone?.deadline_at ?? "")),
    );
  });

  it("ends at the deadline with the blocks left, and the page shows it", async () => {
    const { cookie, target, sourceId, targetId, ruleId } = await waiting("deadline-end");

    await post(`/accounts/${sourceId}/disconnect`, cookie);
    advance(CLEANUP_DEADLINE_MS);
    await target.tick();

    expect(await removalsOf(target)).toBeUndefined();
    expect(await blocksIn(target)).toBe(1);
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "deadline",
      removed: 0,
      left: 1,
      estimated: true,
    });
    expect((await tombstoneOf(targetId))?.state).toBe("deadline");
    const text = await page("/cleanup", (await signIn("owner@example.com")).cookie);
    expect(text).toContain(await ruleTagFor(ruleId));
    expect(text).toContain(en.cleanup.reasons.deadline);
  });

  it("ends in an alarm too", async () => {
    const { cookie, target, sourceId, targetId } = await waiting("deadline-alarm");

    await post(`/accounts/${sourceId}/disconnect`, cookie);
    advance(CLEANUP_DEADLINE_MS);
    await runDurableObjectAlarm(target);

    expect((await tombstoneOf(targetId))?.state).toBe("deadline");
  });

  it("counts a job of an older version from the start of the pause", async () => {
    const { user, target, targetId, ruleId } = await waiting("deadline-old");
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("removalQueue", [
        {
          ruleId,
          remoteCalendarId: CALENDAR,
          attempts: 0,
          offboarding: { orgId: user.orgId, userId: user.id, removed: 0 },
        },
      ]),
    );

    await target.tick();
    expect(await removalsOf(target)).toHaveLength(1);
    advance(CLEANUP_DEADLINE_MS);
    await target.tick();

    expect(await removalsOf(target)).toBeUndefined();
    expect((await tombstoneOf(targetId))?.state).toBe("deadline");
  });

  it("does not end a removal outside an offboarding", async () => {
    const { target, ruleId } = await waiting("deadline-plain");
    await target.queueRemoval(ruleId, CALENDAR);

    advance(CLEANUP_DEADLINE_MS);
    await target.tick();

    expect(await removalsOf(target)).toHaveLength(1);
  });

  it("does not clean up on a reconnect after the end", async () => {
    const { cookie, target, sourceId, targetId, ruleId } = await waiting("deadline-reconnect");
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    advance(CLEANUP_DEADLINE_MS);
    await target.tick();

    await target.storeTokens(targetId, {
      refreshToken: "fake",
      accessToken: "fake",
      accessExpiresAt: Date.now() + DAY,
    });
    await runDurableObjectAlarm(target);

    expect(await removalsOf(target)).toBeUndefined();
    expect(await blocksIn(target)).toBe(1);
    expect((await tombstoneOf(targetId))?.state).toBe("deadline");
    const { cookie: later } = await signIn("owner@example.com");
    expect(await page("/cleanup", later)).toContain(await ruleTagFor(ruleId));
  });

  it("ends for a deactivated user, and an admin sees the rest", async () => {
    const { user, target, targetId, ruleId } = await waiting(
      "deadline-user",
      "deadline-user@org.example",
    );

    expect((await patchActive(user.id, false)).status).toBe(200);
    expect(await removalsOf(target)).toHaveLength(1);
    advance(CLEANUP_DEADLINE_MS);
    await target.tick();

    expect((await tombstoneOf(targetId))?.state).toBe("deadline");
    const admin = await signIn("admin@example.com");
    expect(await page("/cleanup", admin.cookie)).toContain(await ruleTagFor(ruleId));
    expect(await page("/admin", admin.cookie)).toContain('href="/cleanup"');
  });
});

describe("a cleanup result that D1 refuses", () => {
  const refuseResult = (query: string) => query.includes("INTO cleanup_tombstones");

  it("stays in the object, holds the tokens, and reaches D1 later", async () => {
    const { cookie, target, targetId } = await setup("lost-result");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await post(`/accounts/${targetId}/disconnect`, cookie);
    await changeObjectEnv(target, (base) => envWithRefusal(refuseResult, base));

    await runDurableObjectAlarm(target);

    expect(await removalsOf(target)).toBeUndefined();
    expect(await reportsOf(target)).toHaveLength(1);
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([]);
    expect(await alarmAt(target)).not.toBeNull();
    await runDurableObjectAlarm(target);
    expect(await target.hasTokens()).toBe(true);
    expect(await alarmAt(target)).not.toBeNull();

    await changeObjectEnv(target, () => env);
    await runDurableObjectAlarm(target);
    expect(await reportsOf(target)).toBeUndefined();
    expect(await tombstoneOf(targetId)).toMatchObject({ state: "removed", removed: 1 });
    expect(await eventsOf(targetId, "cleanup_finished")).toHaveLength(1);
    await runDurableObjectAlarm(target);
    expect(await target.hasTokens()).toBe(false);
  });

  it("holds the tokens if a result arrives while the watches stop", async () => {
    const { user, cookie, target, targetId } = await setup("report-during-stop");
    await post(`/accounts/${targetId}/disconnect`, cookie);
    await runDurableObjectAlarm(target);
    const late = [
      {
        id: "late",
        orgId: user.orgId,
        userId: user.id,
        ruleId: "late-rule",
        remoteCalendarId: CALENDAR,
        result: "removed",
        removed: 0,
      },
    ];
    vi.spyOn(methods, "stopWatches").mockImplementationOnce(async function (this: AccountSync) {
      await (this as unknown as { ctx: DurableObjectState }).ctx.storage.put(
        "cleanupReports",
        late,
      );
    });

    await runDurableObjectAlarm(target);

    expect(await target.hasTokens()).toBe(true);
    await runDurableObjectAlarm(target);
    expect(await reportsOf(target)).toBeUndefined();
    await runDurableObjectAlarm(target);
    expect(await target.hasTokens()).toBe(false);
  });

  it("writes a stored result in a step of its own, and the work goes on", async () => {
    const { user, target, targetId, ruleId } = await setup("lost-step");
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    await runInDurableObject(target, (_instance, state) =>
      state.storage.put("cleanupReports", [
        {
          id: "stored",
          orgId: user.orgId,
          userId: user.id,
          ruleId: "stored-rule",
          remoteCalendarId: "other",
          result: "removed",
          removed: 3,
        },
      ]),
    );

    await runDurableObjectAlarm(target);

    expect(await reportsOf(target)).toBeUndefined();
    expect(await blocksIn(target)).toBe(1);
    expect(await removalsOf(target)).toHaveLength(1);
    expect(await alarmAt(target)).not.toBeNull();
    await runDurableObjectAlarm(target);
    expect((await tombstoneOf(targetId))?.state).not.toBe("open");
    expect(await blocksIn(target)).toBe(0);
  });

  it("keeps an alarm in an account that stays", async () => {
    const { user, target, targetId, sourceId } = await setup("lost-stays");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await removeAccounts(env, user, [sourceId]);
    await changeObjectEnv(target, (base) => envWithRefusal(refuseResult, base));

    await runDurableObjectAlarm(target);
    await runDurableObjectAlarm(target);

    expect(await reportsOf(target)).toHaveLength(1);
    expect(await alarmAt(target)).not.toBeNull();
    await changeObjectEnv(target, () => env);
    await runDurableObjectAlarm(target);
    expect((await tombstoneOf(targetId))?.state).toBe("removed");
  });

  it("is not lost in an object without tokens", async () => {
    const { user } = await signIn("owner@example.com");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = stubOf("lost-no-tokens");
    await stub.queueRemovals([{ ruleId: "gone-rule", remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    await changeObjectEnv(stub, (base) => envWithRefusal(refuseResult, base));

    await runDurableObjectAlarm(stub);

    expect(await removalsOf(stub)).toBeUndefined();
    expect(await reportsOf(stub)).toHaveLength(1);
    expect(await alarmAt(stub)).not.toBeNull();
    await changeObjectEnv(stub, () => env);
    await runDurableObjectAlarm(stub);
    expect(await reportsOf(stub)).toBeUndefined();
    expect((await tombstoneOf("lost-no-tokens"))?.state).toBe("no_tokens");
  });

  it("reaches D1 from a tick of a paused account", async () => {
    const { cookie, target, sourceId, targetId } = await setup("lost-paused");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await pause(target);
    await flagReconnect(targetId);
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    await changeObjectEnv(target, (base) => envWithRefusal(refuseResult, base));
    advance(CLEANUP_DEADLINE_MS);

    await target.tick();
    expect(await reportsOf(target)).toHaveLength(1);

    await changeObjectEnv(target, () => env);
    await target.tick();
    expect(await reportsOf(target)).toBeUndefined();
    expect((await tombstoneOf(targetId))?.state).toBe("deadline");
  });

  it("keeps the count of a failed read of the last run for the next try", async () => {
    const { cookie, target, targetId } = await setup("lost-count");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "token", count: 5 });
    await post(`/accounts/${targetId}/disconnect`, cookie);
    await changeObjectEnv(target, (base) =>
      envWithRefusal((query) => query.includes("json_extract"), base),
    );

    await runAttempts(target, 5);
    expect(await reportsOf(target)).toHaveLength(1);

    await changeObjectEnv(target, () => env);
    await runDurableObjectAlarm(target);
    expect((await tombstoneOf(targetId))?.blocks_left).toBe(1);
  });
});

describe("overlapping requests", () => {
  // The sweep reads the oldest holds of the database, also those of other tests.
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM rule_holds").run();
  });

  /** `env` whose Durable Object stubs call `after` once `retiring()` answered. */
  function envAfterRetiring(after: () => Promise<void>): Env {
    const namespace = new Proxy(env.ACCOUNT_SYNC, {
      get(target, property) {
        if (property !== "getByName") {
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? (value.bind(target) as unknown) : value;
        }
        return (name: string) => {
          const stub = target.getByName(name);
          return new Proxy(stub, {
            get(object, method) {
              // A property of a stub is a stub too: it needs no binding.
              if (method !== "retiring") return Reflect.get(object, method);
              return async () => {
                const answer = await object.retiring();
                await after();
                return answer;
              };
            },
          });
        };
      },
    });
    return new Proxy(env, {
      get: (target, property) =>
        property === "ACCOUNT_SYNC" ? namespace : Reflect.get(target, property),
    });
  }

  function queueingFails() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    return vi
      .spyOn(AccountSync.prototype, "queueRemovals")
      .mockRejectedValueOnce(new Error("Network connection lost."));
  }

  it("does not start a rule that a newer request holds, and its blocks go", async () => {
    const { user, target, sourceId, targetId, ruleId } = await setup("overlap");
    // The second request stops between its retirement and the delete of the row.
    let second: Promise<void> | undefined;
    let reachedDelete!: () => void;
    const atDelete = new Promise<void>((resolve) => (reachedDelete = resolve));
    let finishDelete!: () => void;
    const goOn = new Promise<void>((resolve) => (finishDelete = resolve));
    const hooked = envWithHook(async () => {
      reachedDelete();
      await goOn;
    });
    let started = false;
    const first = envAfterRetiring(async () => {
      if (started) return;
      started = true;
      second = removeAccounts(hooked, user, [sourceId]);
      await atDelete;
    });
    queueingFails();

    await expect(removeAccounts(first, user, [sourceId])).rejects.toBeInstanceOf(CleanupNotQueued);

    expect(await ruleEnabled(ruleId)).toBe(0);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    expect((await tombstoneOf(targetId))?.state).toBe("removed");
    finishDelete();
    await second;
  });

  it("never drops an offboarding's job because its rule runs", async () => {
    const { user, target, targetId, ruleId } = await setup("overlap-drop");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    await target.injectFakeFault({ kind: "reads_fail", error: "server", count: 1 });
    await runDurableObjectAlarm(target);
    expect((await removalsOf(target))?.[0]?.attempts).toBe(1);
    expect(await ruleEnabled(ruleId)).toBe(1);

    await runDurableObjectAlarm(target);

    expect(await blocksIn(target)).toBe(0);
    expect(await removalsOf(target)).toBeUndefined();
    expect((await tombstoneOf(targetId))?.state).toBe("removed");
  });

  it("keeps a rule off whose other account retires by another request", async () => {
    const { cookie, target, sourceId, ruleId } = await setup("overlap-other");
    await target.retire("other-request");
    queueingFails();

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);

    expect(await ruleEnabled(ruleId)).toBe(0);
  });

  it("starts a rule again after two failed disconnects", async () => {
    const { cookie, sourceId, ruleId } = await setup("overlap-twice");
    vi.spyOn(AccountSync.prototype, "cancelRetire").mockRejectedValue(new Error("lost"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const retire = vi.spyOn(AccountSync.prototype, "retire").mockRejectedValue(new Error("lost"));

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);
    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);
    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(retire).toHaveBeenCalledTimes(2);
    expect(await holdsOf(ruleId)).toBe(2);

    await sweepHolds();

    expect(await ruleEnabled(ruleId)).toBe(1);
    expect(await holdsOf(ruleId)).toBe(0);
  });

  it("starts the rule with the second request if only the first left it open", async () => {
    const { cookie, sourceId, ruleId } = await setup("overlap-second");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValue(new Error("lost"));
    vi.spyOn(AccountSync.prototype, "cancelRetire").mockRejectedValueOnce(new Error("lost"));

    await post(`/accounts/${sourceId}/disconnect`, cookie);
    expect(await ruleEnabled(ruleId)).toBe(0);
    await post(`/accounts/${sourceId}/disconnect`, cookie);

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await holdsOf(ruleId)).toBe(1);
  });

  it("reports the restart in the log", async () => {
    const { cookie, sourceId, targetId, ruleId } = await setup("overlap-log");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValue(new Error("lost"));
    vi.spyOn(AccountSync.prototype, "cancelRetire").mockRejectedValue(new Error("lost"));
    await post(`/accounts/${sourceId}/disconnect`, cookie);

    await sweepHolds();

    expect((await eventsOf(targetId, "rule_enabled"))[0]).toMatchObject({
      rule_id: ruleId,
      detail: { restored: true },
    });
  });

  it("keeps the set of rules if the start fails at D1", async () => {
    const { user, sourceId, ruleId } = await setup("overlap-d1");
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
    expect(await holdsOf(ruleId)).toBe(1);

    await sweepHolds();
    expect(await ruleEnabled(ruleId)).toBe(1);
  });

  it("leaves a rule paused by the user off", async () => {
    const { user, sourceId, ruleId } = await setup("overlap-paused");
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));

    await expect(removeAccounts(env, user, [sourceId])).rejects.toThrow("lost");
    await sweepHolds();

    expect(await holdsOf(ruleId)).toBe(0);
    expect(await ruleEnabled(ruleId)).toBe(0);
  });

  it("holds a rule while an account of it retires, and starts it after a reconnect", async () => {
    const { cookie, source, sourceId, ruleId } = await setup("overlap-reconnect");
    vi.spyOn(console, "error").mockImplementation(() => {});
    retireStoresAndFails();
    vi.spyOn(methods, "cancelRetire").mockRejectedValueOnce(new Error("lost"));
    await post(`/accounts/${sourceId}/disconnect`, cookie);

    await sweepHolds();
    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await holdsOf(ruleId)).toBe(1);

    await source.storeTokens(sourceId, {
      refreshToken: "fake",
      accessToken: "fake",
      accessExpiresAt: Date.now() + DAY,
    });
    await sweepHolds();
    expect(await ruleEnabled(ruleId)).toBe(1);
  });

  it("keeps a held rule off if no answer tells whether its account retires", async () => {
    const { cookie, sourceId, ruleId } = await setup("overlap-unknown");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));
    vi.spyOn(AccountSync.prototype, "cancelRetire").mockRejectedValueOnce(new Error("lost"));
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    vi.spyOn(AccountSync.prototype, "retiring").mockRejectedValueOnce(new Error("lost"));

    await sweepHolds();

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await holdsOf(ruleId)).toBe(1);
  });

  it("does not read a hold before its lease ends", async () => {
    const { cookie, sourceId, ruleId } = await setup("overlap-lease");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));
    vi.spyOn(AccountSync.prototype, "cancelRetire").mockRejectedValueOnce(new Error("lost"));
    await post(`/accounts/${sourceId}/disconnect`, cookie);

    expect(await sweepNow()).toBe(0);

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await holdsOf(ruleId)).toBe(1);
  });

  it("ends a hold if the rule starts by another way", async () => {
    const { cookie, sourceId, ruleId } = await setup("overlap-user");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));
    vi.spyOn(AccountSync.prototype, "cancelRetire").mockRejectedValueOnce(new Error("lost"));
    await post(`/accounts/${sourceId}/disconnect`, cookie);

    await post(`/rules/${ruleId}/enable`, cookie);
    await post(`/rules/${ruleId}/pause`, cookie);
    await sweepHolds();

    expect(await ruleEnabled(ruleId)).toBe(0);
  });

  it("reads no rule without a budget, and one rule with the least", async () => {
    const { cookie, sourceId, ruleId } = await setup("overlap-small");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));
    vi.spyOn(AccountSync.prototype, "cancelRetire").mockRejectedValueOnce(new Error("lost"));
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    advance(HOLD_LEASE_MS);

    expect(await sweepNow(2)).toBe(0);
    expect(await ruleEnabled(ruleId)).toBe(0);

    expect(await sweepNow(3)).toBe(3);
    expect(await ruleEnabled(ruleId)).toBe(1);
  });

  it("runs from the cron", async () => {
    const { cookie, sourceId, ruleId } = await setup("overlap-cron");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));
    vi.spyOn(AccountSync.prototype, "cancelRetire").mockRejectedValueOnce(new Error("lost"));
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    advance(HOLD_LEASE_MS);

    await runCron();

    expect(await ruleEnabled(ruleId)).toBe(1);
  });

  it("stays inside its share of the cron budget", async () => {
    const { user, cookie, sourceId } = await setup("overlap-budget");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValue(new Error("lost"));
    vi.spyOn(AccountSync.prototype, "cancelRetire").mockRejectedValue(new Error("lost"));
    for (let index = 0; index < HOLD_SWEEP_RULES + 3; index++) {
      const id = `overlap-budget-${index}`;
      await addAccount(user.id, id);
      await addRule(user.id, `${id}-rule`, sourceId, id);
    }
    await post(`/accounts/${sourceId}/disconnect`, cookie);

    const cost = await sweepHolds();

    expect(cost).toBeLessThanOrEqual(HOLD_SWEEP_SUBREQUESTS);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM rule_holds h JOIN rules r ON r.id = h.rule_id WHERE r.user_id = ?",
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(4);
  });
});

describe("a reactivation while a job waits", () => {
  it("lets the job end, and the rule writes the blocks back", async () => {
    const { user, target, targetId } = await setup("reactivate", "reactivate@org.example");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await patchActive(user.id, false)).status).toBe(200);
    expect((await patchActive(user.id, true)).status).toBe(200);

    await runDurableObjectAlarm(target);
    expect((await tombstoneOf(targetId))?.state).toBe("removed");
    await runDurableObjectAlarm(target);

    expect(await blocksIn(target)).toBe(1);
  });
});

describe("the job of a failed request", () => {
  it("runs to its end, and the rule that runs again writes the blocks back", async () => {
    const { cookie, target, sourceId, targetId, ruleId } = await setup("failed-job");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);
    expect(await ruleEnabled(ruleId)).toBe(1);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    expect((await tombstoneOf(targetId))?.state).toBe("removed");

    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(1);
  });
});

describe("the page of blocks left", () => {
  async function ended(name: string, email?: string) {
    const context = await setup(name, email);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await context.target.injectFakeFault({ kind: "reads_fail", error: "token", count: 5 });
    await removeAccounts(env, context.user, [context.sourceId, context.targetId]);
    await runAttempts(context.target, 5);
    return context;
  }

  it("needs a session", async () => {
    const response = await exports.default.fetch(`${BASE}/cleanup`, { redirect: "manual" });
    expect(response.status).toBe(302);
  });

  it("names no event content", async () => {
    const { cookie, ruleId } = await ended("page-private", "page-private@org.example");
    await env.DB.prepare(`UPDATE cleanup_tombstones SET block_title = NULL WHERE rule_id = ?`)
      .bind(ruleId)
      .run();

    const text = await page("/cleanup", cookie);

    expect(text).not.toContain("Busy");
    expect(text).not.toContain("meeting");
    expect(text).toContain(en.cleanup.markerOnly(await ruleTagFor(ruleId)));
  });

  it("stores no title of a rule that copies event titles", async () => {
    const { user, target, targetId, ruleId } = await setup("page-title");
    await env.DB.prepare("UPDATE rules SET options = ? WHERE id = ?")
      .bind('{"daysAhead":30,"detailLevel":"title"}', ruleId)
      .run();
    await removeAccounts(env, user, [targetId]);
    expect(target).toBeDefined();
    expect((await tombstoneOf(targetId))?.block_title).toBeNull();
  });

  it("shows nothing for a removal that ended well", async () => {
    const { cookie, target, targetId, ruleId } = await setup(
      "page-clean",
      "page-clean@org.example",
    );
    await post(`/accounts/${targetId}/disconnect`, cookie);
    await runDurableObjectAlarm(target);
    const text = await page("/cleanup", cookie);
    expect(text).toContain(en.cleanup.empty);
    expect(text).not.toContain(await ruleTagFor(ruleId));
  });

  it("shows the same user nothing of another user", async () => {
    const { ruleId } = await ended("page-owner");
    const other = await signIn("other@elsewhere.org");
    expect(await page("/cleanup", other.cookie)).not.toContain(await ruleTagFor(ruleId));
  });

  it("shows an admin the rest of an active user only on that user's page", async () => {
    const { ruleId } = await ended("page-admin");
    const admin = await signIn("admin@example.com");
    expect(await page("/cleanup", admin.cookie)).not.toContain(await ruleTagFor(ruleId));
  });

  it("shows an admin the rest of a deleted user", async () => {
    const { user, cookie, ruleId } = await ended("page-deleted", "page-deleted@org.example");
    await post("/account/delete", cookie);
    expect(await rowExists("users", user.id)).toBe(false);
    const admin = await signIn("admin@example.com");
    expect(await page("/cleanup", admin.cookie)).toContain(await ruleTagFor(ruleId));
  });

  it("hides a job whose rule runs again", async () => {
    const { cookie, target, sourceId, ruleId } = await setup("page-live");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    expect(await ruleEnabled(ruleId)).toBe(1);
    expect(await removalsOf(target)).toHaveLength(1);

    expect(await page("/cleanup", cookie)).not.toContain(await ruleTagFor(ruleId));
  });

  it("adds two rules up per target calendar", async () => {
    const { user, cookie, target, sourceId, targetId, ruleId } = await setup("page-group");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const thirdId = "page-group-c";
    await addAccount(user.id, thirdId);
    await addRule(user.id, "page-group-rule-2", thirdId, targetId);
    await runInDurableObject(target, (_instance, state) => state.storage.deleteAlarm());
    await target.injectFakeFault({ kind: "reads_fail", error: "token", count: 5 });
    await removeAccounts(env, user, [sourceId, thirdId, targetId]);
    await env.DB.prepare(
      "UPDATE cleanup_tombstones SET blocks_left = 2, left_estimated = 0 WHERE account_id = ?",
    )
      .bind(targetId)
      .run();
    await env.DB.prepare(
      "UPDATE cleanup_tombstones SET state = 'token_refused' WHERE account_id = ?",
    )
      .bind(targetId)
      .run();

    const text = await page("/cleanup", cookie);

    expect(text).toContain(en.cleanup.count(4));
    expect(text).toContain(await ruleTagFor(ruleId));
    expect(text).toContain(await ruleTagFor("page-group-rule-2"));
  });

  it("is named on the home page", async () => {
    const { cookie } = await ended("page-home");
    expect(await page("/", cookie)).toContain('href="/cleanup"');
  });

  it("speaks German", async () => {
    const { cookie } = await ended("page-german");
    const text = await exports.default.fetch(`${BASE}/cleanup`, {
      headers: { cookie: `${cookie}; lang=de` },
    });
    expect(await text.text()).toContain(de.cleanup.reconnectDoesNotHelp);
  });
});

/** Stop a rule with a hold whose lease ended. */
function holdRule(ruleId: string, until = 0) {
  return env.DB.batch([
    env.DB.prepare("INSERT INTO rule_holds VALUES (?, 'old', ?)").bind(ruleId, until),
    env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId),
  ]);
}

/** Refuse the next token of the job, so that it ends with a rest. */
async function failedRequestLeavesRest(name: string) {
  const context = await setup(name);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));
  await context.target.injectFakeFault({ kind: "reads_fail", error: "server", count: 5 });
  expect((await post(`/accounts/${context.sourceId}/disconnect`, context.cookie)).status).toBe(500);
  expect(await ruleEnabled(context.ruleId)).toBe(1);
  for (let attempt = 0; attempt < 5; attempt++) {
    const job = (await removalsOf(context.target))?.[0];
    if (job?.notBefore) advance(Math.max(0, job.notBefore - Date.now()));
    await runDurableObjectAlarm(context.target);
  }
  expect((await tombstoneOf(context.targetId))?.state).toBe("incomplete");
  return context;
}

describe("a removal that still runs", () => {
  it("is no rest on the page and on the home page, right after a healthy disconnect", async () => {
    const { cookie, target, targetId, sourceId, ruleId } = await setup(
      "run-page",
      "run-page@org.example",
    );
    await post(`/accounts/${sourceId}/disconnect`, cookie);

    const home = await page("/", cookie);
    const text = await page("/cleanup", cookie);

    expect(home).not.toContain(en.cleanup.notice(1));
    expect(home).toContain(en.cleanup.runningNotice(1));
    const { formatDate } = i18nFor("en");
    const stone = await tombstoneOf(targetId);
    expect(text).toContain(en.cleanup.runningTitle);
    expect(text).toContain(en.cleanup.running(formatDate(stone?.deadline_at ?? "")));
    expect(text).not.toContain(en.cleanup.lead);
    expect(text).not.toContain(en.cleanup.reconnectDoesNotHelp);
    expect(text).not.toContain(await ruleTagFor(ruleId));

    await runDurableObjectAlarm(target);

    expect(await page("/", cookie)).not.toContain(en.cleanup.runningNotice(1));
    expect(await page("/cleanup", cookie)).toContain(en.cleanup.empty);
  });

  it("stands apart from a rest in the same calendar", async () => {
    const { user, cookie, sourceId, targetId, ruleId } = await setup(
      "run-both",
      "run-both@org.example",
    );
    await addAccount(user.id, "run-both-c");
    await addRule(user.id, "run-both-rule-2", "run-both-c", targetId);
    await removeAccounts(env, user, [sourceId, "run-both-c"]);
    await env.DB.prepare("UPDATE cleanup_tombstones SET state = 'deadline' WHERE rule_id = ?")
      .bind(ruleId)
      .run();

    const text = await page("/cleanup", cookie);

    expect(text).toContain(en.cleanup.lead);
    expect(text).toContain(await ruleTagFor(ruleId));
    expect(text).toContain(en.cleanup.runningTitle);
    expect(text).not.toContain(await ruleTagFor("run-both-rule-2"));
    expect(await page("/", cookie)).toContain(en.cleanup.notice(1));
  });

  it("is no rest for an admin link", async () => {
    const { user, sourceId } = await setup("run-admin", "run-admin@org.example");
    const admin = await signIn("admin@example.com");
    const before = await page("/admin", admin.cookie);
    const link = (text: string) => /[^>]*left in \d+ calendars?/.exec(text)?.[0];

    await removeAccounts(env, user, [sourceId]);
    await env.DB.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(user.id).run();

    expect(link(await page("/admin", admin.cookie))).toBe(link(before));
  });
});

describe("a tombstone without a job", () => {
  const closes = JOBLESS_TOMBSTONE_MS + 60_000;

  function queueingFails() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "queueRemovals").mockRejectedValueOnce(new Error("lost"));
  }

  async function paused(name: string) {
    const context = await setup(name, `${name}@org.example`);
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(context.ruleId).run();
    queueingFails();
    await post(`/accounts/${context.sourceId}/disconnect`, context.cookie);
    expect(await removalsOf(context.target)).toBeUndefined();
    expect(await tombstoneOf(context.targetId)).toMatchObject({ state: "open", deadline_at: null });
    return context;
  }

  it("of a paused rule closes soon, with a result in the log", async () => {
    const { target, targetId, ruleId } = await paused("ghost-rule");

    advance(closes);
    await target.tick();
    await runCron();

    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "not_started",
      blocks_left: null,
      left_estimated: 0,
    });
    expect((await tombstoneOf(targetId))?.finished_at).not.toBeNull();
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([
      expect.objectContaining({ rule_id: ruleId, detail: { result: "not_started", removed: 0 } }),
    ]);
    const again = await signIn("ghost-rule@org.example");
    const text = await page("/cleanup", again.cookie);
    expect(text).toContain(en.cleanup.reasons.not_started);
    expect(text).toContain(en.cleanup.unknownCount);
    expect(text).not.toContain(en.cleanup.runningTitle);
  });

  it("of a deactivation closes soon, and asks for the removal by hand", async () => {
    const { user, targetId } = await setup("ghost-user", "ghost-user@org.example");
    queueingFails();
    expect((await patchActive(user.id, false)).status).toBe(500);
    expect((await tombstoneOf(targetId))?.state).toBe("open");

    advance(closes);
    await runCron();

    expect((await tombstoneOf(targetId))?.state).toBe("not_started");
  });

  it("lets a repeated deactivation start the job that never started", async () => {
    const { user, target, targetId } = await setup("ghost-again", "ghost-again@org.example");
    queueingFails();
    expect((await patchActive(user.id, false)).status).toBe(500);
    advance(closes);
    await runCron();

    expect((await patchActive(user.id, false)).status).toBe(200);
    expect(await removalsOf(target)).toHaveLength(1);
    expect((await tombstoneOf(targetId))?.state).toBe("open");
    await runDurableObjectAlarm(target);

    expect(await blocksIn(target)).toBe(0);
    expect((await eventsOf(targetId, "cleanup_finished")).map((event) => event.detail)).toEqual([
      { result: "not_started", removed: 0 },
      { result: "removed", removed: 1 },
    ]);
  });

  it("stays open for the time a request needs, and is once only in the log", async () => {
    const { targetId } = await paused("ghost-early");

    await cronAt(Date.now() + JOBLESS_TOMBSTONE_MS - 60_000);
    expect((await tombstoneOf(targetId))?.state).toBe("open");

    await cronAt(Date.now() + 120_000);
    expect((await tombstoneOf(targetId))?.state).toBe("not_started");
    await runCron();
    expect(await eventsOf(targetId, "cleanup_finished")).toHaveLength(1);
  });

  it("does not count as a removal that runs", async () => {
    const { cookie } = await paused("ghost-page");

    const text = await page("/cleanup", cookie);

    expect(text).toContain(en.cleanup.empty);
    expect(text).not.toContain(en.cleanup.runningTitle);
    expect(await page("/", cookie)).not.toContain(en.cleanup.runningNotice(1));
  });

  it("of a rule that runs closes without asking for anything", async () => {
    const email = "ghost-runs@org.example";
    const { cookie, target, sourceId, targetId, ruleId } = await setup("ghost-runs", email);
    queueingFails();
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    expect(await ruleEnabled(ruleId)).toBe(1);

    advance(closes);
    await runCron();

    expect(await blocksIn(target)).toBe(1);
    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "kept",
      remote_calendar_id: null,
      calendar_name: null,
      block_title: null,
      finished_at: expect.any(String),
    });
    expect((await eventsOf(targetId, "cleanup_finished")).map((event) => event.detail)).toEqual([
      { result: "kept", removed: 0 },
    ]);
    const again = await signIn(email);
    const activity = await page("/activity", again.cookie);
    expect(activity).toContain(en.activity.cleanupReasons.kept);
    expect(activity).not.toContain(en.activity.cleanupReasons.not_started);
    expect(await page("/cleanup", again.cookie)).toContain(en.cleanup.empty);
  });

  it("that closed as kept shows no rest if the rule stops later", async () => {
    const email = "ghost-kept-off@org.example";
    const { user, cookie, sourceId, targetId, ruleId } = await setup("ghost-kept-off", email);
    queueingFails();
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    advance(closes);
    await runCron();
    await env.DB.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(user.id).run();
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();

    expect((await tombstoneOf(targetId))?.state).toBe("kept");
    expect(await ownCleanups(env.DB, user.id)).toEqual({ left: [], running: [] });
  });

  it("gets the full time again from a new request that fails", async () => {
    const { sourceId, targetId } = await paused("ghost-twice");
    advance(closes);
    await runCron();
    expect((await tombstoneOf(targetId))?.state).toBe("not_started");

    queueingFails();
    const again = await signIn("ghost-twice@org.example");
    await post(`/accounts/${sourceId}/disconnect`, again.cookie);
    expect((await tombstoneOf(targetId))?.state).toBe("open");
    await cronAt(Date.now() + JOBLESS_TOMBSTONE_MS - 60_000);

    expect((await tombstoneOf(targetId))?.state).toBe("open");
  });

  it("waits until the rule of a dead request runs again", () => {
    expect(JOBLESS_TOMBSTONE_MS).toBeGreaterThan(HOLD_LEASE_MS + CRON_TICK_MS);
  });

  it("gives way to the result of a job that ends later, without a second event", async () => {
    const { user, target, targetId, ruleId } = await paused("ghost-late");
    advance(closes);
    await runCron();
    expect((await tombstoneOf(targetId))?.state).toBe("not_started");

    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    await runDurableObjectAlarm(target);

    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "removed",
      finished_at: expect.any(String),
    });
    expect((await eventsOf(targetId, "cleanup_finished")).map((event) => event.detail)).toEqual([
      { result: "not_started", removed: 0 },
    ]);
  });

  it("keeps the numbers of a job that got no deadline in the log", async () => {
    const { targetId, ruleId } = await paused("ghost-count");
    await noteTombstoneProgress(env.DB, { accountId: targetId, ruleId }, 2, 3).run();

    advance(closes);
    await runCron();

    expect((await eventsOf(targetId, "cleanup_finished")).map((event) => event.detail)).toEqual([
      { result: "not_started", removed: 2, left: 3 },
    ]);
  });

  it("of a rule that the user deleted goes, and asks for nothing", async () => {
    const email = "ghost-deleted@org.example";
    const { cookie, target, sourceId, targetId, ruleId } = await setup("ghost-deleted", email);
    queueingFails();
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    await post(`/rules/${ruleId}/delete`, cookie);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    expect(await tombstoneOf(targetId)).toMatchObject({ state: "open", deadline_at: null });

    await cronAt(Date.now() + JOBLESS_TOMBSTONE_MS - 60_000);
    expect((await tombstoneOf(targetId))?.state).toBe("open");

    await cronAt(Date.now() + 120_000);

    expect(await tombstoneOf(targetId)).toBeNull();
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([]);
    const again = await signIn(email);
    expect(await page("/cleanup", again.cookie)).toContain(en.cleanup.empty);
    expect(await page("/", again.cookie)).not.toContain(en.cleanup.notice(1));
  });

  it("of a rule that was paused and then deleted goes too", async () => {
    const { cookie, targetId, ruleId } = await paused("ghost-off-deleted");
    await post(`/rules/${ruleId}/delete`, cookie);

    advance(closes);
    await runCron();

    expect(await tombstoneOf(targetId)).toBeNull();
  });

  it("of a rule that the user stopped goes, and asks for nothing", async () => {
    const email = "ghost-stopped@org.example";
    const { cookie, target, sourceId, targetId, ruleId } = await setup("ghost-stopped", email);
    queueingFails();
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    await post(`/rules/${ruleId}/pause`, cookie);
    expect(await ruleEnabled(ruleId)).toBe(0);
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }]);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);

    advance(closes);
    await runCron();

    expect(await tombstoneOf(targetId)).toBeNull();
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([]);
    const again = await signIn(email);
    expect(await page("/cleanup", again.cookie)).toContain(en.cleanup.empty);
  });

  it("of a rule that a request still holds closes with a doubt", async () => {
    const name = "ghost-held";
    const { cookie, sourceId, targetId, ruleId } = await setup(name, `${name}@org.example`);
    queueingFails();
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    await holdRule(ruleId, Date.now() + 10 * DAY);

    advance(closes);
    await runCron();

    expect((await tombstoneOf(targetId))?.state).toBe("not_started");
  });

  it("of a rule that stopped for a deactivated user closes with a doubt", async () => {
    const name = "ghost-stopped-user";
    const { user, cookie, sourceId, targetId, ruleId } = await setup(name, `${name}@org.example`);
    queueingFails();
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    await post(`/rules/${ruleId}/pause`, cookie);
    await env.DB.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(user.id).run();

    advance(closes);
    await runCron();

    expect((await tombstoneOf(targetId))?.state).toBe("not_started");
  });

  it("that the cron removed gets a row from a job that ends later", async () => {
    const name = "ghost-gone-job";
    const context = await setup(name, `${name}@org.example`);
    const { user, cookie, target, sourceId, targetId, ruleId } = context;
    queueingFails();
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    await post(`/rules/${ruleId}/pause`, cookie);
    advance(closes);
    await runCron();
    expect(await tombstoneOf(targetId)).toBeNull();

    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id, accountId: targetId },
    });
    await runDurableObjectAlarm(target);

    expect((await tombstoneOf(targetId))?.state).toBe("removed");
    expect((await eventsOf(targetId, "cleanup_finished")).map((event) => event.detail)).toEqual([
      { result: "removed", removed: 1 },
    ]);
  });

  it("names only what is known, also that a reconnect can still finish the removal", async () => {
    const { targetId } = await paused("ghost-unknown");
    advance(closes);
    await runCron();
    expect((await tombstoneOf(targetId))?.state).toBe("not_started");

    const { cookie } = await signIn("ghost-unknown@org.example");
    const text = await page("/cleanup", cookie);
    expect(text).toContain("The state of this removal is not known");
    expect(text).toContain("Blocks may be left");
    expect(text).toContain("Connecting the account again can still finish the removal");
    expect(text).toContain("Otherwise delete them by hand");
    expect(text).not.toContain("could not start");
    expect(text).not.toContain("slotmirror could not remove these blocks");
    expect(text).not.toContain("Connecting the account again does not remove them.");

    const activity = await page("/activity", cookie);
    expect(activity).toContain(en.activity.cleanupReasons.not_started);
    expect(activity).not.toContain("could not start");

    const reason = de.cleanup.reasons.not_started;
    expect(reason).toContain("Der Stand dieser Entfernung ist nicht bekannt");
    expect(reason).toContain("können Blöcke übrig sein");
    expect(reason).toContain("kann die Entfernung noch abschließen");
    expect(reason).toContain("Sonst lösche sie von Hand");
    expect(de.cleanup.lead).not.toContain("konnte diese Blöcke nicht entfernen");
    expect(de.cleanup.reconnectDoesNotHelp).not.toBe(
      "Ein erneutes Verbinden des Kontos entfernt sie nicht.",
    );
    expect(de.activity.cleanupReasons.not_started).not.toContain("konnte nicht starten");
  });
});

describe("a tombstone with a job", () => {
  const closes = JOBLESS_TOMBSTONE_MS + 60_000;

  async function waiting(name: string) {
    const context = await setup(name, `${name}@org.example`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await pause(context.target);
    await flagReconnect(context.targetId);
    return context;
  }

  function queueingFails() {
    vi.spyOn(AccountSync.prototype, "queueRemovals").mockRejectedValueOnce(new Error("lost"));
  }

  it("stays open if the rule goes while the job runs, and takes the job's result", async () => {
    const email = "job-rule-gone@org.example";
    const { cookie, target, sourceId, targetId, ruleId } = await setup("job-rule-gone", email);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));
    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);
    expect(await ruleEnabled(ruleId)).toBe(1);
    const deadline = (await tombstoneOf(targetId))?.deadline_at;
    expect(deadline).not.toBeNull();

    await post(`/rules/${ruleId}/delete`, cookie);

    expect(await rowExists("rules", ruleId)).toBe(false);
    expect(await tombstoneOf(targetId)).toMatchObject({ state: "open", deadline_at: deadline });
    expect(await page("/cleanup", cookie)).toContain(en.cleanup.runningTitle);

    await runDurableObjectAlarm(target);

    expect(await blocksIn(target)).toBe(0);
    expect((await tombstoneOf(targetId))?.state).toBe("removed");
    expect((await eventsOf(targetId, "cleanup_finished")).map((event) => event.detail)).toEqual([
      { result: "removed", removed: 1 },
    ]);
  });

  it("takes its deadline from the job", async () => {
    const { cookie, target, sourceId, targetId } = await setup("job-deadline");

    await post(`/accounts/${sourceId}/disconnect`, cookie);

    expect((await removalsOf(target))?.[0]).toMatchObject({
      offboarding: { since: Date.now() },
    });
    expect((await tombstoneOf(targetId))?.deadline_at).toBe(
      new Date(Date.now() + CLEANUP_DEADLINE_MS).toISOString(),
    );
  });

  it("stays open past its deadline, and ends once, if the job is throttled", async () => {
    const email = "job-throttled@org.example";
    const { cookie, target, sourceId, targetId } = await setup("job-throttled", email);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "throttled" });
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    await runDurableObjectAlarm(target);
    expect(await removalsOf(target)).toHaveLength(1);
    const deadline = (await tombstoneOf(targetId))?.deadline_at ?? "";

    advance(CLEANUP_DEADLINE_MS + 2 * closes);
    await runCron();

    expect((await tombstoneOf(targetId))?.state).toBe("open");
    expect(await eventsOf(targetId, "cleanup_finished")).toEqual([]);
    const text = await page("/cleanup", (await signIn(email)).cookie);
    expect(text).toContain(en.cleanup.runningTitle);
    expect(text).not.toContain(en.cleanup.running(i18nFor("en").formatDate(deadline)));

    await runDurableObjectAlarm(target);

    expect((await tombstoneOf(targetId))?.state).toBe("removed");
    // The clock passed the block, so the removal leaves it as a record.
    expect((await eventsOf(targetId, "cleanup_finished")).map((event) => event.detail)).toEqual([
      { result: "removed", removed: 0 },
    ]);
  });

  it("gets a new deadline from a retry after the first request could not queue", async () => {
    const { cookie, target, sourceId, targetId } = await waiting("job-retry");
    queueingFails();
    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);
    advance(13 * DAY);
    await runCron();

    const email = "job-retry@org.example";
    const again = (await signIn(email)).cookie;
    expect((await post(`/accounts/${sourceId}/disconnect`, again)).status).toBe(302);
    expect((await tombstoneOf(targetId))?.deadline_at).toBe(
      new Date(Date.now() + CLEANUP_DEADLINE_MS).toISOString(),
    );

    advance(DAY + closes);
    await runCron();
    expect((await tombstoneOf(targetId))?.state).toBe("open");
    expect(await removalsOf(target)).toHaveLength(1);
    const text = await page("/cleanup", (await signIn(email)).cookie);
    expect(text).not.toContain(en.cleanup.reasons.not_started);
    expect(text).toContain(en.cleanup.runningTitle);

    advance(CLEANUP_DEADLINE_MS - DAY - closes);
    await target.tick();

    expect(await removalsOf(target)).toBeUndefined();
    expect((await tombstoneOf(targetId))?.state).toBe("deadline");
    expect((await eventsOf(targetId, "cleanup_finished")).map((event) => event.detail)).toEqual([
      { result: "kept", removed: 0 },
      { result: "deadline", removed: 0, left: 1, estimated: true },
    ]);
  });

  it("gets its deadline from a retry within the hour, and the cron leaves it", async () => {
    const { cookie, target, sourceId, targetId } = await waiting("job-retry-soon");
    queueingFails();
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    advance(10 * 60_000);

    const again = await signIn("job-retry-soon@org.example");
    expect((await post(`/accounts/${sourceId}/disconnect`, again.cookie)).status).toBe(302);
    expect((await tombstoneOf(targetId))?.deadline_at).toBe(
      new Date(Date.now() + CLEANUP_DEADLINE_MS).toISOString(),
    );

    advance(closes);
    await runCron();

    expect((await tombstoneOf(targetId))?.state).toBe("open");
    expect(await removalsOf(target)).toHaveLength(1);
  });

  it("gets a new deadline from a new offboarding after the old one ended", async () => {
    const { user, target, targetId, ruleId } = await waiting("job-second");
    await patchActive(user.id, false);
    advance(CLEANUP_DEADLINE_MS);
    await target.tick();
    expect((await tombstoneOf(targetId))?.state).toBe("deadline");
    await patchActive(user.id, true);
    expect(await ruleEnabled(ruleId)).toBe(1);

    await patchActive(user.id, false);

    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "open",
      deadline_at: new Date(Date.now() + CLEANUP_DEADLINE_MS).toISOString(),
    });
  });

  it("keeps the deadline of a job that a repeated request takes over", async () => {
    const { user, target, targetId, ruleId } = await waiting("job-repeat");
    const job = [{ ruleId, remoteCalendarId: CALENDAR }];
    const offboarding = { orgId: user.orgId, userId: user.id, accountId: targetId };
    await env.DB.prepare(
      `INSERT INTO cleanup_tombstones (account_id, rule_id, org_id, user_id, rule_tag)
       VALUES (?, ?, ?, ?, 'tag')`,
    )
      .bind(targetId, ruleId, user.orgId, user.id)
      .run();
    await target.queueRemovals(job, { offboarding });
    const first = (await tombstoneOf(targetId))?.deadline_at;

    advance(DAY);
    await target.queueRemovals(job, { offboarding });

    expect((await tombstoneOf(targetId))?.deadline_at).toBe(first);
  });

  it("keeps the alarm of its job if D1 does not take the deadline", async () => {
    const { user, target, targetId, ruleId } = await setup("job-no-mark-alarm");
    await changeObjectEnv(target, (base) =>
      envWithRefusal((query) => query.includes("SET deadline_at"), base),
    );
    await runInDurableObject(target, (_instance, state) => state.storage.deleteAlarm());

    const refused = await runInDurableObject(target, (instance) =>
      (instance as unknown as AccountSync)
        .queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
          offboarding: { orgId: user.orgId, userId: user.id, accountId: targetId },
        })
        .then(
          () => false,
          () => true,
        ),
    );

    expect(refused).toBe(true);
    expect(await removalsOf(target)).toHaveLength(1);
    expect(await alarmAt(target)).not.toBeNull();
  });

  it("fails the request if D1 does not take the deadline, and a retry sets it", async () => {
    const { cookie, target, sourceId, targetId } = await setup("job-no-mark");
    vi.spyOn(console, "error").mockImplementation(() => {});
    let outage = true;
    await changeObjectEnv(target, (base) =>
      envWithRefusal((query) => outage && query.includes("SET deadline_at"), base),
    );

    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(500);
    expect(await removalsOf(target)).toHaveLength(1);
    expect((await tombstoneOf(targetId))?.deadline_at).toBeNull();

    outage = false;
    expect((await post(`/accounts/${sourceId}/disconnect`, cookie)).status).toBe(302);

    expect((await tombstoneOf(targetId))?.deadline_at).not.toBeNull();
  });
});

describe("the estimate of a job that cannot read", () => {
  it("does not use the last run of a rule that was off before the offboarding", async () => {
    const email = "est-off@org.example";
    const { cookie, target, targetId, ruleId } = await setup("est-off", email);
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    await target.queueRemoval(ruleId, CALENDAR);
    await runDurableObjectAlarm(target);
    expect(await blocksIn(target)).toBe(0);
    await runInDurableObject(target, (_instance, state) => state.storage.deleteAlarm());
    vi.spyOn(console, "error").mockImplementation(() => {});
    await target.injectFakeFault({ kind: "reads_fail", error: "token", count: 5 });

    await post(`/accounts/${targetId}/disconnect`, cookie);
    for (let i = 0; i < 12 && (await removalsOf(target)) !== undefined; i++) {
      const job = (await removalsOf(target))?.[0];
      if (job?.notBefore && job.notBefore > Date.now()) advance(job.notBefore - Date.now());
      await runDurableObjectAlarm(target);
    }

    expect(await tombstoneOf(targetId)).toMatchObject({ blocks_left: null, left_estimated: 0 });
    expect((await eventsOf(targetId, "cleanup_finished"))[0]?.detail).toEqual({
      result: "token_refused",
      removed: 0,
    });
    const text = await page("/cleanup", (await signIn(email)).cookie);
    expect(text).not.toContain(en.cleanup.aboutCount(1));
    expect(text).toContain(en.cleanup.unknownCount);
  });

  it("still uses the last run of a rule that another request holds", async () => {
    const { user, target, sourceId, targetId, ruleId } = await setup("est-held");
    await holdRule(ruleId, Date.now() + HOLD_LEASE_MS);
    await target.injectFakeFault({ kind: "reads_fail", error: "token", count: 5 });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await removeAccounts(env, user, [sourceId]);
    await runAttempts(target, 5);

    expect(await tombstoneOf(targetId)).toMatchObject({ blocks_left: 1, left_estimated: 1 });
  });
});

describe("the data of a tombstone", () => {
  function rowsOf(accountId: string) {
    return env.DB.prepare("SELECT COUNT(*) AS n FROM cleanup_tombstones WHERE account_id = ?")
      .bind(accountId)
      .first<{ n: number }>();
  }

  it("names no calendar and no title once the blocks went, also after a lost answer", async () => {
    const { cookie, target, targetId } = await setup("data-removed", "data-removed@org.example");
    await post("/account/delete", cookie);
    expect((await tombstoneOf(targetId))?.remote_calendar_id).toBe(CALENDAR);
    expect((await tombstoneOf(targetId))?.block_title).not.toBeNull();

    await loseFirstBatchAnswer(target);
    await runDurableObjectAlarm(target);
    await runDurableObjectAlarm(target);

    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "removed",
      remote_calendar_id: null,
      calendar_name: null,
      block_title: null,
    });
    expect((await rowsOf(targetId))?.n).toBe(1);
  });

  it("keeps them while the user needs them for a rest", async () => {
    const { target, targetId, user, sourceId } = await setup("data-rest");
    await target.injectFakeFault({ kind: "reads_fail", error: "token", count: 5 });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await removeAccounts(env, user, [sourceId]);
    await runAttempts(target, 5);

    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "token_refused",
      remote_calendar_id: CALENDAR,
      calendar_name: "Cal",
    });
    expect((await tombstoneOf(targetId))?.block_title).not.toBeNull();
  });

  it("opens again with the calendar for a new job", async () => {
    const { user, target, sourceId, targetId, ruleId } = await setup("data-again");
    await removeAccounts(env, user, [sourceId]);
    await runDurableObjectAlarm(target);
    expect((await tombstoneOf(targetId))?.remote_calendar_id).toBeNull();

    await addAccount(user.id, sourceId).catch(() => undefined);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, '{}')",
    )
      .bind(ruleId, user.id, `${sourceId}-main`, `${targetId}-main`)
      .run();
    await removeAccounts(env, user, [sourceId]);

    expect(await tombstoneOf(targetId)).toMatchObject({
      state: "open",
      remote_calendar_id: CALENDAR,
    });
    expect((await rowsOf(targetId))?.n).toBe(1);
  });
});

/** Let D1 apply the next batch of the object, and lose its answer. */
function loseFirstBatchAnswer(stub: Stub): Promise<void> {
  let first = true;
  return changeObjectEnv(stub, (base) => {
    const db = new Proxy(base.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const answer = await target.batch(statements);
            if (!first) return answer;
            first = false;
            throw new Error("Network connection lost.");
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value.bind(target) as unknown) : value;
      },
    });
    return new Proxy(base, {
      get: (target, property) => (property === "DB" ? db : Reflect.get(target, property)),
    });
  });
}

describe("a result that D1 cannot take", () => {
  it("spaces the alarms by a minute, also with a job that is due", async () => {
    const { user, target, targetId, ruleId } = await setup("space");
    await addAccount(user.id, "space-c");
    await addRule(user.id, "space-rule-2", "space-c", targetId);
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id IN (?, ?)")
      .bind(ruleId, "space-rule-2")
      .run();
    await target.queueRemovals(
      [
        { ruleId, remoteCalendarId: CALENDAR },
        { ruleId: "space-rule-2", remoteCalendarId: CALENDAR },
      ],
      { offboarding: { orgId: user.orgId, userId: user.id } },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await changeObjectEnv(target, (base) =>
      envWithRefusal(
        (query) => query.includes("cleanup_tombstones") || query.includes("audit_events"),
        base,
      ),
    );

    await runDurableObjectAlarm(target);
    expect(await reportsOf(target)).toBeDefined();
    expect(await removalsOf(target)).toHaveLength(1);

    for (let alarm = 0; alarm < 3; alarm++) {
      const gap = ((await alarmAt(target)) ?? 0) - Date.now();
      expect(gap).toBeGreaterThanOrEqual(60_000);
      await runDurableObjectAlarm(target);
    }
  });

  it("writes one event if the answer of its D1 step got lost", async () => {
    const { user, target, targetId, ruleId } = await setup("lost-answer");
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();
    await target.queueRemovals([{ ruleId, remoteCalendarId: CALENDAR }], {
      offboarding: { orgId: user.orgId, userId: user.id },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await loseFirstBatchAnswer(target);

    await runDurableObjectAlarm(target);
    expect(await reportsOf(target)).toBeDefined();
    await runDurableObjectAlarm(target);

    expect(await reportsOf(target)).toBeUndefined();
    expect(await eventsOf(targetId, "cleanup_finished")).toHaveLength(1);
  });
});

describe("rules that wait in the sweep", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM rule_holds").run();
  });

  async function waitingRules(prefix: string) {
    const { user } = await signIn("owner@example.com");
    await addAccount(user.id, `${prefix}-s`);
    for (const n of [1, 2, 3, 4]) {
      await addAccount(user.id, `${prefix}-t${n}`);
      await addRule(user.id, `${prefix}-a${n}`, `${prefix}-s`, `${prefix}-t${n}`);
      await holdRule(`${prefix}-a${n}`);
    }
    await addAccount(user.id, `${prefix}-x`);
    await addAccount(user.id, `${prefix}-y`);
    await addRule(user.id, `${prefix}-z`, `${prefix}-x`, `${prefix}-y`);
    await holdRule(`${prefix}-z`);
    await stubOf(`${prefix}-s`).retire("g");
  }

  it("do not block a rule behind them", async () => {
    await waitingRules("wait");

    for (let cron = 0; cron < 2; cron++) {
      await sweepNow();
      advance(10 * 60_000);
    }

    expect(await ruleEnabled("wait-z")).toBe(1);
    expect(await ruleEnabled("wait-a1")).toBe(0);
  });

  it("do not block a rule at the limit of one rule per cron", async () => {
    await waitingRules("wait-one");

    for (let cron = 0; cron < 5; cron++) {
      expect(await sweepNow(3)).toBeLessThanOrEqual(3);
      advance(10 * 60_000);
    }

    expect(await ruleEnabled("wait-one-z")).toBe(1);
  });

  it("stay out of the next cron", async () => {
    await waitingRules("wait-lease");
    await sweepNow();

    advance(10 * 60_000);

    const { results } = await heldRulesStatement(env, Date.now()).all<HeldRule>();
    expect(results.map((rule) => rule.ruleId)).toEqual(["wait-lease-z"]);
  });

  it("come back once their lease ends", async () => {
    await waitingRules("wait-back");
    await sweepNow();

    advance(HOLD_LEASE_MS);

    const { results } = await heldRulesStatement(env, Date.now()).all<HeldRule>();
    expect(results.map((rule) => rule.ruleId)).toContain("wait-back-a1");
  });

  it("do not block a rule of another user if an account without tokens never ends", async () => {
    const { user, source, sourceId, ruleId } = await setup("wait-none");
    await source.forget();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusing = envWithRefusal((query) => query.startsWith("DELETE FROM accounts"));
    await expect(removeAccounts(refusing, user, [sourceId])).rejects.toThrow();
    expect(await source.retiring()).toBe(true);
    expect(await ruleEnabled(ruleId)).toBe(0);
    const other = await signIn("other@elsewhere.org");
    await addAccount(other.user.id, "wait-none-x");
    await addAccount(other.user.id, "wait-none-y");
    await addRule(other.user.id, "wait-none-z", "wait-none-x", "wait-none-y");
    advance(HOLD_LEASE_MS);
    await holdRule("wait-none-z", Date.now());

    for (let cron = 0; cron < 2; cron++) {
      await sweepNow(3);
      advance(10 * 60_000);
    }

    expect(await ruleEnabled("wait-none-z")).toBe(1);
    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await holdsOf(ruleId)).toBe(1);
  });
});

describe("a repeated deactivation", () => {
  it("leaves an ended tombstone alone and queues no job", async () => {
    const { user, target, targetId } = await setup("repeat", "repeat@org.example");
    await pause(target);
    await flagReconnect(targetId);
    expect((await patchActive(user.id, false)).status).toBe(200);
    advance(CLEANUP_DEADLINE_MS);
    await target.tick();
    const before = await tombstoneOf(targetId);
    expect(before?.state).toBe("deadline");

    advance(DAY);
    expect((await patchActive(user.id, false)).status).toBe(200);

    expect(await tombstoneOf(targetId)).toEqual(before);
    expect(await removalsOf(target)).toBeUndefined();
  });

  it("leaves a removed tombstone alone and queues no job", async () => {
    const { user, target, targetId } = await setup("repeat-done", "repeat-done@org.example");
    expect((await patchActive(user.id, false)).status).toBe(200);
    await runDurableObjectAlarm(target);
    const before = await tombstoneOf(targetId);
    expect(before?.state).toBe("removed");

    expect((await patchActive(user.id, false)).status).toBe(200);

    expect(await tombstoneOf(targetId)).toEqual(before);
    expect(await removalsOf(target)).toBeUndefined();
  });

  it("still queues a job whose tombstone is open", async () => {
    const { user, target, targetId } = await setup("repeat-open", "repeat-open@org.example");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "queueRemovals").mockRejectedValueOnce(new Error("lost"));
    expect((await patchActive(user.id, false)).status).toBe(500);
    expect(await removalsOf(target)).toBeUndefined();

    expect((await patchActive(user.id, false)).status).toBe(200);

    expect(await removalsOf(target)).toHaveLength(1);
    expect((await tombstoneOf(targetId))?.state).toBe("open");
  });

  it("opens a new offboarding after a reactivation", async () => {
    const { user, target, targetId } = await setup("repeat-new", "repeat-new@org.example");
    expect((await patchActive(user.id, false)).status).toBe(200);
    await runDurableObjectAlarm(target);
    expect((await tombstoneOf(targetId))?.state).toBe("removed");
    expect((await patchActive(user.id, true)).status).toBe(200);

    expect((await patchActive(user.id, false)).status).toBe(200);

    expect((await tombstoneOf(targetId))?.state).toBe("open");
    expect(await removalsOf(target)).toHaveLength(1);
  });

  it("changes nothing if the tombstones cannot be written", async () => {
    const { user, target, targetId } = await setup("repeat-step", "repeat-step@org.example");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusing = envWithRefusal((query) => query.includes("INTO cleanup_tombstones"));

    await expect(setUserActive(refusing, user, false, "scim")).rejects.toThrow();

    expect(await tombstoneOf(targetId)).toBeNull();
    const row = await env.DB.prepare("SELECT active FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ active: number }>();
    expect(row?.active).toBe(1);
    expect(await removalsOf(target)).toBeUndefined();
  });
});

describe("the sweep and a newer request", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM rule_holds").run();
  });

  it("keeps the fresh hold, and the rule stays off", async () => {
    const { targetId, ruleId } = await setup("fresh-hold");
    await holdRule(ruleId);
    const { results } = await heldRulesStatement(env, Date.now()).all<HeldRule>();
    expect(results).toHaveLength(1);
    await env.DB.prepare("INSERT INTO rule_holds VALUES (?, 'new', ?)")
      .bind(ruleId, Date.now() + HOLD_LEASE_MS)
      .run();

    await releaseHeldRules(env, results, Date.now());

    expect(await ruleEnabled(ruleId)).toBe(0);
    const { results: holds } = await env.DB.prepare(
      "SELECT hold_id FROM rule_holds WHERE rule_id = ?",
    )
      .bind(ruleId)
      .all<{ hold_id: string }>();
    expect(holds).toEqual([{ hold_id: "new" }]);
    expect(await eventsOf(targetId, "rule_enabled")).toEqual([]);
  });

  it("starts the rule once the newer hold ended too", async () => {
    const { targetId, ruleId } = await setup("fresh-end");
    await holdRule(ruleId, Date.now() - 1);
    await env.DB.prepare("INSERT INTO rule_holds VALUES (?, 'new', ?)")
      .bind(ruleId, Date.now())
      .run();

    await sweepHolds();

    expect(await ruleEnabled(ruleId)).toBe(1);
    expect(await holdsOf(ruleId)).toBe(0);
    expect(await eventsOf(targetId, "rule_enabled")).toEqual([
      expect.objectContaining({ detail: { restored: true } }),
    ]);
  });
});

describe("the rest of a rule that ran again", () => {
  it("does not come back if the user pauses the rule", async () => {
    const { target, targetId, ruleId } = await failedRequestLeavesRest("again-pause");
    expect(await target.hasTokens()).toBe(true);
    const { cookie } = await signIn("owner@example.com");
    expect(await page("/cleanup", cookie)).not.toContain(await ruleTagFor(ruleId));

    await post(`/rules/${ruleId}/pause`, cookie);

    expect(await ruleEnabled(ruleId)).toBe(0);
    expect(await page("/cleanup", cookie)).not.toContain(await ruleTagFor(ruleId));
    expect(await tombstoneOf(targetId)).toBeNull();
  });

  it("does not come back if the rule goes", async () => {
    const { targetId, ruleId } = await failedRequestLeavesRest("again-delete");

    await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(ruleId).run();

    expect(await tombstoneOf(targetId)).toBeNull();
  });

  it("stays for a deactivated user whose rule goes off", async () => {
    const { user, targetId, ruleId } = await failedRequestLeavesRest("again-gone");
    await env.DB.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(user.id).run();

    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();

    expect((await tombstoneOf(targetId))?.state).toBe("incomplete");
    await env.DB.prepare("UPDATE users SET active = 1 WHERE id = ?").bind(user.id).run();
  });

  it("keeps an open tombstone: its job still reports", async () => {
    const { cookie, target, sourceId, targetId, ruleId } = await setup("again-open");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccountSync.prototype, "retire").mockRejectedValueOnce(new Error("lost"));
    await post(`/accounts/${sourceId}/disconnect`, cookie);
    expect(await removalsOf(target)).toHaveLength(1);

    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(ruleId).run();

    expect((await tombstoneOf(targetId))?.state).toBe("open");
  });
});

describe("two entries with the same calendar name", () => {
  async function restInTwoCalendars(prefix: string, email = "owner@example.com") {
    const context = await setup(prefix, email);
    const secondId = `${prefix}-c`;
    await addAccount(context.user.id, secondId);
    await addRule(context.user.id, `${prefix}-rule-2`, context.sourceId, secondId);
    await removeAccounts(env, context.user, [context.sourceId]);
    await env.DB.prepare(
      "UPDATE cleanup_tombstones SET state = 'token_refused' WHERE rule_id IN (?, ?)",
    )
      .bind(context.ruleId, `${prefix}-rule-2`)
      .run();
    return { ...context, secondId };
  }

  it("name the account while it exists", async () => {
    const { cookie, targetId, secondId } = await restInTwoCalendars("label");

    const text = await page("/cleanup", cookie);

    expect(text).toContain(`${targetId}@example.com`);
    expect(text).toContain(`${secondId}@example.com`);
  });

  it("name no account for an admin, and no account that went", async () => {
    const { user, cookie, targetId, secondId } = await restInTwoCalendars(
      "label-admin",
      "label-admin@org.example",
    );
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(targetId).run();
    expect(await page("/cleanup", cookie)).not.toContain(`${targetId}@example.com`);

    await env.DB.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(user.id).run();
    const admin = await signIn("admin@example.com");
    expect(await page("/cleanup", admin.cookie)).not.toContain(`${secondId}@example.com`);
  });
});

describe("a report of an object without tokens", () => {
  it("keeps one row if the object does not know its name", async () => {
    const { user, target, sourceId, targetId, ruleId } = await setup("nameless");
    await removeAccounts(env, user, [sourceId]);
    await runInDurableObject(target, (instance, state) => {
      state.storage.sql.exec("DELETE FROM tokens");
      const object = instance as unknown as { ctx: DurableObjectState };
      const anonymous = { toString: () => "0123", equals: () => false };
      object.ctx = new Proxy(object.ctx, {
        get(base, property) {
          if (property === "id") return anonymous;
          const value: unknown = Reflect.get(base, property);
          return typeof value === "function" ? (value.bind(base) as unknown) : value;
        },
      });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runDurableObjectAlarm(target);

    const { results } = await env.DB.prepare(
      "SELECT account_id, state FROM cleanup_tombstones WHERE rule_id = ? ORDER BY account_id",
    )
      .bind(ruleId)
      .all<{ account_id: string; state: string }>();
    expect(results).toEqual([{ account_id: targetId, state: "no_tokens" }]);
  });
});
