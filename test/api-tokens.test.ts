import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  authenticateToken,
  createApiToken,
  listApiTokens,
  MAX_TOKENS_PER_USER,
  revokeApiToken,
  revokeUserTokens,
} from "../src/api-tokens";
import worker from "../src/index";
import { deleteUser } from "../src/offboarding";
import { resetSignInBinding } from "../src/users";
import { BASE, signIn } from "./helpers";

const HEADER = (token: string) => `Bearer ${token}`;

async function newToken(email = "owner@example.com", days = 30) {
  const { user, cookie } = await signIn(email);
  const created = await createApiToken(env, user, { name: "laptop", days });
  if (!created) throw new Error("no token");
  return { user, cookie, token: created.token };
}

function form(fields: Record<string, string>, cookie: string): RequestInit {
  return {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
    },
    body: new URLSearchParams(fields).toString(),
  };
}

// Tests of a file share one database, and each test expects its users without tokens and rules.
beforeEach(async () => {
  await env.DB.batch(
    ["api_tokens", "api_usage", "rules", "accounts", "audit_events"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

describe("api tokens", () => {
  it("stores a hash and the last four characters, never the token", async () => {
    const { token, user } = await newToken();
    expect(token).toMatch(/^sm_pat_[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare("SELECT * FROM api_tokens WHERE user_id = ?")
      .bind(user.id)
      .first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row?.last_four).toBe(token.slice(-4));
  });

  it("admits a valid token as its user", async () => {
    const { token, user } = await newToken();
    expect((await authenticateToken(env, HEADER(token)))?.id).toBe(user.id);
  });

  it("refuses other schemes and malformed values", async () => {
    const { token } = await newToken();
    for (const header of [undefined, "", token, `Basic ${token}`, "Bearer ", "Bearer x"]) {
      expect(await authenticateToken(env, header)).toBeNull();
    }
  });

  it("ends a token at its expiry", async () => {
    const { token } = await newToken();
    const later = Date.now() + 31 * 86_400_000;
    expect(await authenticateToken(env, HEADER(token), later)).toBeNull();
  });

  it("refuses a lifetime over 90 days", async () => {
    const { user } = await signIn("owner@example.com");
    await expect(createApiToken(env, user, { name: "x", days: 91 })).rejects.toThrow();
  });

  it("ends a revoked token, and only for its owner", async () => {
    const { token, user } = await newToken();
    const other = await signIn("other@elsewhere.org");
    const [row] = await listApiTokens(env.DB, user.id);
    expect(await revokeApiToken(env, other.user, row?.id ?? "")).toBe(false);
    expect(await authenticateToken(env, HEADER(token))).not.toBeNull();
    expect(await revokeApiToken(env, user, row?.id ?? "")).toBe(true);
    expect(await authenticateToken(env, HEADER(token))).toBeNull();
  });

  it("audits a revocation only if a token ended", async () => {
    const { user } = await newToken();
    const [row] = await listApiTokens(env.DB, user.id);
    const audited = async () =>
      (
        await env.DB.prepare(
          "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'api_token_revoked'",
        )
          .bind(user.id)
          .all<{ detail: string }>()
      ).results;
    expect(await revokeApiToken(env, user, "a".repeat(16_000))).toBe(false);
    expect(await revokeApiToken(env, user, crypto.randomUUID())).toBe(false);
    expect(await audited()).toEqual([]);
    expect(await revokeApiToken(env, user, row?.id ?? "")).toBe(true);
    expect(await audited()).toHaveLength(1);
  });

  it("creates no token for a session from before a sign-in reset", async () => {
    const { user } = await signIn("owner@example.com");
    await resetSignInBinding(env, user, "admin");
    expect(await createApiToken(env, user, { name: "late", days: 7 })).toBeNull();
    expect(await listApiTokens(env.DB, user.id)).toEqual([]);
  });

  it("refuses a token whose session version is old, if a row stays", async () => {
    const { token, user } = await newToken();
    await env.DB.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?")
      .bind(user.id)
      .run();
    expect(await authenticateToken(env, HEADER(token))).toBeNull();
  });

  it("frees the slots of a user on a sign-in reset", async () => {
    const { user } = await newToken();
    await resetSignInBinding(env, user, "admin");
    expect(await listApiTokens(env.DB, user.id)).toEqual([]);
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'api_token_revoked'",
    )
      .bind(user.id)
      .first<{ detail: string }>();
    expect(JSON.parse(audit?.detail ?? "{}")).toEqual({ count: 1, by: "admin" });
  });

  it("writes no revocation entry for a reset of a user without tokens", async () => {
    const { user } = await signIn("owner@example.com");
    await resetSignInBinding(env, user, "admin");
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND kind = 'api_token_revoked'",
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(0);
  });

  it("stops tokens while the policy does not admit the user", async () => {
    const { token } = await newToken();
    const removed = { ...env, ALLOWED_EMAILS: "other@elsewhere.org" };
    expect(await authenticateToken(removed, HEADER(token))).toBeNull();
  });

  it("ends tokens on a sign-in reset", async () => {
    const { token, user } = await newToken();
    await resetSignInBinding(env, user, "admin");
    expect(await authenticateToken(env, HEADER(token))).toBeNull();
  });

  it("removes tokens and usage with the user", async () => {
    const { token, user } = await newToken();
    await env.DB.prepare("INSERT INTO api_usage (user_id, day, calls) VALUES (?, '2036-01-01', 1)")
      .bind(user.id)
      .run();
    await deleteUser(env, user, "self");
    expect(await authenticateToken(env, HEADER(token))).toBeNull();
    const rows = await env.DB.batch([
      env.DB.prepare("SELECT 1 FROM api_tokens WHERE user_id = ?").bind(user.id),
      env.DB.prepare("SELECT 1 FROM api_usage WHERE user_id = ?").bind(user.id),
    ]);
    expect(rows.flatMap((result) => result.results)).toEqual([]);
  });

  it("allows five active tokens per user and counts no expired ones", async () => {
    const { user } = await signIn("owner@example.com");
    for (let i = 0; i < MAX_TOKENS_PER_USER; i++) {
      expect(await createApiToken(env, user, { name: `t${i}`, days: 7 })).not.toBeNull();
    }
    expect(await createApiToken(env, user, { name: "more", days: 7 })).toBeNull();
    const later = Date.now() + 8 * 86_400_000;
    expect(await createApiToken(env, user, { name: "more", days: 7 }, later)).not.toBeNull();
  });

  it("writes last_used_at at most once per hour", async () => {
    const { token, user } = await newToken();
    const usedAt = async () =>
      (
        await env.DB.prepare("SELECT last_used_at AS at FROM api_tokens WHERE user_id = ?")
          .bind(user.id)
          .first<{ at: string | null }>()
      )?.at;
    const start = Date.parse("2036-01-01T10:00:00.000Z");
    await env.DB.prepare("UPDATE api_tokens SET expires_at = '2037-01-01T00:00:00.000Z'").run();
    await authenticateToken(env, HEADER(token), start);
    const first = await usedAt();
    await authenticateToken(env, HEADER(token), start + 30 * 60_000);
    expect(await usedAt()).toBe(first);
    await authenticateToken(env, HEADER(token), start + 61 * 60_000);
    expect(await usedAt()).not.toBe(first);
  });

  it("writes an audit event without the token", async () => {
    const { token, user } = await newToken();
    const rows = await env.DB.prepare("SELECT kind, detail FROM audit_events WHERE user_id = ?")
      .bind(user.id)
      .all<{ kind: string; detail: string }>();
    const event = rows.results.find((row) => row.kind === "api_token_created");
    expect(event).toBeDefined();
    expect(event?.detail).not.toContain(token);
  });

  it("lets an admin end all tokens of a user", async () => {
    const { token, user } = await newToken();
    await revokeUserTokens(env, user, "admin");
    expect(await authenticateToken(env, HEADER(token))).toBeNull();
  });
});

describe("token page", () => {
  it("answers 404 while MCP_ENABLED is off, and hides the link", async () => {
    const { cookie } = await signIn("owner@example.com");
    const off = { ...env, MCP_ENABLED: "" };
    const fetchOff = async (path: string) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${BASE}${path}`, { headers: { cookie } }),
        off,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };
    expect((await fetchOff("/tokens")).status).toBe(404);
    expect(await (await fetchOff("/activity")).text()).not.toContain('href="/tokens"');
  });

  it("links the page in the navigation while MCP_ENABLED is on", async () => {
    const { cookie } = await signIn("owner@example.com");
    const page = await exports.default.fetch(`${BASE}/activity`, { headers: { cookie } });
    expect(await page.text()).toContain('href="/tokens"');
  });

  it("sends a visitor without a session to the start page", async () => {
    const response = await exports.default.fetch(`${BASE}/tokens`, { redirect: "manual" });
    expect(response.status).toBe(302);
  });

  it("shows a new token once, and only its end afterwards", async () => {
    const { cookie, user } = await signIn("owner@example.com");
    const created = await exports.default.fetch(
      `${BASE}/tokens`,
      form({ name: "laptop", days: "30" }, cookie),
    );
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const html = await created.text();
    const token = /sm_pat_[A-Za-z0-9_-]{43}/.exec(html)?.[0] ?? "";
    expect(await authenticateToken(env, HEADER(token))).not.toBeNull();
    expect(html).toContain(`${BASE}/mcp`);

    const later = await exports.default.fetch(`${BASE}/tokens`, { headers: { cookie } });
    const page = await later.text();
    expect(page).toContain("laptop");
    expect(page).toContain(token.slice(-4));
    expect(page).not.toContain(token);
    expect((await listApiTokens(env.DB, user.id)).length).toBe(1);
  });

  it("refuses a cross-site create", async () => {
    const { cookie, user } = await signIn("owner@example.com");
    const init = form({ name: "x", days: "30" }, cookie);
    const response = await exports.default.fetch(`${BASE}/tokens`, {
      ...init,
      headers: { ...(init.headers as object), origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(await listApiTokens(env.DB, user.id)).toEqual([]);
  });

  it("refuses an empty name and a lifetime outside the choices", async () => {
    const { cookie, user } = await signIn("owner@example.com");
    for (const fields of [
      { name: " ", days: "30" },
      { name: "x", days: "365" },
    ]) {
      const response = await exports.default.fetch(`${BASE}/tokens`, form(fields, cookie));
      expect(response.status).toBe(400);
    }
    expect(await listApiTokens(env.DB, user.id)).toEqual([]);
  });

  it("escapes a token name", async () => {
    const { cookie } = await signIn("owner@example.com");
    await exports.default.fetch(
      `${BASE}/tokens`,
      form({ name: "<script>x</script>", days: "30" }, cookie),
    );
    const html = await (
      await exports.default.fetch(`${BASE}/tokens`, { headers: { cookie } })
    ).text();
    expect(html).not.toContain("<script>x</script>");
  });

  it("revokes through the page", async () => {
    const { token, user, cookie } = await newToken();
    const [row] = await listApiTokens(env.DB, user.id);
    const response = await exports.default.fetch(
      `${BASE}/tokens/${row?.id}/revoke`,
      form({}, cookie),
    );
    expect(response.status).toBe(302);
    expect(await authenticateToken(env, HEADER(token))).toBeNull();
  });

  it("keeps a token valid after sign-out", async () => {
    const { token, cookie } = await newToken();
    await exports.default.fetch(`${BASE}/auth/logout`, form({}, cookie));
    expect(await authenticateToken(env, HEADER(token))).not.toBeNull();
  });
});

describe("admin", () => {
  it("shows the number of tokens and lets an admin end them", async () => {
    const { token, user } = await newToken();
    const admin = await signIn("admin@example.com");
    const page = await exports.default.fetch(`${BASE}/admin`, {
      headers: { cookie: admin.cookie },
    });
    expect(await page.text()).toContain(`/admin/users/${user.id}/revoke-tokens`);
    const response = await exports.default.fetch(
      `${BASE}/admin/users/${user.id}/revoke-tokens`,
      form({}, admin.cookie),
    );
    expect(response.status).toBe(302);
    expect(await authenticateToken(env, HEADER(token))).toBeNull();
    const audit = await env.DB.prepare(
      "SELECT detail FROM audit_events WHERE user_id = ? AND kind = 'api_token_revoked'",
    )
      .bind(user.id)
      .first<{ detail: string }>();
    expect(JSON.parse(audit?.detail ?? "{}")).toEqual({ count: 1, by: "admin" });
  });

  it("refuses a member", async () => {
    const { user, token } = await newToken();
    const member = await signIn("other@elsewhere.org");
    const response = await exports.default.fetch(
      `${BASE}/admin/users/${user.id}/revoke-tokens`,
      form({}, member.cookie),
    );
    expect(response.status).toBe(404);
    expect(await authenticateToken(env, HEADER(token))).not.toBeNull();
  });
});
