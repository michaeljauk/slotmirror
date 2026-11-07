import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { deleteCookie, getCookie } from "hono/cookie";
import { languageDetector } from "hono/language";
import * as z from "zod/mini";
import { alertsConfigured, sendTestAlert, TEST_ALERT_OUTCOMES } from "./alerts";
import { revokeUserTokens } from "./api-tokens";
import { cleanupsOfOthers, NO_CLEANUPS, ownCleanups } from "./cleanup";
import type { AppEnv } from "./app-env";
import {
  accountStatuses,
  errorCode,
  latestCompares,
  latestRuleOutcomes,
  orgActivity,
  recordAudit,
  userActivity,
} from "./audit";
import { mcpEnabled, setupStatus, signInProviders } from "./config";
import { can, mcpForMembersSchema } from "./permissions";
import { routePermissions } from "./route-permissions";
import { operatorNotice } from "./operator-notice";
import { i18nFromContext, LOCALES } from "./i18n";
import { ActivityPage, OrgActivityPage } from "./pages/activity";
import { AdminPage, type AdminUserRow } from "./pages/admin";
import { CleanupPage } from "./pages/cleanup";
import { DeleteUserPage } from "./pages/delete-user";
import { DisconnectPage } from "./pages/disconnect";
import { HomePage, SignInPage, type AccountRow, type AccountSettingsDraft } from "./pages/home";
import type { Notice } from "./pages/calendar-editor";
import { MessagePage } from "./pages/message";
import { PrivacyPage } from "./pages/privacy";
import { SetupPage } from "./pages/setup";
import { render } from "./render";
import { mcp } from "./mcp";
import { auth } from "./routes/auth";
import { dev } from "./routes/dev";
import { rules } from "./routes/rules";
import { oauthApi, oauthPages } from "./routes/oauth";
import { tokens } from "./routes/tokens";
import { ACCOUNT_COLOR_KEYS } from "./colors";
import {
  accountWorkHours,
  EditorConflict,
  loadEditorState,
  renameAccount,
  setAccountColor,
  setAccountWorkHours,
  setRuleDetails,
  type AccountWorkHours,
} from "./editor";
import { SESSION_COOKIE, verifySession } from "./session";
import { loadUser, resetSignInBinding, type CurrentUser, type SignedInUser } from "./users";
import { policyFromEnv } from "./access";
import { detailCapsFromEnv } from "./detail-policy";
import { accountSync } from "./durable";
import { isValidToken, notifyChange } from "./webhooks";
import { deleteUser, removeAccounts } from "./offboarding";
import { crossSiteGuard, securityHeaders } from "./request-guard";
import { carrier, log, startRequest } from "./telemetry";

/** A count from a query string, or 0 if it is none. */
function countParam(value: string | undefined): number {
  const count = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export const app = new Hono<AppEnv>();

// First, so that every answer of the Worker carries the headers, also errors and redirects.
app.use("*", securityHeaders);

// Before the routes and the error handler, so that every log line of a request carries its ID.
app.use("*", (_c, next) => startRequest("http", next));

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
    await accountSync(c.env, accountId).graphChanged(ids, carrier());
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
    const channelId = c.req.header("x-goog-channel-id") ?? "";
    await accountSync(c.env, accountId).googleChanged(channelId, carrier());
  }
  return c.body(null, 200);
});

// Before the language and session middleware: the bearer token is the only credential here.
app.route("/mcp", mcp);
// OAuth metadata, registration, token and revocation: server to server, without cookies.
app.route("/", oauthApi);

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
// and the guard exempts them by path as well.
app.use("*", crossSiteGuard);

/** The signed-in user of the request, or null. Needs a finished setup. */
async function sessionUser(c: Context<AppEnv>): Promise<SignedInUser | null> {
  const session = await verifySession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
  return session ? loadUser(c.env, session.userId, session.version ?? 0) : null;
}

// Public, also before the setup is finished: Google requires a reachable privacy statement.
app.get("/privacy", async (c) =>
  render(
    c,
    <PrivacyPage
      user={setupStatus(c.env).ready ? await sessionUser(c) : null}
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
  c.set("user", await sessionUser(c));
  await next();
});

/**
 * Every route below asks `can` for its action in `ROUTE_NEEDS`; a route without an entry is 404.
 * A test checks that only routes with their own check are registered above this line.
 */
