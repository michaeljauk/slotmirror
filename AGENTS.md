# AGENTS.md

Guidance for AI coding agents (Codex, Claude Code, Cursor, Copilot and others) working on this
repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

slotmirror mirrors busy blocks between Microsoft 365 and Google calendars. It runs as one
Cloudflare Worker on the Workers Free plan and is self-hosted: every deployment holds its own OAuth
tokens. Privacy is the product: by default only "Busy" crosses from one calendar to another.

## Commands

```sh
pnpm install
pnpm dev               # wrangler dev on http://localhost:8787
pnpm db:migrate:local  # apply D1 migrations to the local database
pnpm check             # format check, lint, typecheck, tests: run before every commit
pnpm test              # Vitest inside the Workers runtime
pnpm suite             # scenario suite against the simulated calendars, see suite/README.md
pnpm cf-typegen        # regenerate worker-configuration.d.ts after changing wrangler.jsonc
```

Local secrets live in `.dev.vars` (copy `.dev.vars.example`). Never commit `.dev.vars`.

## Layout

| Path                            | Content                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `src/index.tsx`                 | Hono app: middleware, pages, webhooks, cron handler                               |
| `src/routes/`                   | Route groups (OAuth in `auth.tsx`)                                                |
| `src/account-sync.ts`           | `AccountSync` Durable Object, one per connected account: tokens, mappings, alarms |
| `src/providers/`                | Microsoft Graph and Google Calendar clients, plain `fetch`                        |
| `src/access.ts`, `src/users.ts` | Orgs, users, roles, access policy                                                 |
| `src/feeds.ts`, `src/ics.ts`    | Private free/busy ICS feeds: tokens, access checks, busy events, ICS writer       |
| `src/i18n/`                     | Message catalogs. `en.ts` defines the shape; every locale must match it           |
| `src/pages/`                    | Server-rendered Hono JSX pages                                                    |
| `migrations/`                   | D1 migrations (registry: orgs, users, accounts, calendars, rules, runs)           |
| `test/`                         | Vitest tests with `@cloudflare/vitest-plugin`                                     |
| `suite/`                        | Scenario suite: frozen list in `v1/`, own oracle, drivers. Not in the Worker      |
| `design/`                       | Logo and design assets                                                            |

## Rules

- **Free plan limits are design constraints.** 10 ms CPU and 50 subrequests per invocation. Split
  work into small steps (one rule direction per Durable Object alarm). Do not add a dependency or
  loop that assumes the Paid plan.
- **Privacy.** Never log or store event titles, descriptions, attendees or locations unless a rule
  explicitly asks for that detail level. The audit log stores IDs and times, not content. Never
  log tokens.
- **Migrations are additive.** Add tables and columns. Do not drop or rename anything. Do not add
  `NOT NULL` without a default. The previous Worker must run on the new schema, because migrations
  run before the code and do not run backward. See `website/src/content/docs/docs/updating.md`.
- **Recurring events are read per occurrence** (Graph `calendarView`, Google `singleEvents=true`).
  Never sync series masters.
- **Provider calls go through `client()` in `AccountSync`.** It runs them one at a time, because
  Outlook allows four concurrent requests per mailbox and one `$batch` uses all four. Do not call
  `calendarClient()` directly or start provider calls in parallel. On 429 or 503, and on Google's
  403 `rateLimitExceeded`, wait for `Retry-After` through the alarm, never inside the invocation
  (`src/sync/throttle.ts`).
- **Every provider `fetch` goes through `providerFetch()`** (`src/providers/provider-fetch.ts`). A
  call without a deadline holds the provider queue of its account. A test fails on a bare `fetch`.
  The one exception is the operator webhook in `src/alerts.ts`, which has its own deadline.
- **Plain `fetch` for Graph and Google.** No `googleapis`, MSAL or Graph SDK: they do not fit
  workerd or the bundle.
- **No Node-only APIs.** Use Web Crypto, `fetch`, `TextEncoder`.
- **Every user-facing string goes through `src/i18n/`.** Add the key to `en.ts` and every other
  catalog; a test fails if catalogs differ.
- **Light mode only** in the UI. No `prefers-color-scheme: dark` styles.
- **Tests first for sync logic.** Every change to the sync engine needs a test, including the
  recurring-event matrix.

## Commits and pull requests

- Conventional Commits, enforced by commitlint: `type(scope): description`, lowercase description,
  header and body lines at most 100 characters.
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`.
- Do not add `Co-Authored-By` trailers.
- Pull requests are squash-merged; the PR title becomes the commit message and must follow the same
  format.
