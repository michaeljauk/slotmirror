import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DEFAULT_ORG_ID } from "../access";
import type { AppEnv } from "../app-env";
import { errorLogFields, recordAudit } from "../audit";
import { PROVIDER_LABEL, signInProviders, type Provider } from "../config";
import { checkOAuthState, createOAuthState, OAUTH_COOKIE, type OAuthPurpose } from "../oauth";
import { i18nFromContext } from "../i18n";
import { MessagePage } from "../pages/message";
import { OAuthErrorPage } from "../pages/oauth-error";
import {
  classifyExchangeError,
  classifyProviderError,
  newReference,
  TROUBLESHOOTING_URL,
  type ProviderErrorInfo,
} from "../oauth-errors";
import { CONNECT_SCOPES, TokenError } from "../providers/microsoft";
import { clientCredentials, oauthClient } from "../providers/oauth-clients";
import type { Identity, TokenResponse } from "../providers/oauth-token";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "../session";
import { render } from "../render";
import { APP_NAME } from "../brand";
import { refreshUserCalendars } from "../calendars";
import { admitSignIn, CONSUMER_TENANT_ID } from "../users";
import { accountSync } from "../durable";

export const auth = new Hono<AppEnv>();

const PROVIDERS: readonly Provider[] = ["microsoft", "google"];

/**
 * Marks the return from the admin consent link. The value is fixed, because the administrator's
 * browser usually holds no flow cookie. It proves nothing: that return only shows a page.
 */
const ADMIN_CONSENT_STATE = "admin-consent";

function parseProvider(value: string): Provider | null {
  return (PROVIDERS as readonly string[]).includes(value) ? (value as Provider) : null;
}

function redirectUri(c: Context<AppEnv>, provider: Provider): string {
  return `${new URL(c.req.url).origin}/auth/${provider}/callback`;
}

function message(
  c: Context<AppEnv>,
  status: 200 | 400 | 403 | 409 | 501 | 502,
  title: string,
  text: string,
) {
  return render(c, <MessagePage title={title} message={text} />, status);
}

/**
 * A provider error as a page with a code and a reference, never the provider's text. The log
 * holds the same reference and code, so an operator can find the failure.
 */
function oauthErrorPage(
  c: Context<AppEnv>,
  provider: Provider,
  purpose: OAuthPurpose,
  info: ProviderErrorInfo,
  status: 400 | 502,
  loggedReference?: string,
) {
  const { t } = i18nFromContext(c);
  const label = PROVIDER_LABEL[provider];
  const reference = loggedReference ?? newReference();
  if (!loggedReference) {
    console.error(
      "oauth error",
      provider,
      purpose,
      `code=${info.code ?? "none"}`,
      `ref=${reference}`,
    );
  }
  const helpHref = `${TROUBLESHOOTING_URL}${info.anchor ? `#${info.anchor}` : ""}`;
  const retryHref = `/auth/${provider}/${purpose === "sign-in" ? "login" : "connect"}`;
  const base = { code: info.code, reference, helpHref, retryHref };
  if (info.kind === "consent") {
    const clientId = clientCredentials(c.env, provider).clientId;
    // The link asks for `.default`, which approves the permissions of the app, not of this flow.
    const permissions = CONNECT_SCOPES.join(", ");
    const link =
      "https://login.microsoftonline.com/organizations/v2.0/adminconsent?" +
      new URLSearchParams({
        client_id: clientId,
        scope: "https://graph.microsoft.com/.default",
        redirect_uri: redirectUri(c, "microsoft"),
        state: ADMIN_CONSENT_STATE,
      }).toString();
    return render(
      c,
      <OAuthErrorPage
        {...base}
        title={t.oauthError.consentTitle(label)}
        lead={t.oauthError.consentLead(label)}
        steps={
          provider === "microsoft" ? t.oauthError.consentSteps : t.oauthError.googleConsentSteps
        }
        request={
          provider === "microsoft" && clientId
            ? {
                title: t.oauthError.requestTitle,
                text: t.oauthError.adminRequest({
                  appName: APP_NAME,
                  clientId,
                  permissions,
                  link,
                }),
              }
            : undefined
        }
      />,
      status,
    );
  }
  if (info.kind === "tenant") {
    return render(
      c,
      <OAuthErrorPage {...base} title={t.oauthError.tenantTitle} lead={t.oauthError.tenantLead} />,
      status,
    );
  }
  return render(
    c,
    <OAuthErrorPage
      {...base}
      title={status === 400 ? t.messages.providerRefused(label) : t.messages.signInFailed}
      lead={
        status === 400 ? t.messages.providerRefusedText(label) : t.messages.exchangeFailed(label)
      }
    />,
    status,
  );
}

