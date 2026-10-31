import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_OPERATOR_NOTICE, operatorNotice } from "../src/operator-notice";
import worker from "../src/index";
import { BASE, signIn } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const NOTICE = "Example Operator runs this test deployment.";

async function get(path: string, overrides: Partial<Env>, cookie?: string): Promise<string> {
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: { "accept-language": "en", ...(cookie ? { cookie } : {}) },
    }),
    { ...env, ...overrides },
    ctx,
  );
  expect(response.status).toBe(200);
  return response.text();
}

describe("operatorNotice", () => {
  it("returns an empty string when unset, empty or blank", () => {
    expect(operatorNotice({})).toBe("");
    expect(operatorNotice({ OPERATOR_NOTICE: "" })).toBe("");
    expect(operatorNotice({ OPERATOR_NOTICE: "  \n " })).toBe("");
  });

  it("folds white space and caps the length", () => {
    expect(operatorNotice({ OPERATOR_NOTICE: " one \n two  " })).toBe("one two");
    const long = operatorNotice({ OPERATOR_NOTICE: "x".repeat(MAX_OPERATOR_NOTICE + 50) });
    expect(long).toHaveLength(MAX_OPERATOR_NOTICE);
    expect(long.endsWith("…")).toBe(true);
  });

  it("counts characters, so that text within the limit stays whole", () => {
    const text = "😀".repeat(MAX_OPERATOR_NOTICE);
    expect(operatorNotice({ OPERATOR_NOTICE: text })).toBe(text);
  });

  it("does not split a surrogate pair when it cuts", () => {
    const text = operatorNotice({ OPERATOR_NOTICE: "😀".repeat(MAX_OPERATOR_NOTICE + 5) });
    expect(text.slice(0, -1)).toBe("😀".repeat(MAX_OPERATOR_NOTICE - 1));
    expect(text.endsWith("…")).toBe(true);
  });
});

async function connectAccounts(userId: string, prefix: string, broken: boolean, count = 1) {
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email, needs_reconnect) VALUES (?, ?, 'google', ?, ?)",
      ).bind(id, userId, `${id}@org.example`, broken && i === 0 ? 1 : 0),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES (?, ?, ?, 'Main', 1, 1, 1)",
      ).bind(`${id}-cal`, id, `${id}-remote`),
    ]);
  }
}

function count(html: string): number {
  return html.split(NOTICE).length - 1;
}

describe("operator notice at every connect entry", () => {
  it.each(["/", "/rules"])("shows a hostile notice as text on %s", async (path) => {
    const { user, cookie } = await signIn("escape@org.example");
    await connectAccounts(user.id, `ops-escape${path.length}`, true);
    const notice = `<img src=x onerror=alert(1)><script>alert(1)</script>`;
    const html = await get(path, { OPERATOR_NOTICE: notice }, cookie);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;img src=x");
  });

  it.each(["/", "/rules"])("caps a long notice on %s", async (path) => {
    const { user, cookie } = await signIn("long@org.example");
    await connectAccounts(user.id, `ops-long${path.length}`, true);
    const shown = "y".repeat(MAX_OPERATOR_NOTICE - 1);
    const html = await get(path, { OPERATOR_NOTICE: "y".repeat(5000) }, cookie);
    expect(html).toContain(`${shown}…`);
    expect(html).not.toContain(`${shown}y`);
  });

  it("shows it once in the first steps of the rules page", async () => {
    const { user, cookie } = await signIn("steps@org.example");
    await connectAccounts(user.id, "ops-steps", false);
    const html = await get("/rules", { OPERATOR_NOTICE: NOTICE }, cookie);
    expect(count(html)).toBe(1);
    expect(html.indexOf(NOTICE)).toBeLessThan(html.indexOf("/auth/microsoft/connect"));
  });

  it("shows it once, before the banner and its link, on the rules page", async () => {
    const { user, cookie } = await signIn("banner@org.example");
    await connectAccounts(user.id, "ops-banner", true);
    const html = await get("/rules", { OPERATOR_NOTICE: NOTICE }, cookie);
    expect(count(html)).toBe(1);
    expect(html.indexOf(NOTICE)).toBeLessThan(html.indexOf("/auth/google/connect?account="));
  });

  it("shows it once, before the banner, the list link and the buttons, on the home page", async () => {
    const { user, cookie } = await signIn("home@org.example");
    await connectAccounts(user.id, "ops-home", true, 2);
    const html = await get("/", { OPERATOR_NOTICE: NOTICE }, cookie);
    expect(count(html)).toBe(1);
    const first = html.indexOf("/auth/google/connect");
    expect(first).toBeGreaterThan(-1);
    expect(html.indexOf(NOTICE)).toBeLessThan(first);
  });

  it("shows nothing at those entries when the value is empty", async () => {
    const { user, cookie } = await signIn("none@org.example");
    await connectAccounts(user.id, "ops-none", true);
    for (const path of ["/", "/rules"]) {
      expect(await get(path, { OPERATOR_NOTICE: "" }, cookie)).not.toContain("operator-notice");
    }
  });
});

describe("operator notice pages", () => {
  it("shows the notice before the connect buttons", async () => {
    const { cookie } = await signIn("owner@example.com");
    const html = await get("/", { OPERATOR_NOTICE: NOTICE }, cookie);
    const notice = html.indexOf(NOTICE);
    const connect = html.indexOf("/auth/microsoft/connect");
    expect(notice).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(notice);
  });

  it("shows the notice on the privacy page", async () => {
    expect(await get("/privacy", { OPERATOR_NOTICE: NOTICE })).toContain(NOTICE);
  });

  it("escapes markup in the notice", async () => {
    const html = await get("/privacy", { OPERATOR_NOTICE: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows no notice block when the value is empty", async () => {
    const { cookie } = await signIn("owner@example.com");
    const home = await get("/", { OPERATOR_NOTICE: "" }, cookie);
    expect(home).toContain("/auth/microsoft/connect");
    expect(home).not.toContain("operator-notice");
    const privacy = await get("/privacy", { OPERATOR_NOTICE: "" });
    expect(privacy).not.toContain("Notice from the operator");
  });

  it("caps a long notice on the privacy page", async () => {
    const shown = "y".repeat(MAX_OPERATOR_NOTICE - 1);
    const html = await get("/privacy", { OPERATOR_NOTICE: "y".repeat(5000) });
    expect(html).toContain(`${shown}…`);
    expect(html).not.toContain(`${shown}y`);
  });

  it("shows the German labels in German", async () => {
    const { cookie } = await signIn("owner@example.com");
    const response = await worker.fetch(
      new Request(`${BASE}/?lang=de`, { headers: { cookie } }),
      { ...env, OPERATOR_NOTICE: NOTICE },
      ctx,
    );
    const html = await response.text();
    expect(html).toContain("Wer diese Installation betreibt");
    expect(html).toContain("Datenschutzerklärung");
  });

  it("shows the German heading on the privacy page", async () => {
    const response = await worker.fetch(
      new Request(`${BASE}/privacy?lang=de`),
      { ...env, OPERATOR_NOTICE: NOTICE },
      ctx,
    );
    expect(await response.text()).toContain("Hinweis des Betreibers");
  });
});
