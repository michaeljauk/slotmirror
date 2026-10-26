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
    const list = html.slice(html.indexOf('<ul class="list">'));
    const row = list.slice(list.indexOf("acc-ui-fail@example.com"));
    expect(row.slice(0, row.indexOf("</li>"))).toMatch(
      /class="status error" href="\/auth\/microsoft\/connect\?account=acc-ui-fail" title="[^"]+">Reconnect</,
    );
    // The notice comes first on the page, names the account and its provider, and starts the
    // connect flow of that provider.
    const notice = html.slice(html.indexOf('class="reconnect-notice"'));
    expect(html.indexOf('class="reconnect-notice"')).toBeLessThan(html.indexOf("<h1>"));
    expect(notice.slice(0, notice.indexOf("</div>"))).toContain(
      "The Microsoft 365 account acc-ui-fail@example.com is no longer connected.",
    );
    expect(notice).toContain(
      'href="/auth/microsoft/connect?account=acc-ui-fail" aria-label="Reconnect acc-ui-fail@example.com">Reconnect</a>',
    );
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
    });
    await stub.requestSync();

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
    expect(await stub.isOwnEcho(["created-0", "created-1"])).toBe(true);
    expect(await stub.isOwnEcho(["created-0", "other"])).toBe(false);
  });
});

