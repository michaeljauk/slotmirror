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
  /** How many days ahead to mirror. The window moves forward every day. */
  daysAhead: z._default(z.int().check(z.minimum(1), z.maximum(365)), 90),
  skipAllDay: z._default(z.boolean(), true),
  /** Skip events that do not block time (Graph `showAs: free`, Google `transparency: transparent`). */
  skipFree: z._default(z.boolean(), true),
  skipTentative: z._default(z.boolean(), false),
  skipDeclined: z._default(z.boolean(), true),
  /**
   * Skip events with any of these categories: Outlook category names, or "color:<id>" for Google
   * event colours. Compared without case.
   */
  skipCategories: z._default(
    z.array(z.string().check(z.maxLength(100))).check(z.maxLength(50)),
    [],
  ),
  /** Mark blocks as private so that people with access to the target calendar see no detail. */
  markPrivate: z._default(z.boolean(), true),
  /**
   * Colour of the blocks in the target calendar: a Google event colour ID ("1" to "11"), or an
   * Outlook category name. Empty: no colour, the calendar's default.
   */
  blockColor: z._default(z.string().check(z.maxLength(100)), ""),
  /**
   * Add a note to each block that names the source account, e.g. "From: Work (Microsoft)", or only
   * the provider for an account without a name. It is the whole description up to detail level
   * "title_location"; at "full" it follows the copied description. The note is the account's name
   * only, never event content. Where any detail cap below "full" applies, no note.
   */
  showOrigin: z._default(z.boolean(), false),
  /**
   * Add a link to the source event below the origin note (Graph `webLink`, Google `htmlLink`).
   * The link holds IDs only; Google's `eid` encodes the event ID and the calendar ID, which for a
   * main calendar is the account's address. Without `showOrigin` it has no effect. It needs detail
   * level "title" or more, and a private source event never gets it.
   */
  linkOrigin: z._default(z.boolean(), false),
  /**
   * Language of the origin note: the language of the user who turned it on. Without it, or for a
   * language this deployment no longer has, the note uses the first entry of `LOCALES` ("en").
   */
  originLocale: z.optional(z.string().check(z.maxLength(16))),
});

export type RuleOptions = z.infer<typeof ruleOptionsSchema>;

export function parseRuleOptions(json: string): RuleOptions {
  return ruleOptionsSchema.parse(JSON.parse(json));
}

export type Provider = "microsoft" | "google";

/** Product names stay untranslated. */
export const PROVIDER_LABEL: Record<Provider, string> = {
  microsoft: "Microsoft 365",
  google: "Google",
};

export interface SetupStatus {
  /** At least one of ALLOWED_EMAILS, ALLOWED_DOMAINS, ADMIN_EMAILS admits someone. */
  accessConfigured: boolean;
  sessionSecret: boolean;
  tokenEncryptionKey: boolean;
  providers: Record<Provider, boolean>;
  /** At least one configured provider is allowed for sign-in. */
  signIn: boolean;
  /** True if the dashboard can be used: access, both secrets, and a sign-in provider. */
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
  const allowed = signInProviders(env);
  const signIn = allowed.microsoft || allowed.google;
  const ready = accessConfigured && sessionSecret && tokenEncryptionKey && signIn;
  return { accessConfigured, sessionSecret, tokenEncryptionKey, providers, signIn, ready };
}

/**
 * Providers offered for sign-in: the configured ones, limited by SIGN_IN_PROVIDERS if it is set.
 * Connecting accounts is not limited; an org can require sign-in through Entra and still let
 * people connect any Microsoft or Google account.
 */
export function signInProviders(env: Env): Record<Provider, boolean> {
  const configured = {
    microsoft: Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  };
  const listed = (env.SIGN_IN_PROVIDERS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (listed.length === 0) return configured;
  return {
    microsoft: configured.microsoft && listed.includes("microsoft"),
    google: configured.google && listed.includes("google"),
  };
}

function isBase64Key(value: string | undefined, bytes: number): boolean {
  if (!value) return false;
  try {
    return atob(value.trim()).length === bytes;
  } catch {
    return false;
  }
}
