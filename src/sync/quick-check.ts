/**
 * Quick type checks for provider responses. Each one accepts only what the matching zod schema
 * accepts, so that a parser can skip the schema for the usual event and fall back to it otherwise.
 */

/** Zod's test for an object: not null and not an array. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/** Indexes every slot, so that a hole fails as in the schema. */
export function isStringArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) if (typeof value[i] !== "string") return false;
  return true;
}
