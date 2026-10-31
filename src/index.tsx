import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { deleteCookie, getCookie } from "hono/cookie";
import { languageDetector } from "hono/language";
import * as z from "zod/mini";
import {
  alertsConfigured,
  checkSilentRules,
  sendTestAlert,
  silenceCheckCost,
  TEST_ALERT_OUTCOMES,
} from "./alerts";
import { accountsToTick, CRON_FIXED_SUBREQUESTS, MAX_CRON_SUBREQUESTS } from "./cron";
import type { AppEnv } from "./app-env";
import {
  accountStatuses,
  errorCode,
  errorLogFields,
  latestCompares,
  latestRuleOutcomes,
  orgActivity,
  purgeAuditEvents,
  userActivity,
} from "./audit";
import { setupStatus, signInProviders } from "./config";
import { operatorNotice } from "./operator-notice";
import { i18nFromContext, LOCALES } from "./i18n";
import { ActivityPage } from "./pages/activity";
import { AdminPage, type AdminUserRow } from "./pages/admin";
import { DeleteUserPage } from "./pages/delete-user";
import { DisconnectPage } from "./pages/disconnect";
import { HomePage, SignInPage, type AccountRow, type AccountSettingsDraft } from "./pages/home";
import type { Notice } from "./pages/calendar-editor";
import { MessagePage } from "./pages/message";
import { PrivacyPage } from "./pages/privacy";
import { SetupPage } from "./pages/setup";
import { render } from "./render";
import { auth } from "./routes/auth";
import { dev } from "./routes/dev";
import { rules } from "./routes/rules";
import { ACCOUNT_COLOR_KEYS } from "./colors";
import {
  accountWorkHours,
  EditorConflict,
  loadEditorState,
  renameAccount,
  setAccountColor,
  setAccountWorkHours,
  type AccountWorkHours,
} from "./editor";
import { SESSION_COOKIE, verifySession } from "./session";
import { loadUser, resetSignInBinding, type CurrentUser } from "./users";
import { policyFromEnv } from "./access";
import { detailCapsFromEnv } from "./detail-policy";
import { accountSync } from "./durable";
import { isValidToken, notifyChange } from "./webhooks";
import { deleteUser, removeAccounts } from "./offboarding";
import { scim } from "./routes/scim";
import { crossSiteGuard, securityHeaders } from "./request-guard";
import { feeds } from "./routes/feeds";
import { feedResponse, listFeeds } from "./feeds";
import { userCalendars } from "./calendars";

export { AccountSync } from "./account-sync";

/** A count from a query string, or 0 if it is none. */
function countParam(value: string | undefined): number {
  const count = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

const app = new Hono<AppEnv>();

const noReferrer: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("Referrer-Policy", "no-referrer");
};

// A feed address is a secret. These answers keep their stricter referrer policy: this runs after
// the headers below, which set the default for every other answer.
app.use("/ics/*", noReferrer);
app.use("/feeds/*", noReferrer);

// First, so that every answer of the Worker carries the headers, also errors and redirects.
app.use("*", securityHeaders);

app.get("/healthz", (c) => c.text("ok"));

// Microsoft Graph change notifications. On subscription creation Graph sends a validation
// request and expects the token back as plain text within 10 seconds.
app.post("/webhooks/microsoft", async (c) => {
  const validationToken = c.req.query("validationToken");
  if (validationToken !== undefined) {
    return c.text(validationToken, 200, { "Content-Type": "text/plain" });
  }
  // Graph counts a notification as delivered only on a 2xx within 3 seconds. Every answer is 202,
  // so that a forged request learns nothing.
  const accountId = c.req.query("account") ?? "";
  const body = (await c.req.json().catch(() => null)) as {
    value?: { clientState?: string; resourceData?: { id?: string } }[];
  } | null;
  const valid: { resourceData?: { id?: string } }[] = [];
  for (const item of body?.value ?? []) {
    if (await isValidToken(c.env, accountId, item.clientState)) valid.push(item);
  }
  // The instance skips the sync if the notification is only about blocks it wrote itself. Without
  // event IDs that cannot be told, so the sync starts at once.
  const ids = valid.map((item) => item.resourceData?.id);
  if (valid.length === 0) return c.body(null, 202);
  if (ids.every((id): id is string => typeof id === "string" && id !== "")) {
    await accountSync(c.env, accountId).graphChanged(ids);
  } else {
    await notifyChange(c.env, accountId);
  }
  return c.body(null, 202);
});

