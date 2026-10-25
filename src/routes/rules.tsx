import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env";
import { latestRuleOutcomes, recordAudit } from "../audit";
import { refreshUserCalendars, userCalendars } from "../calendars";
import { ruleOptionsSchema } from "../config";
import { i18nFromContext, useI18n as i18nForStatus } from "../i18n";
import {
  CHOICES,
  deleteRuleWithBlocks,
  loadEditorState,
  resetDirection,
  setDirection,
  setGroupMembership,
  setSourceOptions,
  type Choice,
} from "../editor";
import { CalendarEditorPage, SourceCard, type Notice } from "../pages/calendar-editor";
import { render, renderFragment } from "../render";
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

async function renderPage(c: Context<AppEnv>, notice?: Notice, status: 200 | 400 = 200) {
  const user = currentUser(c);
  if ((await userCalendars(c.env.DB, user.id)).length === 0) {
    await refreshUserCalendars(c.env, user.id);
  }
  const view = c.req.query("view") === "matrix" ? "matrix" : "list";
  const page = (
    <CalendarEditorPage
      user={user}
      state={await loadEditorState(c.env, user.id)}
      view={view}
      open={c.req.query("open") ?? null}
      notice={notice}
      status={<SyncStatus outcomes={await latestRuleOutcomes(c.env.DB, user.id)} />}
    />
  );
  return render(c, page, status);
}

/** One line for the whole page: the newest run, or the first failure. */
function SyncStatus(props: { outcomes: Awaited<ReturnType<typeof latestRuleOutcomes>> }) {
  const { t, formatRelative, formatTimestamp } = i18nForStatus();
  if (props.outcomes.length === 0) return null;
  const failed = props.outcomes.find(
    (outcome) => outcome.kind === "sync_failed" || (outcome.detail.failed ?? 0) > 0,
  );
  const newest = props.outcomes.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  const shown = failed ?? newest;
  return (
    <span class={failed ? "status error" : "status ok"} title={formatTimestamp(shown.createdAt)}>
      {failed
        ? t.editor.statusFailed(formatRelative(shown.createdAt), failed.detail.code ?? "")
        : t.editor.statusOk(formatRelative(shown.createdAt))}
    </span>
  );
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

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** The editor script asks for fragments with this header; forms without the script do not. */
function wantsFragment(c: Context<AppEnv>): boolean {
  return c.req.header("x-fragment") === "1";
}

/**
 * Where to go after a change: the updated card for the editor script, otherwise back to the list
 * with the source open.
 */
async function backTo(c: Context<AppEnv>, sourceId: string) {
  if (wantsFragment(c)) {
    const state = await loadEditorState(c.env, currentUser(c).id);
    const source = state.accounts.find((account) => account.id === sourceId);
    if (!source) return c.notFound();
    return renderFragment(c, <SourceCard state={state} source={source} open />);
  }
  return c.redirect(
    `/rules?open=${encodeURIComponent(sourceId)}#src-${encodeURIComponent(sourceId)}`,
  );
}

rules.post("/group/:accountId", async (c) => {
  const form = await c.req.formData();
  await setGroupMembership(
    c.env,
    currentUser(c),
    c.req.param("accountId"),
    form.get("inGroup") === "1",
  );
  return c.redirect("/rules");
});

rules.post("/direction", async (c) => {
  const form = await c.req.formData();
  const from = formText(form, "from");
  const to = formText(form, "to");
  const choice = formText(form, "choice");
  if (!(CHOICES as readonly string[]).includes(choice)) return c.text("Bad choice", 400);
  await setDirection(c.env, currentUser(c), from, to, choice as Choice);
  return backTo(c, from);
});

// Several choices of one source at once, sent by the editor script: fields "choice.<target ID>".
rules.post("/source/:accountId/choices", async (c) => {
  const user = currentUser(c);
  const from = c.req.param("accountId");
  const form = await c.req.formData();
  for (const [name, value] of form.entries()) {
    if (!name.startsWith("choice.") || typeof value !== "string") continue;
    if (!(CHOICES as readonly string[]).includes(value)) return c.text("Bad choice", 400);
    await setDirection(c.env, user, from, name.slice("choice.".length), value as Choice);
  }
  return backTo(c, from);
});

rules.post("/direction/reset", async (c) => {
  const form = await c.req.formData();
  const from = formText(form, "from");
  await resetDirection(c.env, currentUser(c), from, formText(form, "to"));
  return backTo(c, from);
});

rules.post("/source/:accountId/options", async (c) => {
  const form = await c.req.formData();
  const days = Number(form.get("daysAhead") ?? 90);
  await setSourceOptions(c.env, currentUser(c), c.req.param("accountId"), {
    daysAhead: [30, 90, 180, 365].includes(days) ? days : 90,
    skipAllDay: form.has("skipAllDay"),
    skipTentative: form.has("skipTentative"),
    markPrivate: form.has("markPrivate"),
  });
  return backTo(c, c.req.param("accountId"));
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
      if (wantsFragment(c)) {
        // Next to its button the result says what the next sync would do, in plain words.
        return c.text(
          action === "preview" ? t.editor.checkResult(create, update, remove, unchanged) : text,
        );
      }
      return renderPage(c, { kind: "info", text });
    } catch (error) {
      console.error(`Rule ${action} failed`, ruleId, error);
      const text = (error as Error).message;
      return wantsFragment(c) ? c.text(text, 400) : renderPage(c, { kind: "error", text }, 400);
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
  await deleteRuleWithBlocks(c.env, currentUser(c), c.req.param("id"));
  return c.redirect("/rules");
});
