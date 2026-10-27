import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountWorkHours,
  loadEditorState,
  resetDirection,
  setAccountWorkHours,
  setDirection,
  setGroupMembership,
  setRuleDetails,
  setSettings,
  setSourceCalendar,
  type AccountWorkHours,
} from "../src/editor";
import type { CurrentUser } from "../src/users";
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

/** A second source calendar of an account, turned on, so that a direction has two rules. */
async function addSource(user: CurrentUser, accountId: string) {
  await env.DB.prepare(
    "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Side', 1, 0, 0)",
  )
    .bind(`${accountId}-side`, accountId, `${accountId}-side-remote`)
    .run();
  await setSourceCalendar(env, user, `${accountId}-side`, true);
}

const optionsOf = async (userId: string, from: string, to: string) =>
  (await loadEditorState(env, userId)).directions.find((d) => d.from === from && d.to === to)
    ?.options;

const accountHoursOf = async (userId: string, accountId: string) =>
  (await loadEditorState(env, userId)).accounts.find((a) => a.id === accountId)?.workHours;

/** The rules of one direction: origin, enabled, and the stored options. */
async function rulesOf(userId: string, from: string, to: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.origin, r.enabled, r.options FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ? AND sc.account_id = ? AND tc.account_id = ?
     ORDER BY r.source_calendar_id`,
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

const save = (cookie: string, fields: Record<string, string>) =>
  post("/rules/choices", cookie, new URLSearchParams(fields), { "x-fragment": "1" });

const page = async (cookie: string, path: string) =>
  (await exports.default.fetch(`${BASE}${path}`, { headers: { cookie } })).text();

const OFF = { workDays: [1, 2, 3, 4, 5, 6, 7], workStart: "", workEnd: "", workTimeZone: "" };

const OFFICE: AccountWorkHours = {
  workDays: [1, 2, 3, 4, 5],
  workStart: "08:00",
  workEnd: "18:00",
  workTimeZone: "Europe/Vienna",
};

/** The account settings form with working hours, as the home page sends it. */
function settingsForm(
  fields: { workStart?: string; workEnd?: string; workTimeZone?: string; name?: string },
  days: string[],
  extra: Record<string, string> = {},
) {
  const body = new URLSearchParams({
    name: fields.name ?? "",
    color: "auto",
    workHoursShown: "1",
    workStart: fields.workStart ?? "",
    workEnd: fields.workEnd ?? "",
    workTimeZone: fields.workTimeZone ?? "",
    ...extra,
  });
  for (const day of days) body.append("workDays", day);
  return body;
}

/** The fieldset of an account's working hours on the home page. */
function hoursFieldset(html: string, accountId: string): string {
  const item = html.split(`id="account-${accountId}"`)[1] ?? "";
  return item.match(/<fieldset class="account-hours">[\s\S]*?<\/fieldset>/)?.[0] ?? "";
}

/** The target row of a direction in the editor. */
function targetRow(html: string, from: string, to: string): string {
  const card = html.split(`id="src-${from}"`)[1]?.split("</details>\n")[0] ?? "";
  return (
    card.split('<div class="dest"').find((row) => row.startsWith(` data-key="${from}&gt;${to}"`)) ??
    ""
  );
}

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

describe("working hours of an account", () => {
  it("saves the hours from the account settings, shows them, and refuses invalid values", async () => {
    const { user, cookie, w } = await setup("acct");
    const saved = await post(
      `/accounts/${w}/settings`,
      cookie,
      settingsForm({ workStart: "08:00", workEnd: "18:00", workTimeZone: "europe/vienna" }, [
        "5",
        "1",
        "2",
        "3",
        "4",
      ]),
    );
    expect(saved.status).toBe(302);
    // The account has no rules yet; its hours are stored anyway.
    expect(await accountHoursOf(user.id, w)).toEqual(OFFICE);

    const html = await page(cookie, `/?settings=${w}`);
    const fieldset = hoursFieldset(html, w);
    expect(fieldset).toMatch(/name="workStart"[^>]*value="08:00"/);
    expect(fieldset).toMatch(/name="workEnd"[^>]*value="18:00"/);
    expect(fieldset).toMatch(/name="workTimeZone"[^>]*value="Europe\/Vienna"/);
    // A stored zone is not replaced by the browser's.
    expect(fieldset).not.toContain("data-browser-zone");
    const checked = [...fieldset.matchAll(/<input[^>]*name="workDays"[^>]*>/g)]
      .filter(([input]) => /checked/.test(input))
      .map(([input]) => input.match(/value="(\d)"/)?.[1]);
    expect(checked).toEqual(["1", "2", "3", "4", "5"]);
    expect(fieldset).toContain(
      'title="You turn it on per calendar in the sync settings. Without working hours the whole day counts."',
    );
    expect(html).toMatch(/<details class="rename" open/);

    const cases = [
      [{ workStart: "18:00", workEnd: "08:00" }, ["1"], "the end must be after the start"],
      [{ workStart: "08:00", workEnd: "08:00" }, ["1"], "the end must be after the start"],
      [{ workStart: "08:00", workEnd: "" }, ["1"], "enter a start and an end"],
      [{ workStart: "8:00", workEnd: "18:00" }, ["1"], "enter a start and an end"],
      [{ workStart: "08:00", workEnd: "18:00" }, [], "choose at least one weekday"],
      [{ workStart: "08:00", workEnd: "18:00" }, ["0", "1"], "choose at least one weekday"],
      [{ workStart: "08:00", workEnd: "18:00", workTimeZone: "Mars/Olympus" }, ["1"], "zone"],
    ] as const;
    for (const [fields, days, message] of cases) {
      // The name in the same form is not saved either: the form saves all or nothing.
      const body = settingsForm({ ...fields, name: "Renamed" }, [...days]);
      const response = await post(`/accounts/${w}/settings`, cookie, body);
      expect(response.status, message).toBe(400);
      const text = await response.text();
      expect(text).toContain(message);
      expect(text).toContain(`<details class="rename" open`);
    }
    const german = await post(
      `/accounts/${w}/settings`,
      cookie,
      settingsForm({ workStart: "08:00", workEnd: "18:00", name: "Renamed" }, []),
      { "accept-language": "de" },
    );
    expect(await german.text()).toContain("Arbeitszeit: Wähle mindestens einen Wochentag.");
    expect(await accountHoursOf(user.id, w)).toEqual(OFFICE);
    const state = await loadEditorState(env, user.id);
    expect(state.accounts.find((account) => account.id === w)?.customName).toBeNull();
  });

  it("stores none for no day and no time, and for the button; a name-only form keeps them", async () => {
    const { user, cookie, w } = await setup("acctnone");
    await setAccountWorkHours(env, user, w, OFFICE);
    // The form before the working hours came sends the name only.
    const nameOnly = new URLSearchParams({ name: "Office" });
    expect((await post(`/accounts/${w}/name`, cookie, nameOnly)).status).toBe(302);
    expect(await accountHoursOf(user.id, w)).toEqual(OFFICE);

    const button = settingsForm({ workStart: "08:00", workEnd: "18:00" }, ["1"], {
      workHours: "none",
    });
    expect((await post(`/accounts/${w}/settings`, cookie, button)).status).toBe(302);
    expect(await accountHoursOf(user.id, w)).toBeNull();

    await setAccountWorkHours(env, user, w, OFFICE);
    const empty = settingsForm({ workTimeZone: "Europe/Vienna" }, []);
    expect((await post(`/accounts/${w}/settings`, cookie, empty)).status).toBe(302);
    expect(await accountHoursOf(user.id, w)).toBeNull();
    // A form without hours shows no ticked day, so that saving the name sets no hours.
    const fieldset = hoursFieldset(await page(cookie, "/"), w);
    expect(fieldset).not.toMatch(/name="workDays"[^>]*checked/);
    expect(fieldset).not.toContain("No working hours");

    // All seven days and no times filter nothing, so they are none as well.
    const allDays = settingsForm({}, ["1", "2", "3", "4", "5", "6", "7"]);
    expect((await post(`/accounts/${w}/settings`, cookie, allDays)).status).toBe(302);
    expect(await accountHoursOf(user.id, w)).toBeNull();
  });

  it("uses the deployment's zone without a zone, in canonical spelling, and the browser's in the page", async () => {
    const vienna = { ...env, TIME_ZONE: "europe/vienna" };
    expect(accountWorkHours(vienna, { ...OFFICE, workTimeZone: " " })).toEqual({ hours: OFFICE });
    expect(accountWorkHours(env, { ...OFFICE, workTimeZone: "US/Eastern" })).toEqual({
      hours: { ...OFFICE, workTimeZone: "America/New_York" },
    });
    expect(accountWorkHours(env, { ...OFFICE, workTimeZone: "" })).toEqual({
      hours: { ...OFFICE, workTimeZone: "UTC" },
    });
    // Without a stored zone the field shows the deployment's zone, marked for the browser's.
    const { cookie, w } = await setup("acctzone");
    const fieldset = hoursFieldset(await page(cookie, "/"), w);
    expect(fieldset).toMatch(/name="workTimeZone"[^>]*value="UTC"[^>]*data-browser-zone="1"/);
    expect(String(editorScript)).toContain("Intl.DateTimeFormat().resolvedOptions().timeZone");
  });

  it("keeps a stored zone that became unknown and says so on the page", async () => {
    const { user, cookie, w } = await setup("acctstale");
    await env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = ?")
      .bind(JSON.stringify({ ...OFFICE, workTimeZone: "Mars/Olympus" }), w)
      .run();
    expect(await accountHoursOf(user.id, w)).toMatchObject({ workTimeZone: "Mars/Olympus" });
    const html = await page(cookie, "/");
    expect(html).toContain(
      "This server does not know the time zone Mars/Olympus. Until you choose another one, the hours are read in UTC.",
    );
    expect(hoursFieldset(html, w)).toMatch(/name="workTimeZone"[^>]*value="Mars\/Olympus"/);
  });

  it("gives the rules that use them the new hours, and takes them away when cleared", async () => {
    const { user, w, g } = await setup("acctrules");
    await setAccountWorkHours(env, user, w, OFFICE);
    await setAccountWorkHours(env, user, g, OFFICE);
    await setDirection(env, user, g, w, "busy");
    await setDirection(env, user, w, g, "busy");
    await addSource(user, g);
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    expect(await rulesOf(user.id, g, w)).toHaveLength(2);

    const late = { ...OFFICE, workDays: [6, 7], workStart: "10:00", workEnd: "24:00" };
    expect(await setAccountWorkHours(env, user, w, late)).toBe(true);
    for (const rule of await rulesOf(user.id, g, w)) {
      expect(JSON.parse(rule.options)).toMatchObject(late);
    }
    // The rules into the other account do not use working hours and stay without.
    expect(await optionsOf(user.id, w, g)).toMatchObject(OFF);

    expect(await setAccountWorkHours(env, user, w, null)).toBe(true);
    for (const rule of await rulesOf(user.id, g, w)) {
      expect(JSON.parse(rule.options)).toMatchObject(OFF);
    }
    expect(await accountHoursOf(user.id, w)).toBeNull();
    // An account of another user is refused.
    const other = await setup("acctrules2");
    expect(await setAccountWorkHours(env, other.user, w, OFFICE)).toBe(false);
    expect(await accountHoursOf(user.id, w)).toBeNull();
  });

  it("gives parked rules and rules outside the directions the new hours", async () => {
    const { user, w, g } = await setup("acctstale2");
    const late = { ...OFFICE, workStart: "12:00", workEnd: "20:00" };
    await setAccountWorkHours(env, user, w, OFFICE);
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, g, w, "off");
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    // A manual rule between two other calendars, with hours from before. No direction covers it.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'w-extra', 'Extra', 1, 0, 0)",
      ).bind(`${w}-extra`, w),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'g-other', 'Other', 1, 0, 0)",
      ).bind(`${g}-other`, g),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled, origin) VALUES ('stale2-extra', ?, ?, ?, ?, 1, 'custom')",
      ).bind(user.id, `${g}-other`, `${w}-extra`, JSON.stringify(OFFICE)),
    ]);
    await setSourceCalendar(env, user, `${g}-cal`, false);
    expect(await setAccountWorkHours(env, user, w, late)).toBe(true);
    const [parked] = await rulesOf(user.id, g, w);
    expect(JSON.parse(parked?.options ?? "{}")).toMatchObject({ ...late, parked: true });

    await setSourceCalendar(env, user, `${g}-cal`, true);
    await setDirection(env, user, g, w, "busy");
    const back = (await rulesOf(user.id, g, w)).find((rule) => rule.id !== "stale2-extra");
    expect(JSON.parse(back?.options ?? "{}")).toMatchObject(late);
    const extra = await env.DB.prepare(
      "SELECT options FROM rules WHERE id = 'stale2-extra'",
    ).first<{
      options: string;
    }>();
    expect(JSON.parse(extra?.options ?? "{}")).toMatchObject(late);
  });

  it("gives a copy from a parked rule the account's current hours", async () => {
    const { user, w, g } = await setup("acctcopy");
    const late = { ...OFFICE, workStart: "12:00", workEnd: "20:00" };
    await setAccountWorkHours(env, user, w, OFFICE);
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, g, w, "off");
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    await setSourceCalendar(env, user, `${g}-cal`, false);
    // The account's hours changed without its rules, as after an earlier failure.
    await env.DB.prepare("UPDATE accounts SET work_hours = ? WHERE id = ?")
      .bind(JSON.stringify(late), w)
      .run();
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'g-side', 'Side', 1, 0, 0)",
    )
      .bind(`${g}-side`, g)
      .run();
    await setSourceCalendar(env, user, `${g}-side`, true);
    const copy = await env.DB.prepare("SELECT options FROM rules WHERE source_calendar_id = ?")
      .bind(`${g}-side`)
      .first<{ options: string }>();
    expect(JSON.parse(copy?.options ?? "{}")).toMatchObject(late);
  });
});

describe("copies without account hours", () => {
  it("gives a copy no hours once the account has none", async () => {
    const { user, w, g } = await setup("acctcopynone");
    await setAccountWorkHours(env, user, w, OFFICE);
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, g, w, "off");
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    await setSourceCalendar(env, user, `${g}-cal`, false);
    // The account lost its hours without its rules, as after an earlier failure.
    await env.DB.prepare("UPDATE accounts SET work_hours = NULL WHERE id = ?").bind(w).run();
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'g-side', 'Side', 1, 0, 0)",
    )
      .bind(`${g}-side`, g)
      .run();
    await setSourceCalendar(env, user, `${g}-side`, true);
    const copy = await env.DB.prepare("SELECT options FROM rules WHERE source_calendar_id = ?")
      .bind(`${g}-side`)
      .first<{ options: string }>();
    expect(JSON.parse(copy?.options ?? "{}")).toMatchObject(OFF);
  });
});

describe("the account settings form", () => {
  /** The settings form of an account on the home page. */
  const settingsOf = (html: string, accountId: string) =>
    html.split(`id="account-${accountId}"`)[1]?.match(/<form[\s\S]*?<\/form>/)?.[0] ?? "";

  it("saves with Enter: the first submit button is the save button", async () => {
    const { user, cookie, w } = await setup("acctenter");
    await setAccountWorkHours(env, user, w, OFFICE);
    const form = settingsOf(await page(cookie, "/"), w);
    expect(form).toContain("No working hours");
    const buttons = form.match(/<button[^>]*>/g) ?? [];
    const submits = buttons.filter((button) => !/type="button"/.test(button));
    // Enter submits with the first submit button of the form, so that one must not clear.
    expect(submits[0]).not.toContain('name="workHours"');
    expect(submits.some((button) => button.includes('value="none"'))).toBe(true);
  });

  it("leaves the end field enabled without the script, and the script disables it", async () => {
    const { user, cookie, w } = await setup("acctmid");
    await setAccountWorkHours(env, user, w, { ...OFFICE, workEnd: "24:00" });
    const fieldset = hoursFieldset(await page(cookie, "/"), w);
    expect(fieldset).toMatch(/name="workUntilMidnight"[^>]*checked/);
    expect(fieldset.match(/<input[^>]*name="workEnd"[^>]*>/)?.[0]).not.toContain("disabled");
    expect(String(editorScript)).toContain("input[name=workUntilMidnight]:checked");
  });

  it("shows what the user typed after a refused save", async () => {
    const { cookie, w } = await setup("accttyped");
    const body = settingsForm(
      { workStart: "18:00", workEnd: "08:00", workTimeZone: "Europe/Berlin", name: "Desk" },
      ["2", "4"],
    );
    body.set("color", "indigo");
    const response = await post(`/accounts/${w}/settings`, cookie, body);
    expect(response.status).toBe(400);
    const html = await response.text();
    const fieldset = hoursFieldset(html, w);
    expect(fieldset).toMatch(/name="workStart"[^>]*value="18:00"/);
    expect(fieldset).toMatch(/name="workEnd"[^>]*value="08:00"/);
    expect(fieldset).toMatch(/name="workTimeZone"[^>]*value="Europe\/Berlin"/);
    expect(fieldset).not.toContain("data-browser-zone");
    const checked = [...fieldset.matchAll(/<input[^>]*name="workDays"[^>]*>/g)]
      .filter(([input]) => /checked/.test(input))
      .map(([input]) => input.match(/value="(\d)"/)?.[1]);
    expect(checked).toEqual(["2", "4"]);
    const form = settingsOf(html, w);
    expect(form).toMatch(/name="name"[^>]*value="Desk"/);
    expect(form).toMatch(/name="color"[^>]*value="indigo"[^>]*checked/);
  });

  it("answers an account of another user with 404 and changes nothing", async () => {
    const { user, w } = await setup("acctowner");
    const other = await setup("acctintruder");
    const body = settingsForm({ workStart: "08:00", workEnd: "18:00", name: "Taken" }, ["1"]);
    body.set("color", "indigo");
    const response = await post(`/accounts/${w}/settings`, other.cookie, body);
    expect(response.status).toBe(404);
    const account = (await loadEditorState(env, user.id)).accounts.find((a) => a.id === w);
    expect(account?.workHours).toBeNull();
    expect(account?.customName).toBeNull();
    expect(account?.colorChosen).toBe(false);
  });
});

describe("working hours per target", () => {
  it("copies the account's hours into every rule of the direction from the page, and clears them", async () => {
    const { user, cookie, w, g } = await setup("target");
    await setAccountWorkHours(env, user, w, OFFICE);
    await setDirection(env, user, g, w, "busy");
    await setDirection(env, user, w, g, "busy");
    await addSource(user, g);

    const html = await page(cookie, `/rules?open=${g}`);
    const row = targetRow(html, g, w);
    expect(row).toContain("Only during the working hours of work (Mo–Fr 08:00–18:00)");
    expect(row).toMatch(/<input type="checkbox" name="workHours" value="1" form="[^"]+"\/?>/);

    expect((await save(cookie, { [`workHours.${g}.${w}`]: "1" })).status).toBe(204);
    const rules = await rulesOf(user.id, g, w);
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(JSON.parse(rule.options)).toMatchObject(OFFICE);
    expect(await optionsOf(user.id, w, g)).toMatchObject(OFF);
    expect(targetRow(await page(cookie, `/rules?open=${g}`), g, w)).toMatch(
      /name="workHours" value="1"[^>]*checked/,
    );

    // Settings for all rules keep the hours.
    await save(cookie, { settings: "1", "settings.daysAhead": "30" });
    expect(await optionsOf(user.id, g, w)).toMatchObject({ ...OFFICE, daysAhead: 30 });

    expect((await save(cookie, { [`workHours.${g}.${w}`]: "0" })).status).toBe(204);
    for (const rule of await rulesOf(user.id, g, w)) {
      expect(JSON.parse(rule.options)).toMatchObject(OFF);
    }
  });

  it("offers a link for an account without hours, and refuses to turn them on", async () => {
    const { user, cookie, w, g } = await setup("targetnone");
    await setDirection(env, user, g, w, "busy");
    const row = targetRow(await page(cookie, `/rules?open=${g}`), g, w);
    expect(row).toContain(`href="/?settings=${w}#account-${w}"`);
    expect(row).toContain("Set working hours");
    expect(row).not.toContain('name="workHours"');

    const response = await save(cookie, {
      [`choice.${w}.${g}`]: "title",
      [`workHours.${g}.${w}`]: "1",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "work has no working hours. Set them in the account settings. Nothing was saved.",
    );
    expect(await rulesOf(user.id, w, g)).toEqual([]);
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFF);
  });

  it("saves the colour and the checkbox from the form without the editor script", async () => {
    const { user, cookie, w, g } = await setup("targetform");
    await setAccountWorkHours(env, user, w, OFFICE);
    await setDirection(env, user, g, w, "title");
    const body = new URLSearchParams({
      from: g,
      to: w,
      blockColor: "Focus",
      workHoursShown: "1",
      workHours: "1",
    });
    const response = await post("/rules/direction/details", cookie, body);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/rules?open=${g}#src-${g}`);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ ...OFFICE, blockColor: "Focus" });

    // An unchecked box is not sent; the marker field says that it was on the page.
    body.delete("workHours");
    expect((await post("/rules/direction/details", cookie, body)).status).toBe(302);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ ...OFF, blockColor: "Focus" });

    // A refused colour stores nothing, also not the checkbox.
    const refused = new URLSearchParams({
      from: g,
      to: w,
      blockColor: "a, b",
      workHoursShown: "1",
      workHours: "1",
    });
    const answer = await post("/rules/direction/details", cookie, refused);
    expect(answer.status).toBe(400);
    expect(await answer.text()).toContain("cannot contain a comma");
    expect(await optionsOf(user.id, g, w)).toMatchObject({ ...OFF, blockColor: "Focus" });
  });

  it("refuses a file in any field of the editor, and writes nothing", async () => {
    const { user, cookie, w, g } = await setup("hoursfile");
    const fields = [
      `calendar.${w}-cal`,
      `choice.${w}.${g}`,
      `blockColor.${g}.${w}`,
      `workHours.${g}.${w}`,
      `bufferBefore.${g}`,
      `bufferAfter.${g}`,
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
    await setAccountWorkHours(env, user, w, OFFICE);
    await setDirection(env, user, g, w, "busy");
    // The same save turns off the only source calendar of the direction.
    const response = await save(cookie, {
      [`calendar.${g}-cal`]: "0",
      [`workHours.${g}.${w}`]: "1",
    });
    expect(response.status).toBe(204);
    const row = await env.DB.prepare("SELECT is_source FROM calendars WHERE id = ?")
      .bind(`${g}-cal`)
      .first<{ is_source: number }>();
    expect(row?.is_source).toBe(0);
    expect(await rulesOf(user.id, g, w)).toEqual([]);
  });

  it("refuses hours for a direction that does not exist, and writes nothing", async () => {
    const { user, cookie, w, g } = await setup("hoursgone");
    await setAccountWorkHours(env, user, w, OFFICE);
    const response = await save(cookie, {
      [`choice.${g}.${w}`]: "busy",
      [`workHours.nope.${w}`]: "1",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("direction that no longer exists");
    expect(await rulesOf(user.id, g, w)).toEqual([]);
  });

  it("turns a direction on and its hours on in one save", async () => {
    const { user, cookie, w, g } = await setup("hoursnew");
    await setAccountWorkHours(env, user, w, OFFICE);
    const response = await save(cookie, {
      [`choice.${g}.${w}`]: "busy",
      [`workHours.${g}.${w}`]: "1",
    });
    expect(response.status).toBe(204);
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFFICE);
  });
});

