import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountStatuses, latestRuleOutcomes, recordAudit } from "../src/audit";
import { loadEditorState, setDirection, setGroupMembership } from "../src/editor";
import { BASE, signIn } from "./helpers";

/** A user with a work and another Microsoft account and a Google account, all with tokens. */
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
    `SELECT r.id, sc.account_id AS source, tc.account_id AS target, r.enabled, r.options,
            json_extract(r.options, '$.detailLevel') AS level
     FROM rules r JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.user_id = ? ORDER BY source, target`,
  )
    .bind(userId)
    .all<{ id: string; source: string; target: string; enabled: number; options: string }>();
  return results;
}

function post(path: string, cookie: string, fields: URLSearchParams, headers = {}) {
  return exports.default.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: fields,
  });
}

const page = async (cookie: string, path = "/rules", headers = {}) =>
  (await exports.default.fetch(`${BASE}${path}`, { headers: { cookie, ...headers } })).text();

const GERMAN = { "accept-language": "de-AT,de;q=0.9" };

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

describe("page save is all or nothing", () => {
  it("refuses a category with a comma before it writes anything, with a reason", async () => {
    const { user, cookie, w, o } = await setup("comma");
    const response = await post(
      "/rules/choices",
      cookie,
      new URLSearchParams({ [`choice.${w}.${o}`]: "title", [`blockColor.${w}.${o}`]: "a, b" }),
      { "x-fragment": "1", ...GERMAN },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Komma");
    expect(await rulesOf(user.id)).toEqual([]);
  });

  it("refuses a colour of a target that is not the user's before it writes anything", async () => {
    const { user, cookie, w, o } = await setup("strangercolor");
    const response = await post(
      "/rules/choices",
      cookie,
      new URLSearchParams({ [`choice.${w}.${o}`]: "busy", [`blockColor.${w}.nobody`]: "3" }),
      { "x-fragment": "1" },
    );
    expect(response.status).toBe(400);
    expect(await rulesOf(user.id)).toEqual([]);
  });

  it("saves a colour together with turning off the only source of its direction", async () => {
    const { user, cookie, w, g } = await setup("lastsource");
    await setDirection(env, user, w, g, "busy");
    const response = await post(
      "/rules/choices",
      cookie,
      new URLSearchParams({ [`calendar.${w}-cal`]: "0", [`blockColor.${w}.${g}`]: "3" }),
      { "x-fragment": "1" },
    );
    expect(response.status).toBe(204);
    expect(await rulesOf(user.id)).toEqual([]);
  });

  it("explains a refused category on the form without the editor script", async () => {
    const { user, cookie, w, o } = await setup("commanojs");
    await setDirection(env, user, w, o, "busy");
    const response = await post(
      "/rules/direction/details",
      cookie,
      new URLSearchParams({ from: w, to: o, blockColor: "a,b" }),
      GERMAN,
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('class="notice error"');
    expect(html).toContain("Komma");
  });
});

describe("sync status", () => {
  it("forgets the failure of a deleted rule, and shows a paused account as paused", async () => {
    const { user, cookie, w, o, g } = await setup("stalefail");
    await setDirection(env, user, w, o, "busy");
    await setDirection(env, user, w, g, "busy");
    const rules = await rulesOf(user.id);
    const toO = rules.find((rule) => rule.target === o);
    const toG = rules.find((rule) => rule.target === g);
    for (const rule of [toO!, toG!]) {
      await recordAudit(env.DB, {
        orgId: user.orgId,
        userId: user.id,
        accountId: rule.target,
        ruleId: rule.id,
        kind: "sync_failed",
        detail: { code: "graph_500" },
      });
    }
    expect(await latestRuleOutcomes(env.DB, user.id)).toHaveLength(2);

    await setDirection(env, user, w, o, "off");
    await env.DB.prepare("UPDATE rules SET enabled = 0 WHERE id = ?").bind(toG!.id).run();

    const outcomes = await latestRuleOutcomes(env.DB, user.id);
    expect(outcomes).toEqual([expect.objectContaining({ ruleId: toG!.id, enabled: false })]);
    const statuses = accountStatuses(outcomes);
    expect(statuses.get(o)).toBeUndefined();
    expect(statuses.get(g)).toMatchObject({ state: "paused" });
    expect(await page(cookie)).not.toContain("graph_500");
    const home = await page(cookie, "/");
    expect(home).not.toContain("graph_500");
    expect(home).toContain("Sync paused · Last run");
  });

  it("lets a running rule decide the status over a paused one", () => {
    const outcome = (enabled: boolean, kind: "sync_run" | "sync_failed", at: string) => ({
      ruleId: `${kind}-${at}`,
      accountId: "acc",
      kind,
      createdAt: at,
      enabled,
      detail: kind === "sync_failed" ? { code: "x" } : { failed: 0, remaining: 0 },
    });
    const later = "2026-10-27T10:00:00.000Z";
    const earlier = "2026-10-27T09:00:00.000Z";
    expect(
      accountStatuses([
        outcome(false, "sync_failed", later),
        outcome(true, "sync_run", earlier),
      ]).get("acc"),
    ).toMatchObject({ state: "ok", at: earlier });
    expect(
      accountStatuses([
        outcome(true, "sync_run", earlier),
        outcome(false, "sync_failed", later),
      ]).get("acc"),
    ).toMatchObject({ state: "ok", at: earlier });
    expect(
      accountStatuses([
        outcome(false, "sync_run", earlier),
        outcome(false, "sync_failed", later),
      ]).get("acc"),
    ).toEqual({ state: "paused", at: later });
  });
});

describe("account name and colour", () => {
  it("keeps the automatic name when only the colour changes, and logs no rename", async () => {
    const { cookie, w } = await setup("colouronly");
    const home = await page(cookie, "/");
    // The field is empty; the derived name is the placeholder.
    expect(home).toContain(`name="name" maxlength="40" value="" placeholder="work"`);

    const response = await post(
      `/accounts/${w}/name`,
      cookie,
      new URLSearchParams({ name: "work", color: "blue" }),
    );
    expect(response.status).toBe(302);
    const row = await env.DB.prepare(
      "SELECT display_name AS name, color FROM accounts WHERE id = ?",
    )
      .bind(w)
      .first<{ name: string | null; color: string }>();
    expect(row).toEqual({ name: null, color: "blue" });
    const renamed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE account_id = ? AND kind = 'account_renamed'",
    )
      .bind(w)
      .first<{ n: number }>();
    expect(renamed?.n).toBe(0);
  });

  it("logs a rename once, and not again for the same name", async () => {
    const { user, cookie, w } = await setup("renameonce");
    for (let i = 0; i < 2; i++) {
      await post(`/accounts/${w}/name`, cookie, new URLSearchParams({ name: "Job" }));
    }
    const state = await loadEditorState(env, user.id);
    expect(state.accounts.find((a) => a.id === w)?.name).toBe("Job");
    const renamed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE account_id = ? AND kind = 'account_renamed'",
    )
      .bind(w)
      .first<{ n: number }>();
    expect(renamed?.n).toBe(1);
  });
});

