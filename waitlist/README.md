# slotmirror waitlist

A separate Worker with its own D1 database. It serves the waitlist of the hosted version on
`slotmirror.app`. It is not part of the self-hosted app and shares no code or data with it.
The form on `slotmirror.com` posts to this Worker.

Free plan limits apply: one D1 round trip per step, no loops over rows, no Durable Objects.

## Flow

1. The form posts to `POST /api/signup` with a Turnstile token.
2. The Worker stores the normalized address (trim, lowercase) as unconfirmed and sends one mail
   through Resend. The mail holds a confirm link and an unsubscribe link.
3. The link opens a landing page. A GET changes nothing. The button on the page sends a POST.
   This stops mail scanners from confirming an address.
4. Unconfirmed entries are deleted after 7 days. Confirmed entries stay until `RETENTION_UNTIL`.

## Endpoint

`POST https://slotmirror.app/api/signup`

Body, JSON (`content-type: application/json`):

```json
{ "email": "ada@example.com", "source": "website-hero", "turnstileToken": "<token>" }
```

A form post (`application/x-www-form-urlencoded`) works too. Use the fields `email`, `source` and
`cf-turnstile-response`, which the Turnstile widget adds by itself.

- `source` says where the sign-up came from: 1 to 40 characters of `a-z 0-9 _ . : -`. Anything
  else is stored as `unknown`. The first source of an address stays.
- Every submit needs a fresh Turnstile token. A token works once. After an error, reset the widget.
- Allowed origins are listed in `ALLOWED_ORIGINS`. Other origins get no CORS headers and a 403.

Success: `200 {"status":"check_inbox"}`. The answer is the same for a new address, an unconfirmed
address and a confirmed address. Show "Check your inbox" in all three cases.

Errors: RFC 9457 body (`application/problem+json`) with a stable `code`. Keep the typed email in the
form for every error.

| Status | `code`                 | Meaning and form text                                       |
| ------ | ---------------------- | ----------------------------------------------------------- |
| 400    | `invalid_request`      | Body unreadable. Should not happen from the form.           |
| 400    | `invalid_email`        | Ask for a valid address.                                    |
| 403    | `origin_not_allowed`   | The form runs on a host that is not allowed.                |
| 403    | `turnstile_failed`     | Reset the widget and offer "Try again".                     |
| 429    | `rate_limited`         | Too many attempts from this network. `Retry-After` is 3600. |
| 503    | `mail_unavailable`     | Daily mail cap reached or Resend failed. Try again later.   |
| 503    | `server_misconfigured` | A secret is missing. Not for users.                         |

Suggested form states: Turnstile loading, "Sending...", success, error with the input kept, and the
note "The hosted version does not exist yet. Joining the list is not a purchase."

Rules for the website when it posts the form:

- Send the request from the browser to the `.app` host. Do not proxy it through the PostHog proxy.
- The Turnstile widget needs the hosts `slotmirror.com` and `slotmirror.app` (and `www`, if used).
- The confirm and unsubscribe pages live on `slotmirror.app` and load no script. Never send these
  URLs to PostHog. If a page on the website ever receives a `t` token, drop the query string
  before it calls `capture`.

## Pages

| Path                     | GET                             | POST                 |
| ------------------------ | ------------------------------- | -------------------- |
| `/confirm?t=<token>`     | Page with a confirm button      | Confirms the address |
| `/unsubscribe?t=<token>` | Page with an unsubscribe button | Deletes the entry    |

States: confirmed, already confirmed, expired (410, sign up again), not valid (400), unsubscribed.
All pages are `noindex`, `no-store` and send `Referrer-Policy: no-referrer`.

A mail client can post to `/unsubscribe?t=<token>` directly. This is the one-click unsubscribe of
RFC 8058. Each mail has `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.

## Limits and privacy

- Tokens have 128 random bits and are stored as SHA-256 hashes. A confirm token expires after
  7 days. An unsubscribe token expires after 365 days.
- A new sign-up for an unconfirmed address sends a new mail at most once in 10 minutes. The new mail
  replaces the old links. If the last mail failed, the next sign-up sends it again.
- The global cap is `DAILY_MAIL_CAP` mails per UTC day. A reserved mail counts, also if Resend
  fails. At the cap the API answers `mail_unavailable`. The log holds only the cap number.
- The IP limit is `SIGNUPS_PER_IP_PER_HOUR` per hour. It runs on a D1 counter keyed by a hash of
  the IP address and `HASH_PEPPER` (IPv6 per /64). The Worker stores no plain IP address.
- The Workers Rate Limiting binding is optional. Cloudflare does not say whether it runs on the
  Workers Free plan. If you add the binding `RATE_LIMITER` (see `wrangler.jsonc`), it is used as a
  second limit. The D1 counter always applies.
- The Worker logs no address and no token. Workers Logs is off, because invocation logs record the
  request URL and confirm links hold a token.

## Set up

All steps need a Cloudflare, Resend or Turnstile account. Nothing here ran in production.

```sh
cd waitlist
pnpm install
pnpm wrangler d1 create slotmirror-waitlist      # put the ID into wrangler.jsonc
pnpm wrangler secret put RESEND_API_KEY
pnpm wrangler secret put TURNSTILE_SECRET
pnpm wrangler secret put HASH_PEPPER             # e.g. the output of: openssl rand -base64 32
pnpm deploy
```

Then add the custom domain `slotmirror.app` to the Worker. Verify the sending domain in Resend and
pick an EU region for it. Create a Turnstile widget for `slotmirror.com` and `slotmirror.app`.

Local development: copy `.dev.vars.example` to `.dev.vars`, run `pnpm db:migrate:local`, then
`pnpm dev`. Turnstile has test keys for local runs.

## Tests

`pnpm check` runs the typecheck and the tests in the Workers runtime. The tests mock Resend and
Turnstile. No mail goes out. The root `pnpm check` runs this too.
