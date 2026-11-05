import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { fromJSONSchema, type z } from "zod";
import * as zm from "zod/mini";
import {
  createApiToken,
  DAILY_TOOL_CALLS,
  DEPLOYMENT_DAILY_CALLS,
  DEPLOYMENT_DAILY_ROWS,
  RESERVED_ROWS,
  reserveToolCall,
  USER_DAILY_ROWS,
  settleToolCall,
} from "../src/api-tokens";
import { accountsAnswer, rulesAnswer, statusAnswer } from "../src/read-model";
import worker from "../src/index";
import { addAccount, BASE, signIn } from "./helpers";

const MODERN = "2026-07-28";

type Headers = Record<string, string>;

function post(body: unknown, headers: Headers = {}): Promise<Response> {
  return exports.default.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A POST to /mcp against a changed environment, for failures the shared bindings cannot show. */
async function postWith(overrides: Partial<Env>, body: unknown, headers: Headers = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function bearer(token: string): Headers {
  return { authorization: `Bearer ${token}` };
}

/** A request of a client that speaks 2025-11-25: no `_meta`, no method headers. */
function legacy(token: string, method: string, params: object = {}): Promise<Response> {
  return post(
    { jsonrpc: "2.0", id: 1, method, params },
    { ...bearer(token), "mcp-protocol-version": "2025-11-25" },
  );
}

/** A request of a client that speaks 2026-07-28, with `_meta` and the required headers. */
function modern(token: string, method: string, params: object = {}): Promise<Response> {
  const name = (params as { name?: string }).name;
  return post(
    {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    {
      ...bearer(token),
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
    },
  );
}

/**
 * The served form of a JSON Schema: a `type` list becomes `anyOf`, one type per branch. Some
 * clients map tool schemas onto a dialect with a single `type`, and drop or refuse a list.
 * `src/mcp-output-schemas.json` holds this form of the read-model shapes.
 */
function portable(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(portable);
  if (typeof schema !== "object" || schema === null) return schema;
  const entries = Object.entries(schema).map(([key, value]) => [key, portable(value)] as const);
  const node: Record<string, unknown> = Object.fromEntries(entries);
  if (Array.isArray(node.type)) {
    const { type, ...rest } = node;
    return { ...rest, anyOf: (type as string[]).map((one) => ({ type: one })) };
  }
  return node;
}

interface RpcBody {
  result?: Record<string, unknown> & {
    structuredContent?: Record<string, unknown>;
    content?: { type: string; text: string }[];
  };
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

const rpcBody = async (response: Response) => (await response.json()) as RpcBody;

async function call(token: string, name: string, args: object = {}) {
  const response = await modern(token, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  const body = await rpcBody(response);
  return body.result?.structuredContent as Record<string, unknown>;
}

async function tokenFor(email: string): Promise<{ token: string; userId: string; cookie: string }> {
  const { user, cookie } = await signIn(email);
  const created = await createApiToken(env, user, { name: "test", days: 30 });
  if (!created) throw new Error("no token");
  return { token: created.token, userId: user.id, cookie };
}

/** Two accounts, a calendar in each, and one rule from `a` to `b`. Returns the rule's ID. */
async function seedRule(userId: string, prefix: string, options = "{}", enabled = 1) {
  await addAccount(userId, `${prefix}-a`, `${prefix}-a@example.com`);
  await addAccount(userId, `${prefix}-b`, `${prefix}-b@example.com`);
  const rule = `${prefix}-rule`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO calendars (id, account_id, remote_id, name)
       VALUES (?1 || '-ca', ?1 || '-a', 'remote-secret-a', 'Work'),
              (?1 || '-cb', ?1 || '-b', 'remote-secret-b', 'Home')`,
    ).bind(prefix),
    env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options, enabled)
       VALUES (?, ?, ? || '-ca', ? || '-cb', ?, ?)`,
    ).bind(rule, userId, prefix, prefix, options, enabled),
  ]);
  return rule;
}

async function addRun(
  userId: string,
  ruleId: string,
  kind: string,
  detail: object,
  createdAt: string,
) {
  await env.DB.prepare(
    `INSERT INTO audit_events (org_id, user_id, account_id, rule_id, kind, detail, created_at)
     VALUES ('default', ?, NULL, ?, ?, ?, ?)`,
  )
    .bind(userId, ruleId, kind, JSON.stringify(detail), createdAt)
    .run();
}

async function statusOf(token: string, ruleId: string) {
  const { rules } = (await call(token, "get_sync_status")) as {
    rules: ({ ruleId: string } & Record<string, unknown>)[];
  };
  return rules.find((rule) => rule.ruleId === ruleId);
}

// Tests of a file share one database, and each test expects its users without tokens and rules.
beforeEach(async () => {
  await env.DB.batch(
    ["api_tokens", "api_usage", "api_usage_total", "rules", "accounts", "audit_events"].map(
      (table) => env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

describe("access to /mcp", () => {
  it("answers 404 for every method while MCP_ENABLED is off", async () => {
    const { token } = await tokenFor("owner@example.com");
    for (const method of ["GET", "POST"]) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${BASE}/mcp`, { method, headers: bearer(token) }),
        { ...env, MCP_ENABLED: "" },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(404);
    }
  });

  it("refuses a request without a token, and points to Bearer", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("names an invalid token as such, as RFC 6750 asks", async () => {
    const response = await legacy(`sm_pat_${"b".repeat(43)}`, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  });

  it("refuses a session cookie without a token", async () => {
    const { cookie } = await signIn("owner@example.com");
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { cookie });
    expect(response.status).toBe(401);
  });

  it("refuses a token in the query string", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await exports.default.fetch(`${BASE}/mcp?access_token=${token}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuses an unknown token", async () => {
    const response = await legacy(`sm_pat_${"a".repeat(43)}`, "tools/list");
    expect(response.status).toBe(401);
  });

  it("refuses a foreign Origin before it looks at the token", async () => {
    const { token } = await tokenFor("owner@example.com");
    const request = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const withToken = await post(request, { ...bearer(token), origin: "https://evil.example" });
    expect(withToken.status).toBe(403);
    // Without a token the order shows: a check of the token first would answer 401.
    const without = await post(request, { origin: "https://evil.example" });
    expect(without.status).toBe(403);
  });

  it("answers 404 for MCP_ENABLED=0 as for an unset variable", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await postWith(
      { MCP_ENABLED: "0" },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      bearer(token),
    );
    expect(response.status).toBe(404);
  });

  it("answers 503 with JSON-RPC while the deployment's setup is unfinished", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await postWith(
      { SESSION_SECRET: "short" },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      bearer(token),
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as RpcBody).error?.code).toBe(-32000);
  });

  it("answers a tool error without the cause if a tool's query fails", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await seedRule(userId, "throws");
    const failing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM rules r")) throw new Error("D1_ERROR: secret detail");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, key);
      },
    });
    const response = await postWith(
      { DB: failing },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_rules", arguments: {} },
      },
      { ...bearer(token), "mcp-protocol-version": "2025-11-25" },
    );
    expect(response.status).toBe(200);
    const body = await rpcBody(response);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe("The tool failed. Try again later.");
    expect(body.result).not.toHaveProperty("structuredContent");
    expect(JSON.stringify(body)).not.toContain("secret detail");
  });

  it("takes only the Origin of PUBLIC_URL once it is set, not one the Host header names", async () => {
    const { token } = await tokenFor("owner@example.com");
    const request = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const rebound = await postWith({ PUBLIC_URL: "https://sync.example.com" }, request, {
      ...bearer(token),
      origin: BASE,
    });
    expect(rebound.status).toBe(403);
    const own = await postWith({ PUBLIC_URL: "https://sync.example.com" }, request, {
      ...bearer(token),
      origin: "https://sync.example.com",
    });
    expect(own.status).toBe(200);
  });

  it("stops reading an endless body when the database fails before the size check", async () => {
    const { token } = await tokenFor("owner@example.com");
    const failing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return () => {
            throw new Error("D1_ERROR: daily limit");
          };
        }
        return Reflect.get(target, key);
      },
    });
    const chunk = new TextEncoder().encode(" ".repeat(16 * 1024));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: endless,
      }),
      { ...env, DB: failing },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(500);
    expect(((await response.json()) as RpcBody).error?.code).toBe(-32603);
  }, 10_000);

  it("answers a JSON-RPC error, not an HTML page, if the database fails", async () => {
    const { token } = await tokenFor("owner@example.com");
    const failing = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return () => {
            throw new Error("D1_ERROR: daily limit");
          };
        }
        return Reflect.get(target, key);
      },
    });
    const response = await postWith(
      { DB: failing },
      { jsonrpc: "2.0", id: 9, method: "tools/list" },
      bearer(token),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as RpcBody & { id?: number };
    expect(body.error?.code).toBe(-32603);
    expect(body.id).toBe(9);
    expect(JSON.stringify(body)).not.toContain("D1_ERROR");
  });

  it("takes the deployment's own Origin", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { ...bearer(token), origin: BASE },
    );
    expect(response.status).toBe(200);
  });

  it("answers 405 to GET and DELETE with a valid token", async () => {
    const { token } = await tokenFor("owner@example.com");
    for (const method of ["GET", "DELETE"]) {
      const response = await exports.default.fetch(`${BASE}/mcp`, {
        method,
        headers: bearer(token),
      });
      expect(response.status).toBe(405);
    }
  });

  it("refuses a body over the limit", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await post("x".repeat(70_000), bearer(token));
    expect(response.status).toBe(413);
  });

  it("answers 404 below /mcp without reading a session", async () => {
    const { token, cookie } = await tokenFor("owner@example.com");
    const response = await exports.default.fetch(`${BASE}/mcp/other`, {
      method: "POST",
      headers: { ...bearer(token), cookie },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("forbids caching and keeps the security headers", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await legacy(token, "tools/list");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets no language cookie", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await legacy(token, "tools/list");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("protocol", () => {
  it("answers a legacy initialize with the client's version and the tools capability", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
      },
      bearer(token),
    );
    const body = (await response.json()) as RpcBody & { id: number };
    expect(body.id).toBe(7);
    expect(body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "slotmirror" },
    });
  });

  it("offers the newest legacy version to a client that asks for an unknown one", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await legacy(token, "initialize", {
      protocolVersion: "2099-01-01",
      capabilities: {},
      clientInfo: { name: "t" },
    });
    expect((await rpcBody(response)).result?.protocolVersion).toBe("2025-11-25");
  });

  it("does not offer 2025-03-26, whose servers must take batches", async () => {
    const { token } = await tokenFor("owner@example.com");
    const init = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t" } },
      },
      bearer(token),
    );
    expect((await rpcBody(init)).result?.protocolVersion).toBe("2025-11-25");
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { ...bearer(token), "mcp-protocol-version": "2025-03-26" },
    );
    expect(response.status).toBe(400);
    expect((await rpcBody(response)).error?.code).toBe(-32022);
  });

  it("accepts the initialized notification with 202 and no body", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      bearer(token),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("answers ping for legacy clients", async () => {
    const { token } = await tokenFor("owner@example.com");
    expect((await rpcBody(await legacy(token, "ping"))).result).toEqual({});
  });

  it("describes itself through server/discover", async () => {
    const { token } = await tokenFor("owner@example.com");
    const { result } = await rpcBody(await modern(token, "server/discover"));
    expect(result).toMatchObject({
      resultType: "complete",
      supportedVersions: expect.arrayContaining([MODERN, "2025-11-25"]),
      capabilities: { tools: {} },
      // Private: the instructions follow Accept-Language, so a shared cache must not reuse them.
      cacheScope: "private",
    });
    expect(typeof result?.ttlMs).toBe("number");
    expect(result?._meta).toMatchObject({
      "io.modelcontextprotocol/serverInfo": { name: "slotmirror" },
    });
  });

  it("lists read-only tools in a fixed order, with cache fields for modern clients", async () => {
    const { token } = await tokenFor("owner@example.com");
    const { result } = await rpcBody(await modern(token, "tools/list"));
    const tools = result?.tools as {
      name: string;
      title: string;
      description: string;
      outputSchema: { type: string };
      annotations: Record<string, boolean>;
    }[];
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_accounts",
      "list_rules",
      "get_sync_status",
    ]);
    for (const tool of tools) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.title).not.toBe(tool.name);
      expect(tool.outputSchema.type).toBe("object");
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    expect(result).toMatchObject({ resultType: "complete", cacheScope: "private" });
  });

  it("publishes output schemas that equal the answer shapes of the read model", async () => {
    const { token } = await tokenFor("owner@example.com");
    const { result } = await rpcBody(await modern(token, "tools/list"));
    const tools = result?.tools as { name: string; outputSchema: unknown }[];
    const served = Object.fromEntries(tools.map((tool) => [tool.name, tool.outputSchema]));
    expect(served).toEqual({
      list_accounts: portable(zm.toJSONSchema(accountsAnswer, { io: "output" })),
      list_rules: portable(zm.toJSONSchema(rulesAnswer, { io: "output" })),
      get_sync_status: portable(zm.toJSONSchema(statusAnswer, { io: "output" })),
    });
    // Control: no `type` list is left, so clients with a single-type dialect read every field.
    expect(JSON.stringify(served)).not.toMatch(/"type":\[/);
    expect(JSON.stringify(served)).toContain('"anyOf"');
  });

  it("answers each tool with content that its output schema admits, and nothing more", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const clean = await seedRule(userId, "schema", '{"skipCategories":["x"]}');
    const failed = await seedRule(userId, "schema2");
    await addRun(
      userId,
      clean,
      "sync_run",
      { create: 1, update: 0, delete: 0, unchanged: 2, failed: 1, remaining: 3 },
      "2036-01-01T00:00:00.000Z",
    );
    await addRun(userId, failed, "sync_failed", { code: "503" }, "2036-01-01T00:00:00.000Z");
    await seedRule(userId, "schema3");
    await env.DB.prepare("UPDATE rules SET options = '{broken' WHERE id = 'schema3-rule'").run();

    const { result } = await rpcBody(await modern(token, "tools/list"));
    const tools = result?.tools as { name: string; outputSchema: z.core.JSONSchema.BaseSchema }[];
    for (const tool of tools) {
      const schema = fromJSONSchema(tool.outputSchema);
      const content = await call(token, tool.name);
      expect(schema.safeParse(content).error).toBeUndefined();
      // Control: the schema refuses a field that is not part of it, at the top and inside a list.
      expect(schema.safeParse({ ...content, tenantId: "t" }).success).toBe(false);
      const [key, list] = Object.entries(content).find(([, value]) => Array.isArray(value)) as [
        string,
        object[],
      ];
      expect(list.length).toBeGreaterThan(0);
      const widened = { ...content, [key]: [{ ...list[0], remoteId: "r" }, ...list.slice(1)] };
      expect(schema.safeParse(widened).success).toBe(false);
    }
  });

  it("gives tool descriptions in the language of Accept-Language", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { ...bearer(token), "accept-language": "de-AT,de;q=0.9" },
    );
    const german = (await rpcBody(response)).result?.tools as { description: string }[];
    const english = (await rpcBody(await legacy(token, "tools/list"))).result?.tools as {
      description: string;
    }[];
    expect(german[0]?.description).not.toBe(english[0]?.description);
  });

  it("omits the modern fields for legacy clients", async () => {
    const { token } = await tokenFor("owner@example.com");
    const { result } = await rpcBody(await legacy(token, "tools/list"));
    expect(result).not.toHaveProperty("resultType");
    expect(result).not.toHaveProperty("ttlMs");
  });

  it("refuses a modern request whose headers differ from its body", async () => {
    const { token } = await tokenFor("owner@example.com");
    const meta = {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const request = (headers: Headers) =>
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_rules", arguments: {}, _meta: meta },
        },
        { ...bearer(token), "mcp-protocol-version": MODERN, ...headers },
      );
    const wrong: Headers[] = [
      { "mcp-method": "tools/list", "mcp-name": "list_rules" },
      { "mcp-method": "tools/call", "mcp-name": "list_accounts" },
      { "mcp-method": "tools/call" },
      { "mcp-name": "list_rules" },
    ];
    for (const headers of wrong) {
      const response = await request(headers);
      expect(response.status).toBe(400);
      expect((await rpcBody(response)).error?.code).toBe(-32020);
    }
  });

  it("decodes a Base64 Mcp-Name before it compares", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_rules",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      {
        ...bearer(token),
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/call",
        "mcp-name": `=?base64?${btoa("list_rules")}?=`,
      },
    );
    expect(response.status).toBe(200);
  });

  it("names the supported versions for an unknown modern version", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } },
      },
      { ...bearer(token), "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
    );
    expect(response.status).toBe(400);
    const { error } = await rpcBody(response);
    expect(error?.code).toBe(-32022);
    expect(error?.data).toMatchObject({ requested: "2099-01-01" });
    expect(error?.data?.supported).toContain(MODERN);
  });

  it("echoes only a string as the requested version", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": 5 } },
      },
      { ...bearer(token), "mcp-protocol-version": "5", "mcp-method": "tools/list" },
    );
    expect(response.status).toBe(400);
    expect((await rpcBody(response)).error?.data).not.toHaveProperty("requested");
  });

  it("refuses an unknown version in the header of a legacy request", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { ...bearer(token), "mcp-protocol-version": "2099-01-01" },
    );
    expect(response.status).toBe(400);
  });

  it("answers an unknown method with -32601: 404 for modern, 200 for legacy", async () => {
    const { token } = await tokenFor("owner@example.com");
    const modernResponse = await modern(token, "resources/list");
    expect(modernResponse.status).toBe(404);
    expect((await rpcBody(modernResponse)).error?.code).toBe(-32601);
    const legacyResponse = await legacy(token, "resources/list");
    expect(legacyResponse.status).toBe(200);
    expect((await rpcBody(legacyResponse)).error?.code).toBe(-32601);
  });

  it("answers malformed JSON with -32700 and a batch with -32600", async () => {
    const { token } = await tokenFor("owner@example.com");
    const malformed = await post("{nope", bearer(token));
    expect(malformed.status).toBe(400);
    expect((await rpcBody(malformed)).error?.code).toBe(-32700);
    const batch = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }], bearer(token));
    expect(batch.status).toBe(400);
    expect((await rpcBody(batch)).error?.code).toBe(-32600);
  });

  it("keeps the ID of a request it refuses as invalid", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await post({ jsonrpc: "1.0", id: 5, method: "tools/list" }, bearer(token));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { id?: number }).id).toBe(5);
  });

  it("treats a list as arguments, as it treats any other argument", async () => {
    const { token } = await tokenFor("owner@example.com");
    const response = await legacy(token, "tools/call", { name: "list_rules", arguments: [] });
    expect((await rpcBody(response)).result?.isError).toBe(true);
  });

  it("refuses an unknown tool with -32602", async () => {
    const { token } = await tokenFor("owner@example.com");
    const unknown = await legacy(token, "tools/call", { name: "delete_event", arguments: {} });
    expect((await rpcBody(unknown)).error?.code).toBe(-32602);
  });

  it("answers unexpected arguments with a tool error the model can read, and no data", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await seedRule(userId, "args");
    const response = await legacy(token, "tools/call", {
      name: "list_rules",
      arguments: { userId: "someone" },
    });
    expect(response.status).toBe(200);
    const body = await rpcBody(response);
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/argument/i);
    expect(body.result).not.toHaveProperty("structuredContent");
    expect(JSON.stringify(body)).not.toContain("args-rule");
  });

  it("returns the data as text too, for clients without structured content", async () => {
    const { token } = await tokenFor("owner@example.com");
    const { result } = await rpcBody(
      await legacy(token, "tools/call", { name: "list_accounts", arguments: {} }),
    );
    expect(JSON.parse(result?.content?.[0]?.text ?? "null")).toEqual(result?.structuredContent);
  });
});

