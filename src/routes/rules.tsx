import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env";
import { errorLogFields, latestRuleOutcomes, recordAudit } from "../audit";
import { refreshUserCalendars, userCalendars } from "../calendars";
import { MAX_BUFFER_MINUTES, ruleOptionsSchema, setupStatus } from "../config";
import { i18nFromContext, useI18n as i18nForStatus, type Messages } from "../i18n";
import {
  CHOICES,
  deleteRuleWithBlocks,
  EditorConflict,
  loadEditorState,
  MAX_CATEGORY_LENGTH,
  requestSyncs,
  resetDirection,
  ruleDetailsProblem,
  setDirection,
  setDefaultBlockTitle,
  setGroupMembership,
  setGroupMemberships,
  setRuleDetails,
  setSettings,
  setSourceCalendar,
  type BlockBuffer,
  type Choice,
  type RuleDetails,
  type RuleDetailsProblem,
  type SettingsForm,
} from "../editor";
import { CalendarEditorPage, type Notice } from "../pages/calendar-editor";
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

async function renderPage(c: Context<AppEnv>, notice?: Notice, status: 200 | 400 = 200) {
  const user = currentUser(c);
  if ((await userCalendars(c.env.DB, user.id)).length === 0) {
    await refreshUserCalendars(c.env, user.id);
  }
  // Every rule starts on this page, so a new user's first rule gets the title in their language.
  await setDefaultBlockTitle(c.env, user.id, i18nFromContext(c).t.editor.defaultBlockTitle);
  const page = (
    <CalendarEditorPage
      user={user}
      providers={setupStatus(c.env).providers}
      state={await loadEditorState(c.env, user.id)}
      open={(c.req.query("open") ?? "").split(",").filter(Boolean)}
      notice={notice}
      status={<SyncStatus outcomes={await latestRuleOutcomes(c.env.DB, user.id)} />}
    />
  );
  return render(c, page, status);
}

/** One line for the whole page: the newest run, or the first failure. */
function SyncStatus(props: { outcomes: Awaited<ReturnType<typeof latestRuleOutcomes>> }) {
  const { t, formatRelative, formatTimestamp } = i18nForStatus();
  // A paused rule's last run is history; the line shows the rules that run.
  const outcomes = props.outcomes.filter((outcome) => outcome.enabled);
  if (outcomes.length === 0) return null;
  const failed = outcomes.find(
    (outcome) => outcome.kind === "sync_failed" || (outcome.detail.failed ?? 0) > 0,
  );
  const newest = outcomes.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
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
    bufferBefore: minutes(formText(form, "bufferBefore")),
    bufferAfter: minutes(formText(form, "bufferAfter")),
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

/** Minutes from a number field. An empty field is 0; the options schema refuses the rest. */
function minutes(value: string): number {
  return value.trim() === "" ? 0 : Number(value);
}

/** The editor script asks for fragments with this header; forms without the script do not. */
function wantsFragment(c: Context<AppEnv>): boolean {
  return c.req.header("x-fragment") === "1";
}

/** Where to go after a change without the editor script: back to the list with the source open. */
function backTo(c: Context<AppEnv>, sourceId: string) {
  return c.redirect(
    `/rules?open=${encodeURIComponent(sourceId)}#src-${encodeURIComponent(sourceId)}`,
  );
}

// Quick start: every account joins the block group.
rules.post("/group/all", async (c) => {
  const user = currentUser(c);
  const state = await loadEditorState(c.env, user.id);
  const ids = state.accounts.map((account) => account.id);
  await setGroupMemberships(c.env, user, ids, true);
  return c.redirect("/rules");
});

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

/** A refused change: plain text for the editor script, the page with a notice without it. */
function refuse(c: Context<AppEnv>, text: string) {
  return wantsFragment(c) ? c.text(text, 400) : renderPage(c, { kind: "error", text }, 400);
}

/** Refuse a save that met a change of another request (`EditorConflict`); rethrow the rest. */
function refuseConflict(c: Context<AppEnv>, error: unknown) {
  if (error instanceof EditorConflict) return refuse(c, i18nFromContext(c).t.editor.saveConflict);
  throw error;
}

rules.post("/direction", async (c) => {
  const form = await c.req.formData();
  const from = formText(form, "from");
  const to = formText(form, "to");
  const choice = formText(form, "choice");
  if (!(CHOICES as readonly string[]).includes(choice)) {
    return refuse(c, i18nFromContext(c).t.editor.choiceInvalid);
  }
  await setDirection(c.env, currentUser(c), from, to, choice as Choice);
  return backTo(c, from);
});

// All unsaved changes of the page, sent by the editor script: fields "calendar.<id>",
// "choice.<from>.<to>", "blockColor.<from>.<to>", "workHours.<from>.<to>" ("1" or "0"), the
// buffer of a source "bufferBefore.<from>" and "bufferAfter.<from>", and "settings.<name>". Every
// field is checked before the first write, so that an invalid field refuses the whole save. The
// writes are not one transaction: a D1 or Durable Object failure, or a rule that another request
// changed meanwhile, can still stop them part-way. Each account gets one sync request at the end.
rules.post("/choices", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  // The editor sends text only; a file in one of its fields is a bad request, not a skip.
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string" && isEditorField(name.split(".")[0])) {
      return c.text("Bad field", 400);
    }
  }
  const fields = (kind: string) =>
    [...form.entries()].flatMap(([name, value]) => {
      const [prefix, first, second, ...rest] = name.split(".");
      if (prefix !== kind || !first || rest.length > 0 || typeof value !== "string") return [];
      return [{ first, second, value }];
    });
  const calendars = fields("calendar").filter((field) => field.second === undefined);
  const changes: { from: string; to: string; choice: Choice }[] = [];
  for (const { first, second, value } of fields("choice")) {
    if (!second) continue;
    if (!(CHOICES as readonly string[]).includes(value)) return refuse(c, t.editor.choiceInvalid);
    changes.push({ from: first, to: second, choice: value as Choice });
  }
  const colors = fields("blockColor").flatMap(({ first, second, value }) =>
    second ? [{ from: first, to: second, value }] : [],
  );
  // The two buffers of a source are one change; a missing one is 0.
  const buffers = new Map<string, Required<BlockBuffer>>();
  for (const kind of ["bufferBefore", "bufferAfter"] as const) {
    for (const { first, second, value } of fields(kind)) {
      if (second) continue;
      const buffer = buffers.get(first) ?? { bufferBefore: 0, bufferAfter: 0 };
      buffer[kind] = minutes(value);
      buffers.set(first, buffer);
    }
  }
  const details: RuleDetails = {
    colors,
    sources: [...buffers].map(([from, options]) => ({ from, options })),
    workHours: fields("workHours").flatMap(({ first, second, value }) =>
      second ? [{ from: first, to: second, on: value === "1" }] : [],
    ),
  };
  const problem = ruleDetailsProblem(await loadEditorState(c.env, user.id), details);
  if (problem) return refuse(c, ruleDetailsError(t, problem));

  const syncs = new Set<string>();
  try {
    // Source calendars first, so that the choices below also reach newly chosen calendars.
    for (const { first, value } of calendars) {
      await setSourceCalendar(c.env, user, first, value === "1", syncs);
    }
    for (const change of changes) {
      await setDirection(c.env, user, change.from, change.to, change.choice, syncs);
    }
    // Rule details after the choices, so that a direction turned on in the same save has its
    // rules. A direction that lost its last source in this save has no rules left to change.
    await setRuleDetails(c.env, user, details, syncs);
    if (form.has("settings")) {
      const settings = settingsFrom(form, t.editor.defaultBlockTitle, "settings.");
      await setSettings(c.env, user, settings, syncs);
    }
  } catch (error) {
    return refuseConflict(c, error);
  } finally {
    // Writes before a failure stay, so their accounts sync as well.
    await requestSyncs(c.env, syncs);
  }
  if (wantsFragment(c)) return c.body(null, 204);
  return c.redirect("/rules");
});

