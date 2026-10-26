import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSync } from "../src/account-sync";
import { DEDUP_PROPERTY_ID, MARKER_PROPERTY_ID } from "../src/sync/graph-events";
import { inPrecedenceOrder, ruleTagFor } from "../src/sync/plan";
import fixture from "./fixtures/graph/calendar-view.json";
import { BASE, signIn } from "./helpers";

const SOURCE_CAL = "remote-source";
const TARGET_CAL = "remote-target";

/** One account with a source and a target calendar and a rule between them. */
async function setupRule(accountId: string, options: object = {}) {
  const { user } = await signIn("owner@example.com");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(accountId, user.id, `${accountId}@example.com`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, ?, 'Work')",
    ).bind(`${accountId}-src`, accountId, SOURCE_CAL),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, ?, 'Test')",
    ).bind(`${accountId}-dst`, accountId, TARGET_CAL),
    env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      `${accountId}-rule`,
      user.id,
      `${accountId}-src`,
      `${accountId}-dst`,
      JSON.stringify(options),
    ),
  ]);
  const stub = env.ACCOUNT_SYNC.getByName(accountId);
  return { stub, ruleId: `${accountId}-rule` };
}

/** The blocks a run wrote, as the target's calendarView returns them. */
function writtenBlocks(calls: { url: string; init?: RequestInit }[], prefix: string): unknown[] {
  const [template] = fixture.value;
  return calls
    .filter((call) => call.url.endsWith("/$batch"))
    .flatMap((call) => (JSON.parse(call.init?.body as string) as { requests: unknown[] }).requests)
    .map((request, index) => {
      const body = (request as { body: Record<string, unknown> }).body;
      return {
        ...template,
        ...body,
        id: `${prefix}-${index}`,
        type: "singleInstance",
        seriesMasterId: null,
        originalStart: null,
      };
    });
}

