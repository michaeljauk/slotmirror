import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { BASE, signIn } from "./helpers";

async function addEvent(orgId: string, userId: string | null, kind: string, detail = "{}") {
  await env.DB.prepare(
    "INSERT INTO audit_events (org_id, user_id, kind, detail) VALUES (?, ?, ?, ?)",
  )
    .bind(orgId, userId, kind, detail)
    .run();
}

async function get(path: string, cookie: string): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, { headers: { cookie } });
}

describe("activity", () => {
  it("shows a member only their own events, and never another org's", async () => {
    const owner = await signIn("owner@example.com");
    const other = await signIn("other@elsewhere.org");
    await env.DB.prepare("INSERT INTO orgs (id, name) VALUES ('org-b', 'B')").run();
    await env.DB.prepare(
      "INSERT INTO users (id, org_id, email, role) VALUES ('user-b', 'org-b', 'b@org-b.test', 'member')",
    ).run();
    await addEvent("default", owner.user.id, "rule_created");
    await addEvent("default", other.user.id, "rule_deleted");
    await addEvent("org-b", "user-b", "account_connected");

    const html = await (await get("/activity", owner.cookie)).text();
    expect(html).toContain("Rule created");
    expect(html).not.toContain("Rule deleted");
    expect(html).not.toContain("Account connected");
  });

  it("shows an admin the events of the whole org, with user emails", async () => {
    const admin = await signIn("admin@example.com");
    const owner = await signIn("owner@example.com");
    await addEvent(
      "default",
      owner.user.id,
      "sync_run",
      '{"dryRun":false,"create":3,"update":1,"delete":0,"failed":0}',
    );
    await addEvent("org-b", "user-b", "token_refresh_failed", '{"code":"org-b-secret"}');

    const html = await (await get("/admin", admin.cookie)).text();
    expect(html).toContain("owner@example.com");
    expect(html).toContain("3 new, 1 changed, 0 removed");
    expect(html).not.toContain("org-b-secret");
    expect(html).not.toContain("b@org-b.test");
  });

  it("keeps a member out of the full log and shows the excerpt with a link to an admin", async () => {
    const admin = await signIn("admin@example.com");
    const owner = await signIn("owner@example.com");
    for (let i = 0; i < 12; i++) {
      await addEvent("default", owner.user.id, "token_refresh_failed", `{"code":"code-${i}"}`);
    }
    expect((await get("/admin/activity", owner.cookie)).status).toBe(404);
    const excerpt = await (await get("/admin", admin.cookie)).text();
    expect(excerpt).toContain('href="/admin/activity"');
    expect(excerpt.match(/code-\d+/g)?.length).toBe(10);
    const full = await (await get("/admin/activity", admin.cookie)).text();
    expect(full.match(/code-\d+/g)?.length).toBe(12);
  });

  it("joins rows that read the same and names the account for its own user only", async () => {
    const admin = await signIn("admin@example.com");
    const owner = await signIn("owner@example.com");
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, provider, email) VALUES ('acc-log', ?, 'google', 'log@example.com')",
    )
      .bind(owner.user.id)
      .run();
    const detail = '{"dryRun":false,"create":1,"update":0,"delete":0,"failed":0}';
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        `INSERT INTO audit_events (org_id, user_id, account_id, kind, detail, created_at)
         VALUES ('default', ?, 'acc-log', 'sync_run', ?, '2026-10-31T10:00:00.000Z')`,
      )
        .bind(owner.user.id, detail)
        .run();
    }
    const own = await (await get("/activity", owner.cookie)).text();
    expect(own).toContain("log@example.com");
    expect(own).toContain("× 3");
    const org = await (await get("/admin/activity", admin.cookie)).text();
    expect(org).toContain("owner@example.com");
    expect(org).not.toContain("log@example.com");
  });

  it("names the run and pause events and describes them, in every language", async () => {
    const owner = await signIn("owner@example.com");
    await addEvent("default", owner.user.id, "sync_run_aborted", '{"runId":"r","startedAt":"t"}');
    await addEvent("default", owner.user.id, "account_paused", '{"code":"invalid_grant"}');
    await addEvent("default", owner.user.id, "account_resumed", '{"code":"invalid_grant"}');

    for (const [lang, messages] of [
      ["en", en],
      ["de", de],
    ] as const) {
      const html = await (await get(`/activity?lang=${lang}`, owner.cookie)).text();
      const { kinds } = messages.activity;
      for (const kind of ["sync_run_aborted", "account_paused", "account_resumed"] as const) {
        expect(html).toContain(kinds[kind]);
        expect(html).not.toContain(`<td>${kind}</td>`);
      }
      expect(html).toContain(messages.activity.abortedDetail);
      expect(html).toContain(messages.activity.pausedDetail("invalid_grant"));
      expect(html).toContain(messages.activity.resumedDetail);
    }
  });

  it("describes the reason of an alert, in every language", async () => {
    const owner = await signIn("owner@example.com");
    const codes = ["rule_silent", "run_aborted", "check_blind"] as const;
    for (const code of codes) {
      await addEvent("default", owner.user.id, "alert_sent", JSON.stringify({ code }));
    }

    for (const [lang, messages] of [
      ["en", en],
      ["de", de],
    ] as const) {
      const html = await (await get(`/activity?lang=${lang}`, owner.cookie)).text();
      for (const code of codes) {
        expect(html).toContain(messages.activity.alertDetails[code]);
        expect(html).not.toContain(`<td>${code}</td>`);
      }
    }
  });

  it("hides the org-wide table from members", async () => {
    const owner = await signIn("owner@example.com");
    expect((await get("/admin", owner.cookie)).status).toBe(403);
  });

  it("lists the activity page in German with translated labels", async () => {
    const owner = await signIn("owner@example.com");
    await addEvent("default", owner.user.id, "sign_in_refused");
    const html = await (await get("/activity?lang=de", owner.cookie)).text();
    expect(html).toContain("Anmeldung abgelehnt");
  });
});
