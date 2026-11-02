import { Hono, type Context } from "hono";
import {
  createApiToken,
  listApiTokens,
  MAX_TOKEN_NAME_LENGTH,
  revokeApiToken,
  TOKEN_DAYS,
} from "../api-tokens";
import type { AppEnv } from "../app-env";
import { mcpEnabled } from "../config";
import { i18nFromContext } from "../i18n";
import { TokensPage } from "../pages/tokens";
import { render } from "../render";
import type { CurrentUser } from "../users";

/** Personal API tokens. The page exists only while the MCP endpoint is on. */
export const tokens = new Hono<AppEnv>();

tokens.use("*", async (c, next) => {
  if (!mcpEnabled(c.env)) return c.notFound();
  if (!c.get("user")) return c.redirect("/");
  // A new token stands in the answer to the POST. No cache may keep it.
  c.header("Cache-Control", "no-store");
  await next();
});

function currentUser(c: Context<AppEnv>): CurrentUser {
  const user = c.get("user");
  if (!user) throw new Error("token routes require a user");
  return user;
}

function endpoint(c: Context<AppEnv>): string {
  const base = c.env.PUBLIC_URL?.trim().replace(/\/+$/, "") || new URL(c.req.url).origin;
  return `${base}/mcp`;
}

async function renderPage(
  c: Context<AppEnv>,
  extra: { created?: string; problem?: string } = {},
  status: 200 | 400 | 409 = 200,
) {
  const user = currentUser(c);
  return render(
    c,
    <TokensPage
      user={user}
      tokens={await listApiTokens(c.env.DB, user.id)}
      endpoint={endpoint(c)}
      {...extra}
    />,
    status,
  );
}

tokens.get("/", (c) => renderPage(c));

tokens.post("/", async (c) => {
  const { t } = i18nFromContext(c);
  const form = await c.req.parseBody();
  const name = typeof form.name === "string" ? form.name.trim() : "";
  const days = Number(form.days);
  if (
    name === "" ||
    name.length > MAX_TOKEN_NAME_LENGTH ||
    !(TOKEN_DAYS as readonly number[]).includes(days)
  ) {
    return renderPage(c, { problem: t.tokens.invalid }, 400);
  }
  const created = await createApiToken(c.env, currentUser(c), { name, days });
  if (!created) return renderPage(c, { problem: t.tokens.limitReached }, 409);
  return renderPage(c, { created: created.token });
});

tokens.post("/:id/revoke", async (c) => {
  await revokeApiToken(c.env, currentUser(c), c.req.param("id"));
  return c.redirect("/tokens");
});