/** Fake Graph and token endpoint. Records every request. */
function fakeGraph(target: unknown[] = []) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (url.includes("/oauth2/v2.0/token")) {
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
    }
    // Also matches further source calendars such as `remote-source-2`.
    if (url.includes(`/calendars/${SOURCE_CAL}`)) return Response.json({ value: fixture.value });
    if (url.includes(`/calendars/${TARGET_CAL}/calendarView`))
      return Response.json({ value: target });
    if (url.endsWith("/$batch")) {
      const body = JSON.parse(init?.body as string) as {
        requests: { id: string; method: string }[];
      };
      return Response.json({
        responses: body.requests.map((request) => ({
          id: request.id,
          status: request.method === "DELETE" ? 204 : 201,
        })),
      });
    }
    return new Response("unexpected", { status: 500 });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AccountSync.runRule", () => {
  it("plans without writing in a dry run", async () => {
    const { stub, ruleId } = await setupRule("acc-dry");
    await stub.storeTokens("acc-dry", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    const calls = fakeGraph();

    const result = await stub.runRule(ruleId, { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, applied: 0, stats: { create: 15, delete: 0 } });
    expect(calls.some((call) => call.url.endsWith("/$batch"))).toBe(false);
  });

  it("writes all blocks in one batch and marks every block", async () => {
    const { stub, ruleId } = await setupRule("acc-run");
    await stub.storeTokens("acc-run", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    const calls = fakeGraph();

    const result = await stub.runRule(ruleId);
    expect(result).toMatchObject({ applied: 15, failed: 0, remaining: 0 });

    const batch = calls.find((call) => call.url.endsWith("/$batch"));
    const requests = (JSON.parse(batch?.init?.body as string) as { requests: { body: unknown }[] })
      .requests;
    expect(requests).toHaveLength(15);
    for (const request of requests) {
      const body = request.body as {
        subject: string;
        sensitivity: string;
        singleValueExtendedProperties: { id: string; value: string }[];
      };
      expect(body.subject).toBe("Busy");
      expect(body.sensitivity).toBe("private");
      // The marker keeps three parts, so that a deployment from before the dedup key reads it.
      expect(body.singleValueExtendedProperties).toEqual([
        {
          id: MARKER_PROPERTY_ID,
          value: expect.stringMatching(/^[0-9a-f]{12}\.[0-9a-f]{32}\.[0-9a-f]{32}$/),
        },
        { id: DEDUP_PROPERTY_ID, value: expect.stringMatching(/^[0-9a-f]{32}$/) },
      ]);
      expect(body).not.toHaveProperty("attendees");
    }
  });

  it("never deletes blocks that another rule wrote into the same target calendar", async () => {
    const { stub, ruleId } = await setupRule("acc-shared-target");
    await stub.storeTokens("acc-shared-target", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    const [template] = fixture.value;
    const foreignBlock = (id: string, value: string) => ({
      ...template,
      id,
      singleValueExtendedProperties: [{ id: MARKER_PROPERTY_ID, value }],
    });
    const calls = fakeGraph([
      foreignBlock(
        "other-rule",
        "aaaaaaaaaaaa.0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef",
      ),
      foreignBlock("legacy", "0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef"),
    ]);

    const result = await stub.runRule(ruleId, { dryRun: true });
    expect(result.stats).toMatchObject({ create: 15, delete: 0 });
    expect(calls.some((call) => call.url.endsWith("/$batch"))).toBe(false);
  });

  it("writes one block where two rules into one calendar would write equal ones", async () => {
    const { stub, ruleId } = await setupRule("acc-dedupe");
    await stub.storeTokens("acc-dedupe", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    // A second source calendar with the same events, for example a second subscription.
    const owner = await env.DB.prepare("SELECT user_id FROM rules WHERE id = ?")
      .bind(ruleId)
      .first<{ user_id: string }>();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, ?, 'Copy')",
      ).bind("acc-dedupe-src2", "acc-dedupe", `${SOURCE_CAL}-2`),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES (?, ?, ?, ?)",
      ).bind("acc-dedupe-rule-2", owner?.user_id, "acc-dedupe-src2", "acc-dedupe-dst"),
    ]);
    const [first, second] = await inPrecedenceOrder([ruleId, "acc-dedupe-rule-2"]);
    if (!first || !second) throw new Error("no rules");

    // Before the rule with precedence has written, the other rule writes its own blocks.
    let calls = fakeGraph();
    expect(await stub.runRule(second)).toMatchObject({ applied: 15 });
    const copies = writtenBlocks(calls, "copy");
    vi.restoreAllMocks();

    calls = fakeGraph(copies);
    expect(await stub.runRule(first)).toMatchObject({ applied: 15 });
    const kept = writtenBlocks(calls, "kept");
    vi.restoreAllMocks();

    // Then it removes its copies, and the rule with precedence keeps its blocks.
    fakeGraph([...kept, ...copies]);
    expect((await stub.runRule(second, { dryRun: true })).stats).toMatchObject({
      create: 0,
      delete: 15,
    });
    expect((await stub.runRule(first, { dryRun: true })).stats).toMatchObject({
      create: 0,
      update: 0,
      delete: 0,
      unchanged: 15,
    });
  });

  it("refreshes an expired token once and stores the rotated refresh token", async () => {
    const { stub, ruleId } = await setupRule("acc-refresh");
    await stub.storeTokens("acc-refresh", {
      refreshToken: "old-refresh",
      accessToken: "old",
      accessExpiresAt: 0,
    });
    const calls = fakeGraph();

    await stub.runRule(ruleId, { dryRun: true });
    const tokenCalls = calls.filter((call) => call.url.includes("/oauth2/v2.0/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(
      new URLSearchParams(tokenCalls[0]?.init?.body as URLSearchParams).get("refresh_token"),
    ).toBe("old-refresh");

    const graphCall = calls.find((call) => call.url.includes("calendarView"));
    expect(new Headers(graphCall?.init?.headers).get("authorization")).toBe("Bearer new-access");

    // The next run uses the stored new access token without another refresh.
    calls.length = 0;
    await stub.runRule(ruleId, { dryRun: true });
    expect(calls.filter((call) => call.url.includes("/oauth2/v2.0/token"))).toHaveLength(0);
  });

  it("refuses to run a rule in the instance of another account", async () => {
    const { ruleId } = await setupRule("acc-owner");
    const other = env.ACCOUNT_SYNC.getByName("acc-other");
    await other.storeTokens("acc-other", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    let message = "";
    try {
      await other.runRule(ruleId, { dryRun: true });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/target account/);
  });
});

/** Audit rows of one rule, oldest first, with the detail parsed. */
async function auditOf(ruleId: string, kind?: string) {
  const { results } = await env.DB.prepare(
    "SELECT kind, org_id, user_id, account_id, detail FROM audit_events WHERE rule_id = ? ORDER BY id",
  )
    .bind(ruleId)
    .all<{ kind: string; org_id: string; user_id: string; account_id: string; detail: string }>();
  return results
    .filter((row) => !kind || row.kind === kind)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
}

