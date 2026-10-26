import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAccountColorState, resolveAccountColors } from "../src/colors";
import { ruleOptionsSchema } from "../src/config";
import { blockColorFor, loadEditorState, setBlockColor, setDirection } from "../src/editor";
import { toGraphBlock } from "../src/providers/graph-calendar";
import { toGoogleBlock } from "../src/sync/google-events";
import { desiredBlocks } from "../src/sync/plan";
import type { SourceEvent } from "../src/sync/types";
import { BASE, signIn } from "./helpers";

const EVENT: SourceEvent = {
  occurrenceKey: "event:1",
  start: "2026-10-27T13:00:00.000Z",
  end: "2026-10-27T14:00:00.000Z",
  allDay: false,
  showAs: "busy",
  isPrivate: false,
  declined: false,
  categories: ["Private"],
  subject: "Review",
  location: "",
  body: "",
  isMirror: false,
};

async function blockWith(blockColor?: string) {
  const options = ruleOptionsSchema.parse(blockColor === undefined ? {} : { blockColor });
  const [block] = await desiredBlocks("rule", [EVENT], options);
  if (!block) throw new Error("no block");
  return block;
}

describe("resolveAccountColors", () => {
  it("keeps chosen colours and gives the others the next unused one, blue last", () => {
    expect(resolveAccountColors([null, "green", null, "nope"])).toEqual([
      "vermilion",
      "green",
      "purple",
      "orange",
    ]);
    expect(resolveAccountColors([null, null, null, null, null, null, null, null])).toEqual([
      "green",
      "vermilion",
      "purple",
      "orange",
      "sky",
      "indigo",
      "slate",
      "blue",
    ]);
  });

  it("starts the order again after all eight colours", () => {
    const colors = resolveAccountColors(Array.from({ length: 10 }, () => null));
    expect(colors.slice(8)).toEqual(["green", "vermilion"]);
  });

  it("keeps assigned colours when another account gets a chosen colour", () => {
    const first = resolveAccountColorState([null, null, null]);
    expect(first.map((entry) => entry.stored)).toEqual([
      "auto:green",
      "auto:vermilion",
      "auto:purple",
    ]);
    // Account 2 chooses indigo. Account 3 keeps purple and does not take the freed vermilion.
    const after = resolveAccountColorState(["auto:green", "indigo", "auto:purple"]);
    expect(after.map((entry) => entry.color)).toEqual(["green", "indigo", "purple"]);
    expect(after.map((entry) => entry.chosen)).toEqual([false, true, false]);
  });

  it("moves an assigned colour only if a chosen colour takes it", () => {
    const state = resolveAccountColorState(["auto:green", "green", "auto:green"]);
    expect(state.map((entry) => entry.color)).toEqual(["vermilion", "green", "purple"]);
    expect(state[0]?.stored).toBe("auto:vermilion");
  });
});

describe("block colour", () => {
  it("leaves the content hash of blocks without a colour as it was", async () => {
    const plain = await blockWith();
    expect(plain).not.toHaveProperty("color");
    expect((await blockWith("")).contentHash).toBe(plain.contentHash);
  });

  it("changes the content hash when the colour changes, so the next run updates the blocks", async () => {
    const plain = await blockWith();
    const red = await blockWith("11");
    const green = await blockWith("10");
    expect(new Set([plain.contentHash, red.contentHash, green.contentHash]).size).toBe(3);
  });

  it("writes the colour into the Google and Graph payloads, and clears it without one", async () => {
    expect(toGoogleBlock(await blockWith("5"), "tag").colorId).toBe("5");
    expect(toGoogleBlock(await blockWith(), "tag").colorId).toBeNull();
    // An Outlook category in a rule that targets Google never reaches Google.
    expect(toGoogleBlock(await blockWith("Focus"), "tag").colorId).toBeNull();
    expect(toGraphBlock(await blockWith("slotmirror"), "tag").categories).toEqual(["slotmirror"]);
    // The source's own categories are never copied; without a colour the list is empty.
    expect(toGraphBlock(await blockWith(), "tag").categories).toEqual([]);
  });

  it("accepts only values the target can show", () => {
    expect(blockColorFor("google", " 7 ")).toBe("7");
    expect(blockColorFor("google", "12")).toBeNull();
    expect(blockColorFor("google", "Focus")).toBeNull();
    expect(blockColorFor("microsoft", " Focus ")).toBe("Focus");
    expect(blockColorFor("microsoft", "a,b")).toBeNull();
    expect(blockColorFor("microsoft", "x".repeat(101))).toBeNull();
    expect(blockColorFor("google", "")).toBe("");
  });
});

