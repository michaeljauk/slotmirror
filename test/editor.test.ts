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
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default) VALUES (?, ?, ?, 'Main', 1, 1)",
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
      await exports.default.fetch(`${BASE}/rules?view=matrix`, { headers: { cookie } })
    ).text();
    expect(matrix).toContain('class="cell level-full"');
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
