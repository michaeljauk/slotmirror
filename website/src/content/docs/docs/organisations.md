---
title: "Organisations: calendar sync for a team"
description: Run slotmirror for a team, with sign-in limited to your tenant and detail caps.
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
- On the Rules page, a capped choice shows the note "This deployment's policy allows at most …".

## Offboarding

If Entra requires an assignment for the app, removing a user there stops their next sign-in. It
deletes nothing in slotmirror: an open session stays until it expires, and the user's rules keep
running. To remove a user with their accounts, rules and blocks, delete them under `/admin`.

## Quotas for a team

Each connected account needs a few hundred requests a day. A large team needs Workers Paid. See
[Limits](../limits/).