describe("accessibility", () => {
  it("tells assistive technology which choice, member and calendar is on", async () => {
    const { user, cookie, w, o } = await setup("aria");
    await setGroupMembership(env, user, w, true);
    await setDirection(env, user, w, o, "title");
    const html = await page(cookie);
    expect(html).toMatch(/<button[^>]*value="title"[^>]*class="choice on"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/<button[^>]*value="busy"[^>]*class="choice"[^>]*aria-pressed="false"/);
    expect(html).toMatch(/class="member"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/class="member out"[^>]*aria-pressed="false"/);
    expect(html).toMatch(/class="member cal-chip"[^>]*aria-pressed="true"/);
  });
});

describe("language switch", () => {
  it("links to a page that exists after a form post without the editor script", async () => {
    const { cookie } = await setup("langpost");
    const response = await post("/rules", cookie, new URLSearchParams({ source: "x" }), {
      referer: `${BASE}/rules?open=a&lang=en`,
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('href="/rules?open=a&amp;lang=de"');
    expect(html).not.toContain('href="?lang=');
  });

  it("falls back to the start page without a referrer from this site", async () => {
    const { cookie } = await setup("langnoref");
    const response = await post("/rules", cookie, new URLSearchParams({ source: "x" }), {
      referer: "https://elsewhere.example/rules",
    });
    expect(await response.text()).toContain('href="/?lang=de"');
  });

  it("keeps the current page on a normal page view", async () => {
    const { cookie } = await setup("langget");
    expect(await page(cookie, "/rules?open=x")).toContain('href="/rules?open=x&amp;lang=de"');
  });
});

describe("copy", () => {
  it("uses the singular for one item", async () => {
    const { i18nFor } = await import("../src/i18n");
    const { t: en } = i18nFor("en");
    const { t: de } = i18nFor("de");
    expect(en.accounts.changesFailed(1)).toBe("1 change failed");
    expect(de.accounts.changesFailed(1)).toBe("1 Änderung fehlgeschlagen");
    expect(en.accounts.changesFailed(2)).toBe("2 changes failed");
    expect(en.editor.checkResult(0, 0, 0, 1)).toBe("Matches the calendar · 1 block");
    expect(de.editor.checkResult(0, 0, 0, 1)).toBe("Stimmt mit dem Kalender überein · 1 Block");
    expect(de.editor.checkResult(0, 0, 0, 2)).toBe("Stimmt mit dem Kalender überein · 2 Blöcke");
  });

  it("says copies are private only when the setting is on", async () => {
    const { user, cookie, w, o } = await setup("grouptext");
    await setGroupMembership(env, user, w, true);
    await setGroupMembership(env, user, o, true);
    const saveSettings = (fields: Record<string, string>) =>
      post(
        "/rules/choices",
        cookie,
        new URLSearchParams({ settings: "1", "settings.daysAhead": "90", ...fields }),
        { "x-fragment": "1" },
      );
    expect(await page(cookie, "/rules", GERMAN)).toContain("als privat markiert");

    await saveSettings({});
    const off = await page(cookie, "/rules", GERMAN);
    expect(off).toContain("sehen voneinander nur „Belegt“. Mehr Details");
    expect(off).not.toContain("als privat markiert");

    await saveSettings({ "settings.markPrivate": "on" });
    expect(await page(cookie, "/rules", GERMAN)).toContain("als privat markiert");
  });

  it("gives a new German user the German block title, and keeps existing rules' titles", async () => {
    const fresh = await setup("titlenew");
    await page(fresh.cookie, "/rules", GERMAN);
    await setDirection(env, fresh.user, fresh.w, fresh.o, "busy");
    const [rule] = await rulesOf(fresh.user.id);
    expect(JSON.parse(rule!.options)).toMatchObject({ blockTitle: "Belegt" });

    const existing = await setup("titleold");
    await setDirection(env, existing.user, existing.w, existing.o, "busy");
    expect(await page(existing.cookie, "/rules", GERMAN)).toContain('value="Busy"');
    const [old] = await rulesOf(existing.user.id);
    expect(JSON.parse(old!.options)).toMatchObject({ blockTitle: "Busy" });
  });

  it("explains a check that fails for an account without tokens in the user's language", async () => {
    const { user, cookie, w } = await setup("notokens");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('notokens-x', ?, 'microsoft', 'x@third.example')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit, is_default, is_source) VALUES ('notokens-x-cal', 'notokens-x', 'x-remote', 'Main', 1, 1, 1)",
      ),
    ]);
    await setDirection(env, user, w, "notokens-x", "busy");
    const response = await post(
      "/rules/direction/check",
      cookie,
      new URLSearchParams({ from: w, to: "notokens-x" }),
      { "x-fragment": "1", ...GERMAN },
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("Account has no tokens");
    expect(text).toContain("neu");
  });
});

