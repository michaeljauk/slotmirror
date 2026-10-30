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

## Waitlist of the hosted version

The home page can show a form for the waitlist of a hosted version that does not exist yet.
Joining the list is not a purchase. The form appears only if the site was built with a waitlist
address and a Turnstile site key. Without both, the page shows no form and loads nothing for it.

- **What is stored.** The email address (trimmed, lowercase), the place of the sign-up (for example
  `website-home`), the time of the sign-up, the time of the last confirmation mail, the time of the
  confirmation, and the expiry times of two links. The two link tokens are stored only as hashes.
  Nothing else is stored: no name, no IP address, no user agent.
- **Double opt-in.** After the sign-up the Worker sends one mail with a confirm link and an
  unsubscribe link. The address counts only after the person confirms. Opening a link changes
  nothing. A button on the page sends the confirmation or the unsubscription. The Worker sends no
  other mail.
- **Deadlines.** The confirm link works for 7 days. A daily cleanup deletes unconfirmed entries
  after that time, so an entry can stay for up to 8 days. Confirmed entries stay until
  31 March 2027 and are deleted by the first cleanup after that date. The unsubscribe link works
  for 365 days.
- **Deletion.** Every mail has an unsubscribe link. It deletes the whole entry at once. The mail
  header also offers one-click unsubscribe. If the link has expired, a person can ask the operator
  to delete the entry. The page names the contact for this.
- **Protection against abuse.** Every sign-up needs a Cloudflare Turnstile check. The browser loads
  the Turnstile script from `challenges.cloudflare.com` only when the form comes into view. The
  Worker sends the Turnstile answer and the IP address of the visitor to Cloudflare to verify it.
  A daily limit of mails applies to all sign-ups together.
- **IP hash.** To limit sign-ups per network, the Worker counts attempts per hour and per day. It
  stores a hash of the IP address, built with a secret key, and not the address. For IPv6 the hash
  covers the /64 network. The counter rows are deleted by the daily cleanup once they are older
  than 24 hours. Because the cleanup runs once a day, a row stays for up to 48 hours.
- **Processors.** Cloudflare (Workers and D1 database; the database is created in the EU
  jurisdiction), Cloudflare Turnstile, and Resend, which sends the mail (sending region: EU).
- **Logs.** The Worker logs no address and no token. The invocation logs of the Worker are off,
  because the confirm and unsubscribe links carry a token in the URL.
- **Browser requests.** The browser posts the form straight to the waitlist Worker on
  `slotmirror.app`. The request does not go through the statistics proxy. The confirm and
  unsubscribe pages load no script and send nothing to PostHog.

## This website

The website slotmirror.com and its documentation use PostHog (EU Cloud, Frankfurt) for
privacy-friendly statistics. It replaces Cloudflare Web Analytics.

- PostHog runs in cookieless mode. It sets no cookie and stores nothing in the browser for
  statistics. A visitor gets no persistent ID. PostHog builds a hash from IP address, user agent
  and a daily salt, and the hash changes every day.
- The site records page views (`$pageview`) and these events: `deploy_click`, a click on a "Deploy
  to Cloudflare" button or link, and `waitlist_submit`, a submit of the waitlist form (see
  below). `waitlist_submit` is sent only on pages that show the form. It carries the page path and
  nothing else: no email address, no token and no answer of the server.
- There is no autocapture, no session replay, no survey and no feature flag. URLs are sent
  without query string and fragment.
- Only the website is measured. A slotmirror deployment that you run sends nothing to PostHog.
- The browser talks to the own domain. A Cloudflare Worker forwards the requests to PostHog and
  adds the visitor IP address as `X-Forwarded-For`. PostHog needs the IP address for the daily
  hash, and without it all visitors would look like one visitor. The Worker accepts only the
  event path (`POST /ingest/e/`) and answers every other request with 404. It forwards only the
  headers `Content-Type`, `Content-Encoding` and `User-Agent`, plus `X-Forwarded-For`. It drops all
  other headers, including cookies and authorisation headers, and stores nothing. The PostHog
  project discards the IP address after it has built the hash.
- The browser also keeps the theme choice in local storage. It is not used for tracking.

Controller: [operator name and address, to be added before launch]. Contact:
[privacy contact, to be added before launch].