describe("AccountSync audit events", () => {
  it("writes one sync_run per run, marks a dry run, and keeps content out", async () => {
    const { stub, ruleId } = await setupRule("acc-audit");
    await stub.storeTokens("acc-audit", {
      refreshToken: "r-secret",
      accessToken: "a-secret",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    fakeGraph();

    await stub.runRule(ruleId, { dryRun: true });
    expect(await auditOf(ruleId, "sync_run")).toHaveLength(1);
    await stub.runRule(ruleId);

    const events = await auditOf(ruleId, "sync_run");
    expect(events).toHaveLength(2);
    expect(events[0]?.detail).toMatchObject({
      dryRun: true,
      create: 15,
      update: 0,
      delete: 0,
      applied: 0,
    });
    expect(events[1]?.detail).toMatchObject({
      dryRun: false,
      create: 15,
      applied: 15,
      failed: 0,
      remaining: 0,
    });
    expect(typeof events[1]?.detail.durationMs).toBe("number");
    expect(events[1]).toMatchObject({ account_id: "acc-audit", org_id: "default" });
    expect(events[1]?.user_id).toBeTruthy();

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("secret");
    for (const event of fixture.value) {
      if (event.subject) expect(serialized).not.toContain(event.subject);
    }
  });

  it("records token_refresh_failed and sync_failed when an alarm run throws", async () => {
    const { stub, ruleId } = await setupRule("acc-fail");
    await stub.storeTokens("acc-fail", {
      refreshToken: "r-secret",
      accessToken: "a-secret",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { error: "invalid_grant", error_description: "refresh token revoked" },
        { status: 400 },
      ),
    );

    await stub.requestSync();
    await runDurableObjectAlarm(stub);

    const events = await auditOf(ruleId);
    const failed = events.find((event) => event.kind === "sync_failed");
    expect(failed?.detail).toEqual({ code: "token_invalid_grant" });
    const refresh = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE account_id = 'acc-fail' AND kind = 'token_refresh_failed'",
    ).first<{ detail: string }>();
    expect(JSON.parse(refresh?.detail ?? "{}")).toEqual({ code: "token_invalid_grant" });
    expect(JSON.stringify(events)).not.toContain("secret");
  });
});

describe("manual run failures", () => {
  it("records sync_failed for a manual run, but not for a failing preview", async () => {
    const { stub, ruleId } = await setupRule("acc-manual-fail");
    await stub.storeTokens("acc-manual-fail", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );

    await expectRejection(stub.runRule(ruleId, { dryRun: true }));
    expect((await auditOf(ruleId)).filter((event) => event.kind === "sync_failed")).toHaveLength(0);

    await expectRejection(stub.runRule(ruleId));
    const failed = (await auditOf(ruleId)).filter((event) => event.kind === "sync_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toEqual({ code: "token_invalid_grant" });
  });
});

/** RPC rejections must be awaited inside try/catch, or the test runner reports them as unhandled. */
async function expectRejection(promise: Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}

describe("sync status in the UI", () => {
  async function accountsPage(): Promise<string> {
    const { cookie } = await signIn("owner@example.com");
    return (await exports.default.fetch(`${BASE}/`, { headers: { cookie } })).text();
  }

  it("shows In sync after a successful run, and the run on the rules page", async () => {
    const { stub, ruleId } = await setupRule("acc-ui-ok");
    await stub.storeTokens("acc-ui-ok", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    fakeGraph();
    await stub.runRule(ruleId);

    const home = await accountsPage();
    expect(home).toMatch(/status ok" title="[^"]*UTC">In sync · now</);

    // A rule between two calendars that are not main calendars shows under "Other rules".
    const { cookie } = await signIn("owner@example.com");
    const rules = await (
      await exports.default.fetch(`${BASE}/rules`, { headers: { cookie } })
    ).text();
    expect(rules).toContain("Other rules");
    // The short name gets the local part when other tests left more example.com accounts.
    expect(rules).toMatch(/example( \(acc-ui-ok\))? · Work → example( \(acc-ui-ok\))? · Test/);
  });

  it("does not count a dry run as a sync", async () => {
    const { stub, ruleId } = await setupRule("acc-ui-dry");
    await stub.storeTokens("acc-ui-dry", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    fakeGraph();
    await stub.runRule(ruleId, { dryRun: true });

    const html = await accountsPage();
    const row = html.slice(html.indexOf("acc-ui-dry@example.com"));
    expect(row.slice(0, row.indexOf("</li>"))).toContain("Not synced yet");
  });

  it("asks to connect again after the provider refused the refresh token", async () => {
    const { stub } = await setupRule("acc-ui-fail");
    await stub.storeTokens("acc-ui-fail", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    vi.restoreAllMocks();

    const html = await accountsPage();
    const row = html.slice(html.indexOf("acc-ui-fail@example.com"));
    expect(row.slice(0, row.indexOf("</li>"))).toContain(
      'class="status error" href="/auth/microsoft/connect">Connect again<',
    );
    expect(html).toContain('class="reconnect-notice"');
  });

  it("shows the error state after a run that failed for another reason", async () => {
    const { stub } = await setupRule("acc-ui-down");
    await stub.storeTokens("acc-ui-down", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
    );
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    vi.restoreAllMocks();

    const html = await accountsPage();
    const row = html.slice(html.indexOf("acc-ui-down@example.com"));
    expect(row.slice(0, row.indexOf("</li>"))).toMatch(
      /status error" title="[^"]*UTC">Sync failed: token_temporarily_unavailable · now</,
    );
  });
});

describe("alarm queue", () => {
  it("runs one rule per alarm and schedules the next one", async () => {
    const { stub, ruleId } = await setupRule("acc-queue");
    // A second rule in the other direction; it also targets this account.
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) SELECT 'acc-queue-rule-2', user_id, target_calendar_id, source_calendar_id FROM rules WHERE id = ?",
    )
      .bind(ruleId)
      .run();
    await stub.storeTokens("acc-queue", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    fakeGraph();
    const runs = async () =>
      (await auditOf(ruleId)).length + (await auditOf("acc-queue-rule-2")).length;

    await stub.requestSync();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runs()).toBe(1);
    // The second rule is still queued and its alarm is set.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runs()).toBe(2);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("keeps removals queued while another removal runs", async () => {
    const { stub } = await setupRule("acc-race-removal");
    await stub.storeTokens("acc-race-removal", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    // The first Graph read of the removal lets a second removal in before it answers.
    const instance = await runInDurableObject(stub, (object: AccountSync) => object);
    let raced = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("calendarView") && !raced) {
        raced = true;
        void instance.queueRemoval("late-rule", TARGET_CAL);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return Response.json({ value: [] });
    });

    await stub.queueRemoval("first-rule", TARGET_CAL);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(raced).toBe(true);
    const queue = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ ruleId: string }[]>("removalQueue"),
    );
    expect(queue?.map((job) => job.ruleId)).toEqual(["late-rule"]);
  });

  it("gives up a removal whose deletes keep failing, so that the syncs go on", async () => {
    const { stub } = await setupRule("acc-removal-403");
    await stub.storeTokens("acc-removal-403", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    const [template] = fixture.value;
    const tag = await ruleTagFor("gone-rule");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("calendarView")) {
        return Response.json({
          value: [
            {
              ...template,
              id: "stuck",
              singleValueExtendedProperties: [
                {
                  id: MARKER_PROPERTY_ID,
                  value: `${tag}.0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef`,
                },
              ],
            },
          ],
        });
      }
      if (url.endsWith("/$batch")) {
        const body = JSON.parse(init?.body as string) as { requests: { id: string }[] };
        return Response.json({
          responses: body.requests.map((request) => ({ id: request.id, status: 403 })),
        });
      }
      return Response.json({ value: [] });
    });
    const removals = () =>
      runInDurableObject(stub, (_instance, state) => state.storage.get<unknown[]>("removalQueue"));

    await stub.queueRemoval("gone-rule", TARGET_CAL);
    for (let attempt = 1; attempt < 5; attempt++) {
      await runDurableObjectAlarm(stub);
      expect(await removals()).toHaveLength(1);
    }
    await runDurableObjectAlarm(stub);
    expect(await removals()).toBeUndefined();
  });

  it("keeps rules that a tick queues while a rule runs", async () => {
    const { stub, ruleId } = await setupRule("acc-race-tick");
    // A second rule into this account, which the tick queues during the first run.
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) SELECT 'acc-race-tick-rule-2', user_id, target_calendar_id, source_calendar_id FROM rules WHERE id = ?",
    )
      .bind(ruleId)
      .run();
    await stub.storeTokens("acc-race-tick", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    const instance = await runInDurableObject(stub, (object: AccountSync) => object);
    let raced = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("calendarView") && !raced) {
        raced = true;
        void instance.tick();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (url.endsWith("/$batch")) return Response.json({ responses: [] });
      return Response.json({ value: [] });
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("ruleQueue", [ruleId]);
      // A recent full cycle, so that the tick queues only the unwatched rules.
      await state.storage.put("fullCycleAt", Date.now());
      // An alarm for the queue, but no requested full cycle: that would make the tick wait for it.
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(raced).toBe(true);
    const queue = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string[]>("ruleQueue"),
    );
    expect(queue).toContain("acc-race-tick-rule-2");
  });

  it("queues the later rules into the same calendar after a rule removed blocks", async () => {
    const { stub, ruleId } = await setupRule("acc-follow");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES ('acc-follow-src2', 'acc-follow', ?, 'Copy')",
      ).bind(`${SOURCE_CAL}-2`),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) SELECT 'acc-follow-rule-2', user_id, 'acc-follow-src2', target_calendar_id FROM rules WHERE id = ?",
      ).bind(ruleId),
    ]);
    await stub.storeTokens("acc-follow", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    const [first, second] = await inPrecedenceOrder([ruleId, "acc-follow-rule-2"]);
    if (!first || !second) throw new Error("no rules");
    const [template] = fixture.value;
    // A block of the first rule whose source event is gone: the first rule removes it.
    fakeGraph([
      {
        ...template,
        id: "stale",
        singleValueExtendedProperties: [
          {
            id: MARKER_PROPERTY_ID,
            value: `${await ruleTagFor(first)}.0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef`,
          },
        ],
      },
    ]);
    await runInDurableObject(stub, (_instance, state) => state.storage.put("ruleQueue", [first]));
    await stub.requestSync();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const queue = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string[]>("ruleQueue"),
    );
    expect(queue).toEqual([second]);
  });
});