export const permissionGate = routePermissions((c, message) => {
  const { t } = i18nFromContext(c);
  return render(
    c,
    <MessagePage user={c.get("user")} title={t.messages.notAllowed} message={message(t)} />,
    403,
  );
});
app.use("*", permissionGate);

app.route("/auth", auth);
app.route("/rules", rules);
app.route("/tokens", tokens);
app.route("/oauth", oauthPages);
app.route("/dev", dev);

app.get("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return render(c, <SignInPage providers={signInProviders(c.env)} />);
  }
  return renderHome(c, user, {
    openSettings: c.req.query("settings"),
    returnSource: c.req.query("from"),
  });
});

/** The home page, with a notice and an account's settings open if given. */
async function renderHome(
  c: Context<AppEnv>,
  user: CurrentUser,
  options: {
    notice?: Notice;
    openSettings?: string;
    draft?: AccountSettingsDraft;
    returnSource?: string;
  } = {},
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
  const [outcomes, editor, cleanups] = await Promise.all([
    latestRuleOutcomes(c.env.DB, user.id),
    loadEditorState(c.env, user.id),
    ownCleanups(c.env.DB, user.id),
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
      cleanups={cleanups.left.length}
      cleanupsRunning={cleanups.running.length}
      notice={options.notice}
      openSettings={options.openSettings}
      draft={options.draft}
      returnSource={options.returnSource}
    />,
    status,
  );
}

/** "auto" or a palette key; the form of the account's name and colour sends it. */
const accountColorField = z.enum(["auto", ...ACCOUNT_COLOR_KEYS]);

/**
 * Working hours from the account settings form. The switch off, no weekday and no time, or the
 * button "No working hours" of an older page, mean none. A time field cannot hold 24:00; "until
 * midnight" stands for it.
 */
function workHoursFrom(form: FormData): AccountWorkHours | null {
  if (form.get("workHours") === "none") return null;
  if (form.has("workHoursSwitch") && !form.has("workHoursOn")) return null;
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
          on: form.has("workHoursOn") || !form.has("workHoursSwitch"),
          applyFrom: form.getAll("applyFrom").filter((value) => typeof value === "string"),
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
    const back = form.get("returnSource");
    const returnSource = typeof back === "string" ? back : "";
    const refuse = (text: string) =>
      renderHome(
        c,
        user,
        {
          notice: { kind: "error", text },
          openSettings: accountId,
          draft: settingsDraft(accountId, form),
          returnSource: returnSource || undefined,
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
        // Hours filter only the directions that use them, so the form sets both. Without hours
        // the write above already cleared every rule.
        const applyFrom = new Set(form.getAll("applyFrom"));
        const workHours = form
          .getAll("applyFromShown")
          .filter((from) => typeof from === "string")
          .map((from) => ({ from, to: accountId, on: applyFrom.has(from) }));
        if (hours.hours && workHours.length > 0) {
          await setRuleDetails(c.env, user, { workHours });
        }
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
    if (returnSource) return c.redirect(`/rules?open=${encodeURIComponent(returnSource)}`);
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
  const target = await deletableUser(c.env, user, c.req.param("id"));
  if (!target) return c.notFound();
  await deleteUser(c.env, { id: target.id, orgId: user.orgId }, "admin");
  return c.redirect("/admin");
});

app.post("/admin/users/:id/reset-sign-in", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const target = await deletableUser(c.env, user, c.req.param("id"));
  if (!target) return c.notFound();
  await resetSignInBinding(c.env, { id: target.id, orgId: user.orgId }, "admin");
  return c.redirect("/admin");
});

app.post("/admin/users/:id/revoke-tokens", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const target = await deletableUser(c.env, user, c.req.param("id"));
  if (!target) return c.notFound();
  await revokeUserTokens(c.env, { id: target.id, orgId: user.orgId }, "admin");
  return c.redirect("/admin");
});

// What an offboarding could not remove. An admin also sees the rest of users who cannot sign in.
app.get("/cleanup", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const [own, others] = await Promise.all([
    ownCleanups(c.env.DB, user.id),
    can(user, "org:audit") ? cleanupsOfOthers(c.env.DB, user.orgId) : NO_CLEANUPS,
  ]);
  return render(c, <CleanupPage user={user} own={own} others={others} />);
});

app.get("/activity", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  return render(c, <ActivityPage user={user} rows={await userActivity(c.env.DB, user.id)} />);
});

