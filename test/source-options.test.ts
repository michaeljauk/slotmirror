import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadEditorState,
  resetDirection,
  setDirection,
  setGroupMembership,
  setGroupMemberships,
  setRuleDetails,
  setSourceCalendar,
} from "../src/editor";
import { BASE, signIn } from "./helpers";

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
  return { user, cookie, w: `${prefix}-w`, o: `${prefix}-o`, g: `${prefix}-g` };
}

/** Buffers of every rule from an account, as "before,after", by target account. */
async function buffersFrom(userId: string, accountId: string) {
  const { results } = await env.DB.prepare(
    `SELECT tc.account_id AS target,
            json_extract(r.options, '$.bufferBefore') || ',' ||
            json_extract(r.options, '$.bufferAfter') AS buffer
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ? AND sc.account_id = ? ORDER BY tc.account_id`,
  )
    .bind(userId, accountId)
    .all<{ target: string; buffer: string }>();
  return Object.fromEntries(results.map((row) => [row.target, row.buffer]));
}

const sourceOptionsOf = async (userId: string, accountId: string) =>
  (await loadEditorState(env, userId)).accounts.find((account) => account.id === accountId)
    ?.sourceOptions;

const post = (cookie: string, path: string, fields: Record<string, string>, fragment = false) =>
  exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      ...(fragment ? { "x-fragment": "1" } : {}),
    },
    body: new URLSearchParams(fields),
  });

/** The buffer row of a source card. */
async function bufferRow(cookie: string, from: string) {
  const html = await (
    await exports.default.fetch(`${BASE}/rules?open=${from}`, { headers: { cookie } })
  ).text();
  const card = html.split(`id="src-${from}"`)[1]?.split("</details>\n")[0] ?? "";
  return card.match(/<form[^>]*source-buffer[\s\S]*?<\/form>/)?.[0] ?? "";
}

const BUFFER = { bufferBefore: 30, bufferAfter: 15 };

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

describe("source options stored on the source account", () => {
  it("keeps the buffer of a source without rules, and shows it", async () => {
    const { user, cookie, w, g } = await setup("srcnone");
    expect(await bufferRow(cookie, w)).toContain("No buffer");
    const saved = await post(
      cookie,
      "/rules/choices",
      { [`bufferBefore.${w}`]: "30", [`bufferAfter.${w}`]: "15" },
      true,
    );
    expect(saved.status).toBe(204);
    expect(await sourceOptionsOf(user.id, w)).toEqual(BUFFER);
    expect(await bufferRow(cookie, w)).toContain("30 min. before, 15 min. after");

    await setDirection(env, user, w, g, "title");
    expect(await buffersFrom(user.id, w)).toEqual({ [g]: "30,15" });
  });

  it("keeps the buffer when the last direction of a source goes off and comes back", async () => {
    const { user, w, g } = await setup("srcoff");
    await setDirection(env, user, w, g, "busy");
    await setRuleDetails(env, user, { sources: [{ from: w, options: BUFFER }] });
    await setDirection(env, user, w, g, "off");
    expect(await buffersFrom(user.id, w)).toEqual({});
    await setDirection(env, user, w, g, "busy");
    expect(await buffersFrom(user.id, w)).toEqual({ [g]: "30,15" });
  });

  it("gives group rules the source's buffer: join, rejoin and quick start", async () => {
    const { user, cookie, w, o, g } = await setup("srcgroup");
    await setRuleDetails(env, user, { sources: [{ from: w, options: BUFFER }] });
    // Quick start: every account joins the group.
    expect((await post(cookie, "/rules/group/all", {})).status).toBe(302);
    expect(await buffersFrom(user.id, w)).toEqual({ [g]: "30,15", [o]: "30,15" });
    expect(await buffersFrom(user.id, g)).toEqual({ [o]: "0,0", [w]: "0,0" });

    await setGroupMembership(env, user, w, false);
    expect(await buffersFrom(user.id, w)).toEqual({});
    await setGroupMembership(env, user, w, true);
    expect(await buffersFrom(user.id, w)).toEqual({ [g]: "30,15", [o]: "30,15" });

    // A reset of a group direction keeps the buffer.
    await setDirection(env, user, w, g, "title");
    await resetDirection(env, user, w, g);
    expect(await buffersFrom(user.id, w)).toEqual({ [g]: "30,15", [o]: "30,15" });
  });

  it("adopts a custom busy rule with the source's buffer into the group", async () => {
    const { user, w, g } = await setup("srcadopt");
    await setDirection(env, user, w, g, "busy");
    await setRuleDetails(env, user, { sources: [{ from: w, options: BUFFER }] });
    await setGroupMemberships(env, user, [w, g], true);
    const { results } = await env.DB.prepare(
      `SELECT r.origin FROM rules r JOIN calendars sc ON sc.id = r.source_calendar_id
       WHERE sc.account_id = ?`,
    )
      .bind(w)
      .all<{ origin: string }>();
    expect(results.map((row) => row.origin)).toEqual(["group"]);
  });

  it("gives a copy for a new source calendar the stored buffer, also from a parked model", async () => {
    const { user, w, g } = await setup("srcpark");
    await setGroupMemberships(env, user, [w, g], true);
    await setDirection(env, user, w, g, "off");
    await setSourceCalendar(env, user, `${w}-cal`, false);
    await setRuleDetails(env, user, { sources: [{ from: w, options: BUFFER }] });
    // The parked "off" exception takes the buffer too.
    const parked = await env.DB.prepare("SELECT options FROM rules WHERE source_calendar_id = ?")
      .bind(`${w}-cal`)
      .first<{ options: string }>();
    expect(JSON.parse(parked?.options ?? "{}")).toMatchObject({ ...BUFFER, parked: true });
    await env.DB.prepare(
      "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, 'side', 'Side', 1, 0, 0)",
    )
      .bind(`${w}-side`, w)
      .run();
    await setSourceCalendar(env, user, `${w}-side`, true);
    const side = await env.DB.prepare(
      "SELECT options, enabled FROM rules WHERE source_calendar_id = ?",
    )
      .bind(`${w}-side`)
      .first<{ options: string; enabled: number }>();
    expect(side?.enabled).toBe(0);
    expect(JSON.parse(side?.options ?? "{}")).toMatchObject(BUFFER);
  });

  it('shows "differs" when a rule differs from the stored buffer', async () => {
    const { user, cookie, w, g, o } = await setup("srcmixed");
    await setDirection(env, user, w, g, "busy");
    await setDirection(env, user, w, o, "busy");
    await setRuleDetails(env, user, { sources: [{ from: w, options: BUFFER }] });
    expect(await bufferRow(cookie, w)).toContain("30 min. before, 15 min. after");
    await env.DB.prepare(
      "UPDATE rules SET options = json_set(options, '$.bufferBefore', 10) WHERE target_calendar_id = ?",
    )
      .bind(`${g}-cal`)
      .run();
    expect(await bufferRow(cookie, w)).toContain(">differs<");
  });
});
