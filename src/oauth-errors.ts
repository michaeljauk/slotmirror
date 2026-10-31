/**
 * Maps what a provider reports about a failed sign-in to a code that is safe to show and to log.
 * The provider's `error_description` can name the user, so no page prints it. Only a code from
 * these rules reaches a page: an AADSTS number (digits only) or an OAuth error name (lowercase
 * letters, digits and underscores).
 */

/** The troubleshooting page of the documentation. Anchors are the lowercase codes. */
export const TROUBLESHOOTING_URL = "https://slotmirror.com/docs/troubleshooting/";

/** Codes with a section on the troubleshooting page. Keep in step with that page. */
export const DOCUMENTED: ReadonlySet<string> = new Set([
  "access_denied",
  "consent_required",
  "aadsts65001",
  "aadsts90094",
  "aadsts90095",
  "aadsts50020",
]);

const CONSENT_AADSTS = new Set(["65001", "90094", "90095"]);
const CONSENT_ERRORS = new Set(["access_denied", "consent_required"]);

const AADSTS = /AADSTS(\d{4,7})/;
const OAUTH_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export type ProviderErrorKind =
  /** The user cancelled, or the tenant needs an admin to approve the app. */
  | "consent"
  /** AADSTS50020: the account does not exist in the tenant that the app signs in to. */
  | "tenant"
  | "other";

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  /** Safe to show, e.g. "AADSTS65001" or "access_denied". Null if nothing passed the filter. */
  code: string | null;
  /** Anchor on the troubleshooting page, or null if the code has no section. */
  anchor: string | null;
}

function anchorFor(code: string | null): string | null {
  const anchor = code?.toLowerCase() ?? null;
  return anchor && DOCUMENTED.has(anchor) ? anchor : null;
}

/** The AADSTS number in a description, digits only. */
export function aadstsNumber(description: string | undefined): string | null {
  return AADSTS.exec(description ?? "")?.[1] ?? null;
}

/** An OAuth error name if it has the expected shape, else null. */
export function safeErrorName(name: string | undefined): string | null {
  return name !== undefined && OAUTH_NAME.test(name) ? name : null;
}

/** A known AADSTS number decides first, because `access_denied` can wrap any of them. */
function kindOf(aadsts: string | null, name: string | null): ProviderErrorKind {
  if (aadsts && CONSENT_AADSTS.has(aadsts)) return "consent";
  if (aadsts === "50020") return "tenant";
  return name && CONSENT_ERRORS.has(name) ? "consent" : "other";
}

function classify(aadsts: string | null, name: string | null): ProviderErrorInfo {
  const code = aadsts ? `AADSTS${aadsts}` : name;
  return { kind: kindOf(aadsts, name), code, anchor: anchorFor(code) };
}

/** Classify the `error` and `error_description` that a provider sent to the callback. */
export function classifyProviderError(
  error: string | undefined,
  description: string | undefined,
): ProviderErrorInfo {
  return classify(aadstsNumber(description), safeErrorName(error));
}

/** Classify a failed token exchange. `code` is the provider's error name, `aadsts` a number. */
export function classifyExchangeError(
  code: string | undefined,
  aadsts: string | undefined,
): ProviderErrorInfo {
  const safeAadsts = aadsts !== undefined && /^\d{4,7}$/.test(aadsts) ? aadsts : null;
  return classify(safeAadsts, safeErrorName(code));
}

/** A short ID that a page shows and the log repeats. It carries no data. */
export function newReference(): string {
  return crypto.randomUUID().slice(0, 8);
}
