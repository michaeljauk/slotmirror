import {
  accessPolicySchema,
  decideAccess,
  DEFAULT_ORG_ID,
  policyFromEnv,
  type Role,
  type SignInIdentity,
} from "./access";

export interface CurrentUser {
  id: string;
  orgId: string;
  email: string;
  role: Role;
}

/**
 * Create or update the user for a sign-in. Returns null if the org policy refuses the identity.
 *
 * Self-hosted deployments have one org whose policy mirrors the variables; this call writes the
 * current variables into it first, so that the database never holds a stale policy.
 */
export async function signInUser(env: Env, identity: SignInIdentity): Promise<CurrentUser | null> {
  const policy = policyFromEnv(env);
  const decision = decideAccess(policy, identity);
  if (!decision.allowed) return null;

  const orgName = env.ORG_NAME?.trim() || "slotmirror";
  const email = identity.email.trim().toLowerCase();
  // A user that Entra deactivated over SCIM cannot sign in, whatever the policy says.
  const inactive = await env.DB.prepare("SELECT 1 FROM users WHERE email = ? AND active = 0")
    .bind(email)
    .first();
  if (inactive) return null;
  const [, user] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orgs (id, name, policy) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, policy = excluded.policy`,
    ).bind(DEFAULT_ORG_ID, orgName, JSON.stringify(policy)),
    env.DB.prepare(
      `INSERT INTO users (id, org_id, email, tenant_id, role, last_sign_in_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (email) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         role = excluded.role,
         last_sign_in_at = excluded.last_sign_in_at
       RETURNING id, org_id AS orgId, email, role`,
    ).bind(crypto.randomUUID(), DEFAULT_ORG_ID, email, identity.tenantId ?? null, decision.role),
  ]);
  return (user?.results[0] as CurrentUser | undefined) ?? null;
}

/**
 * Load the user of a session and check the org policy again, so that removing someone from the
 * policy ends their access at the next request instead of when the session cookie expires. A
 * deactivated user has no session either.
 */
export async function loadUser(env: Env, userId: string): Promise<CurrentUser | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.org_id AS orgId, u.email, u.tenant_id AS tenantId, o.policy
     FROM users u JOIN orgs o ON o.id = u.org_id
     WHERE u.id = ? AND u.active = 1`,
  )
    .bind(userId)
    .first<{ id: string; orgId: string; email: string; tenantId: string | null; policy: string }>();
  if (!row) return null;
  return admittedUser(env, row);
}

/**
 * The user if the org policy still admits them, otherwise null. The default org follows the
 * variables; other orgs (hosted mode) follow their stored policy.
 */
export function admittedUser(
  env: Env,
  row: { id: string; orgId: string; email: string; tenantId: string | null; policy: string },
): CurrentUser | null {
  const policy =
    row.orgId === DEFAULT_ORG_ID
      ? policyFromEnv(env)
      : accessPolicySchema.parse(JSON.parse(row.policy));
  const decision = decideAccess(policy, { email: row.email, tenantId: row.tenantId });
  if (!decision.allowed) return null;
  return { id: row.id, orgId: row.orgId, email: row.email, role: decision.role };
}
