import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadEditorState,
  resetDirection,
  setDirection,
  setGroupMembership,
  shortNames,
} from "../src/editor";
import { BASE, signIn } from "./helpers";

describe("shortNames", () => {
  it("names public providers and work domains, and tells duplicates apart", () => {
    expect(shortNames(["a@gmail.com", "me@netcero.eu", "x@outlook.com"])).toEqual([
      "Gmail",
      "netcero",
      "Outlook",
    ]);
    expect(shortNames(["one@gmail.com", "two@gmail.com"])).toEqual(["Gmail (one)", "Gmail (two)"]);
  });
});

/** A user with three accounts, each with one main calendar and stored tokens. */
async function setup(prefix: string) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const accounts = [
    [`${prefix}-w`, `${prefix}@work.example`, "microsoft"],
    [`${prefix}-o`, `${prefix}@other.example`, "microsoft"],
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
  const [w, o, g] = accounts.map(([id]) => id);
  return { user, cookie, w: w!, o: o!, g: g! };
}

async function rulesOf(userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT sc.account_id AS source, tc.account_id AS target, r.enabled, r.origin,
            json_extract(r.options, '$.detailLevel') AS level
     FROM rules r JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ? ORDER BY source, target`,
  )
    .bind(userId)
    .all<{ source: string; target: string; enabled: number; origin: string; level: string }>();
  return results;
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

describe("block group", () => {
  it("creates busy rules both ways when accounts join, and removes them when one leaves", async () => {
    const { user, w, o, g } = await setup("grp");
    for (const id of [w, o, g]) await setGroupMembership(env, user, id, true);

    const rules = await rulesOf(user.id);
    expect(rules).toHaveLength(6);
    expect(rules.every((rule) => rule.origin === "group" && rule.level === "busy")).toBe(true);

    await setGroupMembership(env, user, g, false);
    const left = await rulesOf(user.id);
    expect(left).toHaveLength(2);
    expect(left.some((rule) => rule.source === g || rule.target === g)).toBe(false);
  });

  it("keeps exceptions when an account leaves, and adopts plain busy rules when it joins", async () => {
    const { user, w, o } = await setup("adopt");
    await setDirection(env, user, w, o, "busy");
    expect((await rulesOf(user.id))[0]).toMatchObject({ origin: "custom" });

    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, o, true);
    const rules = await rulesOf(user.id);
    expect(rules).toHaveLength(2);
    expect(rules.every((rule) => rule.origin === "group")).toBe(true);

    await setDirection(env, user, w, o, "full");
    await setGroupMembership(env, user, o, false);
    expect(await rulesOf(user.id)).toEqual([
      expect.objectContaining({ source: w, target: o, level: "full", origin: "custom" }),
    ]);
  });
});

describe("directions", () => {
  it("makes a different choice an exception and resets it to the group", async () => {
    const { user, w, g } = await setup("exc");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, g, true);

    await setDirection(env, user, w, g, "full");
    let state = await loadEditorState(env, user.id);
    expect(state.directions.find((d) => d.from === w && d.to === g)).toMatchObject({
      choice: "full",
      origin: "custom",
    });

    await resetDirection(env, user, w, g);
    state = await loadEditorState(env, user.id);
    expect(state.directions.find((d) => d.from === w && d.to === g)).toMatchObject({
      choice: "busy",
      origin: "group",
    });
  });

  it("turns a group direction off with a disabled exception, and deletes it outside the group", async () => {
    const { user, w, o, g } = await setup("off");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, o, true);

    await setDirection(env, user, w, o, "off");
    expect((await rulesOf(user.id)).find((r) => r.source === w && r.target === o)).toMatchObject({
      enabled: 0,
      origin: "custom",
    });

    await setDirection(env, user, w, g, "title");
    await setDirection(env, user, w, g, "off");
    expect((await rulesOf(user.id)).some((r) => r.source === w && r.target === g)).toBe(false);
  });
});

describe("editor page", () => {
  it("shows the group, one card per source, and marks exceptions", async () => {
    const { user, cookie, w, o, g } = await setup("page");
    for (const id of [w, o, g]) await setGroupMembership(env, user, id, true);
    await setDirection(env, user, w, g, "full");

    const html = await (
      await exports.default.fetch(`${BASE}/rules?open=${w}`, { headers: { cookie } })
    ).text();
    expect(html).toContain("Block each other");
    expect(html).toContain("Events from work");
    expect(html).toContain('class="pill exception"');
    expect(html).toContain(`id="src-${w}" open`);
    expect(html).toContain("Exception");

    const matrix = await (
      await exports.default.fetch(`${BASE}/rules`, { headers: { cookie } })
    ).text();
    expect(matrix).toContain('class="cell level-full exception"');
  });

  it("saves a choice from the form and returns to the open card", async () => {
    const { user, cookie, w, o } = await setup("form");
    const response = await exports.default.fetch(`${BASE}/rules/direction`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ from: w, to: o, choice: "title" }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/rules?open=${w}#src-${w}`);
    expect(await rulesOf(user.id)).toEqual([
      expect.objectContaining({ source: w, target: o, level: "title", enabled: 1 }),
    ]);
  });
});

