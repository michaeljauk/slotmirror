import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { languageDetector } from "hono/language";
import * as z from "zod/mini";
import type { AppEnv } from "./app-env";
import {
  accountStatuses,
  errorCode,
  latestRuleOutcomes,
  orgActivity,
  purgeAuditEvents,
  userActivity,
} from "./audit";
import { setupStatus, signInProviders } from "./config";
import { i18nFromContext, LOCALES } from "./i18n";
import { ActivityPage } from "./pages/activity";
import { AdminPage, type AdminUserRow } from "./pages/admin";
import { DeleteUserPage } from "./pages/delete-user";
import { DisconnectPage } from "./pages/disconnect";
import { HomePage, SignInPage, type AccountRow } from "./pages/home";
import { MessagePage } from "./pages/message";
import { PrivacyPage } from "./pages/privacy";
import { SetupPage } from "./pages/setup";
import { render } from "./render";
import { auth } from "./routes/auth";
import { dev } from "./routes/dev";
import { rules } from "./routes/rules";
import { ACCOUNT_COLOR_KEYS } from "./colors";
import { loadEditorState, renameAccount, setAccountColor } from "./editor";
import { SESSION_COOKIE, verifySession } from "./session";
import { loadUser } from "./users";
import { policyFromEnv } from "./access";
import { detailCapsFromEnv } from "./detail-policy";
import { accountSync } from "./durable";
import { isValidToken, notifyChange } from "./webhooks";
import { deleteUser, removeAccounts } from "./offboarding";
import { scim } from "./routes/scim";

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

// SCIM provisioning from Entra: its own bearer token, independent of sessions and the setup.
app.route("/scim/v2", scim);

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
app.route("/dev", dev);

app.get("/", async (c) => {
  const user = c.get("user");
  const { providers } = setupStatus(c.env);
  if (!user) {
    return render(c, <SignInPage providers={signInProviders(c.env)} />);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, provider, email, tenant_id AS tenantId, created_at AS createdAt,
            needs_reconnect AS needsReconnect
     FROM accounts WHERE user_id = ? ORDER BY provider, email`,
  )
    .bind(user.id)
    .all<AccountRow>();
  const [outcomes, editor] = await Promise.all([
    latestRuleOutcomes(c.env.DB, user.id),
    loadEditorState(c.env, user.id),
  ]);
  return render(
    c,
    <HomePage
      user={user}
      accounts={results}
      providers={providers}
      statuses={accountStatuses(outcomes)}
      editor={editor}
    />,
  );
});

/** "auto" or a palette key; the form of the account's name and colour sends it. */
const accountColorField = z.enum(["auto", ...ACCOUNT_COLOR_KEYS]);

app.post("/accounts/:id/name", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect("/");
  const form = await c.req.formData();
  const accountId = c.req.param("id");
  // The colour is optional, so that a form with the name only keeps working.
  if (form.has("color")) {
    const color = accountColorField.safeParse(form.get("color"));
    if (!color.success) return c.text("Bad colour", 400);
    const owned = await setAccountColor(
      c.env,
      user,
      accountId,
      color.data === "auto" ? null : color.data,
    );
    if (!owned) return c.notFound();
  }
  const name = form.get("name");
  if (form.has("name")) {
    await renameAccount(c.env, user, accountId, typeof name === "string" ? name : "");
  }
  return c.redirect("/");
});

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
  return render(
    c,
    <AdminPage
      user={user}
      users={results}
      activity={activity}
      caps={detailCapsFromEnv(c.env)}
      org={{
        domains: policyFromEnv(c.env).allowedDomains,
        tenantCount: policyFromEnv(c.env).allowedTenantIds.length,
      }}
    />,
  );
});

async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM accounts").all<{ id: string }>();
  for (const { id } of results) {
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
