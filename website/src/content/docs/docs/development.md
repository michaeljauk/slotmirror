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

1. `POST /dev/seed?accounts=10&events=200` creates ten accounts in the block group. `events` goes up
   to 10000, and `days` sets the window of the user, the window of the simulated rules and the
   spread of the meetings.
2. `POST /dev/cycle` starts a sync cycle.
3. `GET /dev/stats` counts runs, writes, blocks and provider calls.

Without the variable, the `/dev` routes do not exist.

`pnpm capacity:probe` runs a staged load profile through these routes against a test instance
without real accounts. With `DEV_FAKE_FETCH_URL`, each simulated call also makes one real `fetch`,
so that the Workers subrequest limit applies. See `scripts/README.md` in the repository.

## The website

The website and these docs are an Astro site with Starlight in `website/`:

```sh
pnpm --filter website dev
pnpm --filter website build
```

## List what the audit log holds

`pnpm trial:report` reads the `rules` and `audit_events` tables and prints a plain list. It shows,
for each active rule, the time since the last successful run, runs that held duplicates twice in
a row, aborted runs and account pauses. It also lists alerts, comparisons and audit codes that
the script does not know. It makes no judgement: read the list and decide.

```sh
pnpm trial:report                                  # local database, last 7 days
pnpm trial:report --remote --since 3d              # deployed database
pnpm trial:report --remote --config wrangler.local.jsonc
```

- The script sends `SELECT` statements only. A test enforces this.
- Without `--remote` it reads the local database. `--remote` counts against the D1 read quota, so
  the audit read has a period (`--since`, default `7d`; also `72h` or a date) and a row limit
  (`--limit`, default 5000).
- `--config` goes to wrangler. `--db` names the database or binding (default `DB`).
- A successful run is not a dry run and has `failed` = 0 and `remaining` = 0. If the period holds
  no such run for a rule, the list says so and gives the facts: no run, only dry runs, or runs
  without success.
- A rule shows a pause when its source or its target account needs a reconnect.
- The output holds rule and account IDs, a short hash of each calendar ID, times, numbers and
  error codes. It holds no event content and no addresses.

## Contributing

[CONTRIBUTING.md](https://github.com/michaeljauk/slotmirror/blob/main/CONTRIBUTING.md) explains
the setup, the commit format and pull requests. Report vulnerabilities privately, see
[SECURITY.md](https://github.com/michaeljauk/slotmirror/blob/main/SECURITY.md).
