import { Hono, type Context } from "hono";
import { DEFAULT_ORG_ID, policyFromEnv } from "../access";
import type { AppEnv } from "../app-env";
import { recordAudit } from "../audit";
import { deleteUser, setUserActive } from "../offboarding";

/**
 * SCIM 2.0 user provisioning for Microsoft Entra (RFC 7643, RFC 7644), behind SCIM_TOKEN. Entra
 * creates a user before their first sign-in, deactivates them when they leave (sign-in and sync
 * stop, blocks go), and deletes them for good. Groups are not supported; Entra's connection test
 * gets an empty list for them.
 *
 * Stored: userName (as the sign-in email), externalId, active. Names and other attributes Entra
 * sends are not stored and not returned.
 */
export const scim = new Hono<AppEnv>();

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const CONTENT_TYPE = { "Content-Type": "application/scim+json" };

/** Largest page Entra may ask for. */
const MAX_COUNT = 200;

interface UserRow {
  id: string;
  email: string;
  externalId: string | null;
  active: number;
  createdAt: string;
}

function json(c: Context<AppEnv>, body: unknown, status: 200 | 201 = 200) {
  return c.body(JSON.stringify(body), status, CONTENT_TYPE);
}

function scimError(
  c: Context<AppEnv>,
  status: 400 | 401 | 404 | 409,
  detail: string,
  scimType?: string,
) {
  return c.body(
    JSON.stringify({ schemas: [ERROR_SCHEMA], status: String(status), detail, scimType }),
    status,
    CONTENT_TYPE,
  );
}

function toResource(c: Context<AppEnv>, row: UserRow) {
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    externalId: row.externalId ?? undefined,
    userName: row.email,
    active: row.active === 1,
    emails: [{ value: row.email, type: "work", primary: true }],
    meta: {
      resourceType: "User",
      created: row.createdAt,
      lastModified: row.createdAt,
      location: `${new URL(c.req.url).origin}/scim/v2/Users/${row.id}`,
    },
  };
}

const USER_COLUMNS = `id, email, external_id AS externalId, active, created_at AS createdAt`;

async function findUser(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND org_id = ?`)
    .bind(id, DEFAULT_ORG_ID)
    .first<UserRow>();
}

/** Constant-time comparison of the bearer token with SCIM_TOKEN. */
function tokenMatches(expected: string, header: string | undefined): boolean {
  const received = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(received);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

// Without SCIM_TOKEN the endpoints do not exist; with it, every request needs the token.
scim.use("*", async (c, next) => {
  const expected = (c.env.SCIM_TOKEN ?? "").trim();
  if (expected === "") return c.notFound();
  if (!tokenMatches(expected, c.req.header("authorization"))) {
    return scimError(c, 401, "Missing or wrong bearer token.");
  }
  await next();
});

/** Entra filters with `eq` on userName, externalId or the work email, optionally joined by `and`. */
function parseFilter(filter: string): { attribute: string; value: string } | null {
  const match =
    /^\s*(userName|externalId|emails\[type eq "work"\]\.value|emails\.value)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(
      filter,
    );
  if (!match) return null;
  const [, attribute = "", value = ""] = match;
  return { attribute: attribute.toLowerCase(), value: value.replace(/\\(.)/g, "$1") };
}

scim.get("/Users", async (c) => {
  const startIndex = Math.max(1, Number(c.req.query("startIndex") ?? 1) || 1);
  const count = Math.min(MAX_COUNT, Math.max(0, Number(c.req.query("count") ?? MAX_COUNT) || 0));
  const filter = c.req.query("filter");
  let where = "org_id = ?";
  const binds: unknown[] = [DEFAULT_ORG_ID];
  if (filter) {
    const parsed = parseFilter(filter);
    if (!parsed) return scimError(c, 400, "Unsupported filter.", "invalidFilter");
    if (parsed.attribute === "externalid") {
      where += " AND external_id = ?";
      binds.push(parsed.value);
    } else {
      where += " AND email = ?";
      binds.push(parsed.value.trim().toLowerCase());
    }
  }
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM users WHERE ${where} ORDER BY created_at, id LIMIT ? OFFSET ?`,
  )
    .bind(...binds, count, startIndex - 1)
    .all<UserRow>();
  return json(c, {
    schemas: [LIST_SCHEMA],
    totalResults: total?.n ?? 0,
    startIndex,
    itemsPerPage: results.length,
    Resources: results.map((row) => toResource(c, row)),
  });
});

