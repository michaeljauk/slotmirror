import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as z from "zod/mini";
import { authenticateToken, reserveToolCall, settleToolCall } from "./api-tokens";
import type { AppEnv } from "./app-env";
import { APP_NAME } from "./brand";
import { mcpEnabled, setupStatus } from "./config";
import { countingRows } from "./d1-rows";
import {
  authenticateAccessToken,
  isAccessToken,
  OAUTH_SCOPE,
  oauthIssuer,
  resourceMetadataUrl,
} from "./mcp-oauth";
import { i18nFor, type Messages } from "./i18n";
import outputSchemas from "./mcp-output-schemas.json";
import { readAccounts, readRules, readSyncStatus } from "./read-model";
import { can, permitted } from "./permissions";
import { log } from "./telemetry";
import type { CurrentUser } from "./users";
import { buildVersionLabel } from "./version";

/**
 * Read-only MCP server over Streamable HTTP. Each POST gets one JSON answer: no sessions, no SSE.
 * The protocol is written by hand, as for Graph and Google: the official SDK adds 109 KB gzip to a
 * Worker of 189 KB. It serves both protocol eras, because a request with `_meta` selects 2026-07-28
 * and anything else the `initialize` handshake of older revisions.
 *
 * The route runs before the language and session middleware and never reads a cookie. The user comes
 * only from the bearer token, and no tool takes a user as an argument.
 */

const MODERN_VERSION = "2026-07-28";
// 2025-03-26 is left out: its servers must accept JSON-RPC batches, and this one takes one message.
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18"];
const VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";

const MAX_BODY_BYTES = 64 * 1024;
/** Rows that the token check and the reservation read, about, charged to every call. */
const CHECK_ROWS = 8;
const CACHE_TTL_MS = 3_600_000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const SERVER_ERROR = -32000;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

const messageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.optional(z.union([z.string(), z.number()])),
  method: z.string(),
  params: z.optional(z.record(z.string(), z.unknown())),
});

type RequestId = string | number | undefined;

const SERVER_INFO = () => ({ name: APP_NAME, version: buildVersionLabel() ?? "dev" });

/**
 * `outputSchema` of each tool: JSON Schema 2020-12 of the strict answer shapes in `read-model.ts`.
 * The file is static, because `z.toJSONSchema` adds 10 KB gzip and CPU to every isolate. A test
 * fails if the file and the shapes differ.
 */
const TOOLS = [
  {
    name: "list_accounts",
    action: "mcp:read",
    run: (env: Env, user: CurrentUser) => readAccounts(env.DB, user.id),
  },
  {
    name: "list_rules",
    action: "mcp:read",
    run: (env: Env, user: CurrentUser) => readRules(env, user.id),
  },
  {
    name: "get_sync_status",
    action: "mcp:read",
    run: (env: Env, user: CurrentUser) => readSyncStatus(env.DB, user.id),
  },
] as const;

/** The tools the request's user may see and call. A tool the user may not call does not exist. */
function toolsOf(c: Context<AppEnv>) {
  const user = c.get("user");
  if (!user) throw new Error("the MCP route requires a user");
  return permitted(user, TOOLS);
}

function messages(c: Context<AppEnv>): Messages["mcp"] {
  return i18nFor(/^\s*de\b/i.test(c.req.header("accept-language") ?? "") ? "de" : "en").t.mcp;
}

function rpcError(
  c: Context<AppEnv>,
  status: 200 | 400 | 401 | 403 | 404 | 413 | 500 | 503,
  id: RequestId,
  code: number,
  message: string,
  data?: Record<string, unknown>,
) {
  return c.json(
    {
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      error: { code, message, ...(data ? { data } : {}) },
    },
    status,
  );
}

export const mcp = new Hono<AppEnv>();