describe("tools", () => {
  it("shows a token only the data of its own user, also for an admin", async () => {
    const admin = await tokenFor("admin@example.com");
    const other = await tokenFor("other@elsewhere.org");
    await seedRule(admin.userId, "adm");
    await seedRule(other.userId, "oth");
    await addRun(
      other.userId,
      "oth-rule",
      "sync_run",
      { unchanged: 1 },
      "2036-01-01T00:00:00.000Z",
    );

    const seen = JSON.stringify([
      await call(admin.token, "list_accounts"),
      await call(admin.token, "list_rules"),
      await call(admin.token, "get_sync_status"),
    ]);
    expect(seen).toContain("adm-a@example.com");
    expect(seen).not.toContain("oth-");
  });

  it("lists accounts without tenant and remote IDs", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await seedRule(userId, "acc");
    await env.DB.prepare(
      "UPDATE accounts SET tenant_id = 'tenant-secret', needs_reconnect = 1 WHERE id = 'acc-a'",
    ).run();
    const { accounts } = (await call(token, "list_accounts")) as {
      accounts: Record<string, unknown>[];
    };
    expect(accounts.find((account) => account.id === "acc-a")).toEqual({
      id: "acc-a",
      provider: "microsoft",
      email: "acc-a@example.com",
      name: "acc-a@example.com",
      needsReconnect: true,
      calendars: 1,
    });
    expect(JSON.stringify(accounts)).not.toMatch(/tenant-secret|remote-secret/);
  });

  it("lists rules without the options' free text", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const options = JSON.stringify({
      blockTitle: "Doctor visit",
      skipCategories: ["Therapy"],
      onlyCategories: ["Clients"],
      blockColor: "Secret colour",
      bufferBefore: 15,
      workStart: "09:00",
      workEnd: "17:00",
      workTimeZone: "Europe/Vienna",
    });
    const ruleId = await seedRule(userId, "opt", options);
    const data = await call(token, "list_rules");
    const rule = (data.rules as Record<string, unknown>[]).find((row) => row.id === ruleId);
    expect(rule).toEqual({
      id: ruleId,
      source: { accountId: "opt-a", calendar: "Work" },
      target: { accountId: "opt-b", calendar: "Home" },
      enabled: true,
      detailLevel: "busy",
      daysAhead: 90,
      bufferBefore: 15,
      bufferAfter: 0,
      filters: { categories: true, workingHours: true },
    });
    expect(JSON.stringify(data)).not.toMatch(
      /Doctor|Therapy|Clients|Secret colour|Vienna|remote-secret/,
    );
  });

  it("reports the level a cap lowers the rule to, not the stored one", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    // MAX_DETAIL_FROM_EXTERNAL is "busy" in the test bindings; the target belongs to the org.
    await addAccount(userId, "cap-a", "cap-a@elsewhere.test");
    await addAccount(userId, "cap-b", "cap-b@org.example");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO calendars (id, account_id, remote_id, name)
         VALUES ('cap-ca', 'cap-a', 'r1', 'A'), ('cap-cb', 'cap-b', 'r2', 'B')`,
      ),
      env.DB.prepare(
        `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id, options)
         VALUES ('cap-rule', ?, 'cap-ca', 'cap-cb', '{"detailLevel":"full"}')`,
      ).bind(userId),
    ]);
    const { rules } = (await call(token, "list_rules")) as {
      rules: { id: string; detailLevel: string }[];
    };
    expect(rules.find((rule) => rule.id === "cap-rule")?.detailLevel).toBe("busy");
  });

  it("reads a broken stored rule as unknown instead of failing the whole list", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "bad", '{"workDays":"never"}');
    const { rules } = (await call(token, "list_rules")) as {
      rules: { id: string; detailLevel: string | null; filters: unknown }[];
    };
    expect(rules.find((rule) => rule.id === ruleId)).toMatchObject({
      detailLevel: null,
      filters: null,
    });
  });

  it("counts the blocks of a clean run", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "ok");
    await addRun(
      userId,
      ruleId,
      "sync_run",
      { dryRun: false, create: 2, update: 3, delete: 4, unchanged: 10, failed: 0, remaining: 0 },
      "2036-01-01T00:00:00.000Z",
    );
    expect(await statusOf(token, ruleId)).toEqual({
      ruleId,
      enabled: true,
      state: "ok",
      at: "2036-01-01T00:00:00.000Z",
      changes: { create: 2, update: 3, delete: 4, unchanged: 10 },
      blocks: 15,
      blocksExact: true,
      blocksAt: "2036-01-01T00:00:00.000Z",
    });
  });

  it("marks the count as inexact if work stayed open", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "open");
    await addRun(
      userId,
      ruleId,
      "sync_run",
      { create: 2, unchanged: 1, failed: 0, remaining: 2 },
      "2036-01-01T00:00:00.000Z",
    );
    expect(await statusOf(token, ruleId)).toMatchObject({
      state: "partial",
      remaining: 2,
      blocks: 3,
      blocksExact: false,
    });
  });

  it("keeps the last count after a failed run, with its own time", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "fail");
    await addRun(userId, ruleId, "sync_run", { unchanged: 5 }, "2036-01-01T00:00:00.000Z");
    await addRun(
      userId,
      ruleId,
      "sync_failed",
      { code: "503", message: "Team sync with Alice" },
      "2036-01-02T00:00:00.000Z",
    );
    const status = await statusOf(token, ruleId);
    expect(status).toMatchObject({
      state: "error",
      at: "2036-01-02T00:00:00.000Z",
      code: "503",
      blocks: 5,
      blocksExact: false,
      blocksAt: "2036-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(status)).not.toContain("Alice");
  });

  it("ignores dry runs", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "dry");
    await addRun(userId, ruleId, "sync_run", { unchanged: 5 }, "2036-01-01T00:00:00.000Z");
    await addRun(
      userId,
      ruleId,
      "sync_run",
      { dryRun: true, create: 100 },
      "2036-01-02T00:00:00.000Z",
    );
    expect(await statusOf(token, ruleId)).toMatchObject({ blocks: 5 });
  });

  it("shows a turned-off rule as paused, whatever its last run says", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "off", "{}", 0);
    await addRun(userId, ruleId, "sync_failed", { code: "503" }, "2036-01-01T00:00:00.000Z");
    expect(await statusOf(token, ruleId)).toMatchObject({ state: "paused", enabled: false });
  });

  it("shows a rule as stalled if one of its accounts needs reconnecting, after a clean run", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    for (const side of ["a", "b"]) {
      const prefix = `stall${side}`;
      const ruleId = await seedRule(userId, prefix);
      await addRun(userId, ruleId, "sync_run", { unchanged: 3 }, "2036-01-01T00:00:00.000Z");
      expect(await statusOf(token, ruleId)).toMatchObject({ state: "ok", blocksExact: true });
      await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = ?")
        .bind(`${prefix}-${side}`)
        .run();
      expect(await statusOf(token, ruleId)).toMatchObject({
        state: "reconnect",
        blocks: 3,
        blocksExact: false,
      });
    }
  });

  it("shows a rule whose last run was aborted as an error, after a clean run", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "abort");
    await addRun(userId, ruleId, "sync_run", { unchanged: 4 }, "2036-01-01T00:00:00.000Z");
    await addRun(
      userId,
      ruleId,
      "sync_run_aborted",
      { runId: "r", startedAt: "2036-01-02T00:00:00.000Z" },
      "2036-01-02T00:00:01.000Z",
    );
    expect(await statusOf(token, ruleId)).toMatchObject({
      state: "error",
      code: "aborted",
      at: "2036-01-02T00:00:01.000Z",
      blocks: 4,
      blocksExact: false,
    });
  });

  it("shows a turned-off rule as paused even if an account needs reconnecting", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "offstall", "{}", 0);
    await env.DB.prepare("UPDATE accounts SET needs_reconnect = 1 WHERE id = 'offstall-a'").run();
    expect(await statusOf(token, ruleId)).toMatchObject({ state: "paused" });
  });

  it("shows a rule as stale once its last run is older than the alert window", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const old = await seedRule(userId, "old");
    const fresh = await seedRule(userId, "fresh");
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    await addRun(userId, old, "sync_run", { unchanged: 2 }, hoursAgo(4));
    await addRun(userId, fresh, "sync_run", { unchanged: 2 }, hoursAgo(1));
    expect(await statusOf(token, old)).toMatchObject({
      state: "stale",
      blocks: 2,
      blocksExact: false,
    });
    expect(await statusOf(token, fresh)).toMatchObject({ state: "ok", blocksExact: true });
  });

  it("keeps an old failure an error, not stale", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "oldfail");
    const at = new Date(Date.now() - 5 * 3_600_000).toISOString();
    await addRun(userId, ruleId, "sync_failed", { code: "503" }, at);
    expect(await statusOf(token, ruleId)).toMatchObject({ state: "error", code: "503" });
  });

  it("shows a rule without a run in reach as unknown, never as ok", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "none");
    expect(await statusOf(token, ruleId)).toEqual({
      ruleId,
      enabled: true,
      state: "unknown",
      at: null,
      blocks: null,
      blocksExact: false,
      blocksAt: null,
    });
  });

  it("reads a bounded number of rows with 13,000 audit rows", async () => {
    const { userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "many");
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 13000)
       INSERT INTO audit_events (org_id, user_id, rule_id, kind, detail, created_at)
       SELECT 'default', ?, ?, 'sync_run', '{"unchanged":1}',
              strftime('%Y-%m-%dT%H:%M:%fZ', '2036-01-01', '-' || i || ' minutes')
       FROM n`,
    )
      .bind(userId, ruleId)
      .run();

    const { readSyncStatus } = await import("../src/read-model");
    let rowsRead = 0;
    const counting = new Proxy(env.DB, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key);
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(inner, method) {
              if (method === "bind") {
                return (...values: unknown[]) => {
                  const bound = inner.bind(...values);
                  return {
                    all: async () => {
                      const result = await bound.all();
                      rowsRead += result.meta.rows_read;
                      return result;
                    },
                  };
                };
              }
              return Reflect.get(inner, method);
            },
          });
        };
      },
    });
    const status = await readSyncStatus(counting, userId);
    expect(status.rules[0]).toMatchObject({ state: "ok", blocks: 1 });
    expect(rowsRead).toBeGreaterThan(0);
    expect(rowsRead).toBeLessThan(400);
  });
});

