<p align="center"><img src="design/logo/mark-light-bg.svg" width="72" height="72" alt=""></p>

# freebusy-sync

Mirror busy blocks between Microsoft 365 and Google calendars. Self-hosted on Cloudflare Workers,
runs on the Workers Free plan.

> **Status: early development.** The setup page, sign-in shell, webhook endpoints and storage
> exist. OAuth and the sync itself are not implemented yet.

## What it does

If you work in more than one calendar (two Microsoft 365 tenants, a work and a private Google
account, or a mix), colleagues only see the calendar they share a tenant with. freebusy-sync reads
your events in one calendar and writes a block titled "Busy" at the same time in the others.
Titles, attendees, locations and descriptions never leave the source calendar.

- Every occurrence of a recurring series is mirrored on its own, so a moved or cancelled single
  occurrence moves or removes its block.
- Changes arrive through Microsoft Graph change notifications and Google push notifications. A
  cron reconcile every 10 minutes catches anything a webhook missed.
- Blocks carry a marker, so that two-way rules do not mirror blocks back and forth.
- You run your own copy in your own Cloudflare account. Nobody else holds your tokens.

## Deploy

<!-- The button URL needs the public repository URL. -->

Requirements:

- A Cloudflare account. The Free plan is enough.
- For Microsoft 365: an app registration in Microsoft Entra ID (steps below).
- For Google Calendar: an OAuth client in Google Cloud (steps below).

### Settings

One deployment serves one person or one team. Each user signs in, connects their own calendars
and sets their own rules. Nobody sees another user's calendars.

| Name                              | Kind     | Purpose                                                                                  |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `ALLOWED_EMAILS`                  | variable | Comma-separated addresses that may sign in. For a personal deployment, your own address. |
| `ALLOWED_DOMAINS`                 | variable | Comma-separated email domains whose users may sign in, e.g. `example.com`. For a team.   |
| `ALLOWED_TENANT_IDS`              | variable | Optional. Entra tenant IDs; Microsoft sign-ins from other tenants are refused.           |
| `ADMIN_EMAILS`                    | variable | Addresses with access to the admin page (users and account counts, no calendar data).    |
| `ORG_NAME`                        | variable | Optional display name.                                                                   |
| `SESSION_SECRET`                  | secret   | At least 32 characters. Signs the session cookie. `openssl rand -base64 48`              |
| `TOKEN_ENCRYPTION_KEY`            | secret   | Base64-encoded 32-byte key for AES-GCM token encryption. `openssl rand -base64 32`       |
| `MICROSOFT_CLIENT_ID` / `_SECRET` | secret   | Entra app registration. Leave empty if you do not use Microsoft 365.                     |
| `GOOGLE_CLIENT_ID` / `_SECRET`    | secret   | Google OAuth client. Leave empty if you do not use Google Calendar.                      |

If you remove someone from these settings, their access ends at their next request.

Until all required settings are present, every dashboard page shows a setup checklist. The
checklist names missing settings and never shows values.

### Microsoft Entra app registration

_To be written._ It needs a web redirect URI on your Worker domain and the delegated permissions
`Calendars.ReadWrite`, `User.Read` and `offline_access`.

### Google OAuth client

_To be written._ Set the OAuth consent screen to **In production**. In **Testing**, Google
expires refresh tokens after 7 days.

## Free plan limits

The Workers Free plan allows 10 ms CPU time and 50 subrequests per invocation. freebusy-sync
splits each sync into one step per rule direction, so that a step stays inside these limits.
The daily quotas (100,000 Worker requests, 100,000 Durable Object requests) cover a person or a
small team. Each connected account needs a few hundred requests a day, so a large team needs
Workers Paid ($5/month).

## Development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in the values
pnpm db:migrate:local
pnpm dev
```

| Command           | Purpose                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `pnpm test`       | Vitest inside the Workers runtime (`@cloudflare/vitest-plugin`)        |
| `pnpm typecheck`  | TypeScript 7                                                           |
| `pnpm lint`       | oxlint with type-aware rules                                           |
| `pnpm format`     | oxfmt                                                                  |
| `pnpm check`      | all of the above                                                       |
| `pnpm cf-typegen` | regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |

### Architecture

- **Worker (Hono):** dashboard pages rendered with Hono JSX, OAuth callbacks, webhook endpoints,
  cron trigger.
- **D1:** orgs, users, accounts, calendars, rules and sync runs (`migrations/`). A self-hosted
  deployment has one org; its access policy follows the variables above.
- **Durable Object `AccountSync`, one per connected account:** encrypted tokens, webhook
  subscriptions, and the mapping from source events to the blocks it wrote. A rule runs in the
  instance of its target account and reads busy times from the source account's instance.

## License

[MIT](LICENSE)