/** The request's ID, if its body is a JSON-RPC message with one. Error answers carry it. */
function readableId(body: unknown): RequestId {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/**
 * The deployment's origins for this route. Once PUBLIC_URL is set, only its origin counts: an
 * Origin that matches the Host header proves nothing under DNS rebinding.
 */
function mcpOrigins(c: Context<AppEnv>): string[] {
  const configured = c.env.PUBLIC_URL?.trim();
  if (!configured) return [new URL(c.req.url).origin];
  try {
    return [new URL(configured).origin];
  } catch {
    return []; // A malformed PUBLIC_URL admits no browser origin.
  }
}

/** The body as text if it ends within `MAX_BODY_BYTES`, or null. Reads no more than that. */
async function readCapped(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// A failure of D1 or of the code reaches the client as JSON-RPC, never as the app's HTML page.
mcp.onError(async (error, c) => {
  log.error("mcp.request_failed", {}, error);
  // Read the body only within the route's own size limit: D1 at its daily limit fails every
  // request before `bodyLimit` runs, and a large or endless body must not cost CPU then.
  let id: RequestId;
  try {
    const text = c.req.raw.bodyUsed ? await c.req.text() : await readCapped(c.req.raw);
    id = text && text.length <= MAX_BODY_BYTES ? readableId(JSON.parse(text)) : undefined;
  } catch {
    id = undefined;
  }
  return rpcError(c, 500, id, INTERNAL_ERROR, messages(c).errors.internal);
});

// Each check ends the request at its first failure. See the design: the order is the contract.
mcp.use("*", async (c, next) => {
  if (!mcpEnabled(c.env)) return c.notFound();
  c.header("Cache-Control", "no-store");
  const t = messages(c);
  const origin = c.req.header("origin");
  if (origin !== undefined && !mcpOrigins(c).includes(origin)) {
    return rpcError(c, 403, undefined, SERVER_ERROR, t.errors.forbiddenOrigin);
  }
  if (!setupStatus(c.env).ready) {
    return rpcError(c, 503, undefined, SERVER_ERROR, t.errors.notReady);
  }
  const authorization = c.req.header("authorization");
  const issuer = oauthIssuer(c.env, c.req.url);
  const bearer = /^bearer +(\S+)$/i.exec(authorization ?? "")?.[1];
  const user =
    bearer && isAccessToken(bearer)
      ? await authenticateAccessToken(c.env, bearer, issuer)
      : await authenticateToken(c.env, authorization);
  if (!user) {
    // RFC 6750: a request without credentials gets no error code, a refused token gets one.
    // The metadata URL lets a client find the authorization server (RFC 9728 5.1).
    const metadata = `resource_metadata="${resourceMetadataUrl(issuer)}", scope="${OAUTH_SCOPE}"`;
    c.header(
      "WWW-Authenticate",
      authorization ? `Bearer error="invalid_token", ${metadata}` : `Bearer ${metadata}`,
    );
    return rpcError(c, 401, undefined, SERVER_ERROR, t.errors.unauthorized);
  }
  // The token stays, as after a change of the access policy; the org's setting may come back.
  // No `insufficient_scope` challenge: a client would start a new authorization, which the
  // consent page refuses as well.
  if (!can(user, "mcp:read")) {
    return rpcError(c, 403, undefined, SERVER_ERROR, t.errors.membersOff);
  }
  c.set("user", user);
  await next();
});

mcp.post(
  "/",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      rpcError(
        c as Context<AppEnv>,
        413,
        undefined,
        SERVER_ERROR,
        messages(c as Context<AppEnv>).errors.tooLarge,
      ),
  }),
  async (c) => {
    const t = messages(c);
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return rpcError(c, 400, undefined, PARSE_ERROR, t.errors.parse);
    }
    const parsed = messageSchema.safeParse(body);
    if (!parsed.success) {
      return rpcError(c, 400, readableId(body), INVALID_REQUEST, t.errors.invalidRequest);
    }
    const message = parsed.data;
    if (message.id === undefined) return c.body(null, 202);

    const meta = message.params?._meta as Record<string, unknown> | undefined;
    const requested = meta?.[VERSION_META];
    const header = c.req.header("mcp-protocol-version");
    if (requested !== undefined) {
      if (requested !== MODERN_VERSION) {
        return rpcError(c, 400, message.id, UNSUPPORTED_VERSION, t.errors.unsupportedVersion, {
          supported: VERSIONS,
          // The schema types `requested` as a string; echo nothing else.
          ...(typeof requested === "string" ? { requested } : {}),
        });
      }
      if (!modernHeadersMatch(c, header, message)) {
        return rpcError(c, 400, message.id, HEADER_MISMATCH, t.errors.headerMismatch);
      }
      return modern(c, message);
    }
    if (header === MODERN_VERSION) {
      return rpcError(c, 400, message.id, HEADER_MISMATCH, t.errors.headerMismatch);
    }
    if (header !== undefined && !LEGACY_VERSIONS.includes(header)) {
      return rpcError(c, 400, message.id, UNSUPPORTED_VERSION, t.errors.unsupportedVersion, {
        supported: VERSIONS,
        requested: header,
      });
    }
    return legacy(c, message);
  },
);

mcp.all("/", (c) => {
  c.header("Allow", "POST");
  return c.body(null, 405);
});

// Paths below /mcp end here, so that no request with a bearer token reaches the session middleware.
mcp.all("*", (c) => c.notFound());

type Message = z.infer<typeof messageSchema> & { id?: string | number };

