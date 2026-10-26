---
title: Quickstart
description: Deploy slotmirror to Cloudflare, connect your calendars, and choose where events go.
---

You need a Cloudflare account (the free plan is enough) and an OAuth app for each provider you
use.

## Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/michaeljauk/slotmirror)

The button creates the Worker, the D1 database and the Durable Object in your account and asks
for the secrets. Then:

1. Create a [Microsoft Entra app](../entra-setup/), a [Google OAuth client](../google-setup/), or
   both.
2. Set `ALLOWED_EMAILS` to your address, or `ALLOWED_DOMAINS` for a team, and set `ADMIN_EMAILS`.
3. Set `PUBLIC_URL` to the address of your Worker. This turns on
   [push notifications](../push-notifications/).
4. Open the address of your Worker, sign in, connect your calendars, and choose where events go.

If a required setting is missing, every page shows a checklist of what is missing.

## Deploy by hand

```sh
git clone https://github.com/michaeljauk/slotmirror && cd slotmirror
pnpm install
pnpm wrangler login
pnpm wrangler d1 create slotmirror            # add --jurisdiction=eu to keep data in the EU
# copy the database_id into wrangler.jsonc, set the variables there
pnpm wrangler secret put SESSION_SECRET       # openssl rand -base64 48
pnpm wrangler secret put TOKEN_ENCRYPTION_KEY # openssl rand -base64 32
pnpm wrangler secret put MICROSOFT_CLIENT_ID  # and the other client secrets you use
pnpm run deploy                               # applies the migrations, then deploys
```

All variables and secrets are in the [settings reference](../settings/).

## Choose where events go

![Connected accounts](../../../../../docs/images/accounts.png)

1. Connect each account under **Accounts**.
2. Open **Where your events go**. Put your calendars in the group **Block each other**: each then
   sees the others only as "Busy", marked private.
3. For more detail in one direction, expand the card of the source account and choose **Not**,
   **As busy**, **With title** or **Everything** per target. **Looks like this there** shows an
   example event as the target will show it.
4. Choose **Save**. The changes apply immediately.

![A source card with several calendars of one account](../../../../../docs/images/source-calendars.png)
