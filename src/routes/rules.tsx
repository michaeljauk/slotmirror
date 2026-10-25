import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env";
import { latestRuleOutcomes, recordAudit } from "../audit";
import { refreshUserCalendars, userCalendars } from "../calendars";
import { parseRuleOptions, ruleOptionsSchema } from "../config";
import { detailLevelFor } from "../detail-policy";
import { i18nFromContext } from "../i18n";
import { RulesPage, type Notice, type RuleRow } from "../pages/rules";
import { render } from "../render";
import type { CurrentUser } from "../users";
import { accountSync } from "../durable";

export const rules = new Hono<AppEnv>();

rules.use("*", async (c, next) => {
  if (!c.get("user")) return c.redirect("/");
  await next();
});

function currentUser(c: Context<AppEnv>): CurrentUser {
  const user = c.get("user");
  if (!user) throw new Error("rules routes require a user");
  return user;
}

export async function userRules(db: D1Database, userId: string): Promise<RuleRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, source_calendar_id AS sourceCalendarId, target_calendar_id AS targetCalendarId,
              options, enabled
       FROM rules WHERE user_id = ? ORDER BY rowid`,
    )
    .bind(userId)
    .all<{
      id: string;
      sourceCalendarId: string;
      targetCalendarId: string;
      options: string;
      enabled: number;
    }>();
  return results.map((row) => ({
    ...row,
    enabled: row.enabled === 1,
    options: parseRuleOptions(row.options),
  }));
}

async function renderPage(c: Context<AppEnv>, notice?: Notice, status: 200 | 400 = 200) {
  const user = currentUser(c);
  let calendars = await userCalendars(c.env.DB, user.id);
  if (calendars.length === 0) {
    await refreshUserCalendars(c.env, user.id);
    calendars = await userCalendars(c.env.DB, user.id);
  }
  const ruleRows = await userRules(c.env.DB, user.id);
  const byId = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const capped = new Map<string, RuleRow["options"]["detailLevel"]>();
  for (const rule of ruleRows) {
    const source = byId.get(rule.sourceCalendarId);
    const target = byId.get(rule.targetCalendarId);
    if (!source || !target) continue;
    const effective = detailLevelFor(
      c.env,
      rule.options.detailLevel,
      { email: source.accountEmail, tenantId: source.accountTenantId },
      { email: target.accountEmail, tenantId: target.accountTenantId },
    );
    if (effective.capped) capped.set(rule.id, effective.level);
  }
  const page = (
    <RulesPage
      user={user}
      calendars={calendars}
      rules={ruleRows}
      capped={capped}
      outcomes={new Map((await latestRuleOutcomes(c.env.DB, user.id)).map((o) => [o.ruleId, o]))}
      notice={notice}
    />
  );
  return render(c, page, status);
}

/** The target account of a rule, if the rule belongs to the user. */
async function targetAccountOf(db: D1Database, ruleId: string, userId: string) {
  return db
    .prepare(
      `SELECT tc.account_id AS accountId FROM rules r
       JOIN calendars tc ON tc.id = r.target_calendar_id
       WHERE r.id = ? AND r.user_id = ?`,
    )
    .bind(ruleId, userId)
    .first<{ accountId: string }>();
}

rules.get("/", (c) => renderPage(c));

rules.post("/calendars/refresh", async (c) => {
  await refreshUserCalendars(c.env, currentUser(c).id);
  return c.redirect("/rules");
});

rules.post("/", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  const source = form.get("source");
  const target = form.get("target");
  const calendars = new Map(
    (await userCalendars(c.env.DB, user.id)).map((calendar) => [calendar.id, calendar]),
  );
  const parsed = ruleOptionsSchema.safeParse({
    detailLevel: form.get("detailLevel") ?? undefined,
    daysAhead: Number(form.get("daysAhead") ?? 60),
    markPrivate: form.has("markPrivate"),
    skipAllDay: form.has("skipAllDay"),
    skipTentative: form.has("skipTentative"),
  });
  const valid =
    parsed.success &&
    typeof source === "string" &&
    typeof target === "string" &&
    source !== target &&
    calendars.has(source) &&
    calendars.get(target)?.canEdit === true;
  if (!valid) return renderPage(c, { kind: "error", text: t.rules.invalid }, 400);

  const ruleId = crypto.randomUUID();
  await c.env.DB.prepare(
    // New rules start paused, so that nothing is written before the user checked the preview.
    `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled)
     VALUES (?, ?, ?, ?, ?, 0)`,
  )
    .bind(ruleId, user.id, source, target, JSON.stringify(parsed.data))
    .run();
  await recordAudit(c.env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId: calendars.get(target)?.accountId,
    ruleId,
    kind: "rule_created",
    detail: { detailLevel: parsed.data.detailLevel, daysAhead: parsed.data.daysAhead },
  });
  return c.redirect("/rules");
});

for (const action of ["preview", "run"] as const) {
  rules.post(`/:id/${action}`, async (c) => {
    const user = currentUser(c);
    const { t } = i18nFromContext(c);
    const ruleId = c.req.param("id");
    const target = await targetAccountOf(c.env.DB, ruleId, user.id);
    if (!target) return c.notFound();
    try {
      const result = await accountSync(c.env, target.accountId).runRule(ruleId, {
        dryRun: action === "preview",
      });
      const { create, update, delete: remove, unchanged } = result.stats;
      const text =
        action === "preview"
          ? t.rules.previewResult(create, update, remove, unchanged)
          : t.rules.runResult(result.applied, result.failed, result.remaining);
      return renderPage(c, { kind: "info", text });
    } catch (error) {
      console.error(`Rule ${action} failed`, ruleId, error);
      return renderPage(c, { kind: "error", text: (error as Error).message }, 400);
    }
  });
}

for (const [action, enabled] of [
  ["enable", 1],
  ["pause", 0],
] as const) {
  rules.post(`/:id/${action}`, async (c) => {
    const user = currentUser(c);
    const ruleId = c.req.param("id");
    const updated = await c.env.DB.prepare(
      "UPDATE rules SET enabled = ? WHERE id = ? AND user_id = ? AND enabled <> ?",
    )
      .bind(enabled, ruleId, user.id, enabled)
      .run();
    if (updated.meta.changes > 0) {
      const target = await targetAccountOf(c.env.DB, ruleId, user.id);
      await recordAudit(c.env.DB, {
        orgId: user.orgId,
        userId: user.id,
        accountId: target?.accountId,
        ruleId,
        kind: enabled ? "rule_enabled" : "rule_paused",
      });
      // Start the first run now instead of waiting for the next cron.
      if (enabled && target) await accountSync(c.env, target.accountId).requestSync();
    }
    return c.redirect("/rules");
  });
}

rules.post("/:id/delete", async (c) => {
  const user = currentUser(c);
  const ruleId = c.req.param("id");
  const target = await c.env.DB.prepare(
    `SELECT tc.account_id AS accountId, tc.remote_id AS remoteCalendarId FROM rules r
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE r.id = ? AND r.user_id = ?`,
  )
    .bind(ruleId, user.id)
    .first<{ accountId: string; remoteCalendarId: string }>();
  if (!target) return c.redirect("/rules");

  // Remove the rule's blocks first; the rule's tag is the only way to find them later.
  let cleanup: { removed: number; remaining: number } | null = null;
  try {
    cleanup = await accountSync(c.env, target.accountId).removeRuleBlocks(
      ruleId,
      target.remoteCalendarId,
    );
  } catch (error) {
    console.error("Removing blocks failed", ruleId, error);
  }

  await c.env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?")
    .bind(ruleId, user.id)
    .run();
  await recordAudit(c.env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId: target.accountId,
    ruleId,
    kind: "rule_deleted",
    detail: cleanup
      ? { removed: cleanup.removed, remaining: cleanup.remaining }
      : { cleanupFailed: true },
  });
  return c.redirect("/rules");
});