describe("cost of a status call", () => {
  /** Rows that `readSyncStatus` reads, with a database that counts them. */
  async function rowsReadBy(userId: string) {
    const { readSyncStatus } = await import("../src/read-model");
    let rowsRead = 0;
    const counting = new Proxy(env.DB, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key);
        return (sql: string) => ({
          bind: (...values: unknown[]) => ({
            all: async () => {
              const result = await target
                .prepare(sql)
                .bind(...values)
                .all();
              rowsRead += result.meta.rows_read;
              return result;
            },
          }),
        });
      },
    });
    const status = await readSyncStatus(counting, userId);
    return { rowsRead, status };
  }

  it("stops at the row limit if other audit rows fill the log", async () => {
    const { userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "noise");
    await addRun(userId, ruleId, "sync_run", { unchanged: 1 }, "2030-01-01T00:00:00.000Z");
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 13000)
       INSERT INTO audit_events (org_id, user_id, kind, detail, created_at)
       SELECT 'default', ?, 'rule_updated', '{}',
              strftime('%Y-%m-%dT%H:%M:%fZ', '2036-01-01', '-' || i || ' minutes')
       FROM n`,
    )
      .bind(userId)
      .run();
    const { rowsRead, status } = await rowsReadBy(userId);
    expect(rowsRead).toBeGreaterThan(0);
    expect(rowsRead).toBeLessThan(400);
    expect(status.rules[0]).toMatchObject({ state: "unknown", blocks: null });
  });

  it("caps the rules that one answer lists, and says so", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await seedRule(userId, "cap");
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
       INSERT INTO calendars (id, account_id, remote_id, name)
       SELECT 'many-' || i, 'cap-a', 'r' || i, 'C' FROM n`,
    ).run();
    // Reverse insert order against the IDs, so that a sort by ID and the insert order differ.
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id)
       SELECT 'rule-' || id, ?, id, 'cap-cb' FROM calendars WHERE id GLOB 'many-*'
       ORDER BY id DESC`,
    )
      .bind(userId)
      .run();
    const listed = await call(token, "list_rules");
    expect((listed.rules as unknown[]).length).toBe(200);
    expect(listed.truncated).toBe(true);
    const status = await call(token, "get_sync_status");
    expect((status.rules as unknown[]).length).toBe(200);
    expect(status.truncated).toBe(true);
    // Both tools name the same 200 rules, so an agent can join their answers.
    const ids = (listed.rules as { id: string }[]).map((rule) => rule.id).sort();
    const statusIds = (status.rules as { ruleId: string }[]).map((rule) => rule.ruleId).sort();
    expect(statusIds).toEqual(ids);
  });

  it("caps the accounts that one answer lists, and says so", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
       INSERT INTO accounts (id, user_id, provider, email)
       SELECT 'acc-' || i, ?, 'google', 'a' || i || '@example.com' FROM n`,
    )
      .bind(userId)
      .run();
    const listed = await call(token, "list_accounts");
    expect((listed.accounts as unknown[]).length).toBe(100);
    expect(listed.truncated).toBe(true);
  });

  it("does not report a short list as cut", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await seedRule(userId, "short");
    expect((await call(token, "list_rules")).truncated).toBe(false);
  });
});

