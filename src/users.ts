import {
  accessPolicySchema,
  decideAccess,
  DEFAULT_ORG_ID,
  policyFromEnv,
  type AccessPolicy,
  type Role,
} from "./access";
import { errorLogFields, recordAudit } from "./audit";
import type { Identity } from "./providers/oauth-token";

export interface CurrentUser {
  id: string;
  orgId: string;
  email: string;
  role: Role;
}

export type SignedInUser = CurrentUser & { sessionVersion: number };

/**
 * Why a sign-in was refused:
 * - "policy": the org policy does not admit the address, or the user is deactivated;
 * - "identity": the address belongs to a user bound to another identity of the same provider;
 * - "provider": the user is bound to the other provider and signs in only there.
 */
export type SignInRefusal = "policy" | "identity" | "provider";

export type SignInOutcome = { user: SignedInUser } | { refused: SignInRefusal };

/** The tenant of personal Microsoft accounts. */
export const CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

interface UserRow {
  id: string;
  email: string;
  tenantId: string | null;
  active: number;
  msObjectId: string | null;
  googleSubject: string | null;
  rebindUntil: string | null;
  refusedSubjects: string | null;
}

const USER_ROW = `id, email, tenant_id AS tenantId, active, ms_object_id AS msObjectId,
  google_subject AS googleSubject, rebind_until AS rebindUntil,
  refused_subjects AS refusedSubjects`;

/** The key of an identity in `users.refused_subjects`. */
function subjectKey(identity: Identity): string {
  return identity.provider === "microsoft"
    ? `microsoft:${identity.tenantId}:${identity.subject}`
    : `google:${identity.subject}`;
}

/**
 * Sign in an identity: find its user, bind the user to the identity, or create a new user.
 *
 * A user is bound to the provider's immutable ID at the first sign-in: Entra tenant and object
 * ID, or Google `sub`. A bound user is found by that ID, whatever address the token carries, and
 * keeps the stored address. A user bound to one provider signs in only with that provider.
 * `mayBind` holds the rules for binding an unbound user found by address.
 *
 * Self-hosted deployments have one org whose policy mirrors the variables; this call writes the
 * current variables into it first, so that the database never holds a stale policy.
 */
export async function admitSignIn(
  env: Env,
  identity: Identity,
  now = Date.now(),
): Promise<SignInOutcome> {
  const microsoft = identity.provider === "microsoft";
  const policy = policyFromEnv(env);
  const bound = await (
    microsoft
      ? env.DB.prepare(
          `SELECT ${USER_ROW} FROM users WHERE ms_tenant_id = ? AND ms_object_id = ?`,
        ).bind(identity.tenantId, identity.subject)
      : env.DB.prepare(`SELECT ${USER_ROW} FROM users WHERE google_subject = ?`).bind(
          identity.subject,
        )
  ).first<UserRow>();
  let row: UserRow | null = bound;
  if (!row) {
    const found = await unboundUserFor(env, policy, identity, now);
    if ("refused" in found) return found;
    row = found.row;
  }

  const email = row?.email ?? identity.email;
  const decision = decideAccess(policy, { email, tenantId: identity.tenantId });
  // A user that Entra deactivated over SCIM cannot sign in, whatever the policy says.
  if (!decision.allowed || row?.active === 0) return { refused: "policy" };

  const orgName = env.ORG_NAME?.trim() || "slotmirror";
  const msTenantId = microsoft ? identity.tenantId : null;
  const msObjectId = microsoft ? identity.subject : null;
  const googleSubject = microsoft ? null : identity.subject;
  const returning = "RETURNING id, org_id AS orgId, email, role, session_version AS sessionVersion";
  const signedIn = `tenant_id = COALESCE(?, tenant_id), role = ?,
    last_sign_in_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  // Each WHERE clause holds only while the row is as read above. If a reset or another sign-in
  // changed it in between, nothing is written and the sign-in is refused.
  let write: D1PreparedStatement;
  if (bound) {
    write = env.DB.prepare(
      `UPDATE users SET ${signedIn}
       WHERE id = ? AND active = 1 AND ${
         microsoft ? "ms_object_id = ? AND ms_tenant_id = ?" : "google_subject = ?"
       }
       ${returning}`,
    ).bind(
      identity.tenantId,
      decision.role,
      bound.id,
      ...(microsoft ? [identity.subject, identity.tenantId] : [identity.subject]),
    );
  } else if (row) {
    write = env.DB.prepare(
      `UPDATE users SET ${signedIn},
         ms_tenant_id = ?, ms_object_id = ?, google_subject = ?, rebind_until = NULL
       WHERE id = ? AND active = 1 AND email = ?
         AND ms_tenant_id IS NULL AND ms_object_id IS NULL AND google_subject IS NULL
         AND tenant_id IS ? AND rebind_until IS ? AND refused_subjects IS ?
       ${returning}`,
    ).bind(
      identity.tenantId,
      decision.role,
      msTenantId,
      msObjectId,
      googleSubject,
      row.id,
      row.email,
      row.tenantId,
      row.rebindUntil,
      row.refusedSubjects,
    );
  } else {
    write = env.DB.prepare(
      `INSERT INTO users (id, org_id, email, tenant_id, role, last_sign_in_at,
                          ms_tenant_id, ms_object_id, google_subject)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?)
       ON CONFLICT (email) DO NOTHING
       ${returning}`,
    ).bind(
      crypto.randomUUID(),
      DEFAULT_ORG_ID,
      email,
      identity.tenantId,
      decision.role,
      msTenantId,
      msObjectId,
      googleSubject,
    );
  }
  let written: D1Result | undefined;
  try {
    [, written] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO orgs (id, name, policy) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, policy = excluded.policy`,
      ).bind(DEFAULT_ORG_ID, orgName, JSON.stringify(policy)),
      write,
    ]);
  } catch (error) {
    // Another sign-in bound this identity to a user in between; the unique index refused a second.
    if (String(error).includes("UNIQUE")) return { refused: "identity" };
    throw error;
  }
  const user = written?.results[0] as SignedInUser | undefined;
  return user ? { user } : { refused: "identity" };
}