describe("polish", () => {
  it("keeps the language switch on this site for a referrer path that starts with //", async () => {
    const { cookie } = await setup("langslash");
    for (const referer of [
      `${BASE}//evil.example/x`,
      `${BASE}/.//evil.example/x`,
      `${BASE}//%5C`,
    ]) {
      const response = await post("/rules", cookie, new URLSearchParams({ source: "x" }), {
        referer,
      });
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('href="/?lang=de"');
      expect(html).not.toContain('href="//');
    }
  });

  it.each(["interaction_required", "consent_required"])(
    "asks to reconnect when the token refresh answers %s",
    async (code) => {
      const { user, cookie, w, g } = await setup(`consent-${code}`);
      await setDirection(env, user, g, w, "busy");
      // The target's access token is expired; the refresh asks for a new sign-in.
      await env.ACCOUNT_SYNC.getByName(w).storeTokens(
        w,
        { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() - 1000 },
        "microsoft",
      );
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/oauth2/")) {
          return Response.json({ error: code, error_description: "AADSTS" }, { status: 400 });
        }
        if (url.includes("googleapis.com/calendar")) return Response.json({ items: [] });
        return Response.json({ value: [] });
      });
      const response = await post(
        "/rules/direction/check",
        cookie,
        new URLSearchParams({ from: g, to: w }),
        { "x-fragment": "1" },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        "This account is no longer signed in. Connect it again on the accounts page.",
      );
    },
  );

  it("answers a check of a direction without rules in words", async () => {
    const { cookie, w, o } = await setup("stalecheck");
    const response = await post(
      "/rules/direction/check",
      cookie,
      new URLSearchParams({ from: w, to: o }),
      { "x-fragment": "1", ...GERMAN },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Diese Richtung hat sich inzwischen geändert. Lade die Seite neu.",
    );
  });

  it("keeps a block title the user chose when the page loads", async () => {
    const { user, cookie } = await setup("titlechosen");
    await post(
      "/rules/choices",
      cookie,
      new URLSearchParams({
        settings: "1",
        "settings.daysAhead": "90",
        "settings.blockTitle": "Mine",
      }),
      { "x-fragment": "1" },
    );
    const html = await page(cookie, "/rules", GERMAN);
    const row = await env.DB.prepare("SELECT sync_settings AS json FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ json: string }>();
    expect(JSON.parse(row?.json ?? "{}")).toMatchObject({ blockTitle: "Mine" });
    // A direction without rules shows the title from the settings in its example.
    expect(html).toContain("<b>Mine</b>");
    expect(html).not.toContain("<b>Busy</b>");
    expect(html).not.toContain("<b>Belegt</b>");
  });

  it("uses the German default for an empty block title of a German user", async () => {
    const { user, cookie, w, o } = await setup("titleempty");
    await setDirection(env, user, w, o, "busy");
    await post(
      "/rules/choices",
      cookie,
      new URLSearchParams({
        settings: "1",
        "settings.daysAhead": "90",
        "settings.blockTitle": " ",
      }),
      { "x-fragment": "1", ...GERMAN },
    );
    const [rule] = await rulesOf(user.id);
    expect(JSON.parse(rule!.options)).toMatchObject({ blockTitle: "Belegt" });
  });

  it("treats a stored name equal to the derived one as automatic", async () => {
    const { cookie, w } = await setup("legacyname");
    await env.DB.prepare("UPDATE accounts SET display_name = 'work' WHERE id = ?").bind(w).run();
    expect(await page(cookie, "/")).toContain(
      'name="name" maxlength="40" value="" placeholder="work"',
    );

    await post(`/accounts/${w}/name`, cookie, new URLSearchParams({ name: "" }));
    const row = await env.DB.prepare("SELECT display_name AS name FROM accounts WHERE id = ?")
      .bind(w)
      .first<{ name: string | null }>();
    expect(row?.name).toBeNull();
    // The name on the pages stays "work", so the log records no rename.
    const renamed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE account_id = ? AND kind = 'account_renamed'",
    )
      .bind(w)
      .first<{ n: number }>();
    expect(renamed?.n).toBe(0);
  });

  it("refuses a category longer than Outlook allows, with the limit", async () => {
    const { user, cookie, w, o } = await setup("longcat");
    const response = await post(
      "/rules/choices",
      cookie,
      new URLSearchParams({
        [`choice.${w}.${o}`]: "busy",
        [`blockColor.${w}.${o}`]: "x".repeat(101),
      }),
      { "x-fragment": "1" },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "A category name can have at most 100 characters. Nothing was saved.",
    );
    expect(await rulesOf(user.id)).toEqual([]);
  });

  it("uses the singular in the last-run line", async () => {
    const { i18nFor } = await import("../src/i18n");
    expect(i18nFor("en").t.rules.lastRun(1, "now", 1)).toBe("1 block · last run now · 1 change");
    expect(i18nFor("de").t.rules.lastRun(1, "jetzt", 1)).toBe(
      "1 Block · letzter Lauf jetzt · 1 Änderung",
    );
    expect(i18nFor("de").t.rules.lastRun(2, "jetzt", 3)).toBe(
      "2 Blöcke · letzter Lauf jetzt · 3 Änderungen",
    );
  });
});
