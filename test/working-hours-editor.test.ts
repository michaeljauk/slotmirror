import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadEditorState,
  resetDirection,
  setDirection,
  setGroupMembership,
  setWorkingHours,
} from "../src/editor";
import { BASE, signIn } from "./helpers";

/** A user with a Microsoft and a Google account, each with one main calendar and tokens. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accounts = [
    [`${prefix}-w`, `${prefix}@work.example`, "microsoft"],
    [`${prefix}-g`, `${prefix}@gmail.com`, "google"],
  ] as const;
  for (const [id, email, provider] of accounts) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)",
      ).bind(id, user.id, provider, email),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
    ]);
    await env.ACCOUNT_SYNC.getByName(id).storeTokens(
      id,
      { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + 3_600_000 },
      provider,
    );
  }
  return { user, cookie, w: `${prefix}-w`, g: `${prefix}-g` };
}

const optionsOf = async (userId: string, from: string, to: string) =>
  (await loadEditorState(env, userId)).directions.find((d) => d.from === from && d.to === to)
    ?.options;

/** The rules of one direction: origin, enabled, and the stored options. */
async function rulesOf(userId: string, from: string, to: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.origin, r.enabled, r.options FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ? AND sc.account_id = ? AND tc.account_id = ?`,
  )
    .bind(userId, from, to)
    .all<{ id: string; origin: string; enabled: number; options: string }>();
  return results;
}

function post(
  path: string,
  cookie: string,
  body: URLSearchParams,
  extra: Record<string, string> = {},
) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...extra },
    body,
  });
}

const OFF = { workDays: [1, 2, 3, 4, 5, 6, 7], workStart: "", workEnd: "", workTimeZone: "" };

beforeEach(() => {
  // Removing blocks reads the target calendar; it is empty in these tests.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("calendarView")) return Response.json({ value: [] });
    if (url.includes("googleapis.com/calendar")) return Response.json({ items: [] });
    return new Response("unexpected", { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("working hours per direction", () => {
  it("saves the hours from the page, shows them again, and refuses invalid values", async () => {
    const { user, cookie, w, g } = await setup("hours");
    await setDirection(env, user, g, w, "busy");
    await setDirection(env, user, w, g, "busy");
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFF);

    const save = (fields: Record<string, string>) =>
      exports.default.fetch(`${BASE}/rules/choices`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
    const hours = (days: string, start: string, end: string, zone: string) => ({
      [`workDays.${g}.${w}`]: days,
      [`workStart.${g}.${w}`]: start,
      [`workEnd.${g}.${w}`]: end,
      [`workTimeZone.${g}.${w}`]: zone,
    });
    const saved = await save(hours("5,1,2,3,4", "08:00", "18:00", "europe/vienna"));
    expect(saved.status).toBe(204);
    const office = {
      workDays: [1, 2, 3, 4, 5],
      workStart: "08:00",
      workEnd: "18:00",
      workTimeZone: "Europe/Vienna",
    };
    expect(await optionsOf(user.id, g, w)).toMatchObject(office);
    // The other direction keeps its defaults.
    expect(await optionsOf(user.id, w, g)).toMatchObject(OFF);

    const html = await (
      await exports.default.fetch(`${BASE}/rules?open=${g}`, { headers: { cookie } })
    ).text();
    const forms = html.match(/<form[^>]*working-hours[\s\S]*?<\/form>/g) ?? [];
    const form = forms.find((f) => f.includes(`name="to" value="${w}"`)) ?? "";
    expect(form).toMatch(/name="workStart"[^>]*value="08:00"/);
    expect(form).toMatch(/name="workEnd"[^>]*value="18:00"/);
    expect(form).toMatch(/name="workTimeZone"[^>]*value="Europe\/Vienna"/);
    const checked = [...form.matchAll(/<input[^>]*name="workDays"[^>]*>/g)]
      .filter(([input]) => /checked/.test(input))
      .map(([input]) => input.match(/value="(\d)"/)?.[1]);
    expect(checked).toEqual(["1", "2", "3", "4", "5"]);
    expect(html).toContain("Only during:");

    // Settings for all rules keep the hours of each direction.
    await save({ settings: "1", "settings.daysAhead": "30" });
    expect(await optionsOf(user.id, g, w)).toMatchObject({ ...office, daysAhead: 30 });

    const invalid = [
      hours("1,2", "18:00", "08:00", "UTC"), // end before start: no overnight windows
      hours("1,2", "08:00", "08:00", "UTC"),
      hours("1,2", "08:00", "", "UTC"),
      hours("1,2", "8:00", "18:00", "UTC"),
      hours("1,2", "08:00", "18:00", "Mars/Olympus"),
      hours("", "08:00", "18:00", "UTC"),
      hours("0,1", "08:00", "18:00", "UTC"),
      hours("x", "08:00", "18:00", "UTC"),
    ];
    for (const fields of invalid) expect((await save(fields)).status).toBe(400);
    expect(await optionsOf(user.id, g, w)).toMatchObject(office);
  });

  it("stores the deployment's time zone when the zone is left empty, and none when off", async () => {
    const { user, w, g } = await setup("hourszone");
    await setDirection(env, user, g, w, "busy");
    const vienna = { ...env, TIME_ZONE: "Europe/Vienna" };
    expect(
      await setWorkingHours(vienna, user, g, w, { workDays: [1, 2, 3], workTimeZone: " " }),
    ).toBe(true);
    expect(await optionsOf(user.id, g, w)).toMatchObject({
      workDays: [1, 2, 3],
      workTimeZone: "Europe/Vienna",
    });
    // The test deployment shows UTC.
    expect(await setWorkingHours(env, user, g, w, { workTimeZone: "" })).toBe(true);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ workTimeZone: "UTC" });
    // All weekdays and no times filter nothing; the zone goes, and the options are the defaults.
    expect(await setWorkingHours(env, user, g, w, { workDays: [7, 6, 5, 4, 3, 2, 1] })).toBe(true);
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFF);
  });

  it("saves from the form without the editor script, and the reset clears the hours", async () => {
    const { user, cookie, w, g } = await setup("hoursform");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, g, w, "title");
    const body = new URLSearchParams({
      from: g,
      to: w,
      workStart: "09:30",
      workEnd: "17:00",
      workTimeZone: "Europe/Vienna",
    });
    body.append("workDays", "2");
    body.append("workDays", "4");
    const response = await exports.default.fetch(`${BASE}/rules/direction/hours`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.status).toBe(302);
    expect(await optionsOf(user.id, g, w)).toMatchObject({
      workDays: [2, 4],
      workStart: "09:30",
      workEnd: "17:00",
      workTimeZone: "Europe/Vienna",
    });

    // No weekday checked: refused, nothing changes.
    const none = new URLSearchParams({ from: g, to: w, workStart: "", workEnd: "" });
    const refused = await exports.default.fetch(`${BASE}/rules/direction/hours`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: none,
    });
    expect(refused.status).toBe(400);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ workDays: [2, 4] });

    await resetDirection(env, user, g, w);
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFF);
  });

  it("changes nothing for a direction without rules, but still refuses invalid hours", async () => {
    const { user, w, g } = await setup("hoursoff");
    expect(await setWorkingHours(env, user, g, w, { workDays: [1] })).toBe(true);
    expect(await optionsOf(user.id, g, w)).toBeNull();
    expect(await setWorkingHours(env, user, g, w, { workDays: [] })).toBe(false);
  });

  it("saves all or nothing: invalid hours stop the choices sent with them", async () => {
    const { user, cookie, w, g } = await setup("hoursall");
    const body = new URLSearchParams({
      [`choice.${w}.${g}`]: "busy",
      [`calendar.${w}-cal`]: "1",
      [`workDays.${g}.${w}`]: "1,2",
      [`workStart.${g}.${w}`]: "18:00",
      [`workEnd.${g}.${w}`]: "08:00",
      [`workTimeZone.${g}.${w}`]: "UTC",
    });
    const response = await post("/rules/choices", cookie, body, { "x-fragment": "1" });
    expect(response.status).toBe(400);
    // The editor script shows this message in its bar.
    expect(await response.json()).toEqual({
      error: "Working hours: the end must be after the start. For the end of the day, enter 24:00.",
    });
    expect(await rulesOf(user.id, w, g)).toEqual([]);
    expect(await rulesOf(user.id, g, w)).toEqual([]);

    // The same save with valid hours writes both.
    body.set(`workEnd.${g}.${w}`, "24:00");
    body.set(`choice.${g}.${w}`, "busy");
    expect((await post("/rules/choices", cookie, body, { "x-fragment": "1" })).status).toBe(204);
    expect(await rulesOf(user.id, w, g)).toHaveLength(1);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ workStart: "18:00", workEnd: "24:00" });
  });

  it("names the wrong field in the page language for the form without the script", async () => {
    const { user, cookie, w, g } = await setup("hoursmsg");
    await setDirection(env, user, g, w, "busy");
    const form = (fields: Record<string, string>, days: string[]) => {
      const body = new URLSearchParams({ from: g, to: w, ...fields });
      for (const day of days) body.append("workDays", day);
      return body;
    };
    const valid = { workStart: "08:00", workEnd: "18:00", workTimeZone: "Europe/Vienna" };
    const cases = [
      [form(valid, []), "Working hours: choose at least one weekday."],
      [form({ ...valid, workStart: "8:00" }, ["1"]), "Working hours: enter a start and an end"],
      [form({ ...valid, workEnd: "07:00" }, ["1"]), "Working hours: the end must be after"],
      [form({ ...valid, workTimeZone: "Mars/Olympus" }, ["1"]), "unknown time zone"],
    ] as const;
    for (const [body, message] of cases) {
      const response = await post("/rules/direction/hours", cookie, body);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(message);
    }
    const german = await post("/rules/direction/hours", cookie, form(valid, []), {
      "accept-language": "de",
    });
    expect(await german.text()).toContain("Arbeitszeit: Wähle mindestens einen Wochentag.");
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFF);
  });

  it("stores the canonical name of a zone", async () => {
    const { user, w, g } = await setup("hourscanon");
    await setDirection(env, user, g, w, "busy");
    await setWorkingHours(env, user, g, w, { workDays: [1], workTimeZone: "US/Eastern" });
    expect(await optionsOf(user.id, g, w)).toMatchObject({ workTimeZone: "America/New_York" });
  });

  it("keeps the page working when a stored zone became unknown", async () => {
    const { user, cookie, w, g } = await setup("hoursstale");
    await setDirection(env, user, g, w, "busy");
    const [rule] = await rulesOf(user.id, g, w);
    const stored = {
      ...JSON.parse(rule?.options ?? "{}"),
      workDays: [1],
      workTimeZone: "Mars/Olympus",
    };
    await env.DB.prepare("UPDATE rules SET options = ? WHERE id = ?")
      .bind(JSON.stringify(stored), rule?.id)
      .run();
    const page = await exports.default.fetch(`${BASE}/rules?open=${g}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ workDays: [1], workTimeZone: "UTC" });
  });
});