scim.get("/Users/:id", async (c) => {
  const row = await findUser(c.env, c.req.param("id"));
  return row ? json(c, toResource(c, row)) : scimError(c, 404, "User not found.");
});

/** The email of a SCIM user: userName, or the primary work email if userName is missing. */
function emailOf(body: {
  userName?: unknown;
  emails?: { value?: unknown; primary?: unknown }[];
}): string | null {
  const candidate =
    typeof body.userName === "string"
      ? body.userName
      : (body.emails?.find((email) => email.primary)?.value ?? body.emails?.[0]?.value);
  if (typeof candidate !== "string") return null;
  const email = candidate.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

/** Entra sends `active` as a boolean, older tenants as the string "True" or "False". */
function parseActive(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value)) {
    return value.toLowerCase() === "true";
  }
  return null;
}

scim.post("/Users", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const email = body ? emailOf(body) : null;
  if (!body || !email)
    return scimError(c, 400, "userName must be an email address.", "invalidValue");
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();
  if (existing) return scimError(c, 409, "A user with this userName exists.", "uniqueness");

  const id = crypto.randomUUID();
  const active = parseActive(body.active) ?? true;
  // A user can arrive before anyone signed in, so the org may not exist yet.
  await c.env.DB.prepare("INSERT OR IGNORE INTO orgs (id, name, policy) VALUES (?, ?, ?)")
    .bind(
      DEFAULT_ORG_ID,
      c.env.ORG_NAME?.trim() || "slotmirror",
      JSON.stringify(policyFromEnv(c.env)),
    )
    .run();
  await c.env.DB.prepare(
    `INSERT INTO users (id, org_id, email, role, external_id, active) VALUES (?, ?, ?, 'member', ?, ?)`,
  )
    .bind(
      id,
      DEFAULT_ORG_ID,
      email,
      typeof body.externalId === "string" ? body.externalId : null,
      active ? 1 : 0,
    )
    .run();
  await recordAudit(c.env.DB, { orgId: DEFAULT_ORG_ID, userId: id, kind: "user_provisioned" });
  const row = await findUser(c.env, id);
  return row ? json(c, toResource(c, row), 201) : scimError(c, 404, "User not found.");
});

/** Apply the attributes slotmirror stores: userName, externalId, active. */
async function applyChanges(
  c: Context<AppEnv>,
  row: UserRow,
  changes: { email?: string; externalId?: string; active?: boolean },
): Promise<Response | null> {
  if (changes.email && changes.email !== row.email) {
    const taken = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ? AND id <> ?")
      .bind(changes.email, row.id)
      .first();
    if (taken) return scimError(c, 409, "A user with this userName exists.", "uniqueness");
    // A new sign-in address starts with a new sign-in. Sessions of the old address end.
    await c.env.DB.prepare(
      "UPDATE users SET email = ?, session_version = session_version + 1 WHERE id = ?",
    )
      .bind(changes.email, row.id)
      .run();
  }
  if (changes.externalId !== undefined) {
    await c.env.DB.prepare("UPDATE users SET external_id = ? WHERE id = ?")
      .bind(changes.externalId, row.id)
      .run();
  }
  if (changes.active !== undefined) {
    await setUserActive(c.env, { id: row.id, orgId: DEFAULT_ORG_ID }, changes.active, "scim");
  }
  return null;
}