/** Fake Graph whose `$batch` throttles every request after the first `accepted` ones. */
function throttlingGraph(accepted: number, retryAfterSeconds: string) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes(`/calendars/${SOURCE_CAL}/calendarView`))
      return Response.json({ value: fixture.value });
    if (url.includes(`/calendars/${TARGET_CAL}/calendarView`)) return Response.json({ value: [] });
    if (url.endsWith("/$batch")) {
      const body = JSON.parse(init?.body as string) as { requests: { id: string }[] };
      return Response.json({
        responses: body.requests.map((request, index) =>
          index < accepted
            ? { id: request.id, status: 201 }
            : { id: request.id, status: 429, headers: { "Retry-After": retryAfterSeconds } },
        ),
      });
    }
    return new Response("unexpected", { status: 500 });
  });
}

async function alarmIn(stub: DurableObjectStub): Promise<number | null> {
  const at = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
  return at === null ? null : at - Date.now();
}

describe("throttling", () => {
  it("keeps throttled writes open, records their status, and waits for Retry-After", async () => {
    const { stub, ruleId } = await setupRule("acc-throttle");
    await stub.storeTokens("acc-throttle", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    throttlingGraph(3, "20");

    const result = await stub.runRule(ruleId);
    expect(result).toMatchObject({ applied: 3, failed: 0, remaining: 12, retryAfterMs: 20_000 });
    const [event] = await auditOf(ruleId, "sync_run");
    expect(event?.detail).toMatchObject({ failed: 0, throttled: 12, statuses: "429:12" });
    const wait = await alarmIn(stub);
    expect(wait).toBeGreaterThan(15_000);
    expect(wait).toBeLessThanOrEqual(20_000);
  });

  it("keeps a rule at the front of the queue when its read is throttled", async () => {
    const { stub, ruleId } = await setupRule("acc-throttle-read");
    await stub.storeTokens("acc-throttle-read", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("busy", { status: 429, headers: { "Retry-After": "7" } }),
    );

    await stub.requestSync();
    await runDurableObjectAlarm(stub);

    const [failure] = await auditOf(ruleId, "sync_failed");
    expect(failure?.detail).toEqual({ code: "graph_429" });
    const queue = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string[]>("ruleQueue"),
    );
    expect(queue).toEqual([ruleId]);
    const wait = await alarmIn(stub);
    expect(wait).toBeGreaterThan(4_000);
    expect(wait).toBeLessThanOrEqual(7_000);
  });
});

