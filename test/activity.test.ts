import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
    expect(html).toContain("+3 / ~1 / −0");
    expect(html).not.toContain("org-b-secret");
    expect(html).not.toContain("b@org-b.test");
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
