import * as z from "zod/mini";
import { policyAdmitsAnyone, policyFromEnv } from "./access";

/** Options of one sync rule (source calendar -> target calendar). Stored as JSON in `rules.options`. */
export const ruleOptionsSchema = z.object({
  /**
   * How much of each source event reaches the target: "busy" (default), "title",
   * "title_location" or "full" (adds the body). A rule has one direction, so each direction has
   * its own level. Events the source marks private never get more than "busy".
   */
  detailLevel: z._default(z.enum(["busy", "title", "title_location", "full"]), "busy"),
  /** Subject of blocks at detail level "busy", and the fallback for events without a title. */
  blockTitle: z._default(z.string().check(z.trim(), z.minLength(1), z.maxLength(255)), "Busy"),
  /** How many days ahead to mirror. */
  daysAhead: z._default(z.int().check(z.minimum(1), z.maximum(180)), 60),
  skipAllDay: z._default(z.boolean(), true),
  /** Skip events that do not block time (Graph `showAs: free`, Google `transparency: transparent`). */
  skipFree: z._default(z.boolean(), true),
  skipTentative: z._default(z.boolean(), false),
  skipDeclined: z._default(z.boolean(), true),
  /** Mark blocks as private so that people with access to the target calendar see no detail. */
  markPrivate: z._default(z.boolean(), true),
});

export type RuleOptions = z.infer<typeof ruleOptionsSchema>;

export function parseRuleOptions(json: string): RuleOptions {
  return ruleOptionsSchema.parse(JSON.parse(json));
}

export type Provider = "microsoft" | "google";

export interface SetupStatus {
  /** At least one of ALLOWED_EMAILS, ALLOWED_DOMAINS, ADMIN_EMAILS admits someone. */
  accessConfigured: boolean;
  sessionSecret: boolean;
  tokenEncryptionKey: boolean;
  providers: Record<Provider, boolean>;
  /** True if the dashboard can be used: access, both secrets, and at least one provider. */
  ready: boolean;
}

/** Report which settings are present. Never returns the values. */
export function setupStatus(env: Env): SetupStatus {
  const accessConfigured = policyAdmitsAnyone(policyFromEnv(env));
  const sessionSecret = (env.SESSION_SECRET ?? "").length >= 32;
  const tokenEncryptionKey = isBase64Key(env.TOKEN_ENCRYPTION_KEY, 32);
  const providers = {
    microsoft: Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  };
  const ready =
    accessConfigured &&
    sessionSecret &&
    tokenEncryptionKey &&
    (providers.microsoft || providers.google);
  return { accessConfigured, sessionSecret, tokenEncryptionKey, providers, ready };
}

function isBase64Key(value: string | undefined, bytes: number): boolean {
  if (!value) return false;
  try {
    return atob(value.trim()).length === bytes;
  } catch {
    return false;
  }
}
