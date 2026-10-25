import * as z from "zod/mini";

export type Role = "member" | "admin";

/** Who may sign in to an org, and who of them is an admin. Stored as JSON in `orgs.policy`. */
export const accessPolicySchema = z.object({
  allowedEmails: z._default(z.array(z.string()), []),
  allowedDomains: z._default(z.array(z.string()), []),
  /** Entra tenant IDs. If not empty, Microsoft sign-ins from other tenants are refused. */
  allowedTenantIds: z._default(z.array(z.string()), []),
  adminEmails: z._default(z.array(z.string()), []),
});

export type AccessPolicy = z.infer<typeof accessPolicySchema>;

/** ID of the single org of a self-hosted deployment. */
export const DEFAULT_ORG_ID = "default";

const emailSchema = z.email();

/** Split a comma-separated variable, trim and lowercase. Entries that fail `valid` are dropped. */
function parseList(raw: string | undefined, valid: (entry: string) => boolean): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && valid(entry));
}

const isEmail = (entry: string) => emailSchema.safeParse(entry).success;
const isDomain = (entry: string) => /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entry);
const isTenantId = (entry: string) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry);

/** The policy of a self-hosted deployment comes from its variables. */
export function policyFromEnv(env: Env): AccessPolicy {
  return {
    allowedEmails: parseList(env.ALLOWED_EMAILS, isEmail),
    allowedDomains: parseList(env.ALLOWED_DOMAINS, isDomain),
    allowedTenantIds: parseList(env.ALLOWED_TENANT_IDS, isTenantId),
    adminEmails: parseList(env.ADMIN_EMAILS, isEmail),
  };
}

/** True if at least one person could sign in. */
export function policyAdmitsAnyone(policy: AccessPolicy): boolean {
  return (
    policy.allowedEmails.length > 0 ||
    policy.allowedDomains.length > 0 ||
    policy.adminEmails.length > 0
  );
}

export interface SignInIdentity {
  email: string;
  /** Entra tenant ID for Microsoft identities; undefined for Google. */
  tenantId?: string | null;
}

export type AccessDecision = { allowed: false } | { allowed: true; role: Role };

export function decideAccess(policy: AccessPolicy, identity: SignInIdentity): AccessDecision {
  const email = identity.email.trim().toLowerCase();
  const domain = email.split("@")[1] ?? "";

  if (identity.tenantId && policy.allowedTenantIds.length > 0) {
    if (!policy.allowedTenantIds.includes(identity.tenantId.toLowerCase())) {
      return { allowed: false };
    }
  }

  if (policy.adminEmails.includes(email)) return { allowed: true, role: "admin" };
  if (policy.allowedEmails.includes(email)) return { allowed: true, role: "member" };
  if (domain && policy.allowedDomains.includes(domain)) return { allowed: true, role: "member" };
  return { allowed: false };
}
