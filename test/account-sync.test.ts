import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKER_PROPERTY_ID } from "../src/sync/graph-events";
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
    if (url.includes(`/calendars/${SOURCE_CAL}/calendarView`))
      return Response.json({ value: fixture.value });
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
        singleValueExtendedProperties: { value: string }[];
      };
      expect(body.subject).toBe("Busy");
      expect(body.sensitivity).toBe("private");
      expect(body.singleValueExtendedProperties[0]?.value).toMatch(
        /^[0-9a-f]{12}\.[0-9a-f]{32}\.[0-9a-f]{32}$/,
      );
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
