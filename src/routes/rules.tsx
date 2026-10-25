import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env";
import { refreshUserCalendars, userCalendars } from "../calendars";
import { parseRuleOptions, ruleOptionsSchema } from "../config";
import { i18nFromContext } from "../i18n";
import { RulesPage, type Notice, type RuleRow } from "../pages/rules";
import { render } from "../render";
import type { CurrentUser } from "../users";

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

async function userRules(db: D1Database, userId: string): Promise<RuleRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, source_calendar_id AS sourceCalendarId, target_calendar_id AS targetCalendarId,
              options
       FROM rules WHERE user_id = ? ORDER BY rowid`,
    )
    .bind(userId)
    .all<{ id: string; sourceCalendarId: string; targetCalendarId: string; options: string }>();
  return results.map((row) => ({ ...row, options: parseRuleOptions(row.options) }));
}

async function renderPage(c: Context<AppEnv>, notice?: Notice, status: 200 | 400 = 200) {
  const user = currentUser(c);
  let calendars = await userCalendars(c.env.DB, user.id);
  if (calendars.length === 0) {
    await refreshUserCalendars(c.env, user.id);
    calendars = await userCalendars(c.env.DB, user.id);
  }
  const page = (
    <RulesPage
      user={user}
      calendars={calendars}
      rules={await userRules(c.env.DB, user.id)}
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

  await c.env.DB.prepare(
    `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), user.id, source, target, JSON.stringify(parsed.data))
    .run();
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
      const result = await c.env.ACCOUNT_SYNC.getByName(target.accountId).runRule(ruleId, {
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

rules.post("/:id/delete", async (c) => {
  await c.env.DB.prepare("DELETE FROM rules WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), currentUser(c).id)
    .run();
  return c.redirect("/rules");
});
