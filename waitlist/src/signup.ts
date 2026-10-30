import { hashToken, newToken } from "./crypto";
import { normalizeEmail, normalizeSource } from "./email";
import type { WaitlistEnv } from "./env";
import { corsHeaders, problem } from "./http";
import { sendConfirmationMail } from "./mail";
import { allowAttempt } from "./ratelimit";
import { verifyTurnstile } from "./turnstile";

export const CONFIRM_TTL_MS = 7 * 24 * 3_600_000;
export const UNSUBSCRIBE_TTL_MS = 365 * 24 * 3_600_000;
/** An unconfirmed address gets a new mail at most once in this time. */
export const RESEND_COOLDOWN_MS = 10 * 60_000;

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Reserve one mail of today's global cap. Returns false if the cap is reached. */
async function reserveMail(env: WaitlistEnv, now: number): Promise<boolean> {
  const cap = Number(env.DAILY_MAIL_CAP) || 0;
  if (cap <= 0) return false;
  const row = await env.DB.prepare(
    `INSERT INTO mail_counter (day, reserved) VALUES (?, 1)
     ON CONFLICT (day) DO UPDATE SET reserved = reserved + 1 WHERE reserved < ?
     RETURNING reserved`,
  )
    .bind(today(now), cap)
    .first<{ reserved: number }>();
  if (!row) {
    // Only the count goes to the log.
    console.warn("mail cap reached", cap);
    return false;
  }
  return true;
}

interface SignupBody {
  email?: unknown;
  source?: unknown;
  turnstileToken?: unknown;
}

async function readBody(request: Request): Promise<SignupBody | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body: unknown = await request.json();
      return body && typeof body === "object" ? (body as SignupBody) : null;
    }
    if (type.includes("application/x-www-form-urlencoded")) {
      const form = await request.formData();
      return {
        email: form.get("email"),
        source: form.get("source"),
        turnstileToken: form.get("cf-turnstile-response"),
      };
    }
  } catch {
    // Fall through to the invalid-request answer.
  }
  return null;
}

/** POST /api/signup. The same answer for new, pending and confirmed addresses. */
export async function handleSignup(request: Request, env: WaitlistEnv): Promise<Response> {
  const cors = corsHeaders(request, env);
  const origin = request.headers.get("origin");
  if (origin && !cors["access-control-allow-origin"])
    return problem(403, "origin_not_allowed", cors);
  if (!env.RESEND_API_KEY || !env.TURNSTILE_SECRET || !env.HASH_PEPPER) {
    console.error("waitlist secrets missing");
    return problem(503, "server_misconfigured", cors);
  }

  const body = await readBody(request);
  if (!body) return problem(400, "invalid_request", cors);
  const email = normalizeEmail(body.email);
  if (!email) return problem(400, "invalid_email", cors);

  const now = Date.now();
  const ip = request.headers.get("cf-connecting-ip");
  if (!(await allowAttempt(env, ip ?? "unknown", now))) {
    return problem(429, "rate_limited", { ...cors, "retry-after": "3600" });
  }
  if (!(await verifyTurnstile(env, body.turnstileToken, ip))) {
    return problem(403, "turnstile_failed", cors);
  }

  const existing = await env.DB.prepare(
    "SELECT confirmed_at, mail_sent_at FROM subscribers WHERE email = ?",
  )
    .bind(email)
    .first<{ confirmed_at: number | null; mail_sent_at: number | null }>();
  const answer = () => Response.json({ status: "check_inbox" }, { headers: cors });
  if (existing?.confirmed_at) return answer();
  if (existing?.mail_sent_at && now - existing.mail_sent_at < RESEND_COOLDOWN_MS) return answer();

  if (!(await reserveMail(env, now))) return problem(503, "mail_unavailable", cors);

  const confirmToken = newToken();
  const unsubscribeToken = newToken();
  await env.DB.prepare(
    `INSERT INTO subscribers
       (email, source, created_at, confirm_hash, confirm_expires_at,
        unsubscribe_hash, unsubscribe_expires_at, mail_sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (email) DO UPDATE SET
       confirm_hash = excluded.confirm_hash,
       confirm_expires_at = excluded.confirm_expires_at,
       unsubscribe_hash = excluded.unsubscribe_hash,
       unsubscribe_expires_at = excluded.unsubscribe_expires_at,
       mail_sent_at = NULL
     WHERE confirmed_at IS NULL`,
  )
    .bind(
      email,
      normalizeSource(body.source),
      now,
      await hashToken(confirmToken),
      now + CONFIRM_TTL_MS,
      await hashToken(unsubscribeToken),
      now + UNSUBSCRIBE_TTL_MS,
    )
    .run();

  if (!(await sendConfirmationMail(env, email, confirmToken, unsubscribeToken))) {
    // The row stays with mail_sent_at empty, so the next sign-up sends the mail again.
    return problem(503, "mail_unavailable", cors);
  }
  await env.DB.prepare("UPDATE subscribers SET mail_sent_at = ? WHERE email = ?")
    .bind(now, email)
    .run();
  return answer();
}
