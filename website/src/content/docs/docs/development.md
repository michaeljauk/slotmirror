---
title: Local development and load tests
description: Run slotmirror locally, run the checks, and load-test the sync with simulated calendars.
---

## Run it locally

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in the values
pnpm db:migrate:local
pnpm dev
```

| Command           | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `pnpm test`       | Vitest inside the Workers runtime (`@cloudflare/vitest-plugin`)              |
| `pnpm typecheck`  | TypeScript 7                                                                 |
| `pnpm lint`       | oxlint with type-aware rules                                                 |
| `pnpm format`     | oxfmt                                                                        |
| `pnpm check`      | All of the above                                                             |
| `pnpm cf-typegen` | Generate `worker-configuration.d.ts` again after changes to `wrangler.jsonc` |

## Load tests with simulated calendars

This variable replaces Graph and Google with simulated calendars inside the Durable Objects:

```sh
pnpm wrangler dev --var DEV_FAKE_CALENDARS:1 --var DEV_FAKE_LATENCY_MS:80
```

Signed in as an admin:

1. `POST /dev/seed?accounts=10&events=200` creates ten accounts in the block group.
2. `POST /dev/cycle` starts a sync cycle.
3. `GET /dev/stats` counts runs, writes and provider calls.

Without the variable, the `/dev` routes do not exist.

## The website

The website and these docs are an Astro site with Starlight in `website/`:

```sh
pnpm --filter website dev
pnpm --filter website build
```

## Contributing

[CONTRIBUTING.md](https://github.com/michaeljauk/slotmirror/blob/main/CONTRIBUTING.md) explains
the setup, the commit format and pull requests. Report vulnerabilities privately, see
[SECURITY.md](https://github.com/michaeljauk/slotmirror/blob/main/SECURITY.md).