describe("routes of pages opened before the editor rebuild", () => {
  const cases = [
    ["/rules/direction/color", { blockColor: "Focus" }],
    ["/rules/direction/hours", { workDays: "1", workStart: "08:00", workEnd: "18:00" }],
    ["/rules/direction/buffer", { bufferBefore: "30", bufferAfter: "30" }],
  ] as const;
  for (const [path, fields] of cases) {
    it(`answers ${path} with a redirect to the editor and writes nothing`, async () => {
      const { user, cookie, w, g } = await setup(`old${path.split("/").at(-1)}`);
      await setDirection(env, user, g, w, "busy");
      const before = await rulesOf(user.id, g, w);
      const response = await post(path, cookie, new URLSearchParams({ from: g, to: w, ...fields }));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/rules");
      expect(await rulesOf(user.id, g, w)).toEqual(before);
    });
  }
});

describe("working hours in the block group", () => {
  const origins = async (userId: string, from: string, to: string) =>
    (await rulesOf(userId, from, to)).map((rule) => rule.origin);

  it("leave the origin of a group rule as it is, and the reset clears them", async () => {
    const { user, w, g } = await setup("hoursgroup");
    await setAccountWorkHours(env, user, w, OFFICE);
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    expect(await origins(user.id, g, w)).toEqual(["group"]);

    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    expect(await origins(user.id, g, w)).toEqual(["group"]);
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFFICE);
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: false }] });
    expect(await origins(user.id, g, w)).toEqual(["group"]);

    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    await setAccountWorkHours(env, user, w, null);
    expect(await origins(user.id, g, w)).toEqual(["group"]);
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFF);

    await setAccountWorkHours(env, user, w, OFFICE);
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    await resetDirection(env, user, g, w);
    expect(await origins(user.id, g, w)).toEqual(["group"]);
    expect(await optionsOf(user.id, g, w)).toMatchObject(OFF);
  });

  it("keep an exception an exception when they go on and off", async () => {
    const { user, w, g } = await setup("hoursexc");
    await setAccountWorkHours(env, user, w, OFFICE);
    // A custom busy rule from before the group: its colour keeps it out of the group.
    await setDirection(env, user, g, w, "busy");
    await setRuleDetails(env, user, { colors: [{ from: g, to: w, value: "5" }] });
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    expect(await origins(user.id, g, w)).toEqual(["custom"]);

    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    expect(await origins(user.id, g, w)).toEqual(["custom"]);
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: false }] });
    expect(await origins(user.id, g, w)).toEqual(["custom"]);
    await setAccountWorkHours(env, user, w, null);
    expect(await origins(user.id, g, w)).toEqual(["custom"]);

    // An exception survives leaving the group; the group rule of the other direction goes.
    await setGroupMembership(env, user, g, false);
    expect(await origins(user.id, g, w)).toEqual(["custom"]);
    expect(await rulesOf(user.id, w, g)).toEqual([]);
  });

  it("return to the group when busy and no hours are saved together", async () => {
    const { user, cookie, w, g } = await setup("hoursboth");
    await setAccountWorkHours(env, user, w, OFFICE);
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, g, w, "title");
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    expect(await origins(user.id, g, w)).toEqual(["custom"]);
    const response = await save(cookie, {
      [`choice.${g}.${w}`]: "busy",
      [`workHours.${g}.${w}`]: "0",
    });
    expect(response.status).toBe(204);
    expect(await origins(user.id, g, w)).toEqual(["group"]);
    expect(await optionsOf(user.id, g, w)).toMatchObject({ ...OFF, detailLevel: "busy" });
  });
});

