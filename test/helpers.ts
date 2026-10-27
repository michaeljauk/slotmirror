import { env } from "cloudflare:workers";
import { SESSION_COOKIE, signSession } from "../src/session";
import { signInUser, type CurrentUser } from "../src/users";

export const BASE = "https://slotmirror.example.workers.dev";

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

/**
 * Counts what one invocation spends: D1 queries (a `batch()` counts as one) and Durable Object
 * RPC calls. The statements of a batch are counted separately. `beforeBatch` runs before each
 * batch with the SQL of its statements, for example to write as a concurrent request would.
 */
export function countingEnv(beforeBatch?: (sql: string[]) => Promise<void>) {
  const counts = { d1: 0, batchStatements: 0, durable: [] as string[] };
  const real = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        }
        if (key === "run" || key === "all" || key === "first" || key === "raw") {
          return (...args: unknown[]) => {
            counts.d1 += 1;
            return (target[key] as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(proxy, statement);
    sqlOf.set(proxy, sql);
    return proxy;
  };
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          counts.d1 += 1;
          counts.batchStatements += statements.length;
          await beforeBatch?.(statements.map((statement) => sqlOf.get(statement) ?? ""));
          return target.batch(statements.map((statement) => real.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ACCOUNT_SYNC = new Proxy(env.ACCOUNT_SYNC, {
    get(target, key) {
      if (key === "getByName") {
        return (name: string) =>
          new Proxy(target.getByName(name), {
            get(stub, method) {
              if (typeof method !== "string") return Reflect.get(stub, method) as unknown;
              // An RPC property is callable but has no `apply`, so call it as a method.
              return (...args: unknown[]) => {
                counts.durable.push(`${name}:${method}`);
                return (stub as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(
                  ...args,
                );
              };
            },
          });
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { counts, env: { ...env, DB, ACCOUNT_SYNC } as Env };
}