/** Field prefixes of the editor script whose values must be text. */
function isEditorField(name: string | undefined): boolean {
  return (
    name === "calendar" ||
    name === "choice" ||
    name === "blockColor" ||
    name === "bufferBefore" ||
    name === "bufferAfter" ||
    name === "workHours"
  );
}

/** Why rule details were refused, in the user's words. */
function ruleDetailsError(t: Messages, problem: RuleDetailsProblem): string {
  switch (problem.kind) {
    case "color":
      if (problem.problem === "comma") return t.editor.blockCategoryComma;
      if (problem.problem === "tooLong") return t.editor.blockCategoryTooLong(MAX_CATEGORY_LENGTH);
      return t.editor.blockColorInvalid;
    case "source":
      return t.editor.bufferInvalid(MAX_BUFFER_MINUTES);
    case "noWorkHours":
      return t.editor.workHoursMissing(problem.account);
    case "direction":
      return problem.field === "color" ? t.editor.blockColorInvalid : t.editor.workHoursDirection;
  }
}

// The details of one direction from the form without the editor script: the block colour and,
// with "workHoursShown", the working-hours checkbox.
rules.post("/direction/details", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  const from = formText(form, "from");
  const to = formText(form, "to");
  const details: RuleDetails = {
    colors: form.has("blockColor") ? [{ from, to, value: formText(form, "blockColor") }] : [],
    workHours: form.has("workHoursShown") ? [{ from, to, on: form.get("workHours") === "1" }] : [],
  };
  const problem = ruleDetailsProblem(await loadEditorState(c.env, user.id), details);
  if (problem) return refuse(c, ruleDetailsError(t, problem));
  try {
    await setRuleDetails(c.env, user, details);
  } catch (error) {
    return refuseConflict(c, error);
  }
  return backTo(c, from);
});

// These routes exist only for pages opened before the editor rebuild: their forms posted here
// without the editor script. They write nothing and send the browser back to the editor.
for (const path of ["/direction/color", "/direction/hours", "/direction/buffer"]) {
  rules.post(path, (c) => c.redirect("/rules", 303));
}