async function startFlow(
  c: Context<AppEnv>,
  provider: Provider,
  purpose: OAuthPurpose,
  loginHint?: string,
) {
  const { t } = i18nFromContext(c);
  const { clientId } = clientCredentials(c.env, provider);
  if (!clientId) {
    return message(
      c,
      501,
      t.messages.notAvailable,
      t.messages.providerNotConfigured(PROVIDER_LABEL[provider]),
    );
  }
  const { cookie, state, codeChallenge } = await createOAuthState(
    provider,
    purpose,
    c.env.SESSION_SECRET,
  );
  setCookie(c, OAUTH_COOKIE, cookie, {
    path: "/auth",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 600,
  });
  return c.redirect(
    oauthClient(provider).authorizeUrl({
      clientId,
      redirectUri: redirectUri(c, provider),
      state,
      codeChallenge,
      purpose,
      loginHint,
    }),
  );
}

auth.post("/logout", async (c) => {
  const user = c.get("user");
  if (user) await recordAudit(c.env.DB, { orgId: user.orgId, userId: user.id, kind: "sign_out" });
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  return c.redirect("/");
});

auth.get("/:provider/login", async (c) => {
  const provider = parseProvider(c.req.param("provider"));
  if (!provider) return c.notFound();
  const configured = Boolean(clientCredentials(c.env, provider).clientId);
  if (configured && !signInProviders(c.env)[provider]) {
    const { t } = i18nFromContext(c);
    return message(
      c,
      403,
      t.messages.notAllowed,
      t.messages.signInProviderOff(PROVIDER_LABEL[provider]),
    );
  }
  return startFlow(c, provider, "sign-in");
});

auth.get("/:provider/connect", async (c) => {
  const provider = parseProvider(c.req.param("provider"));
  if (!provider) return c.notFound();
  const user = c.get("user");
  if (!user) return c.redirect("/");
  // "Reconnect" names the account by ID. Only the address of the user's own account of this
  // provider becomes the hint; the query never reaches the provider's URL.
  const accountId = c.req.query("account");
  const account = accountId
    ? await c.env.DB.prepare(
        "SELECT email FROM accounts WHERE id = ? AND user_id = ? AND provider = ?",
      )
        .bind(accountId, user.id, provider)
        .first<{ email: string }>()
    : null;
  return startFlow(c, provider, "connect", account?.email);
});