describe("mailbox concurrency", () => {
  it("runs one provider call at a time, also when a read arrives during a write run", async () => {
    const { stub, ruleId } = await setupRule("acc-serial");
    await stub.storeTokens("acc-serial", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      if (url.includes(`/calendars/${SOURCE_CAL}/calendarView`))
        return Response.json({ value: fixture.value });
      if (url.includes(`/calendars/${TARGET_CAL}/calendarView`))
        return Response.json({ value: [] });
      const body = JSON.parse(init?.body as string) as { requests: { id: string }[] };
      return Response.json({
        responses: body.requests.map((request) => ({ id: request.id, status: 201 })),
      });
    });

    const window = { start: new Date(), end: new Date(Date.now() + 86_400_000) };
    const [run] = await Promise.all([
      stub.runRule(ruleId),
      stub.readSourceEvents(SOURCE_CAL, window, false),
      stub.readSourceEvents(SOURCE_CAL, window, false),
    ]);
    expect(run).toMatchObject({ applied: 15, failed: 0 });
    expect(maxInFlight).toBe(1);
  });
});

describe("detail caps", () => {
  /** A rule between two accounts of one user, each with one calendar. */
  async function setupPair(prefix: string, sourceEmail: string, targetEmail: string) {
    const { user } = await signIn("owner@example.com");
    const statements = [
      [`${prefix}-a`, sourceEmail, SOURCE_CAL],
      [`${prefix}-b`, targetEmail, TARGET_CAL],
    ].flatMap(([id, email, remote]) => [
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
      ).bind(id, user.id, email),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES (?, ?, ?, 'Cal')",
      ).bind(`${id}-cal`, id, remote),
    ]);
    await env.DB.batch([
      ...statements,
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        `${prefix}-rule`,
        user.id,
        `${prefix}-a-cal`,
        `${prefix}-b-cal`,
        JSON.stringify({ detailLevel: "full" }),
      ),
    ]);
    for (const id of [`${prefix}-a`, `${prefix}-b`]) {
      await env.ACCOUNT_SYNC.getByName(id).storeTokens(id, {
        refreshToken: "r",
        accessToken: "a",
        accessExpiresAt: Date.now() + 3_600_000,
      });
    }
    return { stub: env.ACCOUNT_SYNC.getByName(`${prefix}-b`), ruleId: `${prefix}-rule` };
  }

  function sentBlocks(calls: { url: string; init?: RequestInit }[]) {
    const batch = calls.find((call) => call.url.endsWith("/$batch"));
    return (
      JSON.parse(batch?.init?.body as string) as {
        requests: {
          body: { subject: string; body: { content: string }; location: { displayName: string } };
        }[];
      }
    ).requests.map((request) => request.body);
  }

  it("copies at most the title from an org account to another account", async () => {
    const { stub, ruleId } = await setupPair("cap-out", "me@org.example", "me@private.example");
    const calls = fakeGraph();
    await stub.runRule(ruleId);

    const blocks = sentBlocks(calls);
    const titled = fixture.value.filter((event) => event.subject).map((event) => event.subject);
    expect(blocks.some((block) => titled.includes(block.subject))).toBe(true);
    for (const block of blocks) {
      expect(block.body.content).toBe("");
      expect(block.location.displayName).toBe("");
    }
  });

  it("copies only busy from another account to an org account", async () => {
    const { stub, ruleId } = await setupPair("cap-in", "in@private.example", "in@org.example");
    const calls = fakeGraph();
    await stub.runRule(ruleId);

    for (const block of sentBlocks(calls)) expect(block.subject).toBe("Busy");
  });
});