/** How long the next sign-in may bind a user again after an admin reset their binding. */
const REBIND_WINDOW_HOURS = 24;

/**
 * Undo a user's binding to their Microsoft or Google account, for example after they moved to
 * another tenant. Their sessions end, the stored tenant goes, and the accounts bound so far can
 * never bind this user again. For 24 hours, a sign-in with a verified address of the user binds
 * them anew; after that, the user needs another reset.
 */
export async function resetSignInBinding(
  env: Env,
  user: { id: string; orgId: string },
  by: "admin",
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET
       refused_subjects = (
         SELECT json_group_array(value) FROM (
           SELECT value FROM json_each(COALESCE(users.refused_subjects, '[]'))
           UNION ALL
           SELECT 'microsoft:' || users.ms_tenant_id || ':' || users.ms_object_id
           WHERE users.ms_object_id IS NOT NULL
           UNION ALL
           SELECT 'google:' || users.google_subject WHERE users.google_subject IS NOT NULL
         )
       ),
       ms_tenant_id = NULL, ms_object_id = NULL, google_subject = NULL, tenant_id = NULL,
       session_version = session_version + 1,
       rebind_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${REBIND_WINDOW_HOURS} hours')
     WHERE id = ? AND org_id = ?`,
  )
    .bind(user.id, user.orgId)
    .run();
  await recordAudit(env.DB, {
    orgId: user.orgId,
    userId: user.id,
    kind: "sign_in_reset",
    detail: { by },
  });
}

/**
 * Whether an identity may bind an unbound user that it found by an address. `verified` says how:
 * through a verified address (`xms_edov` email, UPN, Google `email_verified`), or through the
 * unverified Microsoft `email` claim.
 *
 * - After an admin reset, only within the window, only through a verified address, and never for
 *   an identity bound before the reset. A personal Microsoft account may bind here.
 * - Otherwise a personal Microsoft account never binds an existing user.
 * - A Google account binds only a user without an Entra tenant. A user with a tenant belongs to
 *   that tenant.
 * - The unverified `email` claim binds only from the tenant the user already has, or, for a user
 *   without a tenant (created over SCIM), from a tenant in ALLOWED_TENANT_IDS. It never binds a
 *   user whose address is in ADMIN_EMAILS.
 */
function mayBind(
  row: UserRow,
  identity: Identity,
  verified: boolean,
  policy: AccessPolicy,
  now: number,
): boolean {
  const microsoft = identity.provider === "microsoft";
  const consumer = microsoft && identity.tenantId === CONSUMER_TENANT_ID;
  if (row.rebindUntil !== null || row.refusedSubjects !== null) {
    const open = row.rebindUntil !== null && Date.parse(row.rebindUntil) > now;
    const refused = (JSON.parse(row.refusedSubjects ?? "[]") as string[]).includes(
      subjectKey(identity),
    );
    return open && verified && !refused && (microsoft || row.tenantId === null);
  }
  if (consumer) return false;
  if (!microsoft) return row.tenantId === null;
  if (verified) return true;
  if (policy.adminEmails.includes(row.email)) return false;
  if (row.tenantId !== null) return row.tenantId === identity.tenantId;
  return (
    identity.tenantId !== null && policy.allowedTenantIds.includes(identity.tenantId.toLowerCase())
  );
}

/** The unbound user an identity may bind to; null for a new user. See `admitSignIn`. */
async function unboundUserFor(
  env: Env,
  policy: AccessPolicy,
  identity: Identity,
  now: number,
): Promise<{ row: UserRow | null } | { refused: SignInRefusal }> {
  const microsoft = identity.provider === "microsoft";
  const unverified = microsoft ? identity.unverifiedEmail : undefined;
  const candidates = [...new Set([...identity.addresses, ...(unverified ? [unverified] : [])])];
  const { results } = await env.DB.prepare(
    `SELECT ${USER_ROW} FROM users WHERE email IN (${candidates.map(() => "?").join(", ")})`,
  )
    .bind(...candidates)
    .all<UserRow>();
  const byEmail = new Map(results.map((row) => [row.email, row]));

  // Verified addresses first. A user bound elsewhere under a verified address refuses at once.
  for (const address of identity.addresses) {
    const row = byEmail.get(address);
    if (!row) continue;
    const own = microsoft ? row.msObjectId : row.googleSubject;
    const other = microsoft ? row.googleSubject : row.msObjectId;
    if (own !== null) return { refused: "identity" };
    if (other !== null) return { refused: "provider" };
    if (mayBind(row, identity, true, policy, now)) return { row };
  }
  // The unverified claim proves too little to refuse anything; it can only find a user.
  const claimed = unverified ? byEmail.get(unverified) : undefined;
  if (
    claimed &&
    claimed.msObjectId === null &&
    claimed.googleSubject === null &&
    mayBind(claimed, identity, false, policy, now)
  ) {
    return { row: claimed };
  }
  // A new user, unless the address belongs to a user this identity may not bind to.
  const holder = byEmail.get(identity.email);
  if (!holder) return { row: null };
  const tenantUser = !microsoft && holder.tenantId !== null && holder.refusedSubjects === null;
  return { refused: tenantUser ? "provider" : "identity" };
}

/**
 * Load the user of a session and check the org policy again, so that removing someone from the
 * policy ends their access at the next request instead of when the session cookie expires. A
 * deactivated user has no session either, and neither has a session from before the user's
 * session version changed. The role follows the stored address at every request.
 */
export async function loadUser(
  env: Env,
  userId: string,
  sessionVersion = 0,
): Promise<CurrentUser | null> {
  const row = await env.DB.prepare(
    `SELECT u.id, u.org_id AS orgId, u.email, u.tenant_id AS tenantId, o.policy
     FROM users u JOIN orgs o ON o.id = u.org_id
     WHERE u.id = ? AND u.active = 1 AND u.session_version = ?`,
  )
    .bind(userId, sessionVersion)
    .first<{ id: string; orgId: string; email: string; tenantId: string | null; policy: string }>();
  if (!row) return null;
  return admittedUser(env, row);
}

/** The user if the org policy still admits them, otherwise null. See `orgPolicy`. */
export function admittedUser(
  env: Env,
  row: { id: string; orgId: string; email: string; tenantId: string | null; policy: string },
): CurrentUser | null {
  const policy = orgPolicy(env, row.orgId, row.policy);
  const decision = decideAccess(policy, { email: row.email, tenantId: row.tenantId });
  if (!decision.allowed) return null;
  return { id: row.id, orgId: row.orgId, email: row.email, role: decision.role };
}

/** The default org follows the variables; other orgs (hosted mode) follow their stored policy. */
function orgPolicy(env: Env, orgId: string, stored: string): AccessPolicy {
  return orgId === DEFAULT_ORG_ID
    ? policyFromEnv(env)
    : accessPolicySchema.parse(JSON.parse(stored));
}

/** Columns of a rule's owner, for a query that joins `users u` and `orgs o`. */
export const OWNER_COLUMNS = `u.org_id AS ownerOrgId, u.email AS ownerEmail,
  u.tenant_id AS ownerTenantId, o.policy AS ownerPolicy`;

export interface OwnerColumns {
  ownerOrgId: string;
  ownerEmail: string;
  ownerTenantId: string | null;
  ownerPolicy: string;
}

/**
 * A check whether the org policy still admits a rule's owner, for background work. Sign-in and
 * every request check the policy too, but the cron and the alarms run without a request. Each
 * org's policy is read once per check, not once per rule. A stored policy that does not parse
 * admits nobody.
 */
export function ownerAdmission(env: Env): (owner: OwnerColumns) => boolean {
  const policies = new Map<string, AccessPolicy | null>();
  return (owner) => {
    if (!policies.has(owner.ownerOrgId)) {
      let policy: AccessPolicy | null = null;
      try {
        policy = orgPolicy(env, owner.ownerOrgId, owner.ownerPolicy);
      } catch (error) {
        console.error(
          "Stored access policy is invalid",
          owner.ownerOrgId,
          ...errorLogFields(error),
        );
      }
      policies.set(owner.ownerOrgId, policy);
    }
    const policy = policies.get(owner.ownerOrgId);
    if (!policy) return false;
    return decideAccess(policy, { email: owner.ownerEmail, tenantId: owner.ownerTenantId }).allowed;
  };
}
