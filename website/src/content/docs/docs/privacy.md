---
title: Privacy and data location
description: What slotmirror stores, what it does not store, and how to keep data in the EU.
---

slotmirror is software that you run in your own Cloudflare account. There is no slotmirror
service between your calendars and your deployment.

## What is stored

- The email address of each user and, for Microsoft accounts, the tenant ID.
- OAuth tokens for each connected account, encrypted with AES-256-GCM. The key is the secret
  `TOKEN_ENCRYPTION_KEY`.
- The names of the calendars and the rules.
- An activity log with times, counts and error codes, without event content. Entries older than
  90 days are deleted.
- A session cookie and a language cookie in the browser.

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

Both remove the accounts with their tokens, the rules, and the blocks those rules wrote from
today on. Past blocks stay in the calendars. Activity entries stay until the retention period
ends.

## The /privacy page

Each deployment has a `/privacy` page. It shows `PRIVACY_CONTACT` as the contact of the operator.
Google requires this page for a published OAuth app.

## This website

The website slotmirror.com and its documentation use PostHog (EU Cloud, Frankfurt) for
privacy-friendly statistics. It replaces Cloudflare Web Analytics.

- PostHog runs in cookieless mode. It sets no cookie and stores nothing in the browser for
  statistics. A visitor gets no persistent ID. PostHog builds a hash from IP address, user agent
  and a daily salt, and the hash changes every day.
- The site records page views and three events: a click on "Deploy to Cloudflare", a submit of the
  waitlist form, and a click from the test-suite page to the quickstart.
- There is no autocapture, no session replay, no survey and no feature flag. URLs are sent
  without query string and fragment.
- Only the website is measured. A slotmirror deployment that you run sends nothing to PostHog.
- The browser talks to the own domain. A Cloudflare Worker forwards the requests to PostHog and
  adds the visitor IP address as `X-Forwarded-For`. PostHog needs the IP address for the daily
  hash, and without it all visitors would look like one visitor. The Worker removes cookies and
  authorisation headers and does not store anything. The PostHog project discards the IP address
  after it has built the hash.
- The browser also keeps the theme choice in local storage. It is not used for tracking.

Controller: [operator name and address, to be added before launch]. Contact:
[privacy contact, to be added before launch].
