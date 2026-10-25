import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { AUDIT_RETENTION_DAYS, purgeAuditEvents, recordAudit } from "../src/audit";

async function insertAt(daysAgo: number, kind = "sign_in"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events (org_id, kind, created_at)
     VALUES ('retention-org', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))`,
  )
    .bind(kind, `-${daysAgo} days`)
    .run();
}

describe("audit log", () => {
  it("never throws when the insert fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // `kind` is NOT NULL; a null kind makes the insert fail.
    await recordAudit(env.DB, { orgId: "o", kind: null as never });
    expect(error).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("deletes only rows older than the retention period", async () => {
    await insertAt(AUDIT_RETENTION_DAYS + 1, "old");
    await insertAt(AUDIT_RETENTION_DAYS - 1, "recent");
    await insertAt(0, "today");

    await purgeAuditEvents(env.DB);

    const { results } = await env.DB.prepare(
      "SELECT kind FROM audit_events WHERE org_id = 'retention-org' ORDER BY kind",
    ).all<{ kind: string }>();
    expect(results.map((row) => row.kind)).toEqual(["recent", "today"]);
  });
});
