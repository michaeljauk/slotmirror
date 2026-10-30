const MAX_LENGTH = 254;
// One "@", no spaces or control characters, a dot in the domain. Deliverability is the job of the
// confirmation mail, not of this check.
const SHAPE = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}.]+$/u;

/** Trim and lowercase. Returns null for an address that cannot be valid. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const email = input.trim().toLowerCase();
  if (email.length > MAX_LENGTH || !SHAPE.test(email)) return null;
  return email;
}

const SOURCE = /^[a-z0-9][a-z0-9_.:-]{0,39}$/;

/** Where the sign-up came from, e.g. "website-hero". An unusable value becomes "unknown". */
export function normalizeSource(input: unknown): string {
  if (typeof input !== "string") return "unknown";
  const source = input.trim().toLowerCase();
  return SOURCE.test(source) ? source : "unknown";
}
