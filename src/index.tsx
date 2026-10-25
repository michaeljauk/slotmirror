import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { languageDetector } from "hono/language";
import type { AppEnv } from "./app-env";
import {
  accountStatuses,
  latestRuleOutcomes,
  orgActivity,
  purgeAuditEvents,
  recordAudit,
  userActivity,
} from "./audit";
import { setupStatus } from "./config";
import { i18nFromContext, LOCALES } from "./i18n";
import { ActivityPage } from "./pages/activity";
import { AdminPage, type AdminUserRow } from "./pages/admin";
import { HomePage, SignInPage, type AccountRow } from "./pages/home";
import { MessagePage } from "./pages/message";
import { PrivacyPage } from "./pages/privacy";
import { SetupPage } from "./pages/setup";
import { render } from "./render";
import { auth } from "./routes/auth";
import { rules } from "./routes/rules";
import { SESSION_COOKIE, verifySession } from "./session";
import { loadUser } from "./users";

export { AccountSync } from "./account-sync";

const app = new Hono<AppEnv>();

app.get("/healthz", (c) => c.text("ok"));

// Microsoft Graph change notifications. On subscription creation Graph sends a validation
// request and expects the token back as plain text within 10 seconds.
app.post("/webhooks/microsoft", async (c) => {
  const validationToken = c.req.query("validationToken");
  if (validationToken !== undefined) {
    return c.text(validationToken, 200, { "Content-Type": "text/plain" });
  }
  // Not implemented yet: validate clientState, then requestSync() on the account's instance.
  // Graph counts a notification as delivered only on a 2xx within 3 seconds.
  return c.body(null, 202);
});

// Google Calendar push notifications carry no body; the headers identify the channel.
app.post("/webhooks/google", (c) => c.body(null, 202));

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

// Public, also before the setup is finished: Google requires a reachable privacy statement.
app.get("/privacy", (c) =>
  render(
    c,
    <PrivacyPage
      operator={c.env.ORG_NAME?.trim() || "the operator"}
      contact={c.env.PRIVACY_CONTACT?.trim() ?? ""}
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
  c.set("user", session ? await loadUser(c.env, session.userId) : null);
  await next();
});

app.route("/auth", auth);
app.route("/rules", rules);

app.get("/", async (c) => {
  const user = c.get("user");
  const { providers } = setupStatus(c.env);
  if (!user) {
    return render(c, <SignInPage providers={providers} />);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, provider, email, tenant_id AS tenantId, created_at AS createdAt
     FROM accounts WHERE user_id = ? ORDER BY provider, email`,
  )
    .bind(user.id)
    .all<AccountRow>();
  const statuses = accountStatuses(await latestRuleOutcomes(c.env.DB, user.id));
  return render(
    c,
    <HomePage user={user} accounts={results} providers={providers} statuses={statuses} />,
  );
});

// Remove an account of the signed-in user: its tokens and state first, then the registry row.
app.post("/accounts/:id/disconnect", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const accountId = c.req.param("id");
  const owned = await c.env.DB.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?")
    .bind(accountId, user.id)
    .first();
  if (!owned) return c.notFound();

  // Remove every block that involves the account before its tokens go: blocks in its own
  // calendars (written by rules that target it) and blocks it caused elsewhere (rules with it as
  // source). Each target account deletes with its own tokens.
  const { results: affected } = await c.env.DB.prepare(
    `SELECT r.id AS ruleId, tc.account_id AS targetAccountId, tc.remote_id AS remoteCalendarId
     FROM rules r
     JOIN calendars sc ON sc.id = r.source_calendar_id
     JOIN calendars tc ON tc.id = r.target_calendar_id
     WHERE sc.account_id = ? OR tc.account_id = ?`,
  )
    .bind(accountId, accountId)
    .all<{ ruleId: string; targetAccountId: string; remoteCalendarId: string }>();
  let removed = 0;
  let cleanupFailed = 0;
  for (const rule of affected) {
    try {
      const result = await c.env.ACCOUNT_SYNC.getByName(rule.targetAccountId).removeRuleBlocks(
        rule.ruleId,
        rule.remoteCalendarId,
      );
      removed += result.removed;
    } catch (error) {
      cleanupFailed++;
      console.error("Removing blocks failed", rule.ruleId, error);
    }
  }

  await c.env.ACCOUNT_SYNC.getByName(accountId).forget();
  // Deleting the account also deletes its calendars and every rule that uses them.
  await c.env.DB.prepare("DELETE FROM accounts WHERE id = ? AND user_id = ?")
    .bind(accountId, user.id)
    .run();
  await recordAudit(c.env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId,
    kind: "account_disconnected",
    detail: { rules: affected.length, removed, cleanupFailed },
  });
  return c.redirect("/");
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
    `SELECT u.email, u.role, u.last_sign_in_at AS lastSignInAt, COUNT(a.id) AS accounts
     FROM users u LEFT JOIN accounts a ON a.user_id = u.id
     WHERE u.org_id = ?
     GROUP BY u.id
     ORDER BY u.email`,
  )
    .bind(user.orgId)
    .all<AdminUserRow>();
  const activity = await orgActivity(c.env.DB, user.orgId);
  return render(c, <AdminPage user={user} users={results} activity={activity} />);
});

async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM accounts").all<{ id: string }>();
  for (const { id } of results) {
    await env.ACCOUNT_SYNC.getByName(id).requestSync();
  }
  await purgeAuditEvents(env.DB);
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
