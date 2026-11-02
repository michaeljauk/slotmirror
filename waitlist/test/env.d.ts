declare namespace Cloudflare {
  interface Env {
    RESEND_API_KEY: string;
    TURNSTILE_SECRET: string;
    HASH_PEPPER: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
