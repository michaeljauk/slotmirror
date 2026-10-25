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