describe("written IDs", () => {
  it("remembers the IDs of blocks it created, for the echo filter", async () => {
    const { stub, ruleId } = await setupRule("acc-written");
    await stub.storeTokens("acc-written", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(`/calendars/${SOURCE_CAL}/calendarView`))
        return Response.json({ value: fixture.value });
      if (url.includes(`/calendars/${TARGET_CAL}/calendarView`))
        return Response.json({ value: [] });
      const body = JSON.parse(init?.body as string) as { requests: { id: string }[] };
      return Response.json({
        responses: body.requests.map((request) => ({
          id: request.id,
          status: 201,
          body: { id: `created-${request.id}` },
        })),
      });
    });
    await stub.runRule(ruleId);
    const written = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<Record<string, number>>("recentWrites"),
    );
    expect(written).toEqual(
      expect.objectContaining({ "created-0": expect.any(Number), "created-1": expect.any(Number) }),
    );
  });
});

describe("changes during a cycle", () => {
  /**
   * One account with two rules between its calendars, in both directions. Graph returns the
   * events in `events` per calendar and records the start of every created block.
   */
  async function setupCycle(accountId: string) {
    const { stub, ruleId } = await setupRule(accountId);
    const otherRule = `${accountId}-rule-2`;
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) SELECT ?, user_id, target_calendar_id, source_calendar_id FROM rules WHERE id = ?",
    )
      .bind(otherRule, ruleId)
      .run();
    await stub.storeTokens(accountId, {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    const [first, second] = await inPrecedenceOrder([ruleId, otherRule]);
    if (!first || !second) throw new Error("no rules");
    const sourceOf = (id: string) => (id === ruleId ? SOURCE_CAL : TARGET_CAL);
    const events: Record<string, unknown[]> = {
      [SOURCE_CAL]: fixture.value.slice(0, 2),
      [TARGET_CAL]: [],
    };
    const created: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      for (const calendar of Object.keys(events)) {
        if (url.includes(`/calendars/${calendar}/calendarView`)) {
          return Response.json({ value: events[calendar] });
        }
      }
      if (url.endsWith("/$batch")) {
        const body = JSON.parse(init?.body as string) as {
          requests: { id: string; method: string; body?: { start: { dateTime: string } } }[];
        };
        for (const request of body.requests) {
          if (request.method === "POST" && request.body) created.push(request.body.start.dateTime);
        }
        return Response.json({
          responses: body.requests.map((request) => ({ id: request.id, status: 201 })),
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const runs = async (id: string) => (await auditOf(id, "sync_run")).length;
    const marked = () =>
      runInDurableObject(stub, (_instance, state) => state.storage.get("fullCycleRequested"));
    const runAllAlarms = async () => {
      for (let i = 0; i < 10 && (await runDurableObjectAlarm(stub)); i++);
    };
    return { stub, first, second, sourceOf, events, created, runs, marked, runAllAlarms };
  }

  const newEvent = {
    ...fixture.value[0],
    id: "new-meeting",
    type: "singleInstance",
    seriesMasterId: null,
    originalStart: null,
    start: { dateTime: "2026-12-01T10:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-12-01T11:00:00.0000000", timeZone: "UTC" },
  };

  it("runs the rules that already ran again for a change that arrives during the cycle", async () => {
    const { stub, first, second, sourceOf, events, created, runs, runAllAlarms } =
      await setupCycle("acc-mid");

    await stub.requestSync();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runs(first)).toBe(1);
    // The source of the rule that just ran changes, and its notification asks for a sync.
    events[sourceOf(first)]!.push(newEvent);
    await stub.requestSync();
    await runAllAlarms();

    expect(created.some((start) => start.startsWith("2026-12-01T10:00"))).toBe(true);
    expect(await runs(first)).toBe(2);
    expect(await runs(second)).toBe(2);
  });

  it("runs at most one more cycle for many changes during a cycle", async () => {
    const { stub, first, second, runs, marked, runAllAlarms } = await setupCycle("acc-burst");

    await stub.requestSync();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    for (let i = 0; i < 5; i++) await stub.requestSync();
    await runAllAlarms();

    expect(await runs(first)).toBe(2);
    expect(await runs(second)).toBe(2);
    expect(await marked()).toBeUndefined();
    expect(await alarmIn(stub)).toBeNull();
  });

  it("runs no further cycle when no change arrives during the cycle", async () => {
    const { stub, first, second, runs, marked, runAllAlarms } = await setupCycle("acc-calm");

    await stub.requestSync();
    await runAllAlarms();

    expect(await runs(first)).toBe(1);
    expect(await runs(second)).toBe(1);
    expect(await marked()).toBeUndefined();
  });

  it("waits for the debounce before the further cycle", async () => {
    const { stub } = await setupCycle("acc-wait");
    const instance = await runInDurableObject(stub, (object: AccountSync) => object);
    vi.spyOn(instance as unknown as { delays: () => object }, "delays").mockReturnValue({
      debounce: 900_000,
      nextRun: 600_000,
    });

    await stub.requestSync();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await stub.requestSync();
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // The queue is done; the further cycle waits like any requested sync.
    expect(await alarmIn(stub)).toBeGreaterThan(800_000);
  });

  it("runs a further cycle for a request that arrives while the cycle reads its rules", async () => {
    const { stub, first, second, runs, runAllAlarms } = await setupCycle("acc-list");
    const instance = await runInDurableObject(stub, (object: AccountSync) => object);
    const db = (instance as unknown as { env: Env }).env.DB;
    const prepare = db.prepare.bind(db);
    let raced = false;
    vi.spyOn(db, "prepare").mockImplementation((query: string) => {
      const statement = prepare(query);
      if (raced || !query.includes("JOIN calendars tc ON tc.id = r.target_calendar_id")) {
        return statement;
      }
      raced = true;
      // A request, for example after a new rule, arrives while the cycle reads the rule list.
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            all: async () => {
              await instance.requestSync();
              return bound.all();
            },
          };
        },
      } as unknown as D1PreparedStatement;
    });

    await stub.requestSync();
    await runAllAlarms();

    expect(raced).toBe(true);
    expect(await runs(first)).toBe(2);
    expect(await runs(second)).toBe(2);
  });

  it("runs the requested full cycle when a tick queues rules before it starts", async () => {
    const { stub, first, second, events, runs, runAllAlarms } = await setupCycle("acc-tick");
    events["remote-unwatched"] = [];
    // A third calendar without a watch, read by a third rule; the other two are watched.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES ('acc-tick-src2', 'acc-tick', 'remote-unwatched', 'Other')",
      ),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) SELECT 'acc-tick-rule-3', user_id, 'acc-tick-src2', target_calendar_id FROM rules WHERE id = 'acc-tick-rule'",
      ),
      env.DB.prepare(
        "UPDATE calendars SET watched_until = ? WHERE id IN ('acc-tick-src', 'acc-tick-dst')",
      ).bind(Date.now() + 86_400_000),
    ]);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("fullCycleAt", Date.now()),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    await stub.requestSync();
    // The cron fires within the debounce and polls only the unwatched rule.
    await stub.tick();
    await runAllAlarms();

    expect(await runs(first)).toBe(1);
    expect(await runs(second)).toBe(1);
    expect(await runs("acc-tick-rule-3")).toBe(1);
  });
});

