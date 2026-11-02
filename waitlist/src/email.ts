const MAX_LENGTH = 254;
// Allowlist, not blocklist. Local part: ASCII letters and digits plus the RFC 5322 "atext"
// symbols, in dot-separated parts. No quotes, comments, spaces, "<", ">", "," or ";".
// Domain: dot-separated ASCII labels with at least one dot and a letter-only or punycode end
// label. Internationalized domains must come as punycode ("xn--"). Deliverability is the job of
// the confirmation mail, not of this check.
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function validDomain(domain: string): boolean {
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;
  const tld = labels[labels.length - 1]!;
  return /^[a-z]{2,}$/.test(tld) || /^xn--[a-z0-9-]+$/.test(tld);
}

/** Trim and lowercase. Returns null for an address that cannot be valid. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const email = input.trim().toLowerCase();
  if (email.length > MAX_LENGTH) return null;
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local = "", domain = ""] = parts;
  if (local.length > 64 || !LOCAL.test(local) || !validDomain(domain)) return null;
  return email;
}

const SOURCE = /^[a-z0-9][a-z0-9_.:-]{0,39}$/;

/** Where the sign-up came from, e.g. "website-hero". An unusable value becomes "unknown". */
export function normalizeSource(input: unknown): string {
  if (typeof input !== "string") return "unknown";
  const source = input.trim().toLowerCase();
  return SOURCE.test(source) ? source : "unknown";
}
