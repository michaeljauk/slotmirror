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
});