// The buffer of one source from the form without the editor script.
rules.post("/source/buffer", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  const from = formText(form, "from");
  const details: RuleDetails = {
    sources: [
      {
        from,
        options: {
          bufferBefore: minutes(formText(form, "bufferBefore")),
          bufferAfter: minutes(formText(form, "bufferAfter")),
        },
      },
    ],
  };
  const problem = ruleDetailsProblem(await loadEditorState(c.env, user.id), details);
  if (problem) return refuse(c, ruleDetailsError(t, problem));
  try {
    await setRuleDetails(c.env, user, details);
  } catch (error) {
    return refuseConflict(c, error);
  }
  return backTo(c, from);
});

rules.post("/direction/reset", async (c) => {
  const form = await c.req.formData();
  const from = formText(form, "from");
  try {
    await resetDirection(c.env, currentUser(c), from, formText(form, "to"));
  } catch (error) {
    return refuseConflict(c, error);
  }
  return backTo(c, from);
});

/**
 * Settings from a form or the editor script's fields "settings.<name>". An empty block title
 * becomes `defaultTitle`, the one of the user's language.
 */
function settingsFrom(form: FormData, defaultTitle: string, prefix = ""): SettingsForm {
  const days = Number(form.get(`${prefix}daysAhead`));
  const shown = Number(form.get(`${prefix}daysAheadShown`));
  const text = (name: string) => {
    const value = form.get(`${prefix}${name}`);
    return typeof value === "string" ? value : "";
  };
  // Outlook categories as comma-separated names, Google colours as checkboxes "color:<id>".
  const categories = text("skipCategories")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= 100);
  const colors = form
    .getAll(`${prefix}skipColor`)
    .filter((value): value is string => typeof value === "string" && /^color:\d{1,2}$/.test(value));
  return {
    ...([30, 90, 180, 365].includes(days) ? { daysAhead: days } : {}),
    ...(Number.isInteger(shown) && shown >= 1 && shown <= 365 ? { daysAheadShown: shown } : {}),
    skipAllDay: form.has(`${prefix}skipAllDay`),
    skipTentative: form.has(`${prefix}skipTentative`),
    markPrivate: form.has(`${prefix}markPrivate`),
    blockTitle: text("blockTitle").trim().slice(0, 255) || defaultTitle,
    skipCategories: [...new Set([...categories, ...colors])].slice(0, 50),
  };
}

rules.post("/source-calendar/:calendarId", async (c) => {
  const form = await c.req.formData();
  await setSourceCalendar(
    c.env,
    currentUser(c),
    c.req.param("calendarId"),
    form.get("isSource") === "1",
  );
  return c.redirect("/rules");
});

rules.post("/settings", async (c) => {
  const { t } = i18nFromContext(c);
  await setSettings(
    c.env,
    currentUser(c),
    settingsFrom(await c.req.formData(), t.editor.defaultBlockTitle),
  );
  return c.redirect("/rules");
});

/** Token errors after which only a new sign-in helps; the same codes as in AccountSync. */
const RECONNECT_MESSAGES = [
  "Account has no tokens",
  "invalid_grant",
  "interaction_required",
  "consent_required",
];

/**
 * A failed run or check in the user's words. The error crosses the Durable Object boundary, so
 * only its message is left. A missing or refused token means the account must connect again.
 */
export function runErrorText(t: Messages, error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (RECONNECT_MESSAGES.some((text) => message.includes(text))) return t.editor.checkNoTokens;
  return t.editor.checkFailed;
}

// Check one direction with real events: a dry run of every rule of the direction, one per
// source calendar of the account, summed.
rules.post("/direction/check", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  const from = formText(form, "from");
  const to = formText(form, "to");
  const state = await loadEditorState(c.env, user.id);
  const direction = state.directions.find((d) => d.from === from && d.to === to);
  const ruleIds = (direction?.slots ?? []).flatMap((slot) =>
    slot.rule?.enabled ? [slot.rule.id] : [],
  );
  // A page from before a change can offer a check for a direction that no longer runs.
  if (ruleIds.length === 0) return refuse(c, t.editor.checkStale);
  const sum = { create: 0, update: 0, delete: 0, unchanged: 0 };
  try {
    for (const ruleId of ruleIds) {
      const result = await accountSync(c.env, to).runRule(ruleId, { dryRun: true });
      sum.create += result.stats.create;
      sum.update += result.stats.update;
      sum.delete += result.stats.delete;
      sum.unchanged += result.stats.unchanged;
    }
  } catch (error) {
    console.error("Direction check failed", from, to, ...errorLogFields(error));
    return refuse(c, runErrorText(t, error));
  }
  const text = t.editor.checkResult(sum.create, sum.update, sum.delete, sum.unchanged);
  return wantsFragment(c) ? c.text(text) : renderPage(c, { kind: "info", text });
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
      console.error(`Rule ${action} failed`, ruleId, ...errorLogFields(error));
      return refuse(c, runErrorText(t, error));
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
