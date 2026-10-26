import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKER_PROPERTY_ID } from "../src/sync/graph-events";
import { ruleTagFor } from "../src/sync/plan";
import fixture from "./fixtures/graph/calendar-view.json";
import { BASE, signIn } from "./helpers";

const HASH = "0123456789abcdef0123456789abcdef";

/** Source account A (calendar a-src) and target account B (calendar b-dst), one rule A -> B. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn("owner@example.com");
  const a = `${prefix}-a`;
  const b = `${prefix}-b`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(a, user.id, `${a}@example.com`),
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(b, user.id, `${b}@example.com`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES (?, ?, 'remote-a', 'A', 1)",
    ).bind(`${a}-src`, a),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES (?, ?, 'remote-b', 'B', 1)",
    ).bind(`${b}-dst`, b),
    env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES (?, ?, ?, ?)",
    ).bind(`${prefix}-rule`, user.id, `${a}-src`, `${b}-dst`),
  ]);
  for (const id of [a, b]) {
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(id, {
      refreshToken: "r",
      accessToken: `token-${id}`,
      accessExpiresAt: Date.now() + 3_600_000,
    });
  }
  return { cookie, ruleId: `${prefix}-rule`, a, b };
}

/** Target calendar with two blocks of the rule and one block of another rule. */
async function fakeTarget(ruleId: string) {
  const tag = await ruleTagFor(ruleId);
  const [template] = fixture.value;
  const block = (id: string, value: string) => ({
    ...template,
    id,
    singleValueExtendedProperties: [{ id: MARKER_PROPERTY_ID, value }],
  });
  const deletes: { url: string; token: string | null }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/calendars/remote-b/calendarView")) {
      return Response.json({
        value: [
          block("mine-1", `${tag}.${HASH}.${HASH}`),
          block("mine-2", `${tag}.${HASH.replace("0", "1")}.${HASH}`),
          block("other", `aaaaaaaaaaaa.${HASH}.${HASH}`),
        ],
      });
    }
    if (url.endsWith("/$batch")) {
      const body = JSON.parse(init?.body as string) as {
        requests: { id: string; method: string; url: string }[];
      };
      for (const request of body.requests) {
        deletes.push({ url: request.url, token: new Headers(init?.headers).get("authorization") });
      }
      return Response.json({ responses: body.requests.map((r) => ({ id: r.id, status: 204 })) });
    }
    return new Response("unexpected", { status: 500 });
  });
  return deletes;
}

function post(path: string, cookie: string) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie },
    redirect: "manual",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cleanup", () => {
  it("deleting a rule removes only its own blocks, with the target account's token", async () => {
    const { cookie, ruleId, b } = await setup("del");
    const deletes = await fakeTarget(ruleId);

    expect((await post(`/rules/${ruleId}/delete`, cookie)).status).toBe(302);
    // The request only queues the removal; the target account's alarm does it.
    expect(deletes).toHaveLength(0);
    expect(await runDurableObjectAlarm(env.ACCOUNT_SYNC.getByName(b))).toBe(true);
    expect(deletes.map((d) => d.url).sort()).toEqual(["/me/events/mine-1", "/me/events/mine-2"]);
    expect(deletes.every((d) => d.token === `Bearer token-${b}`)).toBe(true);
    expect(
      await env.DB.prepare("SELECT 1 FROM rules WHERE id = ?").bind(ruleId).first(),
    ).toBeNull();
  });

  it("disconnecting the source account removes the blocks it caused in the other account", async () => {
    const { cookie, ruleId, a, b } = await setup("disc");
    const deletes = await fakeTarget(ruleId);

    expect((await post(`/accounts/${a}/disconnect`, cookie)).status).toBe(302);
    // The other account removes the blocks in its alarm; the disconnected one then retires.
    expect(deletes).toHaveLength(0);
    await runDurableObjectAlarm(env.ACCOUNT_SYNC.getByName(b));
    await runDurableObjectAlarm(env.ACCOUNT_SYNC.getByName(a));
    expect(deletes).toHaveLength(2);
    expect(deletes.every((d) => d.token === `Bearer token-${b}`)).toBe(true);
    expect(
      await env.DB.prepare("SELECT 1 FROM rules WHERE id = ?").bind(ruleId).first(),
    ).toBeNull();
    expect(await env.ACCOUNT_SYNC.getByName(a).hasTokens()).toBe(false);
  });

  it("deletes the rule at once and retries the removal while the provider is down", async () => {
    const { cookie, ruleId, b } = await setup("fail");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("down", { status: 503 }),
    );

    expect((await post(`/rules/${ruleId}/delete`, cookie)).status).toBe(302);
    expect(
      await env.DB.prepare("SELECT 1 FROM rules WHERE id = ?").bind(ruleId).first(),
    ).toBeNull();
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE rule_id = ? AND kind = 'rule_deleted'",
    )
      .bind(ruleId)
      .first<{ detail: string }>();
    expect(JSON.parse(audit?.detail ?? "{}")).toEqual({ cleanup: "queued" });

    const stub = env.ACCOUNT_SYNC.getByName(b);
    await runDurableObjectAlarm(stub);
    const queue = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ ruleId: string; attempts: number }[]>("removalQueue"),
    );
    expect(queue).toEqual([expect.objectContaining({ ruleId, attempts: 1 })]);
  });
});
