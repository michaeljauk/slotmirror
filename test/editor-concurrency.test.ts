import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadEditorState,
  setAccountWorkHours,
  setDirection,
  setGroupMemberships,
  setRuleDetails,
  type AccountWorkHours,
} from "../src/editor";
import app from "../src/index";
import { BASE, countingEnv, signIn } from "./helpers";

/** A user with `count` accounts, alternately Microsoft and Google, each with one main calendar. */
async function setup(prefix: string, count: number) {
  const { user, cookie } = await signIn(`${prefix}@org.example`);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    const provider = i % 2 === 0 ? "microsoft" : "google";
    ids.push(id);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, ?, ?)",
      ).bind(id, user.id, provider, `${id}@x${i}.example`),
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
  return { user, cookie, ids };
}

const OFFICE: AccountWorkHours = {
  workDays: [1, 2, 3, 4, 5],
  workStart: "08:00",
  workEnd: "18:00",
  workTimeZone: "Europe/Vienna",
};

const CONFLICT =
  "These rules changed in the meantime, for example in another tab. Reload the page and check them.";

/** Post a form to the app with the given environment, as the browser or the editor script. */
function send(
  testEnv: Env,
  cookie: string,
  path: string,
  body: URLSearchParams,
  fragment: boolean,
) {
  return app.fetch(
    new Request(`${BASE}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        ...(fragment ? { "x-fragment": "1" } : {}),
      },
      body,
    }),
    testEnv,
    { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
  );
}

const optionsOf = async (ruleTarget: string) =>
  JSON.parse(
    (
      await env.DB.prepare("SELECT options FROM rules WHERE target_calendar_id = ?")
        .bind(ruleTarget)
        .first<{ options: string }>()
    )?.options ?? "{}",
  ) as Record<string, unknown>;

/** An environment in which another request changes a rule right before the first rule write. */
function racingEnv(ruleTarget: string) {
  let raced = false;
  return countingEnv(async (sql) => {
    if (raced || !sql.some((text) => text.startsWith("UPDATE rules SET options = ?"))) return;
    raced = true;
    await env.DB.prepare(
      "UPDATE rules SET options = json_set(options, '$.blockColor', '7') WHERE target_calendar_id = ?",
    )
      .bind(ruleTarget)
      .run();
  });
}

beforeEach(() => {
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

describe("saves that race another request", () => {
  it("refuses a page save whose rules changed after the read, and keeps the other change", async () => {
    const { user, cookie, ids } = await setup("race", 3);
    const [a, b, c] = ids as [string, string, string];
    await setDirection(env, user, a, b, "busy");
    await setDirection(env, user, a, c, "busy");
    const racing = racingEnv(`${b}-cal`);
    const response = await send(
      racing.env,
      cookie,
      "/rules/choices",
      new URLSearchParams({ [`bufferBefore.${a}`]: "30", [`bufferAfter.${a}`]: "30" }),
      true,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(CONFLICT);
    // The other request's change stays, and the save wrote none of its rules.
    expect(await optionsOf(`${b}-cal`)).toMatchObject({ blockColor: "7", bufferBefore: 0 });
    expect(await optionsOf(`${c}-cal`)).toMatchObject({ bufferBefore: 0 });
    const state = await loadEditorState(env, user.id);
    expect(state.accounts.find((account) => account.id === a)?.sourceOptions).toBeNull();
  });

  it("refuses new account hours when a rule into the account changed after the read", async () => {
    const { user, cookie, ids } = await setup("racehours", 2);
    const [a, b] = ids as [string, string];
    await setAccountWorkHours(env, user, b, OFFICE);
    await setDirection(env, user, a, b, "busy");
    await setRuleDetails(env, user, { workHours: [{ from: a, to: b, on: true }] });
    const racing = racingEnv(`${b}-cal`);
    const body = new URLSearchParams({
      workHoursShown: "1",
      workStart: "12:00",
      workEnd: "20:00",
      workTimeZone: "Europe/Vienna",
    });
    for (const day of ["1", "2"]) body.append("workDays", day);
    const response = await send(racing.env, cookie, `/accounts/${b}/settings`, body, false);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(CONFLICT);
    expect(await optionsOf(`${b}-cal`)).toMatchObject({ ...OFFICE, blockColor: "7" });
    const state = await loadEditorState(env, user.id);
    expect(state.accounts.find((account) => account.id === b)?.workHours).toEqual(OFFICE);
  });

  it("saves as before when nothing changed in between", async () => {
    const { user, cookie, ids } = await setup("norace", 2);
    const [a, b] = ids as [string, string];
    await setDirection(env, user, a, b, "busy");
    const counting = countingEnv();
    const response = await send(
      counting.env,
      cookie,
      "/rules/choices",
      new URLSearchParams({ [`bufferBefore.${a}`]: "30", [`bufferAfter.${a}`]: "30" }),
      true,
    );
    expect(response.status).toBe(204);
    expect(await optionsOf(`${b}-cal`)).toMatchObject({ bufferBefore: 30, bufferAfter: 30 });
  });
});

describe("sync requests of one page save", () => {
  it("asks each target account to sync once, after all writes", async () => {
    const { user, cookie, ids } = await setup("syncs", 4);
    await setGroupMemberships(env, user, ids, true);
    await setAccountWorkHours(env, user, ids[1]!, OFFICE);
    await setAccountWorkHours(env, user, ids[2]!, OFFICE);
    // The first load stores the account colours; count the save only.
    await loadEditorState(env, user.id);
    const [a, b, c, d] = ids as [string, string, string, string];
    const counting = countingEnv();
    const response = await send(
      counting.env,
      cookie,
      "/rules/choices",
      new URLSearchParams({
        [`choice.${a}.${b}`]: "title",
        [`choice.${c}.${d}`]: "off",
        [`choice.${d}.${a}`]: "title",
        [`bufferBefore.${a}`]: "15",
        [`bufferAfter.${a}`]: "15",
        [`bufferBefore.${b}`]: "10",
        [`bufferAfter.${b}`]: "0",
        [`workHours.${a}.${b}`]: "1",
        [`workHours.${d}.${c}`]: "1",
        [`blockColor.${a}.${b}`]: "5",
        settings: "1",
        "settings.daysAhead": "30",
        "settings.daysAheadShown": "60",
        "settings.blockTitle": "Busy",
      }),
      true,
    );
    expect(response.status).toBe(204);
    const syncs = counting.counts.durable.filter((call) => call.endsWith(":requestSync"));
    expect([...syncs].sort()).toEqual([a, b, c, d].map((id) => `${id}:requestSync`).sort());
    // The sync requests come last, after every write and queued removal of the save.
    expect(counting.counts.durable.slice(-syncs.length)).toEqual(syncs);
  });
});