/** The value of `Mcp-Name`: plain, or in the Base64 form for names that are not header-safe. */
function decodeName(value: string | undefined): string | undefined {
  const encoded = /^=\?base64\?(.*)\?=$/.exec(value ?? "")?.[1];
  if (encoded === undefined) return value;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

function modernHeadersMatch(
  c: Context<AppEnv>,
  version: string | undefined,
  message: Message,
): boolean {
  if (version !== MODERN_VERSION || c.req.header("mcp-method") !== message.method) return false;
  if (message.method !== "tools/call") return true;
  const name = message.params?.name;
  return typeof name === "string" && decodeName(c.req.header("mcp-name")) === name;
}

function toolList(c: Context<AppEnv>) {
  const t = messages(c);
  return toolsOf(c).map((tool) => ({
    name: tool.name,
    title: t.titles[tool.name],
    description: t.tools[tool.name],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: outputSchemas[tool.name],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));
}

/** A result of a 2026-07-28 request: every result names its type and the server. */
function modernResult(c: Context<AppEnv>, id: RequestId, result: object) {
  return c.json({
    jsonrpc: "2.0",
    id,
    result: { ...result, resultType: "complete", _meta: { [SERVER_INFO_META]: SERVER_INFO() } },
  });
}

async function modern(c: Context<AppEnv>, message: Message) {
  const { id, method } = message;
  if (method === "server/discover") {
    return modernResult(c, id, {
      supportedVersions: VERSIONS,
      capabilities: { tools: {} },
      instructions: messages(c).instructions,
      ttlMs: CACHE_TTL_MS,
      // The instructions follow Accept-Language, so a cache shared across clients must not reuse them.
      cacheScope: "private",
    });
  }
  if (method === "tools/list") {
    return modernResult(c, id, {
      tools: toolList(c),
      ttlMs: CACHE_TTL_MS,
      cacheScope: "private",
    });
  }
  if (method === "tools/call") {
    return callTool(c, message, (result) => modernResult(c, id, result));
  }
  return rpcError(c, 404, id, METHOD_NOT_FOUND, messages(c).errors.unknownMethod);
}

function legacyResult(c: Context<AppEnv>, id: RequestId, result: object) {
  return c.json({ jsonrpc: "2.0", id, result });
}

async function legacy(c: Context<AppEnv>, message: Message) {
  const { id, method } = message;
  if (method === "initialize") {
    const wanted = message.params?.protocolVersion;
    return legacyResult(c, id, {
      protocolVersion:
        typeof wanted === "string" && LEGACY_VERSIONS.includes(wanted)
          ? wanted
          : LEGACY_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO(),
      instructions: messages(c).instructions,
    });
  }
  if (method === "ping") return legacyResult(c, id, {});
  if (method === "tools/list") return legacyResult(c, id, { tools: toolList(c) });
  if (method === "tools/call") {
    return callTool(c, message, (result) => legacyResult(c, id, result));
  }
  return rpcError(c, 200, id, METHOD_NOT_FOUND, messages(c).errors.unknownMethod);
}

async function callTool(
  c: Context<AppEnv>,
  message: Message,
  respond: (result: object) => Response,
) {
  const t = messages(c);
  const tool = toolsOf(c).find((candidate) => candidate.name === message.params?.name);
  if (!tool) return rpcError(c, 200, message.id, INVALID_PARAMS, t.errors.unknownTool);
  // Since 2025-11-25, input errors are tool errors: the model reads them and can correct the call.
  const toolError = (text: string) => respond({ content: [{ type: "text", text }], isError: true });
  const args = message.params?.arguments ?? {};
  if (
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args) ||
    Object.keys(args).length > 0
  ) {
    return toolError(t.errors.unexpectedArguments);
  }
  const user = c.get("user");
  if (!user) throw new Error("the MCP route requires a user");
  const reserved = await reserveToolCall(c.env.DB, user.id);
  if (reserved.outcome !== "ok") {
    const refusal = {
      user: t.errors.dailyLimit,
      userRows: t.errors.userRowLimit,
      deployment: t.errors.deploymentLimit,
      day: t.errors.dayChanged,
    }[reserved.outcome];
    return toolError(refusal);
  }
  const counted = countingRows(c.env.DB);
  try {
    const data = await tool.run({ ...c.env, DB: counted.db }, user);
    return respond({
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    });
  } catch (error) {
    log.error("mcp.tool_failed", { tool: tool.name }, error);
    return toolError(t.errors.toolFailed);
  } finally {
    // A failed count must not cost the user an answer that is ready.
    const rows = counted.rows() + CHECK_ROWS;
    await settleToolCall(c.env.DB, user.id, reserved.day, rows).catch((error: unknown) => {
      log.error("mcp.usage_count_failed", {}, error);
    });
  }
}
