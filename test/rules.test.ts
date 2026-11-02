import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, signIn } from "./helpers";

async function setupCalendars(accountId: string, userId: string) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
    ).bind(accountId, userId, `${accountId}@example.com`),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES (?, ?, 'r-work', 'Work', 1)",
    ).bind(`${accountId}-work`, accountId),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES (?, ?, 'r-holidays', 'Holidays', 0)",
    ).bind(`${accountId}-holidays`, accountId),
    env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES (?, ?, 'r-test', 'Test', 1)",
    ).bind(`${accountId}-test`, accountId),
  ]);
}

function post(path: string, cookie: string, form: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rules", () => {
  it("creates a rule with the options from the form", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await setupCalendars("acc-r1", user.id);
    const response = await post("/rules", cookie, {
      source: "acc-r1-work",
      target: "acc-r1-test",
      detailLevel: "title",
      daysAhead: "30",
      markPrivate: "on",
    });
    expect(response.status).toBe(302);
    const rule = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ options: string }>();
    expect(JSON.parse(rule?.options ?? "{}")).toMatchObject({
      detailLevel: "title",
      daysAhead: 30,
      markPrivate: true,
      skipAllDay: false,
      skipTentative: false,
    });

    const event = await env.DB.prepare(
      "SELECT user_id, account_id, detail FROM audit_events WHERE kind = 'rule_created'",
    ).first<{ user_id: string; account_id: string; detail: string }>();
    expect(event).toMatchObject({ user_id: user.id, account_id: "acc-r1" });
    expect(JSON.parse(event?.detail ?? "{}")).toEqual({ detailLevel: "title", daysAhead: 30 });
  });

  it("records the deletion of a rule once", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await setupCalendars("acc-rdel", user.id);
    await post("/rules", cookie, { source: "acc-rdel-work", target: "acc-rdel-test" });
    const rule = await env.DB.prepare(
      "SELECT id FROM rules WHERE user_id = ? AND source_calendar_id = 'acc-rdel-work'",
    )
      .bind(user.id)
      .first<{ id: string }>();
    await post(`/rules/${rule?.id}/delete`, cookie);
    await post(`/rules/${rule?.id}/delete`, cookie);
    const { results } = await env.DB.prepare(
      "SELECT account_id FROM audit_events WHERE kind = 'rule_deleted' AND rule_id = ?",
    )
      .bind(rule?.id)
      .all<{ account_id: string }>();
    expect(results).toEqual([{ account_id: "acc-rdel" }]);
  });

  it("refuses a target calendar that is not writable, and identical calendars", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await setupCalendars("acc-r2", user.id);
    expect(
      (await post("/rules", cookie, { source: "acc-r2-work", target: "acc-r2-holidays" })).status,
    ).toBe(400);
    expect(
      (await post("/rules", cookie, { source: "acc-r2-work", target: "acc-r2-work" })).status,
    ).toBe(400);
  });

  it("refuses calendars of another user", async () => {
    const other = await signIn("other@elsewhere.org");
    await setupCalendars("acc-r3", other.user.id);
    const { cookie } = await signIn("owner@example.com");
    expect(
      (await post("/rules", cookie, { source: "acc-r3-work", target: "acc-r3-test" })).status,
    ).toBe(400);
  });

  it("does not let a user run someone else's rule", async () => {
    const other = await signIn("other@elsewhere.org");
    await setupCalendars("acc-r4", other.user.id);
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES ('rule-r4', ?, 'acc-r4-work', 'acc-r4-test')",
    )
      .bind(other.user.id)
      .run();
    const { cookie } = await signIn("owner@example.com");
    expect((await post("/rules/rule-r4/run", cookie)).status).toBe(404);
  });
});

describe("calendar refresh", () => {
  it("offers only the account's own calendars as targets, not calendars shared by others", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES ('acc-share', ?, 'microsoft', 'me@example.com')",
    )
      .bind(user.id)
      .run();
    await env.ACCOUNT_SYNC.getByName("acc-share").storeTokens("acc-share", {
      refreshToken: "r",
      accessToken: "a",
      accessExpiresAt: Date.now() + 3_600_000,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/me?")) return Response.json({ mail: "Me@Example.com" });
      return Response.json({
        value: [
          {
            id: "own",
            name: "Calendar",
            canEdit: true,
            isDefaultCalendar: true,
            owner: { address: "me@example.com" },
          },
          {
            id: "shared",
            name: "Colleague",
            canEdit: true,
            owner: { address: "colleague@example.com" },
          },
        ],
      });
    });
    expect((await post("/rules/calendars/refresh", cookie)).status).toBe(302);
    const { results } = await env.DB.prepare(
      "SELECT remote_id AS id, can_edit AS canEdit FROM calendars WHERE account_id = 'acc-share' ORDER BY remote_id",
    ).all<{ id: string; canEdit: number }>();
    expect(results).toEqual([
      { id: "own", canEdit: 1 },
      { id: "shared", canEdit: 0 },
    ]);
  });
});

describe("pause and enable", () => {
  it("creates rules paused, keeps them out of the cron, and turns them on", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await setupCalendars("acc-t1", user.id);
    await post("/rules", cookie, { source: "acc-t1-work", target: "acc-t1-test" });
    const rule = await env.DB.prepare(
      "SELECT id, enabled FROM rules WHERE source_calendar_id = 'acc-t1-work'",
    ).first<{ id: string; enabled: number }>();
    expect(rule?.enabled).toBe(0);
    const { rulesTargetingAccount } = await import("../src/sync/rules");
    expect(await rulesTargetingAccount(env, "acc-t1")).toEqual([]);

    expect((await post(`/rules/${rule?.id}/enable`, cookie)).status).toBe(302);
    expect(await rulesTargetingAccount(env, "acc-t1")).toEqual([rule?.id]);
    const audit = await env.DB.prepare(
      "SELECT kind FROM audit_events WHERE rule_id = ? ORDER BY id DESC",
    )
      .bind(rule?.id)
      .first<{ kind: string }>();
    expect(audit?.kind).toBe("rule_enabled");

    expect((await post(`/rules/${rule?.id}/pause`, cookie)).status).toBe(302);
    expect(await rulesTargetingAccount(env, "acc-t1")).toEqual([]);
  });

  it("does not let a user switch someone else's rule", async () => {
    const other = await signIn("other@elsewhere.org");
    await setupCalendars("acc-t2", other.user.id);
    await env.DB.prepare(
      "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, enabled) VALUES ('rule-t2', ?, 'acc-t2-work', 'acc-t2-test', 0)",
    )
      .bind(other.user.id)
      .run();
    const { cookie } = await signIn("owner@example.com");
    await post("/rules/rule-t2/enable", cookie);
    const row = await env.DB.prepare("SELECT enabled FROM rules WHERE id = 'rule-t2'").first<{
      enabled: number;
    }>();
    expect(row?.enabled).toBe(0);
  });
});