// Google Calendar push notifications carry no body; the headers identify the channel.
app.post("/webhooks/google", async (c) => {
  const accountId = c.req.query("account") ?? "";
  // "sync" only confirms a new channel; "exists" and "not_exists" report a change.
  const state = c.req.header("x-goog-resource-state");
  if (
    state !== "sync" &&
    (await isValidToken(c.env, accountId, c.req.header("x-goog-channel-token")))
  ) {
    // The instance skips the sync if the change is only blocks it wrote itself.
    await accountSync(c.env, accountId).googleChanged(c.req.header("x-goog-channel-id") ?? "");
  }
  return c.body(null, 200);
});

// Private free/busy feeds for calendar apps. Before the language detector, which sets a cookie,
// and before the session middleware: the secret in the address is the only credential.
app.get("/ics/:feedId/:file", (c) =>
  feedResponse(c.env, c.req.param("feedId"), c.req.param("file"), new URL(c.req.url).origin),
);

// Language: ?lang= (stored in a cookie), then the cookie, then Accept-Language.
app.use(
  "*",
  languageDetector({
    supportedLanguages: [...LOCALES],
    fallbackLanguage: LOCALES[0],
    order: ["querystring", "cookie", "header"],
    lookupQueryString: "lang",
    lookupCookie: "lang",
    caches: ["cookie"],
    cookieOptions: { path: "/", sameSite: "Lax", secure: true, httpOnly: true, maxAge: 31_536_000 },
  }),
);

// After the language, so that a refusal speaks it. The webhooks above answer before this runs,
// and the guard exempts them and SCIM by path as well.
app.use("*", crossSiteGuard);

// SCIM provisioning from Entra: its own bearer token, independent of sessions and the setup.
app.route("/scim/v2", scim);

// Public, also before the setup is finished: Google requires a reachable privacy statement.
app.get("/privacy", (c) =>
  render(
    c,
    <PrivacyPage
      operator={c.env.ORG_NAME?.trim() || "the operator"}
      contact={c.env.PRIVACY_CONTACT?.trim() ?? ""}
      notice={operatorNotice(c.env)}
    />,
  ),
);

// Everything below needs a finished setup. `user` is null for visitors without a valid session.
app.use("*", async (c, next) => {
  const status = setupStatus(c.env);
  if (!status.ready) {
    return render(c, <SetupPage status={status} />, 503);
  }
  const session = await verifySession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
  c.set("user", session ? await loadUser(c.env, session.userId, session.version ?? 0) : null);
  await next();
});

app.route("/auth", auth);
app.route("/rules", rules);
app.route("/dev", dev);
app.route("/feeds", feeds);

app.get("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return render(c, <SignInPage providers={signInProviders(c.env)} />);
  }
  return renderHome(c, user, { openSettings: c.req.query("settings") });
});