describe("working hours with copies and parked rules", () => {
  it("gives a copy of a direction's rule the direction's working hours", async () => {
    const { user, w, g } = await setup("hourscopy");
    await setAccountWorkHours(env, user, w, OFFICE);
    await setDirection(env, user, g, w, "busy");
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    await addSource(user, g);
    const rules = await rulesOf(user.id, g, w);
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(JSON.parse(rule.options)).toMatchObject(OFFICE);
      expect(rule.origin).toBe("custom");
    }
  });

  it("keeps the hours of a parked rule, and the parked mark next to them", async () => {
    const { user, w, g } = await setup("hourspark");
    await setAccountWorkHours(env, user, w, OFFICE);
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);
    await setDirection(env, user, g, w, "off");
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    // Turning the only source calendar off parks the "off" exception.
    await setSourceCalendar(env, user, `${g}-cal`, false);
    const [parked] = await rulesOf(user.id, g, w);
    expect(JSON.parse(parked?.options ?? "{}")).toMatchObject({ ...OFFICE, parked: true });
    // Settings keep both.
    await setSettings(env, user, {
      skipAllDay: true,
      skipTentative: false,
      markPrivate: true,
      blockTitle: "Busy",
      skipCategories: [],
    });
    const [kept] = await rulesOf(user.id, g, w);
    expect(JSON.parse(kept?.options ?? "{}")).toMatchObject({ ...OFFICE, parked: true });
    // Back as a source: the rule is no longer parked, still off, and keeps its hours.
    await setSourceCalendar(env, user, `${g}-cal`, true);
    const [back] = await rulesOf(user.id, g, w);
    expect(back?.enabled).toBe(0);
    expect(JSON.parse(back?.options ?? "{}")).not.toHaveProperty("parked");
    expect(JSON.parse(back?.options ?? "{}")).toMatchObject(OFFICE);
  });

  it("keeps a parked mark when it stores hours on a marked rule", async () => {
    const { user, w, g } = await setup("hoursmark");
    await setAccountWorkHours(env, user, w, OFFICE);
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
    await setRuleDetails(env, user, { workHours: [{ from: g, to: w, on: true }] });
    const [rule] = await rulesOf(user.id, g, w);
    expect(JSON.parse(rule?.options ?? "{}")).toMatchObject({ ...OFFICE, parked: true });
  });

  it("saves every change of the page when Enter is pressed in a details form", () => {
    // The editor script has no DOM test harness. This reads the submit handler of the details form.
    const loop = (String(editorScript).split('"form.dest-details[data-key]"')[1] ?? "").split(
      "A click outside an open palette",
    )[0];
    const handler = /addEventListener\("submit", \(event\) => \{([\s\S]*?)\}\);/.exec(
      loop ?? "",
    )?.[1];
    expect(handler).toContain("event.preventDefault()");
    expect(handler).toContain("onChange()");
    expect(handler).toMatch(/pending\.size > 0\) void save\(\)/);
  });
});
