import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadEditorState,
  resetDirection,
  setDirection,
  setGroupMembership,
  setSettings,
  setSourceCalendar,
  setWorkingHours,
} from "../src/editor";
import { BASE, signIn } from "./helpers";
// @ts-expect-error `?raw` imports are untyped without `vite/client`
import editorScript from "../public/editor.js?raw";

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
    // The deployment's zone is stored in canonical spelling, like a zone from the page.
    const vienna = { ...env, TIME_ZONE: "europe/vienna" };
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
    const mars = { workDays: [1], workTimeZone: "Mars/Olympus" };
    expect(await setWorkingHours(env, user, g, w, mars)).toBe(false);
    // With rules, an unknown zone as input is refused as well.
    await setDirection(env, user, g, w, "busy");
    expect(await setWorkingHours(env, user, g, w, mars)).toBe(false);
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFF);
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
    expect(await response.text()).toBe(
      "Working hours: the end must be after the start. For the end of the day, choose “until midnight”. Nothing was saved.",
    );
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

  it("keeps a stored zone that became unknown, says so on the page, and reads UTC", async () => {
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
    const html = await page.text();
    expect(html).toContain(
      "This server does not know the time zone Mars/Olympus. Until you choose another one, the hours are read in UTC.",
    );
    expect(html).toMatch(/name="workTimeZone"[^>]*value="Mars\/Olympus"/);

    // Saves that do not touch the hours keep the stored zone.
    const save = (fields: Record<string, string>) =>
      post("/rules/choices", cookie, new URLSearchParams(fields), { "x-fragment": "1" });
    expect((await save({ settings: "1", "settings.daysAhead": "30" })).status).toBe(204);
    expect((await save({ [`blockColor.${g}.${w}`]: "Focus" })).status).toBe(204);
    expect(await optionsOf(user.id, g, w)).toMatchObject({
      workDays: [1],
      workTimeZone: "Mars/Olympus",
      daysAhead: 30,
      blockColor: "Focus",
    });
    // Sending the unknown zone as input is refused; a known one replaces it.
    const hours = (zone: string) => ({
      [`workDays.${g}.${w}`]: "1",
      [`workStart.${g}.${w}`]: "",
      [`workEnd.${g}.${w}`]: "",
      [`workTimeZone.${g}.${w}`]: zone,
    });
    expect((await save(hours("Mars/Olympus"))).status).toBe(400);
    expect((await save(hours("Europe/Vienna"))).status).toBe(204);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ workTimeZone: "Europe/Vienna" });
  });

  it('shows 24:00 as "until midnight" and saves the checkbox without the script', async () => {
    const { user, cookie, w, g } = await setup("hoursmidnight");
    await setDirection(env, user, g, w, "busy");
    const body = new URLSearchParams({
      from: g,
      to: w,
      workStart: "18:00",
      workEnd: "",
      workUntilMidnight: "1",
      workTimeZone: "Europe/Vienna",
    });
    body.append("workDays", "5");
    expect((await post("/rules/direction/hours", cookie, body)).status).toBe(302);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ workStart: "18:00", workEnd: "24:00" });

    const html = await (
      await exports.default.fetch(`${BASE}/rules?open=${g}`, { headers: { cookie } })
    ).text();
    const forms = html.match(/<form[^>]*working-hours[\s\S]*?<\/form>/g) ?? [];
    const form = forms.find((f) => f.includes(`name="to" value="${w}"`)) ?? "";
    expect(form).toMatch(/<input[^>]*type="time"[^>]*name="workStart"[^>]*value="18:00"/);
    const end = form.match(/<input[^>]*name="workEnd"[^>]*>/)?.[0] ?? "";
    expect(end).toContain('type="time"');
    expect(end).toContain("disabled");
    expect(end).not.toContain("24:00");
    expect(form).toMatch(/<input[^>]*name="workUntilMidnight"[^>]*checked/);
    expect(form).not.toContain("inputmode");

    // Without the checkbox the end field counts again.
    body.delete("workUntilMidnight");
    body.set("workEnd", "22:00");
    expect((await post("/rules/direction/hours", cookie, body)).status).toBe(302);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ workEnd: "22:00" });
  });

  it("refuses a file in any field of the editor, and writes nothing", async () => {
    const { user, cookie, w, g } = await setup("hoursfile");
    const fields = [
      `calendar.${w}-cal`,
      `choice.${w}.${g}`,
      `blockColor.${g}.${w}`,
      `workDays.${g}.${w}`,
      `workStart.${g}.${w}`,
      `workEnd.${g}.${w}`,
      `workTimeZone.${g}.${w}`,
    ];
    for (const field of fields) {
      const body = new FormData();
      body.append(`choice.${g}.${w}`, "busy");
      body.append(field, new Blob(["1"]), "part.txt");
      const response = await exports.default.fetch(`${BASE}/rules/choices`, {
        method: "POST",
        headers: { cookie, "x-fragment": "1" },
        body,
      });
      expect(response.status, field).toBe(400);
    }
    expect(await rulesOf(user.id, g, w)).toEqual([]);
  });

  it("saves the source change and skips the hours of a direction that loses its last source", async () => {
    const { user, cookie, w, g } = await setup("lastsource");
    await setDirection(env, user, g, w, "busy");
    // The same save turns off the only source calendar of the direction.
    const body = new URLSearchParams({
      [`calendar.${g}-cal`]: "0",
      [`workDays.${g}.${w}`]: "1",
      [`workStart.${g}.${w}`]: "",
      [`workEnd.${g}.${w}`]: "",
      [`workTimeZone.${g}.${w}`]: "",
    });
    const response = await post("/rules/choices", cookie, body, { "x-fragment": "1" });
    // The direction has no rules left, so its hours have nothing to change. The save must not
    // answer 409 after it turned the calendar off.
    expect(response.status).toBe(204);
    const row = await env.DB.prepare("SELECT is_source FROM calendars WHERE id = ?")
      .bind(`${g}-cal`)
      .first<{ is_source: number }>();
    expect(row?.is_source).toBe(0);
    expect(await rulesOf(user.id, g, w)).toEqual([]);
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

  it("return a direction to the group when the hours are cleared", async () => {
    const { user, w, g } = await setup("hoursclear");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setWorkingHours(env, user, g, w, { workDays: [1, 2, 3, 4, 5] });
    expect((await rulesOf(user.id, g, w)).map((rule) => rule.origin)).toEqual(["custom"]);
    await setWorkingHours(env, user, g, w, { workDays: [1, 2, 3, 4, 5, 6, 7] });
    expect((await rulesOf(user.id, g, w)).map((rule) => rule.origin)).toEqual(["group"]);
    // A group rule goes with the group.
    await setGroupMembership(env, user, g, false);
    expect(await rulesOf(user.id, g, w)).toEqual([]);
  });

  it("return to the group when busy and cleared hours are saved together", async () => {
    const { user, cookie, w, g } = await setup("hoursboth");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, g, w, "title");
    await setWorkingHours(env, user, g, w, { workDays: [1, 2, 3, 4, 5] });
    expect((await rulesOf(user.id, g, w)).map((rule) => rule.origin)).toEqual(["custom"]);
    const body = new URLSearchParams({
      [`choice.${g}.${w}`]: "busy",
      [`workDays.${g}.${w}`]: "1,2,3,4,5,6,7",
      [`workStart.${g}.${w}`]: "",
      [`workEnd.${g}.${w}`]: "",
      [`workTimeZone.${g}.${w}`]: "",
    });
    expect((await post("/rules/choices", cookie, body, { "x-fragment": "1" })).status).toBe(204);
    expect((await rulesOf(user.id, g, w)).map((rule) => rule.origin)).toEqual(["group"]);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ ...OFF, detailLevel: "busy" });
    await setGroupMembership(env, user, g, false);
    expect(await rulesOf(user.id, g, w)).toEqual([]);

    // A choice other than busy stays an exception when the hours are cleared.
    const other = await setup("hoursboth2");
    await setGroupMembership(env, other.user, other.w, true);
    await setGroupMembership(env, other.user, other.g, true);
    await setDirection(env, other.user, other.g, other.w, "title");
    await setWorkingHours(env, other.user, other.g, other.w, { workDays: [1] });
    await setWorkingHours(env, other.user, other.g, other.w, { workDays: [1, 2, 3, 4, 5, 6, 7] });
    expect((await rulesOf(other.user.id, other.g, other.w)).map((rule) => rule.origin)).toEqual([
      "custom",
    ]);
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

describe("working hours with copies and parked rules", () => {
  const office = {
    workDays: [1, 2, 3, 4, 5],
    workStart: "08:00",
    workEnd: "18:00",
    workTimeZone: "Europe/Vienna",
  };

  it("refuses hours for a direction that does not exist, and writes nothing", async () => {
    const { user, cookie, w, g } = await setup("hoursgone");
    const body = new URLSearchParams({
      [`choice.${g}.${w}`]: "busy",
      [`workDays.nope.${w}`]: "1",
    });
    const response = await post("/rules/choices", cookie, body, { "x-fragment": "1" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("direction that no longer exists");
    expect(await rulesOf(user.id, g, w)).toEqual([]);
  });

  it("gives a copy of a direction's rule the direction's working hours", async () => {
    const { user, w, g } = await setup("hourscopy");
    await setDirection(env, user, g, w, "busy");
    expect(await setWorkingHours(env, user, g, w, office)).toBe(true);
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Side', 1, 0, 0)",
    )
      .bind(`${g}-side`, g, `${g}-side-remote`)
      .run();
    await setSourceCalendar(env, user, `${g}-side`, true);
    const rules = await rulesOf(user.id, g, w);
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(JSON.parse(rule.options)).toMatchObject(office);
      expect(rule.origin).toBe("custom");
    }
  });

  it("keeps the hours of a parked rule, and the parked mark next to them", async () => {
    const { user, w, g } = await setup("hourspark");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, g, w, "off");
    expect(await setWorkingHours(env, user, g, w, office)).toBe(true);
    // Turning the only source calendar off parks the "off" exception.
    await setSourceCalendar(env, user, `${g}-cal`, false);
    const [parked] = await rulesOf(user.id, g, w);
    expect(JSON.parse(parked?.options ?? "{}")).toMatchObject({ ...office, parked: true });
    // Settings keep both.
    await setSettings(env, user, {
      skipAllDay: true,
      skipTentative: false,
      markPrivate: true,
      blockTitle: "Busy",
      skipCategories: [],
    });
    const [kept] = await rulesOf(user.id, g, w);
    expect(JSON.parse(kept?.options ?? "{}")).toMatchObject({ ...office, parked: true });
    // Back as a source: the rule is no longer parked, still off, and keeps its hours.
    await setSourceCalendar(env, user, `${g}-cal`, true);
    const [back] = await rulesOf(user.id, g, w);
    expect(back?.enabled).toBe(0);
    expect(JSON.parse(back?.options ?? "{}")).not.toHaveProperty("parked");
    expect(JSON.parse(back?.options ?? "{}")).toMatchObject(office);
  });

  it("keeps a parked mark when it stores hours on a marked rule", async () => {
    const { user, w, g } = await setup("hoursmark");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, g, w, "off");
    // A rule can still carry the mark while its calendar is a source, for example between the
    // two writes of `setSourceCalendar`. Hours must not drop it.
    await env.DB.prepare(
      "UPDATE rules SET options = json_set(options, '$.parked', json('true')) WHERE user_id = ?",
    )
      .bind(user.id)
      .run();
    expect(await setWorkingHours(env, user, g, w, office)).toBe(true);
    const [rule] = await rulesOf(user.id, g, w);
    expect(JSON.parse(rule?.options ?? "{}")).toMatchObject({ ...office, parked: true });
  });

  it("saves every change of the page when Enter is pressed in a working-hours form", () => {
    // The editor script has no DOM test harness. This reads the submit handler of the hours form.
    const loop = (String(editorScript).split('"form.working-hours[data-key]"')[1] ?? "").split(
      "block colour of a direction",
    )[0];
    const handler = /addEventListener\("submit", \(event\) => \{([\s\S]*?)\}\);/.exec(
      loop ?? "",
    )?.[1];
    expect(handler).toContain("event.preventDefault()");
    expect(handler).toContain("onChange()");
    expect(handler).toMatch(/pending\.size > 0\) void save\(\)/);
  });
});
