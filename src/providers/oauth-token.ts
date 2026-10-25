import * as z from "zod/mini";
import { fromBase64url } from "../session";

/** Token endpoint response shared by Microsoft and Google (RFC 6749 with OpenID Connect). */
export const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  id_token: z.optional(z.string()),
  refresh_token: z.optional(z.string()),
  scope: z.optional(z.string()),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.optional(z.string()),
});

export class TokenError extends Error {
  constructor(
    readonly code: string,
    description: string | undefined,
  ) {
    super(description ? `${code}: ${description}` : code);
  }
}

/** POST a form to a token endpoint. Throws TokenError with the provider's error code. */
export async function requestToken(
  url: string,
  form: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = tokenErrorSchema.safeParse(body);
    throw error.success
      ? new TokenError(error.data.error, error.data.error_description)
      : new TokenError(`http_${response.status}`, undefined);
  }
  return tokenResponseSchema.parse(body);
}

/**
 * Payload of an ID token, without checking the signature: the token comes straight from the
 * token endpoint over TLS in exchange for our client secret (OpenID Connect Core 1.0, 3.1.3.7).
 */
export function idTokenPayload(idToken: string): unknown {
  const [, payload] = idToken.split(".");
  if (!payload) throw new Error("Malformed ID token");
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
}

/** The identity a provider signed in. `tenantId` is the Entra tenant; Google has none. */
export interface Identity {
  email: string;
  tenantId: string | null;
}