app.get("/admin", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  // Metadata only: no calendar contents, no tokens.
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.last_sign_in_at AS lastSignInAt,
            COUNT(a.id) AS accounts,
            COALESCE(SUM(a.needs_reconnect), 0) AS needsReconnect,
            (SELECT COUNT(*) FROM api_tokens t WHERE t.user_id = u.id)
              + (SELECT COUNT(*) FROM oauth_grants g WHERE g.user_id = u.id
                   AND g.refresh_expires_at > ?2 AND g.expires_at > ?2) AS apiTokens
     FROM users u LEFT JOIN accounts a ON a.user_id = u.id
     WHERE u.org_id = ?1
     GROUP BY u.id
     ORDER BY u.email`,
  )
    .bind(user.orgId, new Date().toISOString())
    .all<AdminUserRow>();
  const activity = await orgActivity(c.env.DB, user.orgId);
  const compares = await latestCompares(c.env.DB, user.orgId);
  const cleanups = await cleanupsOfOthers(c.env.DB, user.orgId);
  return render(
    c,
    <AdminPage
      user={user}
      users={results}
      cleanups={cleanups.left.length}
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
      mcpForMembers={mcpEnabled(c.env) ? user.mcpForMembers : null}
      org={{
        domains: policyFromEnv(c.env).allowedDomains,
        tenantCount: policyFromEnv(c.env).allowedTenantIds.length,
      }}
    />,
  );
});

app.get("/admin/activity", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  return render(c, <OrgActivityPage user={user} rows={await orgActivity(c.env.DB, user.orgId)} />);
});

// Start a comparison of every calendar of the org that a rule writes into, and of the writable
// calendars without a rule. It costs one call per account, as the cron does; alarms read the
// calendars. The redirect names what happened, because a calendar can stay open or refuse.
app.post("/admin/compare", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const { results } = await c.env.DB.prepare(
    `SELECT a.id FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.org_id = ?`,
  )
    .bind(user.orgId)
    .all<{ id: string }>();
  const total = { started: 0, open: 0, failed: 0 };
  for (const { id } of results) {
    // One failing account must not stop the others.
    try {
      const { started, open, failed } = await accountSync(c.env, id).startCompares(
        "full",
        carrier(),
      );
      total.started += started;
      total.open += open;
      total.failed += failed;
    } catch (error) {
      log.error("compare.start_failed", { accountId: id, code: errorCode(error) }, error);
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
  const outcome = await sendTestAlert(c.env, { orgId: user.orgId, userId: user.id });
  return c.redirect(`/admin?alert=${outcome}`);
});

// Whether members may use MCP. Tokens and apps of members stay while it is off, and stop working.
app.post("/admin/mcp-policy", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  if (!mcpEnabled(c.env)) return c.notFound();
  const form = await c.req.parseBody();
  const parsed = mcpForMembersSchema.safeParse(form.mcpForMembers);
  if (!parsed.success) {
    const { t } = i18nFromContext(c);
    return render(
      c,
      <MessagePage user={user} title={t.admin.mcpTitle} message={t.admin.mcpInvalid} />,
      400,
    );
  }
  // Only a real change reaches the log; saving the same value again writes nothing.
  const updated = await c.env.DB.prepare(
    "UPDATE orgs SET mcp_for_members = ? WHERE id = ? AND mcp_for_members IS NOT ?",
  )
    .bind(parsed.data, user.orgId, parsed.data)
    .run();
  if (!updated.meta.changes) return c.redirect("/admin");
  await recordAudit(c.env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: "mcp_policy_changed",
    detail: { mcpForMembers: parsed.data },
  });
  return c.redirect("/admin");
});

// An unexpected error gets a page in the user's language, or a short text for the editor
// script. The log never holds a raw message or stack: a provider description can name the user,
// and a SyntaxError can quote the input. See `errorFields`.
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  // The route pattern, not the path: a path can hold a calendar ID, and an OAuth callback carries
  // its code in the query.
  log.error("request.failed", { method: c.req.method, route: c.req.routePath }, error);
  const { t } = i18nFromContext(c);
  if (c.req.header("x-fragment") === "1") return c.text(t.messages.errorText, 500);
  return render(
    c,
    <MessagePage title={t.messages.errorTitle} message={t.messages.errorText} />,
    500,
  );
});
