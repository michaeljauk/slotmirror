import { env } from "cloudflare:workers";
import { SESSION_COOKIE, signSession } from "../src/session";
import { signInUser, type CurrentUser } from "../src/users";

export const BASE = "https://freebusy-sync.example.workers.dev";

/** Sign in an address allowed by the test bindings and return the user and its session cookie. */
export async function signIn(email: string): Promise<{ user: CurrentUser; cookie: string }> {
  const user = await signInUser(env, { email });
  if (!user) throw new Error(`${email} is not allowed by the test bindings`);
  const token = await signSession(
    { userId: user.id, exp: Math.floor(Date.now() / 1000) + 60 },
    env.SESSION_SECRET,
  );
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

export async function addAccount(userId: string, id: string, email: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO accounts (id, user_id, provider, email) VALUES (?, ?, 'microsoft', ?)",
  )
    .bind(id, userId, email)
    .run();
}
