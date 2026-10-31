import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { identityFromIdToken as googleIdentityFrom } from "../src/providers/google";
import { identityFromIdToken as microsoftIdentityFrom } from "../src/providers/microsoft";
import { base64url } from "../src/session";
import { admitSignIn, CONSUMER_TENANT_ID, resetSignInBinding } from "../src/users";
import { signIn } from "./helpers";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const TENANT_B = "bbbbbbbb-0000-0000-0000-000000000002";
const HOUR = 60 * 60 * 1000;

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

const microsoft = (claims: Record<string, unknown>) => microsoftIdentityFrom(idToken(claims));
const google = (email: string, sub: string) =>
  googleIdentityFrom(idToken({ sub, email, email_verified: true }));

/** An unbound user row, as SCIM or a sign-in from before the binding leaves it. */
async function unboundUser(email: string, tenantId: string | null): Promise<string> {
  const { user } = await signIn(email);
  await env.DB.prepare("UPDATE users SET tenant_id = ? WHERE id = ?").bind(tenantId, user.id).run();
  return user.id;
}

async function row(id: string) {
  return env.DB.prepare(
    `SELECT email, tenant_id, ms_tenant_id, ms_object_id, google_subject, rebind_until,
            refused_subjects FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<Record<string, string | null>>();
}

const reset = (id: string) => resetSignInBinding(env, { id, orgId: "default" }, "admin");

describe("Google sign-in and Microsoft users", () => {
  it("does not bind an unbound user of an Entra tenant to a Google account", async () => {
    const id = await unboundUser("ms.user@org.example", TENANT_A);
    expect(await admitSignIn(env, google("ms.user@org.example", "sub-squat"))).toEqual({
      refused: "provider",
    });
    expect(await row(id)).toMatchObject({ google_subject: null, tenant_id: TENANT_A });
  });

  it("binds an unbound user without a tenant to a Google account", async () => {
    const id = await unboundUser("plain@org.example", null);
    expect(await admitSignIn(env, google("plain@org.example", "sub-plain"))).toMatchObject({
      user: { id },
    });
  });
});

describe("admin addresses", () => {
  it("binds an admin row only through a verified address, not a same-tenant mail claim", async () => {
    const id = await unboundUser("admin@example.com", TENANT_A);
    const claim = { tid: TENANT_A, oid: "oid-claim", email: "admin@example.com" };
    // The UPN is not an admitted address, so a new user is refused by the policy.
    expect(
      await admitSignIn(env, microsoft({ ...claim, preferred_username: "x.admin@org2.example" })),
    ).toEqual({ refused: "policy" });
    expect(await row(id)).toMatchObject({ ms_object_id: null });

    expect(
      await admitSignIn(env, microsoft({ ...claim, preferred_username: "admin@example.com" })),
    ).toMatchObject({ user: { id } });
  });
});

describe("trusted tenants and SCIM users", () => {
  // Case B: SCIM created the row from the mail address; the UPN differs; no xms_edov.
  const caseB = (name: string, oid: string) => ({
    tid: TENANT_A,
    oid,
    email: `${name}.mail@org.example`,
    preferred_username: `${name}.upn@org.example`,
  });

  it("does not trust the mail claim of a tenant outside ALLOWED_TENANT_IDS", async () => {
    const id = await unboundUser("b1.mail@org.example", null);
    const outcome = await admitSignIn(
      { ...env, ALLOWED_TENANT_IDS: "" },
      microsoft(caseB("b1", "oid-b1")),
    );
    expect(outcome).toMatchObject({ user: { email: "b1.upn@org.example" } });
    expect(await row(id)).toMatchObject({ ms_object_id: null });
  });

  it("binds a SCIM user whose userName is the mail address, if the tenant is allowed", async () => {
    const id = await unboundUser("b2.mail@org.example", null);
    const outcome = await admitSignIn(
      { ...env, ALLOWED_TENANT_IDS: `${TENANT_A},${TENANT_B}` },
      microsoft(caseB("b2", "oid-b2")),
    );
    expect(outcome).toMatchObject({ user: { id, email: "b2.mail@org.example" } });
    expect(await row(id)).toMatchObject({ ms_tenant_id: TENANT_A, ms_object_id: "oid-b2" });
  });
});

describe("resetting a binding", () => {
  async function boundThenReset(email: string) {
    const id = await unboundUser(email, TENANT_A);
    const first = await admitSignIn(
      env,
      microsoft({ tid: TENANT_A, oid: `oid-old-${email}`, preferred_username: email }),
    );
    expect(first).toMatchObject({ user: { id } });
    await reset(id);
    return id;
  }

  it("clears the tenant and refuses the previous account", async () => {
    const id = await boundThenReset("reset.old@org.example");
    expect(await row(id)).toMatchObject({
      tenant_id: null,
      ms_tenant_id: null,
      ms_object_id: null,
      refused_subjects: JSON.stringify([`microsoft:${TENANT_A}:oid-old-reset.old@org.example`]),
    });
    const old = microsoft({
      tid: TENANT_A,
      oid: "oid-old-reset.old@org.example",
      preferred_username: "reset.old@org.example",
    });
    expect(await admitSignIn(env, old)).toEqual({ refused: "identity" });
  });

  it("binds a new verified account within the window, and nothing after it", async () => {
    const id = await boundThenReset("reset.window@org.example");
    const fresh = microsoft({
      tid: TENANT_B,
      oid: "oid-new",
      preferred_username: "reset.window@org.example",
    });
    expect(await admitSignIn(env, fresh, Date.now() + 25 * HOUR)).toEqual({
      refused: "identity",
    });
    expect(await row(id)).toMatchObject({ ms_object_id: null });

    expect(await admitSignIn(env, fresh, Date.now() + HOUR)).toMatchObject({ user: { id } });
    expect(await row(id)).toMatchObject({ ms_object_id: "oid-new", rebind_until: null });
  });

  it("binds no reset user through an unverified mail claim, also within the window", async () => {
    const id = await boundThenReset("reset.claim@org.example");
    const claim = microsoft({
      tid: TENANT_A,
      oid: "oid-claim-2",
      email: "reset.claim@org.example",
      preferred_username: "someone.else@org.example",
    });
    const outcome = await admitSignIn({ ...env, ALLOWED_TENANT_IDS: TENANT_A }, claim);
    expect(outcome).not.toMatchObject({ user: { id } });
    expect(await row(id)).toMatchObject({ ms_object_id: null });
  });

  it("lets a personal Microsoft account bind a reset user within the window only", async () => {
    const id = await boundThenReset("reset.msa@org.example");
    const msa = microsoft({
      tid: CONSUMER_TENANT_ID,
      oid: "oid-msa",
      preferred_username: "reset.msa@org.example",
    });
    expect(await admitSignIn(env, msa, Date.now() + 25 * HOUR)).toEqual({ refused: "identity" });
    expect(await admitSignIn(env, msa)).toMatchObject({ user: { id } });
  });
});

/** The env with a DB whose `batch` first runs `before`, to put a change between read and write. */
function racing(before: () => Promise<unknown>): Env {
  const db = env.DB;
  const wrapped = {
    prepare: (query: string) => db.prepare(query),
    batch: async (statements: D1PreparedStatement[]) => {
      await before();
      return db.batch(statements);
    },
  } as unknown as D1Database;
  return { ...env, DB: wrapped };
}

describe("races", () => {
  it("refuses a bound sign-in whose binding an admin reset in between", async () => {
    const id = await unboundUser("race.reset@org.example", TENANT_A);
    const identity = microsoft({
      tid: TENANT_A,
      oid: "oid-race-reset",
      preferred_username: "race.reset@org.example",
    });
    expect(await admitSignIn(env, identity)).toMatchObject({ user: { id } });

    const outcome = await admitSignIn(
      racing(() => reset(id)),
      identity,
    );
    expect(outcome).toEqual({ refused: "identity" });
    expect(await row(id)).toMatchObject({ ms_object_id: null });
  });

  it("refuses a first sign-in when an admin reset the unbound user in between", async () => {
    // The same-tenant mail claim may bind the row as read, but not the row after a reset.
    const id = await unboundUser("race.unbound@org.example", TENANT_A);
    const claim = microsoft({
      tid: TENANT_A,
      oid: "oid-race-unbound",
      email: "race.unbound@org.example",
      preferred_username: "race.unbound.upn@org.example",
    });
    expect(
      await admitSignIn(
        racing(() => reset(id)),
        claim,
      ),
    ).toEqual({ refused: "identity" });
    expect(await row(id)).toMatchObject({ ms_object_id: null });
  });

  it("refuses a first sign-in when another account bound the user in between", async () => {
    const id = await unboundUser("race.bind@org.example", TENANT_A);
    const other = microsoft({
      tid: TENANT_A,
      oid: "oid-race-first",
      preferred_username: "race.bind@org.example",
    });
    const late = microsoft({
      tid: TENANT_A,
      oid: "oid-race-late",
      preferred_username: "race.bind@org.example",
    });
    const outcome = await admitSignIn(
      racing(() => admitSignIn(env, other)),
      late,
    );
    expect(outcome).toEqual({ refused: "identity" });
    expect(await row(id)).toMatchObject({ ms_object_id: "oid-race-first" });
  });

  it("refuses a sign-in whose account was bound to another user in between", async () => {
    const id = await unboundUser("race.twice@org.example", TENANT_A);
    const { user: other } = await signIn("race.twice.other@org.example");
    const identity = microsoft({
      tid: TENANT_A,
      oid: "oid-race-twice",
      preferred_username: "race.twice@org.example",
    });
    const bindOther = () =>
      env.DB.prepare("UPDATE users SET ms_tenant_id = ?, ms_object_id = ? WHERE id = ?")
        .bind(TENANT_A, "oid-race-twice", other.id)
        .run();
    expect(await admitSignIn(racing(bindOther), identity)).toEqual({ refused: "identity" });
    expect(await row(id)).toMatchObject({ ms_object_id: null });
  });

  it("keeps each provider ID on at most one user", async () => {
    await signIn("dup.one@org.example");
    const { user } = await signIn("dup.two@org.example");
    await env.DB.prepare(
      "UPDATE users SET ms_tenant_id = ?, ms_object_id = 'oid-dup', google_subject = 'sub-dup' WHERE email = 'dup.one@org.example'",
    )
      .bind(TENANT_A)
      .run();
    for (const columns of [
      ["ms_tenant_id = ?, ms_object_id = 'oid-dup'", TENANT_A],
      ["google_subject = ?", "sub-dup"],
    ] as const) {
      await expect(
        env.DB.prepare(`UPDATE users SET ${columns[0]} WHERE id = ?`)
          .bind(columns[1], user.id)
          .run(),
      ).rejects.toThrow(/UNIQUE/);
    }
  });
});
