import { policyFromEnv, type AccessPolicy } from "./access";
import type { RuleOptions } from "./config";

export type DetailLevel = RuleOptions["detailLevel"];

/** From least to most detail. */
export const DETAIL_LEVELS: readonly DetailLevel[] = ["busy", "title", "title_location", "full"];

/**
 * The most detail a rule may copy between the org's own accounts and other accounts. An org sets
 * these so that, for example, customer meetings do not reach private calendars with their titles,
 * and private appointments do not reach the work calendar.
 */
export interface DetailCaps {
  /** From an org account to an external account. */
  toExternal: DetailLevel;
  /** From an external account to an org account. */
  fromExternal: DetailLevel;
}

/**
 * Caps from MAX_DETAIL_TO_EXTERNAL and MAX_DETAIL_FROM_EXTERNAL. An unset variable means no cap.
 * An invalid value means "busy", so that a typo never copies more than intended.
 */
export function detailCapsFromEnv(env: Env): DetailCaps {
  return {
    toExternal: parseCap(env.MAX_DETAIL_TO_EXTERNAL),
    fromExternal: parseCap(env.MAX_DETAIL_FROM_EXTERNAL),
  };
}

function parseCap(raw: string | undefined): DetailLevel {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "full";
  return (DETAIL_LEVELS as readonly string[]).includes(value) ? (value as DetailLevel) : "busy";
}

export interface AccountIdentity {
  email: string;
  tenantId: string | null;
}

/**
 * True if the account belongs to the org: its Entra tenant is in ALLOWED_TENANT_IDS, or its email
 * domain is in ALLOWED_DOMAINS. Single addresses in ALLOWED_EMAILS do not count; they name people,
 * not the org's own systems.
 */
export function isOrgAccount(policy: AccessPolicy, account: AccountIdentity): boolean {
  if (account.tenantId && policy.allowedTenantIds.includes(account.tenantId.toLowerCase())) {
    return true;
  }
  const domain = account.email.trim().toLowerCase().split("@")[1] ?? "";
  return domain !== "" && policy.allowedDomains.includes(domain);
}

/** The detail level a rule runs with, and whether a cap lowered it. */
export function effectiveDetailLevel(
  requested: DetailLevel,
  caps: DetailCaps,
  source: { org: boolean },
  target: { org: boolean },
): { level: DetailLevel; capped: boolean } {
  const cap =
    source.org && !target.org
      ? caps.toExternal
      : !source.org && target.org
        ? caps.fromExternal
        : "full";
  const level = DETAIL_LEVELS.indexOf(requested) > DETAIL_LEVELS.indexOf(cap) ? cap : requested;
  return { level, capped: level !== requested };
}

/** The effective detail level of a rule between two accounts, from the deployment's variables. */
export function detailLevelFor(
  env: Env,
  requested: DetailLevel,
  source: AccountIdentity,
  target: AccountIdentity,
): { level: DetailLevel; capped: boolean } {
  const policy = policyFromEnv(env);
  return effectiveDetailLevel(
    requested,
    detailCapsFromEnv(env),
    { org: isOrgAccount(policy, source) },
    { org: isOrgAccount(policy, target) },
  );
}