auth.get("/:provider/callback", async (c) => {
  const provider = parseProvider(c.req.param("provider"));
  if (!provider) return c.notFound();
  const { t } = i18nFromContext(c);
  const label = PROVIDER_LABEL[provider];

  // The return from the admin consent link has no flow to resume. Anyone can write this URL, so
  // nothing here trusts its parameters: no sign-in, no cookie, no write, and no `tenant` shown.
  if (
    provider === "microsoft" &&
    !c.req.query("code") &&
    (c.req.query("admin_consent") !== undefined || c.req.query("state") === ADMIN_CONSENT_STATE)
  ) {
    const consentError = c.req.query("error");
    if (consentError) {
      return oauthErrorPage(
        c,
        provider,
        "sign-in",
        classifyProviderError(consentError, c.req.query("error_description")),
        400,
      );
    }
    return message(c, 200, t.oauthError.adminConsentTitle, t.oauthError.adminConsentText);
  }

  const stored = await checkOAuthState(
    getCookie(c, OAUTH_COOKIE),
    provider,
    c.req.query("state"),
    c.env.SESSION_SECRET,
  );
  deleteCookie(c, OAUTH_COOKIE, { path: "/auth", secure: true });
  if (!stored) {
    return message(c, 400, t.messages.signInExpired, t.messages.signInExpiredText);
  }

  const providerError = c.req.query("error");
  if (providerError) {
    return oauthErrorPage(
      c,
      provider,
      stored.purpose,
      classifyProviderError(providerError, c.req.query("error_description")),
      400,
    );
  }
  const code = c.req.query("code");
  if (!code) return message(c, 400, t.messages.signInFailed, t.messages.noCode(label));

  let tokens: TokenResponse;
  let identity: Identity;
  try {
    const client = oauthClient(provider);
    tokens = await client.exchangeCode({
      ...clientCredentials(c.env, provider),
      redirectUri: redirectUri(c, provider),
      code,
      codeVerifier: stored.codeVerifier,
    });
    identity = client.identity(tokens);
  } catch (error) {
    const reference = newReference();
    const info =
      error instanceof TokenError
        ? classifyExchangeError(error.code, error.aadsts)
        : classifyExchangeError(undefined, undefined);
    console.error(
      `${provider} token exchange failed`,
      `code=${info.code ?? "none"}`,
      `ref=${reference}`,
      ...errorLogFields(error),
    );
    return oauthErrorPage(c, provider, stored.purpose, info, 502, reference);
  }

  if (stored.purpose === "sign-in") {
    const outcome = await admitSignIn(c.env, identity);
    if ("refused" in outcome) {
      // No user exists for a refused identity; the log keeps the reason, not the address.
      await recordAudit(c.env.DB, {
        orgId: DEFAULT_ORG_ID,
        kind: "sign_in_refused",
        detail: { reason: outcome.refused },
      });
      const other: Provider = provider === "microsoft" ? "google" : "microsoft";
      const text =
        outcome.refused === "identity"
          ? t.messages.otherIdentity(identity.email, label)
          : outcome.refused === "provider"
            ? t.messages.useOtherProvider(identity.email, PROVIDER_LABEL[other])
            : t.messages.notAllowedToSignIn(identity.email);
      return message(c, 403, t.messages.notAllowed, text);
    }
    const { user } = outcome;
    const session = await signSession(
      {
        userId: user.id,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
        version: user.sessionVersion,
      },
      c.env.SESSION_SECRET,
    );
    await recordAudit(c.env.DB, { orgId: user.orgId, userId: user.id, kind: "sign_in" });
    setCookie(c, SESSION_COOKIE, session, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.redirect("/");
  }

  // purpose === "connect": the account joins the signed-in user, whatever its own address is.
  const user = c.get("user");
  if (!user) return c.redirect("/");
  if (!tokens.refresh_token) {
    return message(c, 502, t.messages.connectFailed, t.messages.noRefreshToken(label));
  }
  // A reconnect finds the user's account under any address the provider gave it before. An
  // unverified Microsoft email claim counts only within the account's own tenant.
  const known = [
    ...identity.addresses,
    ...(identity.unverifiedEmail && identity.tenantId !== CONSUMER_TENANT_ID
      ? [identity.unverifiedEmail]
      : []),
  ];
  const existing = await c.env.DB.prepare(
    `SELECT id, email FROM accounts
     WHERE user_id = ? AND provider = ? AND email IN (${known.map(() => "?").join(", ")})
       AND (email <> ? OR tenant_id IS ?)
     ORDER BY email = ? DESC LIMIT 1`,
  )
    .bind(
      user.id,
      provider,
      ...known,
      identity.unverifiedEmail ?? "",
      identity.tenantId,
      identity.email,
    )
    .first<{ id: string; email: string }>();
  // The WHERE clause keeps an account that belongs to another user untouched; RETURNING is then empty.
  const account = await c.env.DB.prepare(
    `INSERT INTO accounts (id, user_id, provider, email, tenant_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (provider, email) DO UPDATE SET tenant_id = excluded.tenant_id
       WHERE accounts.user_id = excluded.user_id
     RETURNING id`,
  )
    .bind(
      crypto.randomUUID(),
      user.id,
      provider,
      existing?.email ?? identity.email,
      identity.tenantId,
    )
    .first<{ id: string }>();
  if (!account) {
    return message(
      c,
      409,
      t.messages.alreadyConnected,
      t.messages.alreadyConnectedText(identity.email),
    );
  }

  await accountSync(c.env, account.id).storeTokens(
    account.id,
    {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      accessExpiresAt: Date.now() + tokens.expires_in * 1000,
    },
    provider,
  );
  await c.env.DB.prepare("UPDATE accounts SET needs_reconnect = 0 WHERE id = ?")
    .bind(account.id)
    .run();
  await recordAudit(c.env.DB, {
    orgId: user.orgId,
    userId: user.id,
    accountId: account.id,
    kind: "account_connected",
    detail: { provider },
  });
  // Load the new account's calendars now, so that the editor can use them at once.
  await refreshUserCalendars(c.env, user.id);
  // With a second account the next step is choosing where events go.
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?")
    .bind(user.id)
    .first<{ n: number }>();
  const rules = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM rules WHERE user_id = ?")
    .bind(user.id)
    .first<{ n: number }>();
  return c.redirect((count?.n ?? 0) >= 2 && (rules?.n ?? 0) === 0 ? "/rules" : "/");
});