/** The home page, with a notice and an account's settings open if given. */
async function renderHome(
  c: Context<AppEnv>,
  user: CurrentUser,
  options: { notice?: Notice; openSettings?: string; draft?: AccountSettingsDraft } = {},
  status: 200 | 400 = 200,
) {
  const { providers } = setupStatus(c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT id, provider, email, tenant_id AS tenantId, created_at AS createdAt,
            needs_reconnect AS needsReconnect
     FROM accounts WHERE user_id = ? ORDER BY provider, email`,
  )
    .bind(user.id)
    .all<AccountRow>();
  const [outcomes, editor, userFeeds, calendars] = await Promise.all([
    latestRuleOutcomes(c.env.DB, user.id),
    loadEditorState(c.env, user.id),
    listFeeds(c.env.DB, user.id),
    userCalendars(c.env.DB, user.id),
  ]);
  return render(
    c,
    <HomePage
      user={user}
      accounts={results}
      providers={providers}
      operatorNotice={operatorNotice(c.env)}
      statuses={accountStatuses(outcomes)}
      editor={editor}
      feeds={userFeeds}
      calendars={calendars}
      notice={options.notice}
      openSettings={options.openSettings}
      draft={options.draft}
    />,
    status,
  );
}

/** "auto" or a palette key; the form of the account's name and colour sends it. */
const accountColorField = z.enum(["auto", ...ACCOUNT_COLOR_KEYS]);

/**
 * Working hours from the account settings form. No weekday and no time, or the button "No working
 * hours", mean none. A time field cannot hold 24:00; "until midnight" stands for it.
 */
function workHoursFrom(form: FormData): AccountWorkHours | null {
  if (form.get("workHours") === "none") return null;
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const workDays = form.getAll("workDays").map((value) => Number(value));
  const workStart = text("workStart");
  const workEnd = form.has("workUntilMidnight") ? "24:00" : text("workEnd");
  if (workDays.length === 0 && workStart === "" && workEnd === "") return null;
  return { workDays, workStart, workEnd, workTimeZone: text("workTimeZone") };
}

/** What the user typed into the settings form of an account, to show it again after a refusal. */
function settingsDraft(accountId: string, form: FormData): AccountSettingsDraft {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  return {
    accountId,
    name: text("name"),
    color: text("color") || "auto",
    hours: form.has("workHoursShown")
      ? {
          workDays: form.getAll("workDays").map((value) => Number(value)),
          workStart: text("workStart"),
          workEnd: text("workEnd"),
          untilMidnight: form.has("workUntilMidnight"),
          workTimeZone: text("workTimeZone"),
        }
      : null,
  };
}

// The settings of an account: name, colour and working hours. Every field is checked before the
// first write, and the hours, which can meet a concurrent change, are written first. "/name" is
// the address of the form before the working hours came.
for (const path of ["/accounts/:id/settings", "/accounts/:id/name"]) {
  app.post(path, async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/");
    const { t } = i18nFromContext(c);
    const form = await c.req.formData();
    const accountId = c.req.param("id") ?? "";
    // The colour and the hours are optional, so that a form with the name only keeps working.
    const color = form.has("color") ? accountColorField.safeParse(form.get("color")) : null;
    if (color && !color.success) return c.text("Bad colour", 400);
    const hours = form.has("workHoursShown") ? accountWorkHours(c.env, workHoursFrom(form)) : null;
    const refuse = (text: string) =>
      renderHome(
        c,
        user,
        {
          notice: { kind: "error", text },
          openSettings: accountId,
          draft: settingsDraft(accountId, form),
        },
        400,
      );
    if (hours && "problem" in hours) return refuse(t.editor.workHoursErrors[hours.problem]);
    const owned = await c.env.DB.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?")
      .bind(accountId, user.id)
      .first();
    if (!owned) return c.notFound();
    if (hours) {
      try {
        await setAccountWorkHours(c.env, user, accountId, hours.hours);
      } catch (error) {
        if (error instanceof EditorConflict) return refuse(t.editor.saveConflict);
        throw error;
      }
    }
    if (color) {
      await setAccountColor(c.env, user, accountId, color.data === "auto" ? null : color.data);
    }
    const name = form.get("name");
    if (form.has("name")) {
      await renameAccount(c.env, user, accountId, typeof name === "string" ? name : "");
    }
    return c.redirect(`/#account-${encodeURIComponent(accountId)}`);
  });
}