describe("working hours in the block group", () => {
  it("make a group direction an exception, which the reset returns to the group", async () => {
    const { user, cookie, w, g } = await setup("hoursgroup");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    expect((await rulesOf(user.id, g, w)).map((rule) => rule.origin)).toEqual(["group"]);

    await setWorkingHours(env, user, g, w, { workDays: [1, 2, 3, 4, 5] });
    expect((await rulesOf(user.id, g, w)).map((rule) => rule.origin)).toEqual(["custom"]);
    const html = await (
      await exports.default.fetch(`${BASE}/rules?open=${g}`, { headers: { cookie } })
    ).text();
    const resets = html.match(/<form[^>]*\/rules\/direction\/reset[\s\S]*?<\/form>/g) ?? [];
    expect(resets.some((form) => form.includes(`name="to" value="${w}"`))).toBe(true);

    // Choosing busy again keeps the exception while the direction has hours.
    await setDirection(env, user, g, w, "busy");
    expect((await rulesOf(user.id, g, w)).map((rule) => rule.origin)).toEqual(["custom"]);

    await resetDirection(env, user, g, w);
    const [rule] = await rulesOf(user.id, g, w);
    expect(rule?.origin).toBe("group");
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFF);
  });

  it("survive leaving the group, like any exception", async () => {
    const { user, w, g } = await setup("hoursleave");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setWorkingHours(env, user, g, w, { workDays: [1, 2, 3, 4, 5] });
    await setGroupMembership(env, user, g, false);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ workDays: [1, 2, 3, 4, 5] });
    // The direction without hours was a group rule and goes with the group.
    expect(await rulesOf(user.id, w, g)).toEqual([]);
  });
});
