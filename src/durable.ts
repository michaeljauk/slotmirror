/** Jurisdictions a Durable Object namespace can be restricted to. */
const JURISDICTIONS = ["eu", "fedramp"] as const;

type Jurisdiction = (typeof JURISDICTIONS)[number];

/** DATA_JURISDICTION, if it names a supported jurisdiction. */
export function dataJurisdiction(env: Env): Jurisdiction | null {
  const value = (env.DATA_JURISDICTION ?? "").trim().toLowerCase();
  return (JURISDICTIONS as readonly string[]).includes(value) ? (value as Jurisdiction) : null;
}

/**
 * The Durable Object of one connected account. With DATA_JURISDICTION, the object runs and stores
 * its data (tokens, and event contents while it syncs) only inside that jurisdiction.
 *
 * The same name maps to a different object in each jurisdiction. Changing DATA_JURISDICTION on a
 * running deployment therefore loses every stored token; set it before the first account connects.
 */
export function accountSync(env: Env, accountId: string) {
  const jurisdiction = dataJurisdiction(env);
  const namespace = jurisdiction ? env.ACCOUNT_SYNC.jurisdiction(jurisdiction) : env.ACCOUNT_SYNC;
  return namespace.getByName(accountId);
}