describe("overlapping runs", () => {
  it("writes each block once when two runs of one rule overlap", async () => {
    const { stub, ruleId } = await setupRule("acc-overlap");
    await stub.storeTokens("acc-overlap", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    const [template] = fixture.value;
    // Blocks written by `$batch` show up in later reads of the target calendar.
    const target: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (url.includes(`/calendars/${SOURCE_CAL}/calendarView`))
        return Response.json({ value: fixture.value });
      if (url.includes(`/calendars/${TARGET_CAL}/calendarView`))
        return Response.json({ value: [...target] });
      if (url.endsWith("/$batch")) {
        const body = JSON.parse(init?.body as string) as {
          requests: { id: string; method: string; body?: Record<string, unknown> }[];
        };
        for (const request of body.requests) {
          if (request.method !== "POST") continue;
          target.push({
            ...template,
            ...request.body,
            id: `block-${target.length}`,
            type: "singleInstance",
            seriesMasterId: null,
            originalStart: null,
          });
        }
        return Response.json({
          responses: body.requests.map((request) => ({ id: request.id, status: 201 })),
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    // A double click on "Run", or a click while the alarm runs the same rule. A preview at the
    // same time plans on its own and writes nothing.
    const [one, two, preview] = await Promise.all([
      stub.runRule(ruleId),
      stub.runRule(ruleId),
      stub.runRule(ruleId, { dryRun: true }),
    ]);

    expect(target).toHaveLength(15);
    expect(one).toMatchObject({ dryRun: false, applied: 15 });
    // The second click reports the writes of the run it joined.
    expect(two).toEqual(one);
    expect(preview).toMatchObject({ dryRun: true, applied: 0 });
    expect(await auditOf(ruleId, "sync_run")).toHaveLength(2);
    // Once the first run is done, a new run plans from the calendar again.
    expect(await stub.runRule(ruleId)).toMatchObject({ applied: 0, stats: { create: 0 } });
  });

  it("runs the rule again in the alarm after a manual run that read the source before a change", async () => {
    const { stub, ruleId } = await setupRule("acc-manual");
    await stub.storeTokens("acc-manual", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    const source: unknown[] = fixture.value.slice(0, 2);
    const target: { start: { dateTime: string } }[] = [];
    // Flags and timers, not shared promises: a promise resolved in the Durable Object would
    // continue the test in its I/O context.
    const sleep = () => new Promise((resolve) => setTimeout(resolve, 1));
    let sourceRead = false;
    let batchReleased = false;
    let firstBatch = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(`/calendars/${SOURCE_CAL}/calendarView`)) {
        sourceRead = true;
        return Response.json({ value: [...source] });
      }
      if (url.includes(`/calendars/${TARGET_CAL}/calendarView`))
        return Response.json({ value: [...target] });
      if (url.endsWith("/$batch")) {
        // The manual run waits here with the plan it made before the change.
        if (firstBatch) {
          firstBatch = false;
          while (!batchReleased) await sleep();
        }
        const body = JSON.parse(init?.body as string) as {
          requests: { id: string; method: string; body?: { start: { dateTime: string } } }[];
        };
        for (const request of body.requests) {
          if (request.method !== "POST" || !request.body) continue;
          target.push({
            ...fixture.value[0],
            ...request.body,
            id: `block-${target.length}`,
            type: "singleInstance",
            seriesMasterId: null,
            originalStart: null,
          } as unknown as { start: { dateTime: string } });
        }
        return Response.json({
          responses: body.requests.map((request) => ({ id: request.id, status: 201 })),
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const manual = stub.runRule(ruleId);
    while (!sourceRead) await sleep();
    // The source changes after the manual run read it, and the notification asks for a sync.
    source.push({
      ...fixture.value[0],
      id: "new-meeting",
      type: "singleInstance",
      seriesMasterId: null,
      originalStart: null,
      start: { dateTime: "2026-12-01T10:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-01T11:00:00.0000000", timeZone: "UTC" },
    });
    await stub.requestSync();
    const alarm = runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 50));
    batchReleased = true;
    await manual;
    await alarm;

    expect(target.some((block) => block.start.dateTime.startsWith("2026-12-01T10:00"))).toBe(true);
  });
});