describe("account names", () => {
  it("uses a name the user gave, and the derived one again when it is cleared", async () => {
    const { cookie, user, w } = await setup("name");
    const rename = (name: string) =>
      exports.default.fetch(`${BASE}/accounts/${w}/name`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name }),
      });
    expect((await rename("  NetCero  ")).status).toBe(302);
    let state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.name).toBe("NetCero");

    await rename("");
    state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.name).toBe("work");
  });
});

describe("editor script endpoints", () => {
  const fragment = (path: string, cookie: string, body?: URLSearchParams) =>
    exports.default.fetch(`${BASE}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "x-fragment": "1",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

  it("refuses an unknown choice", async () => {
    const { cookie, w, o } = await setup("badchoice");
    const response = await fragment(
      `/rules/choices`,
      cookie,
      new URLSearchParams({ [`choice.${w}.${o}`]: "everything" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("page save", () => {
  it("saves the choices of several sources in one request", async () => {
    const { user, cookie, w, o, g } = await setup("pagesave");
    const response = await exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [`choice.${w}.${g}`]: "full", [`choice.${g}.${o}`]: "busy" }),
    });
    expect(response.status).toBe(204);
    expect(await rulesOf(user.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: w, target: g, level: "full" }),
        expect.objectContaining({ source: g, target: o, level: "busy" }),
      ]),
    );

    const page = await (
      await exports.default.fetch(`${BASE}/rules?open=${w},${g}`, { headers: { cookie } })
    ).text();
    expect(page).toContain(`id="src-${w}" open`);
    expect(page).toContain(`id="src-${g}" open`);
    expect(page).toContain('id="page-bar"');
  });
});

describe("settings", () => {
  it("applies the settings to every rule and to new ones, and keeps each detail level", async () => {
    const { user, cookie, w, o, g } = await setup("settings");
    await setDirection(env, user, w, g, "full");
    const response = await exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        settings: "1",
        "settings.daysAhead": "180",
        "settings.markPrivate": "on",
      }),
    });
    expect(response.status).toBe(204);
    await setDirection(env, user, o, w, "busy");

    const { results } = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
      .bind(user.id)
      .all<{ options: string }>();
    const options = results.map((row) => JSON.parse(row.options) as Record<string, unknown>);
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option).toMatchObject({ daysAhead: 180, skipAllDay: false, markPrivate: true });
    }
    expect(options.map((option) => option.detailLevel).sort()).toEqual(["busy", "full"]);
  });
});

describe("source calendars", () => {
  it("gives a new source calendar the choices of its account, and removes them when off", async () => {
    const { user, cookie, w, o, g } = await setup("srccal");
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('srccal-games', ?, 'games', 'UFC games', 0, 0, 0)",
    )
      .bind(g)
      .run();
    await setDirection(env, user, g, w, "busy");
    await setDirection(env, user, g, o, "title");

    const save = (fields: Record<string, string>) =>
      exports.default.fetch(`${BASE}/rules/choices`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
    expect((await save({ "calendar.srccal-games": "1" })).status).toBe(204);
    const fromGames = (await rulesOf(user.id)).filter((rule) => rule.source === g);
    expect(fromGames).toHaveLength(4);
    expect(fromGames.map((rule) => rule.level).sort()).toEqual(["busy", "busy", "title", "title"]);

    // A later choice reaches every source calendar of the account.
    await setDirection(env, user, g, w, "full");
    const toWork = (await rulesOf(user.id)).filter((r) => r.source === g && r.target === w);
    expect(toWork.map((rule) => rule.level)).toEqual(["full", "full"]);

    expect((await save({ "calendar.srccal-games": "0" })).status).toBe(204);
    expect((await rulesOf(user.id)).filter((rule) => rule.source === g)).toHaveLength(2);
  });
});

describe("title and filter settings", () => {
  it("stores the block title and categories from the form, and colours as color:<id>", async () => {
    const { user, cookie, w, g } = await setup("titlefilter");
    await setDirection(env, user, w, g, "busy");
    const body = new URLSearchParams({
      settings: "1",
      "settings.daysAhead": "90",
      "settings.blockTitle": "  Belegt ",
      "settings.skipCategories": "Privat, Fokus,, ",
    });
    body.append("settings.skipColor", "color:11");
    body.append("settings.skipColor", "color:evil");
    await exports.default.fetch(`${BASE}/rules/choices`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const rule = await env.DB.prepare("SELECT options FROM rules WHERE user_id = ?")
      .bind(user.id)
      .first<{ options: string }>();
    expect(JSON.parse(rule?.options ?? "{}")).toMatchObject({
      blockTitle: "Belegt",
      skipCategories: ["Privat", "Fokus", "color:11"],
    });
  });
});

describe("reconnect", () => {
  it("clears the flag when the account is connected again", async () => {
    const { user, w } = await setup("reconnect");
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?").bind(w).run();
    let state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.needsReconnect).toBe(true);
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 0 WHERE id = ?").bind(w).run();
    state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.needsReconnect).toBe(false);
  });
});

describe("onboarding", () => {
  it("puts every account into the block group with one click", async () => {
    const { user, cookie } = await setup("quick");
    const page = await (
      await exports.default.fetch(`${BASE}/rules`, { headers: { cookie } })
    ).text();
    expect(page).toContain('action="/rules/group/all"');

    const response = await exports.default.fetch(`${BASE}/rules/group/all`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie },
    });
    expect(response.status).toBe(302);
    const rules = await rulesOf(user.id);
    expect(rules).toHaveLength(6);
    expect(rules.every((rule) => rule.origin === "group")).toBe(true);

    const after = await (
      await exports.default.fetch(`${BASE}/rules`, { headers: { cookie } })
    ).text();
    expect(after).not.toContain('action="/rules/group/all"');
  });

  it("shows the first steps with connect buttons before two accounts exist", async () => {
    const { cookie } = await signIn("fresh@org.example");
    const page = await (
      await exports.default.fetch(`${BASE}/rules`, { headers: { cookie } })
    ).text();
    expect(page).toContain("Get started in three steps");
    expect(page).toContain('href="/auth/microsoft/connect"');
  });
});

describe("many accounts", () => {
  it("collapses equal choices into one pill and shows a compact overview", async () => {
    const { user, cookie } = await signIn("many@org.example");
    for (let i = 1; i <= 6; i++) {
      const id = `many-${i}`;
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO accounts (id, user_id, provider, email, in_block_group) VALUES (?, ?, 'microsoft', ?, 1)",
        ).bind(id, user.id, `${id}@many${i}.example`),
        env.DB.prepare(
          "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
        ).bind(`${id}-cal`, id, `${id}-remote`),
      ]);
    }
    await setDirection(env, user, "many-1", "many-2", "busy");
    const page = await (
      await exports.default.fetch(`${BASE}/rules`, { headers: { cookie } })
    ).text();
    expect(page).toContain('class="matrix compact"');
    expect(page).toContain('class="pill summary"');
    expect(page).toContain('class="pills collapsed"');
  });
});
