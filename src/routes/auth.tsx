import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DEFAULT_ORG_ID } from "../access";
import type { AppEnv } from "../app-env";
import { recordAudit } from "../audit";
import { PROVIDER_LABEL, signInProviders, type Provider } from "../config";
import { checkOAuthState, createOAuthState, OAUTH_COOKIE, type OAuthPurpose } from "../oauth";
import { i18nFromContext } from "../i18n";
import { MessagePage } from "../pages/message";
import { clientCredentials, oauthClient } from "../providers/oauth-clients";
import type { Identity, TokenResponse } from "../providers/oauth-token";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "../session";
import { render } from "../render";
import { refreshUserCalendars } from "../calendars";
import { signInUser } from "../users";
import { accountSync } from "../durable";

export const auth = new Hono<AppEnv>();

const PROVIDERS: readonly Provider[] = ["microsoft", "google"];

function parseProvider(value: string): Provider | null {
  return (PROVIDERS as readonly string[]).includes(value) ? (value as Provider) : null;
}

function redirectUri(c: Context<AppEnv>, provider: Provider): string {
  return `${new URL(c.req.url).origin}/auth/${provider}/callback`;
}

function message(
  c: Context<AppEnv>,
  status: 400 | 403 | 409 | 501 | 502,
  title: string,
  text: string,
) {
  return render(c, <MessagePage title={title} message={text} />, status);
}

async function startFlow(c: Context<AppEnv>, provider: Provider, purpose: OAuthPurpose) {
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
  if (!c.get("user")) return c.redirect("/");
  return startFlow(c, provider, "connect");
});

auth.get("/:provider/callback", async (c) => {
  const provider = parseProvider(c.req.param("provider"));
  if (!provider) return c.notFound();
  const { t } = i18nFromContext(c);
  const label = PROVIDER_LABEL[provider];

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
    const description = c.req.query("error_description") ?? providerError;
    return message(c, 400, t.messages.providerRefused(label), description);
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
    console.error(`${provider} token exchange failed`, error);
    return message(c, 502, t.messages.signInFailed, t.messages.exchangeFailed(label));
  }

  if (stored.purpose === "sign-in") {
    const user = await signInUser(c.env, identity);
    if (!user) {
      // No user exists for a refused identity; the log keeps the reason, not the address.
      await recordAudit(c.env.DB, {
        orgId: DEFAULT_ORG_ID,
        kind: "sign_in_refused",
        detail: { reason: "policy" },
      });
      return message(c, 403, t.messages.notAllowed, t.messages.notAllowedToSignIn(identity.email));
    }
    const session = await signSession(
      { userId: user.id, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
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
  // The WHERE clause keeps an account that belongs to another user untouched; RETURNING is then empty.
  const account = await c.env.DB.prepare(
    `INSERT INTO accounts (id, user_id, provider, email, tenant_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (provider, email) DO UPDATE SET tenant_id = excluded.tenant_id
       WHERE accounts.user_id = excluded.user_id
     RETURNING id`,
  )
    .bind(crypto.randomUUID(), user.id, provider, identity.email, identity.tenantId)
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
