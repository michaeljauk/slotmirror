---
title: Sync calendars across Microsoft 365 tenants
description: Keep the calendars of two companies or of client tenants in sync, so that nobody in either tenant books you twice.
sidebar:
  order: 3
---

You work in two Microsoft 365 tenants, for example as a founder of two companies or as a
consultant with a client account. Free/busy sharing between tenants needs an admin on both sides
and often does not exist. This guide syncs the calendars yourself, as busy blocks.

## Steps

1. Create a [Microsoft Entra app](../../docs/entra-setup/) with the account type **Accounts in
   any organizational directory and personal Microsoft accounts**. A single-tenant app cannot
   connect the second tenant.
2. Deploy slotmirror with the [Quickstart](../../docs/quickstart/) and set `PUBLIC_URL`.
3. Connect one account per tenant under **Accounts**. If a tenant blocks user consent, its admin
   must grant consent to the app once.
4. In **Where your events go**, add the calendars to the group **Block each other**.
5. Choose **Save**.

## Names in the editor

slotmirror derives a short name from each address. You can rename an account, for example to the
name of the company, so that the overview reads "from Company A to Company B".

## Things to know

- Each tenant sees only "Busy", marked private, unless you choose more detail per direction.
- If you sign in with one of the tenants and want only that tenant to sign in, see
  [Organisations](../../docs/organisations/).