// Ask before disconnecting: it deletes the rules that use the account and their blocks.
app.get("/accounts/:id/disconnect", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const accountId = c.req.param("id");
  const account = await c.env.DB.prepare("SELECT email FROM accounts WHERE id = ? AND user_id = ?")
    .bind(accountId, user.id)
    .first<{ email: string }>();
  if (!account) return c.notFound();
  const usage = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id = ? OR tc.account_id = ?`,
  )
    .bind(accountId, accountId)
    .first<{ count: number }>();
  return render(
    c,
    <DisconnectPage
      user={user}
      accountId={accountId}
      email={account.email}
      rules={usage?.count ?? 0}
    />,
  );
});

// Remove an account of the signed-in user. Its blocks go through the removal queues, then its
// Durable Object forgets the tokens.
app.post("/accounts/:id/disconnect", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const accountId = c.req.param("id");
  const owned = await c.env.DB.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?")
    .bind(accountId, user.id)
    .first();
  if (!owned) return c.notFound();
  await removeAccounts(c.env, user, [accountId]);
  return c.redirect("/");
});

async function accountCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// "Delete my data": confirmation, then the user goes with every account, rule and block.
app.get("/account/delete", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  return render(
    c,
    <DeleteUserPage
      user={user}
      target={null}
      ownAccounts={await accountCount(c.env, user.id)}
      action="/account/delete"
      cancel="/"
    />,
  );
});

app.post("/account/delete", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  await deleteUser(c.env, user, "self");
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  const { t } = i18nFromContext(c);
  return render(c, <MessagePage title={t.deleteUser.doneTitle} message={t.deleteUser.doneText} />);
});

/** A user of the admin's org other than the admin, or null. */
async function deletableUser(env: Env, admin: { id: string; orgId: string }, userId: string) {
  if (userId === admin.id) return null;
  return env.DB.prepare("SELECT id, email FROM users WHERE id = ? AND org_id = ?")
    .bind(userId, admin.orgId)
    .first<{ id: string; email: string }>();
}

app.get("/admin/users/:id/delete", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  if (user.role !== "admin") return c.notFound();
  const target = await deletableUser(c.env, user, c.req.param("id"));
  if (!target) return c.notFound();
  return render(
    c,
    <DeleteUserPage
      user={user}
      target={{ email: target.email, accounts: await accountCount(c.env, target.id) }}
      ownAccounts={0}
      action={`/admin/users/${target.id}/delete`}
      cancel="/admin"
    />,
  );
});

app.post("/admin/users/:id/delete", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  if (user.role !== "admin") return c.notFound();
  const target = await deletableUser(c.env, user, c.req.param("id"));
  if (!target) return c.notFound();
  await deleteUser(c.env, { id: target.id, orgId: user.orgId }, "admin");
  return c.redirect("/admin");
});

app.post("/admin/users/:id/reset-sign-in", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  if (user.role !== "admin") return c.notFound();
  const target = await deletableUser(c.env, user, c.req.param("id"));
  if (!target) return c.notFound();
  await resetSignInBinding(c.env, { id: target.id, orgId: user.orgId }, "admin");
  return c.redirect("/admin");
});

app.get("/activity", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  return render(c, <ActivityPage user={user} rows={await userActivity(c.env.DB, user.id)} />);
});

app.get("/admin", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  if (user.role !== "admin") {
    const { t } = i18nFromContext(c);
    return render(
      c,
      <MessagePage title={t.messages.notAllowed} message={t.admin.onlyAdmins} />,
      403,
    );
  }
  // Metadata only: no calendar contents, no tokens.
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.active, u.last_sign_in_at AS lastSignInAt,
            COUNT(a.id) AS accounts,
            COALESCE(SUM(a.needs_reconnect), 0) AS needsReconnect
     FROM users u LEFT JOIN accounts a ON a.user_id = u.id
     WHERE u.org_id = ?
     GROUP BY u.id
     ORDER BY u.email`,
  )
    .bind(user.orgId)
    .all<AdminUserRow>();
  const activity = await orgActivity(c.env.DB, user.orgId);
  const compares = await latestCompares(c.env.DB, user.orgId);
  return render(
    c,
    <AdminPage
      user={user}
      users={results}
      activity={activity}
      compares={compares}
      compareStart={
        c.req.query("compare") === "requested"
          ? {
              started: countParam(c.req.query("started")),
              open: countParam(c.req.query("open")),
              failed: countParam(c.req.query("failed")),
            }
          : null
      }
      alertsConfigured={alertsConfigured(c.env)}
      testAlert={TEST_ALERT_OUTCOMES.find((outcome) => outcome === c.req.query("alert")) ?? null}
      caps={detailCapsFromEnv(c.env)}
      org={{
        domains: policyFromEnv(c.env).allowedDomains,
        tenantCount: policyFromEnv(c.env).allowedTenantIds.length,
      }}
    />,
  );
});

