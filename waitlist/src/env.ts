/** Bindings of the waitlist Worker: the generated ones plus secrets and optional bindings. */
export interface WaitlistEnv extends Env {
  /** Resend API key. Secret. */
  RESEND_API_KEY: string;
  /** Turnstile secret key. Secret. */
  TURNSTILE_SECRET: string;
  /** Random string. Secret. Keys the hash of IP addresses, so that the hash cannot be reversed. */
  HASH_PEPPER: string;
  /** Optional. Contact for deletion requests. Shown if an unsubscribe link has expired. */
  DELETION_CONTACT?: string;
  /**
   * Optional. Set to "true" in local development only. Lets Turnstile test keys pass: their
   * answer has the host "localhost" or none.
   */
  TURNSTILE_ALLOW_LOCALHOST?: string;
  /** Optional Workers Rate Limiting binding. Used only if it is set. */
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}
