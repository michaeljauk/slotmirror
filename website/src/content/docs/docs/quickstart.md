---
title: Quickstart
description: Deploy slotmirror to Cloudflare, connect your calendars, and choose where events go.
---

You need:

- A Cloudflare account. The free plan is enough.
- An account at one provider to start: Microsoft 365 or Google.
- Rights to create an OAuth app at that provider: an app registration in Microsoft Entra, or a
  project in Google Cloud.
- A tool to generate two random secrets (step 1).
- For the manual deploy only: Node 22 and pnpm 10.

The OAuth app of the provider takes the most effort. This page gives no time estimate, because
none has been measured.

To mirror, you need two calendars. They can be two accounts at the same provider, for example a
work and a private Microsoft account. Add the second provider later, if you need it.

The order matters. The deploy form needs the two secrets, so you generate them first. The OAuth app needs the address of your Worker, and you get the address only after the deploy. So you deploy second, create the OAuth app after that, and set its secrets last.

## 1. Generate the two secrets

The form of the deploy button asks for both values at once, so create them first. Use any one of these. Keep the values: you cannot read a secret again after you save it.

| Tool                     | `SESSION_SECRET`                                                                                                                 | `TOKEN_ENCRYPTION_KEY`                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `openssl` (macOS, Linux) | `openssl rand -base64 48`                                                                                                        | `openssl rand -base64 32`                                                                                                        |
| PowerShell (Windows)     | `$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)` | `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)` |
| Node.js                  | `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`                                                    | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`                                                    |

`SESSION_SECRET` needs at least 32 characters. `TOKEN_ENCRYPTION_KEY` must decode to exactly 32
bytes, so do not change the number 32.

## 2. Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/michaeljauk/slotmirror)

The button creates the Worker, the D1 database and the Durable Object in your account. In its form:

- Paste in `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` from step 1.
- Leave `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` empty. You do not have them yet.

## 3. Set who may sign in

Until you do this, your Worker shows a checklist and no sign-in page. In the Cloudflare dashboard,
open **Workers & Pages**, your Worker, **Settings**, **Variables and Secrets**. Add these as
**Text** variables:

| Name                | Value                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| `ALLOWED_EMAILS`    | Your address. For a team, set `ALLOWED_DOMAINS` to your domain instead.   |
| `ADMIN_EMAILS`      | Your address.                                                             |
| `TIME_ZONE`         | Your time zone, for example `Europe/Vienna`. The default is `UTC`.        |
| `DATA_JURISDICTION` | `eu`, if the data must stay in the EU. Set it now, see the warning below. |

:::caution[Set DATA_JURISDICTION before the first account]
`DATA_JURISDICTION` cannot change for existing data. If you change it after you connect an
account, every account disconnects. Decide now. The D1 database lives in the region that the
button chose. See [Settings](../settings/).
:::

The deploy keeps these values. A later deploy does not reset them, because `wrangler.jsonc` does
not list them and sets `keep_vars`.

If you cloned the repository, you can set a secret with `pnpm wrangler secret put <NAME>` instead
of the dashboard. The dashboard works without any local tools.

## 4. Read the address of your Worker

On the page of your Worker in the dashboard, open **Settings**, then **Domains & Routes**. The
address looks like `https://slotmirror.<your-subdomain>.workers.dev`. You need it in the next
step. If you use a custom domain, use its address instead, here and in the OAuth app. Then always
open slotmirror through that domain. The redirect URI comes from the address in your browser, so
sign-in fails on the `workers.dev` address.

Add one more variable: `PUBLIC_URL`, set to this address, without a trailing slash. With it,
Microsoft and Google notify the Worker about changes, and mirrored blocks update when they report a change.
Without it, the Worker polls every 10 minutes.

## 5. Create the OAuth app for one provider

Choose one. The redirect address uses the address from step 4.

- Microsoft 365: [Microsoft Entra app](../entra-setup/)
- Google Calendar: [Google OAuth client](../google-setup/)

## 6. Set the secrets of the provider

In **Variables and Secrets**, add these as **Secret**, with the values from the OAuth app:

- Microsoft: `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`
- Google: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

Save and deploy. Reload your Worker. If the checklist still shows, it names what is missing. If
you set `SIGN_IN_PROVIDERS`, write both providers as `microsoft,google`. The word `both` is not a
valid value, and the checklist shows the value it read.

## 7. Sign in and connect

Open the address of your Worker, sign in, and connect your calendars under **Accounts**. To add
the other provider later, repeat steps 5 and 6 for it.

## 8. Watch the first block

1. Under **Where your events go**, put your two calendars in the group **Block each other**, and
   choose **Save**. See below.
2. In one calendar, create a test event for tomorrow.
3. Watch the other calendar. With `PUBLIC_URL`, the block appears when the notification arrives. Without it, it
   appears at the next run, after up to 10 minutes.

When the block appears, the setup works.

## Deploy by hand

You need Node 22 and pnpm 10.

```sh
git clone https://github.com/michaeljauk/slotmirror && cd slotmirror
pnpm install
pnpm wrangler login
pnpm wrangler d1 create slotmirror            # add --jurisdiction=eu to keep data in the EU
# copy the database_id into wrangler.jsonc, see below
pnpm wrangler secret put SESSION_SECRET       # generate it as shown above
pnpm wrangler secret put TOKEN_ENCRYPTION_KEY
pnpm run deploy                               # applies the migrations, then deploys
```

`wrangler d1 create` prints the new database as a configuration block, similar to this one. The ID
is an example:

```jsonc
{
  "d1_databases": [
    {
      "binding": "slotmirror",
      "database_name": "slotmirror",
      "database_id": "11111111-2222-3333-4444-555555555555",
    },
  ],
}
```

In `wrangler.jsonc`, replace only the `database_id` of the existing `d1_databases` entry with this
value. Keep `"binding": "DB"`. The code reads the database under that name, and the printed
`binding` does not match it. If Wrangler offers to add the database to your configuration for you,
decline.

Then follow steps 3 to 8. Set the provider secrets with `pnpm wrangler secret put` after step 5.

All variables and secrets are in the [settings reference](../settings/). To move to a newer
version later, see [Updating your deployment](../updating/).

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