describe("accounts that need reconnecting", () => {
  /** Token endpoint that refuses every refresh token, and an alert webhook that accepts. */
  function refusingTokenEndpoint() {
    const calls = { token: 0, alerts: [] as string[], other: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/oauth2/v2.0/token")) {
        calls.token += 1;
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (url === env.ALERT_WEBHOOK_URL) {
        calls.alerts.push(init?.body as string);
        return new Response("ok");
      }
      calls.other += 1;
      return new Response("unexpected", { status: 500 });
    });
    return calls;
  }

  async function auditCount(accountId: string, kind: string): Promise<number> {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE account_id = ? AND kind = ?",
    )
      .bind(accountId, kind)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async function pendingAlarm(stub: DurableObjectStub<AccountSync>): Promise<number | null> {
    return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
  }

  it("asks the token endpoint once, then skips provider work until the account reconnects", async () => {
    const { stub, ruleId } = await setupRule("acc-revoked");
    await stub.storeTokens("acc-revoked", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = refusingTokenEndpoint();

    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(calls.token).toBe(1);
    const flag = await env.DB.prepare(
      "SELECT needs_reconnect AS n FROM accounts WHERE id = 'acc-revoked'",
    ).first<{ n: number }>();
    expect(flag?.n).toBe(1);
    expect(await auditCount("acc-revoked", "token_refresh_failed")).toBe(1);
    expect(await auditOf(ruleId, "sync_failed")).toHaveLength(1);

    // Further cycles: cron ticks, requested syncs and alarms do nothing.
    await stub.tick();
    expect(await pendingAlarm(stub)).toBeNull();
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(await pendingAlarm(stub)).toBeNull();
    // A manual run and a read from another account's rule fail without a token request.
    await expectRejection(stub.runRule(ruleId));
    await expectRejection(
      stub.readSourceEvents(SOURCE_CAL, { start: new Date(), end: new Date() }, false),
    );
    expect(calls.token).toBe(1);
    expect(calls.other).toBe(0);
    // The audit log keeps the one refusal; a manual run is still recorded.
    expect(await auditCount("acc-revoked", "token_refresh_failed")).toBe(1);
    const failed = await auditOf(ruleId, "sync_failed");
    expect(failed).toHaveLength(2);
    expect(failed[1]?.detail).toEqual({ code: "token_invalid_grant" });
  });

  it("syncs again with a full cycle once the account is connected again", async () => {
    const { stub, ruleId } = await setupRule("acc-back");
    await stub.storeTokens("acc-back", { refreshToken: "r", accessToken: "a", accessExpiresAt: 0 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    refusingTokenEndpoint();
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    vi.restoreAllMocks();

    // The OAuth callback stores the new tokens.
    await stub.storeTokens("acc-back", {
      refreshToken: "r2",
      accessToken: "a2",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    expect(await pendingAlarm(stub)).not.toBeNull();
    const calls = fakeGraph();
    await runDurableObjectAlarm(stub);
    expect(calls.some((call) => call.url.endsWith("/$batch"))).toBe(true);
    expect((await auditOf(ruleId, "sync_run")).at(-1)?.detail).toMatchObject({ applied: 15 });
  });

  it("keeps the account connected if the refused token was replaced during the refresh", async () => {
    const { stub } = await setupRule("acc-race-reconnect");
    await stub.storeTokens("acc-race-reconnect", {
      refreshToken: "old",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const instance = await runInDurableObject(stub, (object: AccountSync) => object);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/oauth2/v2.0/token")) {
        // The user connects the account again while the old token is refused.
        await instance.storeTokens("acc-race-reconnect", {
          refreshToken: "new",
          accessToken: "a2",
          accessExpiresAt: Date.now() + 3_600_000,
        });
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return new Response("unexpected", { status: 500 });
    });

    await expectRejection(stub.listCalendars());
    const flag = await env.DB.prepare(
      "SELECT needs_reconnect AS n FROM accounts WHERE id = 'acc-race-reconnect'",
    ).first<{ n: number }>();
    expect(flag?.n).toBe(0);
    await stub.tick();
    expect(await pendingAlarm(stub)).not.toBeNull();
  });

  it("forgets a retiring account at once, since it cannot remove its blocks", async () => {
    const { stub, ruleId } = await setupRule("acc-revoked-retire");
    await stub.storeTokens("acc-revoked-retire", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = refusingTokenEndpoint();
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(calls.token).toBe(1);

    await stub.queueRemoval(ruleId, TARGET_CAL);
    await stub.retire();
    await runDurableObjectAlarm(stub);
    expect(await stub.hasTokens()).toBe(false);
    expect(calls.token).toBe(1);
    expect(calls.other).toBe(0);
  });

  it("posts one alert per transition to the alert webhook, without addresses", async () => {
    const { stub } = await setupRule("acc-alert");
    await stub.storeTokens("acc-alert", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = refusingTokenEndpoint();

    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(calls.alerts).toHaveLength(1);
    const body = JSON.parse(calls.alerts[0] ?? "{}") as { text?: string };
    expect(body.text).toContain("Microsoft 365");
    expect(body.text).toContain(env.PUBLIC_URL);
    expect(calls.alerts[0]).not.toContain("acc-alert");

    // Connected again, then refused again: a new transition, a new alert.
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 0 WHERE id = 'acc-alert'").run();
    await stub.storeTokens("acc-alert", {
      refreshToken: "r2",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    await runDurableObjectAlarm(stub);
    expect(calls.alerts).toHaveLength(2);
  });

  it("sends no alert if the account was flagged before", async () => {
    const { stub } = await setupRule("acc-alert-old");
    await env.DB.prepare(
      "UPDATE accounts SET needs_reconnect = 1 WHERE id = 'acc-alert-old'",
    ).run();
    await stub.storeTokens("acc-alert-old", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = refusingTokenEndpoint();
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(calls.token).toBe(1);
    expect(calls.alerts).toHaveLength(0);
  });

  /** The stored pause of an account, or undefined. */
  async function storedPause(stub: DurableObjectStub<AccountSync>) {
    return runInDurableObject(stub, (_instance, state) =>
      state.storage.get<Record<string, unknown>>("needsReconnect"),
    );
  }

  async function d1Flag(accountId: string): Promise<number | undefined> {
    const row = await env.DB.prepare("SELECT needs_reconnect AS n FROM accounts WHERE id = ?")
      .bind(accountId)
      .first<{ n: number }>();
    return row?.n;
  }

  /** Let the next token probe run now. */
  async function probeDue(stub: DurableObjectStub<AccountSync>): Promise<void> {
    await runInDurableObject(stub, async (_instance, state) => {
      const pause = await state.storage.get<Record<string, unknown>>("needsReconnect");
      await state.storage.put("needsReconnect", { ...pause, probeAt: 0 });
    });
  }

  async function pauseByRefusal(accountId: string) {
    const setup = await setupRule(accountId);
    await setup.stub.storeTokens(accountId, {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = refusingTokenEndpoint();
    await setup.stub.requestSync();
    await runDurableObjectAlarm(setup.stub);
    expect(await storedPause(setup.stub)).toBeDefined();
    return { ...setup, calls };
  }

  it("ends up connected if new tokens arrive while the pause is written to D1", async () => {
    const { stub } = await setupRule("acc-race-d1");
    await stub.storeTokens("acc-race-d1", {
      refreshToken: "old",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    refusingTokenEndpoint();
    // The OAuth callback stores new tokens while the D1 write of the pause waits on the network.
    await runInDurableObject(stub, (instance: AccountSync) => {
      const target = instance as unknown as { env: Env };
      const real = target.env.DB;
      const db = new Proxy(real, {
        get(object, key) {
          if (key === "prepare") {
            return (sql: string) => {
              const statement = object.prepare(sql);
              if (!sql.includes("SET needs_reconnect = 1")) return statement;
              return {
                bind: (...values: unknown[]) => ({
                  run: async () => {
                    await instance.storeTokens("acc-race-d1", {
                      refreshToken: "new",
                      accessToken: "a2",
                      accessExpiresAt: Date.now() + 3_600_000,
                    });
                    return statement.bind(...values).run();
                  },
                }),
              };
            };
          }
          const value: unknown = Reflect.get(object, key);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
      target.env = { ...target.env, DB: db };
    });

    await expectRejection(stub.listCalendars());
    expect(await storedPause(stub)).toBeUndefined();
    expect(await d1Flag("acc-race-d1")).toBe(0);
    expect(await pendingAlarm(stub)).not.toBeNull();
  });

  it("finishes a pause that was cut off before D1 and the alert, exactly once", async () => {
    const { stub } = await setupRule("acc-evicted");
    await stub.storeTokens("acc-evicted", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = refusingTokenEndpoint();
    // As if the instance was evicted right after storing the pause.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("needsReconnect", {
        code: "invalid_grant",
        since: Date.now(),
        flagPending: true,
        alertPending: true,
        probeAt: Date.now() + 86_400_000,
      }),
    );
    expect(await d1Flag("acc-evicted")).toBe(0);

    await stub.tick();
    expect(await d1Flag("acc-evicted")).toBe(1);
    expect(calls.alerts).toHaveLength(1);
    await stub.tick();
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(calls.alerts).toHaveLength(1);
    expect(calls.token).toBe(0);
  });

  it("probes the token endpoint once a day while paused, and resumes when it works", async () => {
    const { stub, calls } = await pauseByRefusal("acc-probe-ok");
    await stub.tick();
    expect(calls.token).toBe(1);

    await probeDue(stub);
    vi.restoreAllMocks();
    const graph = fakeGraph();
    await stub.tick();
    expect(graph.filter((call) => call.url.includes("/oauth2/v2.0/token"))).toHaveLength(1);
    expect(await storedPause(stub)).toBeUndefined();
    expect(await d1Flag("acc-probe-ok")).toBe(0);
    expect(await pendingAlarm(stub)).not.toBeNull();
  });

  it("stays paused for another day if the probe is refused too", async () => {
    const { stub, calls } = await pauseByRefusal("acc-probe-no");
    await probeDue(stub);
    await stub.tick();
    expect(calls.token).toBe(2);
    const pause = await storedPause(stub);
    expect(pause?.probeAt).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(await d1Flag("acc-probe-no")).toBe(1);

    await stub.tick();
    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(calls.token).toBe(2);
    // One alert for the refusal; a refused probe is no new transition.
    expect(calls.alerts).toHaveLength(1);
    expect(await auditCount("acc-probe-no", "token_refresh_failed")).toBe(2);
  });

  it("clears a stale flag in D1 after a successful refresh", async () => {
    const { stub } = await setupRule("acc-stale-flag");
    await env.DB.prepare(
      "UPDATE accounts SET needs_reconnect = 1 WHERE id = 'acc-stale-flag'",
    ).run();
    await stub.storeTokens("acc-stale-flag", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: 0,
    });
    fakeGraph();
    await stub.listCalendars().catch(() => undefined);
    expect(await d1Flag("acc-stale-flag")).toBe(0);
  });

  it("neither pauses nor alerts for an account whose row is already gone", async () => {
    const stub = env.ACCOUNT_SYNC.getByName("acc-gone");
    await stub.storeTokens("acc-gone", { refreshToken: "r", accessToken: "a", accessExpiresAt: 0 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = refusingTokenEndpoint();
    await expectRejection(stub.listCalendars());
    expect(calls.token).toBe(1);
    expect(await storedPause(stub)).toBeUndefined();
    expect(calls.alerts).toHaveLength(0);
  });

  it("does not run rules whose source account needs reconnecting", async () => {
    const { user } = await signIn("owner@example.com");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email, needs_reconnect) VALUES ('acc-paused-src', ?, 'microsoft', 'paused-src@example.com', 1)",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('acc-healthy-dst', ?, 'microsoft', 'healthy-dst@example.com')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES ('paused-src-cal', 'acc-paused-src', ?, 'Work')",
      ).bind(SOURCE_CAL),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name) VALUES ('healthy-dst-cal', 'acc-healthy-dst', ?, 'Test')",
      ).bind(TARGET_CAL),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES ('rule-from-paused', ?, 'paused-src-cal', 'healthy-dst-cal')",
      ).bind(user.id),
    ]);
    const stub = env.ACCOUNT_SYNC.getByName("acc-healthy-dst");
    await stub.storeTokens("acc-healthy-dst", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = fakeGraph();

    await stub.requestSync();
    await runDurableObjectAlarm(stub);
    expect(await auditOf("rule-from-paused")).toHaveLength(0);
    expect(calls.some((call) => call.url.includes(`/calendars/${SOURCE_CAL}`))).toBe(false);
    // The cron finds no rule to poll either, although no calendar is watched.
    await stub.tick();
    expect(await pendingAlarm(stub)).toBeNull();
  });
});