scim.patch("/Users/:id", async (c) => {
  const row = await findUser(c.env, c.req.param("id"));
  if (!row) return scimError(c, 404, "User not found.");
  const body = (await c.req.json().catch(() => null)) as {
    schemas?: string[];
    Operations?: { op?: string; path?: string; value?: unknown }[];
  } | null;
  if (!body?.Operations || !body.schemas?.includes(PATCH_SCHEMA)) {
    return scimError(c, 400, "Expected a PatchOp request.", "invalidSyntax");
  }
  const changes: { email?: string; externalId?: string; active?: boolean } = {};
  for (const operation of body.Operations) {
    const op = (operation.op ?? "").toLowerCase();
    if (op !== "replace" && op !== "add") continue;
    // A replace without path carries an object of attributes.
    const values: Record<string, unknown> =
      operation.path === undefined && typeof operation.value === "object" && operation.value
        ? (operation.value as Record<string, unknown>)
        : { [operation.path ?? ""]: operation.value };
    for (const [path, value] of Object.entries(values)) {
      const attribute = path.toLowerCase();
      if (attribute === "active") {
        const active = parseActive(value);
        if (active === null)
          return scimError(c, 400, "active must be true or false.", "invalidValue");
        changes.active = active;
      } else if (attribute === "username" || attribute === 'emails[type eq "work"].value') {
        const email = emailOf({ userName: value });
        if (!email) return scimError(c, 400, "userName must be an email address.", "invalidValue");
        // userName is the sign-in identity; a work email alone does not change it.
        if (attribute === "username") changes.email = email;
      } else if (attribute === "externalid" && typeof value === "string") {
        changes.externalId = value;
      }
    }
  }
  const error = await applyChanges(c, row, changes);
  if (error) return error;
  const updated = await findUser(c.env, row.id);
  return updated ? json(c, toResource(c, updated)) : scimError(c, 404, "User not found.");
});

scim.put("/Users/:id", async (c) => {
  const row = await findUser(c.env, c.req.param("id"));
  if (!row) return scimError(c, 404, "User not found.");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const email = body ? emailOf(body) : null;
  if (!body || !email)
    return scimError(c, 400, "userName must be an email address.", "invalidValue");
  const error = await applyChanges(c, row, {
    email,
    externalId: typeof body.externalId === "string" ? body.externalId : undefined,
    active: parseActive(body.active) ?? true,
  });
  if (error) return error;
  const updated = await findUser(c.env, row.id);
  return updated ? json(c, toResource(c, updated)) : scimError(c, 404, "User not found.");
});

scim.delete("/Users/:id", async (c) => {
  const row = await findUser(c.env, c.req.param("id"));
  if (!row) return scimError(c, 404, "User not found.");
  await deleteUser(c.env, { id: row.id, orgId: DEFAULT_ORG_ID }, "scim");
  return c.body(null, 204);
});

// Groups are not supported. Entra's connection test queries one; an empty list satisfies it.
scim.get("/Groups", (c) =>
  json(c, {
    schemas: [LIST_SCHEMA],
    totalResults: 0,
    startIndex: 1,
    itemsPerPage: 0,
    Resources: [],
  }),
);

scim.get("/ServiceProviderConfig", (c) =>
  json(c, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_COUNT },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "The SCIM_TOKEN of this deployment.",
        primary: true,
      },
    ],
  }),
);

scim.get("/ResourceTypes", (c) =>
  json(c, {
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: USER_SCHEMA,
      },
    ],
  }),
);

scim.get("/Schemas", (c) =>
  json(c, {
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
        id: USER_SCHEMA,
        name: "User",
        attributes: [
          {
            name: "userName",
            type: "string",
            required: true,
            uniqueness: "server",
            mutability: "readWrite",
            returned: "default",
            multiValued: false,
            caseExact: false,
          },
          {
            name: "externalId",
            type: "string",
            required: false,
            uniqueness: "none",
            mutability: "readWrite",
            returned: "default",
            multiValued: false,
            caseExact: true,
          },
          {
            name: "active",
            type: "boolean",
            required: false,
            mutability: "readWrite",
            returned: "default",
            multiValued: false,
          },
          {
            name: "emails",
            type: "complex",
            required: false,
            mutability: "readOnly",
            returned: "default",
            multiValued: true,
          },
        ],
      },
    ],
  }),
);