// Start a comparison of every calendar of the org that a rule writes into, and of the writable
// calendars without a rule. It costs one call per account, as the cron does; alarms read the
// calendars. The redirect names what happened, because a calendar can stay open or refuse.
app.post("/admin/compare", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  if (user.role !== "admin") return c.notFound();
  const { results } = await c.env.DB.prepare(
    `SELECT a.id FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.org_id = ?`,
  )
    .bind(user.orgId)
    .all<{ id: string }>();
  const total = { started: 0, open: 0, failed: 0 };
  for (const { id } of results) {
    // One failing account must not stop the others.
    try {
      const { started, open, failed } = await accountSync(c.env, id).startCompares("full");
      total.started += started;
      total.open += open;
      total.failed += failed;
    } catch (error) {
      console.error("Starting a comparison failed", id, errorCode(error));
      total.failed++;
    }
  }
  const { started, open, failed } = total;
  return c.redirect(`/admin?compare=requested&started=${started}&open=${open}&failed=${failed}`);
});

// Post a test alert. The crossSiteGuard above covers this route, and D1 limits it to one per minute.
app.post("/admin/test-alert", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  if (user.role !== "admin") return c.notFound();
  const outcome = await sendTestAlert(c.env, { orgId: user.orgId, userId: user.id });
  return c.redirect(`/admin?alert=${outcome}`);
});

// An unexpected error gets a page in the user's language, or a short text for the editor
// script. The log never holds a raw message or stack: a provider description can name the user,
// and a SyntaxError can quote the input. See `errorLogFields`.
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  console.error("Request failed", ...errorLogFields(error));
  const { t } = i18nFromContext(c);
  if (c.req.header("x-fragment") === "1") return c.text(t.messages.errorText, 500);
  return render(
    c,
    <MessagePage title={t.messages.errorTitle} message={t.messages.errorText} />,
    500,
  );
});

async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  // Before the ticks: it must still run if they use up the subrequests of this invocation.
  const checkCost = silenceCheckCost(env, controller.scheduledTime);
  if (checkCost > 0) {
    try {
      await checkSilentRules(env, controller.scheduledTime);
    } catch (error) {
      console.error("Silence check failed", errorCode(error));
    }
  }
  const { results } = await env.DB.prepare("SELECT id FROM accounts ORDER BY id").all<{
    id: string;
  }>();
  const tickLimit = MAX_CRON_SUBREQUESTS - CRON_FIXED_SUBREQUESTS - checkCost;
  if (results.length > tickLimit) {
    console.error("Cron ticks rotate at the subrequest limit", tickLimit, results.length);
  }
  const ids = results.map(({ id }) => id);
  for (const id of accountsToTick(ids, controller.scheduledTime, tickLimit)) {
    // One failing account must not stop the ticks of the others.
    try {
      await accountSync(env, id).tick();
    } catch (error) {
      console.error("Cron tick failed", id, errorCode(error));
    }
  }
  try {
    await purgeAuditEvents(env.DB);
  } catch (error) {
    console.error("Audit purge failed", errorCode(error));
  }
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
