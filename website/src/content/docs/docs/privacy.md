---
title: Privacy and data location
description: What slotmirror stores, what it does not store, and how to keep data in the EU.
---

slotmirror is software that you run in your own Cloudflare account. There is no slotmirror
service between your calendars and your deployment.

## What is stored

- The email address of each user and the account they signed in with: the tenant ID and object
  ID at Microsoft, the subject ID at Google.
- OAuth tokens for each connected account, encrypted with AES-256-GCM. The key is the secret
  `TOKEN_ENCRYPTION_KEY`.
- The names of the calendars and the rules.
- An activity log with times, counts and error codes, without event content. Entries older than
  90 days are deleted.
- A session cookie and a language cookie in the browser. While a user signs in to connect an app,
  a cookie holds that app's request for 10 minutes.
- For API tokens, if the [MCP server](/docs/mcp/) is on: a hash of each token, its last four
  characters, its name, and when it was last used. One row per user counts the tool calls and the
  database rows they read, for the day of the user's last call.
- For apps connected with OAuth: the name and redirect addresses that each app registered, a hash of
  a confidential app's secret, and for each connection the hash of its refresh token, when it was
  made and when it was last renewed. Access tokens are signed, not stored. To limit
  registrations, a counter per day keeps a keyed hash of the registering network address.

## What is not stored

Event titles, descriptions, locations and attendees are read during a sync and kept only in
memory. They are not written to D1 or to Durable Object storage. Blocks in a target
calendar contain only what the detail level of the rule allows. The default is "Busy".

## Where data is processed

On Cloudflare Workers, D1 and Durable Objects in your Cloudflare account. At Microsoft and Google
when calendars are read and written.

## Keep data in the EU

1. Create the D1 database in the EU:

   ```sh
   pnpm wrangler d1 create slotmirror --jurisdiction=eu
   ```

2. Set `DATA_JURISDICTION=eu`. The Durable Objects then run in the EU. They hold the tokens and
   run the sync, which reads event contents.

:::danger[Set it before the first account connects]
Neither setting can change for existing data. If you change `DATA_JURISDICTION` later, every
account is disconnected.
:::

## Delete data

- Each user can delete their own data under **Delete my data** in the account menu.
- Admins can delete other users on the admin page.
- If blocks cannot be removed, the calendar name, the calendar ID, the block title, the block
  count, the period and the marker stay for 90 days, so that someone can delete the blocks by hand.
  The calendar ID of a primary Google calendar is the mail address of the account. See
  [Blocks left after a disconnect](../troubleshooting/#blocks-left-after-a-disconnect).
- If all blocks of a rule are removed, the calendar name, the calendar ID and the block title go at
  once. The record of the removal stays for 90 days without them.

Both remove the accounts with their tokens, the rules, and the blocks those rules wrote from
today on. Past blocks stay in the calendars. Activity entries stay until the retention period
ends.

## The /privacy page

Each deployment has a `/privacy` page. It shows `PRIVACY_CONTACT` as the contact of the operator.
Google requires this page for a published OAuth app.

## This website and the waitlist

The statistics of slotmirror.com and the waitlist of the hosted version are described in the
[privacy notice](/privacy/) of the website. They do not concern a deployment that you run.
