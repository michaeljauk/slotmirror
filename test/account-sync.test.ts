import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/graph/calendar-view.json";
import { signIn } from "./helpers";

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
      expect(body.singleValueExtendedProperties[0]?.value).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{32}$/);
      expect(body).not.toHaveProperty("attendees");
    }
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
