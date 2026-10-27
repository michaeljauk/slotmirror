import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env";
import { errorLogFields, latestRuleOutcomes, recordAudit } from "../audit";
import { refreshUserCalendars, userCalendars } from "../calendars";
import { MAX_BUFFER_MINUTES, ruleOptionsSchema, setupStatus } from "../config";
import { i18nFromContext, useI18n as i18nForStatus, type Messages } from "../i18n";
import {
  blockColorProblem,
  CHOICES,
  deleteRuleWithBlocks,
  loadEditorState,
  MAX_CATEGORY_LENGTH,
  resetDirection,
  setDirection,
  setBlockBuffer,
  setBlockColor,
  setDefaultBlockTitle,
  setGroupMembership,
  setGroupMemberships,
  setSettings,
  setSourceCalendar,
  type BlockBuffer,
  type SettingsForm,
  type Choice,
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

/** Why a block colour cannot be stored for a target, in the user's words; null if it can. */
function blockColorError(
  t: Messages,
  target: { provider: "microsoft" | "google" } | undefined,
  value: string,
): string | null {
  const problem = target ? blockColorProblem(target.provider, value) : "invalid";
  if (problem === "comma") return t.editor.blockCategoryComma;
  if (problem === "tooLong") return t.editor.blockCategoryTooLong(MAX_CATEGORY_LENGTH);
  return problem ? t.editor.blockColorInvalid : null;
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
// "choice.<from>.<to>", "blockColor.<from>.<to>", "bufferBefore.<from>.<to>",
// "bufferAfter.<from>.<to>" and "settings.<name>". Every field is checked before the first write,
// so that an invalid field refuses the whole save. The writes are not one transaction: a D1 or
// Durable Object failure can still stop them part-way.
rules.post("/choices", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
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
  const colors: { from: string; to: string; value: string }[] = [];
  const { accounts, directions } = await loadEditorState(c.env, user.id);
  for (const { first, second, value } of fields("blockColor")) {
    if (!second) continue;
    const error = blockColorError(
      t,
      accounts.find((account) => account.id === second),
      value,
    );
    if (error) return refuse(c, error);
    colors.push({ from: first, to: second, value });
  }
  // The two buffers of a direction are one change; both must be valid, for a direction that exists.
  const buffers = new Map<string, { from: string; to: string; buffer: BlockBuffer }>();
  for (const kind of ["bufferBefore", "bufferAfter"] as const) {
    for (const { first, second, value } of fields(kind)) {
      if (!second) continue;
      const entry = buffers.get(`${first}>${second}`) ?? { from: first, to: second, buffer: {} };
      entry.buffer[kind] = minutes(value);
      buffers.set(`${first}>${second}`, entry);
    }
  }
  for (const { from, to, buffer } of buffers.values()) {
    const known = directions.some((d) => d.from === from && d.to === to);
    if (!known || !ruleOptionsSchema.safeParse(buffer).success) {
      return refuse(c, t.editor.bufferInvalid(MAX_BUFFER_MINUTES));
    }
  }

  // Source calendars first, so that the choices below also reach newly chosen calendars.
  for (const { first, value } of calendars) {
    await setSourceCalendar(c.env, user, first, value === "1");
  }
  for (const change of changes) {
    await setDirection(c.env, user, change.from, change.to, change.choice);
  }
  // Colours and buffers after the choices, so that a direction turned on in the same save has its
  // rules. A direction that lost its last source in this save has no rules left to change.
  for (const color of colors) {
    await setBlockColor(c.env, user, color.from, color.to, color.value);
  }
  for (const { from, to, buffer } of buffers.values()) {
    await setBlockBuffer(c.env, user, from, to, buffer);
  }
  if (form.has("settings")) {
    await setSettings(c.env, user, settingsFrom(form, t.editor.defaultBlockTitle, "settings."));
  }
  if (wantsFragment(c)) return c.body(null, 204);
  return c.redirect("/rules");
});

rules.post("/direction/color", async (c) => {
  const user = currentUser(c);
  const { t } = i18nFromContext(c);
  const form = await c.req.formData();
  const from = formText(form, "from");
  const to = formText(form, "to");
  const value = formText(form, "blockColor");
  const { accounts } = await loadEditorState(c.env, user.id);
  const error = blockColorError(
    t,
    accounts.find((account) => account.id === to),
    value,
  );
  if (error) return refuse(c, error);
  if (!(await setBlockColor(c.env, user, from, to, value)))
    return refuse(c, t.editor.blockColorInvalid);
  return backTo(c, from);
});

rules.post("/direction/buffer", async (c) => {
  const form = await c.req.formData();
  const from = formText(form, "from");
  const ok = await setBlockBuffer(c.env, currentUser(c), from, formText(form, "to"), {
    bufferBefore: minutes(formText(form, "bufferBefore")),
    bufferAfter: minutes(formText(form, "bufferAfter")),
  });
  if (!ok) return refuse(c, i18nFromContext(c).t.editor.bufferInvalid(MAX_BUFFER_MINUTES));
  return backTo(c, from);
});

rules.post("/direction/reset", async (c) => {
  const form = await c.req.formData();
  const from = formText(form, "from");
  await resetDirection(c.env, currentUser(c), from, formText(form, "to"));
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