/** A user with a Microsoft and a Google account, each with a main calendar and tokens. */
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

describe("block colour per direction", () => {
  it("stores a valid colour on every rule of the direction and refuses an invalid one", async () => {
    const { user, cookie, w, g } = await setup("bcol");
    await setDirection(env, user, w, g, "busy");
    await setDirection(env, user, g, w, "busy");
    const save = (body: Record<string, string>) =>
      exports.default.fetch(`${BASE}/rules/choices`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "x-fragment": "1", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      });
    expect((await save({ [`blockColor.${w}.${g}`]: "11" })).status).toBe(204);
    expect((await save({ [`blockColor.${g}.${w}`]: "Focus" })).status).toBe(204);
    expect((await save({ [`blockColor.${w}.${g}`]: "Focus" })).status).toBe(400);
    const state = await loadEditorState(env, user.id);
    const option = (from: string, to: string) =>
      state.directions.find((d) => d.from === from && d.to === to)?.options?.blockColor;
    expect(option(w, g)).toBe("11");
    expect(option(g, w)).toBe("Focus");
  });

  it("changes nothing for a direction without rules", async () => {
    const { user, w, g } = await setup("bcoff");
    expect(await setBlockColor(env, user, w, g, "3")).toBe(true);
    const state = await loadEditorState(env, user.id);
    expect(state.directions.find((d) => d.from === w)?.ruleId).toBeNull();
  });
});

describe("account colours", () => {
  const post = (cookie: string, accountId: string, body: Record<string, string>) =>
    exports.default.fetch(`${BASE}/accounts/${accountId}/name`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });

  it("stores a chosen colour, and goes back to automatic", async () => {
    const { user, cookie, w, g } = await setup("acol");
    let state = await loadEditorState(env, user.id);
    expect(state.accounts.map((a) => [a.color, a.colorChosen])).toEqual([
      ["green", false],
      ["vermilion", false],
    ]);

    expect((await post(cookie, g, { name: "", color: "green" })).status).toBe(302);
    state = await loadEditorState(env, user.id);
    // The chosen colour stays; the automatic account moves to the next unused one.
    expect(state.accounts.find((a) => a.id === g)).toMatchObject({
      color: "green",
      colorChosen: true,
    });
    expect(state.accounts.find((a) => a.id === w)?.color).toBe("vermilion");

    await post(cookie, g, { name: "", color: "auto" });
    state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === g)?.colorChosen).toBe(false);
  });

  it("refuses an unknown colour and an account of another user", async () => {
    const { cookie, g } = await setup("acbad");
    const other = await setup("acother");
    expect((await post(cookie, g, { color: "pink" })).status).toBe(400);
    expect((await post(cookie, other.g, { color: "green" })).status).toBe(404);
    const row = await env.DB.prepare("SELECT color FROM accounts WHERE id = ?")
      .bind(other.g)
      .first<{ color: string | null }>();
    expect(row?.color).toBeNull();
  });

  it("keeps a form with the name only working", async () => {
    const { user, cookie, w } = await setup("aconly");
    expect((await post(cookie, w, { name: "Work" })).status).toBe(302);
    const state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)).toMatchObject({
      name: "Work",
      colorChosen: false,
    });
  });
});