describe("daily limit", () => {
  const today = () => new Date().toISOString().slice(0, 10);

  it("allows the last call below the limit, then refuses the next", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await env.DB.prepare("INSERT INTO api_usage (user_id, day, calls) VALUES (?, ?, ?)")
      .bind(userId, today(), DAILY_TOOL_CALLS - 1)
      .run();
    const last = await modern(token, "tools/call", { name: "list_rules", arguments: {} });
    expect((await rpcBody(last)).result?.isError).toBeUndefined();
    const next = await modern(token, "tools/call", { name: "list_rules", arguments: {} });
    const refused = await rpcBody(next);
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text).toBe(
      "Your daily limit for tool calls is reached. It resets at 00:00 UTC.",
    );
    // The refused call left the deployment's row as the allowed one settled it.
    const total = await env.DB.prepare("SELECT calls FROM api_usage_total WHERE day = ?")
      .bind(today())
      .first<{ calls: number }>();
    expect(total?.calls).toBe(1);
  });

  it("stops one user at a fifth of the deployment's rows, so that others can still call", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await env.DB.prepare(
      "INSERT INTO api_usage (user_id, day, calls, rows_read) VALUES (?, ?, 1, ?)",
    )
      .bind(userId, today(), USER_DAILY_ROWS)
      .run();
    const response = await modern(token, "tools/call", { name: "list_rules", arguments: {} });
    const text = (await rpcBody(response)).result?.content?.[0]?.text ?? "";
    expect(text).toBe("Your daily budget of database rows is used up. It resets at 00:00 UTC.");
    expect(USER_DAILY_ROWS * 5).toBe(DEPLOYMENT_DAILY_ROWS);
  });

  it("counts tool calls and starts again on a new day", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await env.DB.prepare(
      "INSERT INTO api_usage (user_id, day, calls) VALUES (?, '2020-01-01', 999)",
    )
      .bind(userId)
      .run();
    await call(token, "list_accounts");
    const row = await env.DB.prepare("SELECT day, calls FROM api_usage WHERE user_id = ?")
      .bind(userId)
      .first<{ day: string; calls: number }>();
    expect(row).toEqual({ day: today(), calls: 1 });
  });

  it("stops every user once the deployment's calls read their daily rows, and writes nothing", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    // Other users' calls read the deployment's budget, one row short of it.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO api_usage_total (day, calls, rows_read) VALUES (?, ?, ?)",
    )
      .bind(today(), 10, DEPLOYMENT_DAILY_ROWS - 1)
      .run();
    const first = await modern(token, "tools/call", { name: "list_rules", arguments: {} });
    expect((await rpcBody(first)).result?.isError).toBeUndefined();
    const second = await modern(token, "tools/call", { name: "list_rules", arguments: {} });
    expect((await rpcBody(second)).result?.isError).toBe(true);
    const row = await env.DB.prepare("SELECT calls FROM api_usage WHERE user_id = ?")
      .bind(userId)
      .first<{ calls: number }>();
    expect(row?.calls).toBe(1);
    // The refused call left the deployment's row alone too: ten seeded calls and the one allowed.
    const total = await env.DB.prepare("SELECT calls FROM api_usage_total WHERE day = ?")
      .bind(today())
      .first<{ calls: number }>();
    expect(total?.calls).toBe(11);
  });

  it("reserves the rows of a call before it reads, so that a call that dies stays charged", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await seedRule(userId, "reserve");
    let seen = -1;
    const watching = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM rules r")) {
              // The tool's first read: the reservation must already stand.
              return {
                bind: () => ({
                  all: async () => {
                    const row = await target
                      .prepare("SELECT rows_read AS n FROM api_usage WHERE user_id = ?")
                      .bind(userId)
                      .first<{ n: number }>();
                    seen = row?.n ?? 0;
                    throw new Error("the invocation ends here");
                  },
                }),
              };
            }
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, key);
      },
    });
    await postWith(
      { DB: watching },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_rules", arguments: {} },
      },
      { ...bearer(token), "mcp-protocol-version": "2025-11-25" },
    );
    expect(seen).toBeGreaterThanOrEqual(RESERVED_ROWS);
  });

  it("counts a reservation at once: a second check before any read sees it", async () => {
    const first = await signIn("first@org.example");
    const second = await signIn("second@org.example");
    await env.DB.prepare(
      "INSERT OR REPLACE INTO api_usage_total (day, calls, rows_read) VALUES (?, ?, ?)",
    )
      .bind(today(), 1, DEPLOYMENT_DAILY_ROWS - 1)
      .run();
    // Two calls that check before either has read: only the first may pass.
    expect((await reserveToolCall(env.DB, first.user.id)).outcome).toBe("ok");
    expect((await reserveToolCall(env.DB, second.user.id)).outcome).toBe("deployment");
  });

  it("names the deployment's budget, not the user's limit, when the budget stops a call", async () => {
    const { token } = await tokenFor("owner@example.com");
    await env.DB.prepare(
      "INSERT OR REPLACE INTO api_usage_total (day, calls, rows_read) VALUES (?, ?, ?)",
    )
      .bind(today(), 1, DEPLOYMENT_DAILY_ROWS)
      .run();
    const response = await modern(token, "tools/call", { name: "list_rules", arguments: {} });
    const text = (await rpcBody(response)).result?.content?.[0]?.text ?? "";
    expect(text).toContain("deployment");
    expect(text).toContain("00:00 UTC");
  });

  it("stops all users at the deployment's daily calls, which bounds the writes", async () => {
    const { token } = await tokenFor("owner@example.com");
    await env.DB.prepare(
      "INSERT OR REPLACE INTO api_usage_total (day, calls, rows_read) VALUES (?, ?, ?)",
    )
      .bind(today(), DEPLOYMENT_DAILY_CALLS, 0)
      .run();
    const response = await modern(token, "tools/call", { name: "list_rules", arguments: {} });
    expect((await rpcBody(response)).result?.content?.[0]?.text).toContain("deployment");
  });

  it("writes four rows per call: the user's and the deployment's row, reserved and settled", async () => {
    const { token } = await tokenFor("owner@example.com");
    await call(token, "list_accounts");
    let written = 0;
    const counting = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            for (const result of results) written += result.meta.rows_written;
            return results;
          };
        }
        return Reflect.get(target, key);
      },
    });
    await postWith(
      { DB: counting },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_accounts", arguments: {} },
      },
      { ...bearer(token), "mcp-protocol-version": "2025-11-25" },
    );
    expect(written).toBe(4);
  });

  it("settles a call on the day it reserved, also after midnight", async () => {
    const { user } = await signIn("midnight@org.example");
    const before = Date.parse("2036-03-01T23:59:59.900Z");
    const after = Date.parse("2036-03-02T00:00:00.100Z");
    // Call A reserves before midnight, call B after it, then A settles.
    const reservation = await reserveToolCall(env.DB, user.id, before);
    expect(reservation).toEqual({ outcome: "ok", day: "2036-03-01" });
    expect(await reserveToolCall(env.DB, user.id, after)).toEqual({
      outcome: "ok",
      day: "2036-03-02",
    });
    await settleToolCall(env.DB, user.id, "2036-03-01", 7);
    const row = await env.DB.prepare("SELECT day, rows_read AS n FROM api_usage WHERE user_id = ?")
      .bind(user.id)
      .first<{ day: string; n: number }>();
    // The late settlement of day 1 must not touch the user's reservation of day 2.
    expect(row).toEqual({ day: "2036-03-02", n: RESERVED_ROWS });
    const totals = await env.DB.prepare(
      "SELECT day, rows_read AS n FROM api_usage_total WHERE day IN ('2036-03-01', '2036-03-02') ORDER BY day",
    ).all<{ day: string; n: number }>();
    expect(totals.results).toEqual([
      { day: "2036-03-01", n: 7 },
      { day: "2036-03-02", n: RESERVED_ROWS },
    ]);
  });

  it("never moves a user's row back to an earlier day", async () => {
    const { user } = await signIn("late@org.example");
    const before = Date.parse("2036-04-01T23:59:59.950Z");
    const after = Date.parse("2036-04-02T00:00:00.050Z");
    // Call B after midnight reaches D1 first; call A from before midnight arrives late.
    expect((await reserveToolCall(env.DB, user.id, after)).outcome).toBe("ok");
    expect((await reserveToolCall(env.DB, user.id, before)).outcome).toBe("day");
    const row = await env.DB.prepare("SELECT day, calls FROM api_usage WHERE user_id = ?")
      .bind(user.id)
      .first<{ day: string; calls: number }>();
    expect(row).toEqual({ day: "2036-04-02", calls: 1 });
  });

  it("reads a handful of rows to reserve or refuse, however many users called today", async () => {
    const { user } = await signIn("reader@org.example");
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
       INSERT INTO users (id, org_id, email, role)
       SELECT 'many-' || i, 'default', 'many' || i || '@org.example', 'member' FROM n`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO api_usage (user_id, day, calls, rows_read)
       SELECT id, ?, 1, 10 FROM users WHERE id GLOB 'many-*'`,
    )
      .bind(today())
      .run();
    let rowsRead = 0;
    const counting = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            for (const result of results) rowsRead += result.meta.rows_read;
            return results;
          };
        }
        if (key === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(inner, method) {
                if (method !== "bind") return Reflect.get(inner, method);
                return (...values: unknown[]) => {
                  const bound = inner.bind(...values);
                  return new Proxy(bound, {
                    get(b, m) {
                      if (m === "first") {
                        return async () => {
                          const result = await b.all();
                          rowsRead += result.meta.rows_read;
                          return result.results[0] ?? null;
                        };
                      }
                      return Reflect.get(b, m);
                    },
                  });
                };
              },
            });
          };
        }
        return Reflect.get(target, key);
      },
    });
    expect((await reserveToolCall(counting, user.id)).outcome).toBe("ok");
    expect(rowsRead).toBeLessThan(15);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO api_usage_total (day, calls, rows_read) VALUES (?, ?, ?)",
    )
      .bind(today(), 1, DEPLOYMENT_DAILY_ROWS)
      .run();
    rowsRead = 0;
    expect((await reserveToolCall(counting, user.id)).outcome).toBe("deployment");
    expect(rowsRead).toBeLessThan(15);
  });

  it("records the rows a call read, more for a costly call than for a cheap one", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    const ruleId = await seedRule(userId, "rows");
    for (let i = 0; i < 30; i++) {
      await addRun(
        userId,
        ruleId,
        "sync_run",
        { unchanged: 1 },
        `2036-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      );
    }
    const rowsAfter = async () =>
      (
        await env.DB.prepare("SELECT rows_read AS n FROM api_usage WHERE user_id = ?")
          .bind(userId)
          .first<{ n: number }>()
      )?.n ?? 0;
    await call(token, "list_accounts");
    const cheap = await rowsAfter();
    await call(token, "get_sync_status");
    const costly = (await rowsAfter()) - cheap;
    expect(cheap).toBeGreaterThan(0);
    expect(costly).toBeGreaterThan(30);
  });

  it("counts rows of earlier days not toward the deployment's budget", async () => {
    const { token } = await tokenFor("owner@example.com");
    await env.DB.prepare(
      "INSERT OR REPLACE INTO api_usage_total (day, calls, rows_read) VALUES (?, ?, ?)",
    )
      .bind("2020-01-01", DEPLOYMENT_DAILY_CALLS, DEPLOYMENT_DAILY_ROWS)
      .run();
    const response = await modern(token, "tools/call", { name: "list_rules", arguments: {} });
    expect((await rpcBody(response)).result?.isError).toBeUndefined();
  });

  it("does not count tools/list", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await modern(token, "tools/list");
    const row = await env.DB.prepare("SELECT calls FROM api_usage WHERE user_id = ?")
      .bind(userId)
      .first();
    expect(row).toBeNull();
  });

  it("answers a tool error at the limit, names the reset, and writes nothing", async () => {
    const { token, userId } = await tokenFor("owner@example.com");
    await seedRule(userId, "limit");
    await env.DB.prepare("INSERT INTO api_usage (user_id, day, calls) VALUES (?, ?, ?)")
      .bind(userId, today(), DAILY_TOOL_CALLS)
      .run();
    const response = await modern(token, "tools/call", { name: "list_rules", arguments: {} });
    expect(response.status).toBe(200);
    const body = await rpcBody(response);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("00:00 UTC");
    expect(JSON.stringify(body)).not.toContain("limit-rule");
    const row = await env.DB.prepare("SELECT calls FROM api_usage WHERE user_id = ?")
      .bind(userId)
      .first<{ calls: number }>();
    expect(row?.calls).toBe(DAILY_TOOL_CALLS);
  });
});
