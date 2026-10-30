import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../src/index";
import type { WaitlistEnv } from "../src/env";

export const BASE = "https://slotmirror.app";
export const FORM_ORIGIN = "https://slotmirror.com";

export function testEnv(overrides: Partial<WaitlistEnv> = {}): WaitlistEnv {
  return { ...(env as unknown as WaitlistEnv), ...overrides };
}

export function call(request: Request, overrides: Partial<WaitlistEnv> = {}): Promise<Response> {
  return Promise.resolve(worker.fetch(request, testEnv(overrides)));
}

export interface Outbound {
  turnstile: Request[];
  resend: { body: any; headers: Headers }[];
}

/** Replace the network. Returns what the Worker sent. No real mail, no real Turnstile. */
export function mockNetwork(
  options: { turnstile?: "ok" | "fail" | "wrong-host"; resend?: number } = {},
): Outbound {
  const out: Outbound = { turnstile: [], resend: [] };
  let counter = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    if (url.startsWith("https://challenges.cloudflare.com/")) {
      out.turnstile.push(new Request(input, init));
      const mode = options.turnstile ?? "ok";
      return Response.json(
        mode === "fail"
          ? { success: false, "error-codes": ["invalid-input-response"] }
          : { success: true, hostname: mode === "wrong-host" ? "evil.example" : "slotmirror.com" },
      );
    }
    if (url === "https://api.resend.com/emails") {
      out.resend.push({
        body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
        headers: new Headers(init?.headers),
      });
      counter++;
      const status = options.resend ?? 200;
      return Response.json(status < 300 ? { id: `mail-${counter}` } : { message: "error" }, {
        status,
      });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  return out;
}

export function signupRequest(
  email: string,
  extra: { ip?: string; origin?: string | null; source?: string; token?: string | null } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cf-connecting-ip": extra.ip ?? "203.0.113.7",
  };
  if (extra.origin !== null) headers.origin = extra.origin ?? FORM_ORIGIN;
  return new Request(`${BASE}/api/signup`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email,
      source: extra.source ?? "website-hero",
      turnstileToken: extra.token === null ? undefined : (extra.token ?? "turnstile-ok"),
    }),
  });
}

/** Pull the confirm and unsubscribe tokens out of a sent mail. */
export function tokensFrom(mail: { body: any }): { confirm: string; unsubscribe: string } {
  const confirm = /\/confirm\?t=([A-Za-z0-9_-]{22})/.exec(mail.body.text)?.[1];
  const unsubscribe = /\/unsubscribe\?t=([A-Za-z0-9_-]{22})/.exec(mail.body.text)?.[1];
  if (!confirm || !unsubscribe) throw new Error("No tokens in mail");
  return { confirm, unsubscribe };
}

export async function row(email: string) {
  return env.DB.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first<any>();
}

export async function reset() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM subscribers"),
    env.DB.prepare("DELETE FROM mail_counter"),
    env.DB.prepare("DELETE FROM rate_hits"),
  ]);
}
