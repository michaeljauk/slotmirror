---
title: Organisations
description: Run slotmirror for a team, with sign-in limited to your tenant, detail caps and SCIM provisioning.
---

A deployment can serve a team. Each member connects their work calendar and, if they want, their
private calendars.

## Limit who signs in

For a team on Microsoft 365, set:

- `ALLOWED_DOMAINS` to your domain,
- `ALLOWED_TENANT_IDS` to your tenant ID,
- `SIGN_IN_PROVIDERS=microsoft`.

:::caution
Only all three together limit sign-in to your Entra tenant. Anyone can create a Google account on
an address at your domain.
:::

## Org accounts and detail caps

**Org accounts** are accounts whose Entra tenant is in `ALLOWED_TENANT_IDS` or whose domain is in
`ALLOWED_DOMAINS`. Two caps limit how much detail moves between org accounts and all other
accounts:

| Variable                   | Direction                       |
| -------------------------- | ------------------------------- |
| `MAX_DETAIL_TO_EXTERNAL`   | From org accounts to other ones |
| `MAX_DETAIL_FROM_EXTERNAL` | From other accounts to org ones |

Values: `busy`, `title`, `title_location`.

- The caps apply at every run.
- A lower cap also rewrites the blocks that a rule already wrote.
- An invalid value counts as `busy`.
- In the editor, a capped choice shows the note "This deployment's policy allows at most …".

## Provision users with SCIM

Entra can manage users over SCIM 2.0. It creates them before their first sign-in, deactivates
them when they leave, and deletes them.

- A deactivated user cannot sign in. An open session ends at the next request.
- Their rules stop and their blocks are removed. Accounts and rules stay, so a reactivation syncs
  again.

To set it up:

1. Set a long random secret: `wrangler secret put SCIM_TOKEN`, for example from
   `openssl rand -base64 48`. Without it, `/scim/v2` does not exist.
2. In the Entra admin center, create an enterprise application: "Create your own application",
   then "Integrate any other application you don't find in the gallery".
3. Under **Provisioning**, choose "Automatic". Set the tenant URL to
   `https://<your deployment>/scim/v2` and the secret token to `SCIM_TOKEN`. Test the connection.
4. Under **Attribute mapping**, keep the users mapping and turn off groups. slotmirror stores
   `userName` (the sign-in address), `externalId` and `active`, and ignores the rest.
5. Assign the users or groups who use slotmirror, then start provisioning.

## Quotas for a team

Each connected account needs a few hundred requests a day. A large team needs Workers Paid. See
[Limits](../limits/).
