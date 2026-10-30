# scripts

## Capacity probe (`pnpm capacity:probe`)

Measures how much load one slotmirror instance takes before the sync fails. It runs a fixed load
profile in stages and stops at the first stage that fails. The stage before it is the answer for
`limits.md`. Local numbers are a proof that the script works, not a capacity statement. Do not
write them into `limits.md`.

### Load profile

- 1 user with 3 simulated accounts in the block group: 6 rules. Several rules share a target.
- Stages: 1,000, 2,500, 5,000 and 10,000 native events per source calendar in the window.
- Windows: 90 days (default) and one run with 365 days. The seed writes the window into the rules
  and the script compares it before it measures.
- Every target holds its native events plus the mirrors of the other accounts. All events have
  their own time slot, so every stage must create `events × 6` blocks.

### When a stage passes

All of these must hold after the stage start. Otherwise the stage failed.

- The sync settles before the timeout: no new provider call and no new run for `--quiet-s`.
- Every rule has a finished run with `failed` = 0 and `remaining` = 0 as its last run.
- No run failed, and no write failed.
- The calendars hold exactly the expected number of blocks.

Silence is no pass. An alarm that a Worker limit stops writes no audit row, so its rule has no
finished run.

### What it measures per stage

Duration until the sync is quiet, number of steps (sync runs), simulated provider calls, writes,
blocks, failed and throttled writes, the longest step, audit rows and the rows that the simulation
writes. The profile is part of every result.

### What it does not measure

Read these from Cloudflare during the run. The script cannot see them from outside the Worker.

- **Subrequests per invocation.** Source: the Workers dashboard of the test Worker (Metrics,
  subrequests) and errors in `wrangler tail`. The script only sees the effect: a stopped step.
- **CPU time.** Source: the Workers dashboard (CPU time percentiles) and "Exceeded CPU" errors.
- **Cross-Durable-Object RPC.** A rule reads its source over RPC (`readSourceForRule`). The
  Cloudflare limits page does not say whether that counts as a subrequest. This is an open
  question, and the run does not settle it: the script does not count these calls.
- **D1 rows per day.** The report counts audit rows only. Each one writes the table and its two
  indexes, and every step reads D1 too. Source: the D1 metrics of the test database.
- **Provider behavior.** Throttling, `Retry-After` and response size of Graph and Google are
  simulated away. A simulated page has a small body, so CPU for parsing JSON is missing too.
- **Other profiles.** One user is simulated. Several users with three accounts each, and a burst
  of changes after the first sync, are not part of this run.

### Fetch target

Without a real `fetch`, the simulation can never reach the limit of 50 subrequests. With
`DEV_FAKE_FETCH_URL`, every simulated page and every write batch fetches that URL once. The
variable works only together with `DEV_FAKE_CALENDARS=1`. Without it, nothing is fetched and the
report says that the run is no capacity statement.

The target must belong to you, so that the load hits no foreign service.
`scripts/probe-sink/` is such a target: a Worker with one static file and no script. Cloudflare
documents requests to static assets as free and unlimited.

```sh
pnpm wrangler deploy -c scripts/probe-sink/wrangler.jsonc
```

A Worker cannot reach a Worker on its own zone with `fetch` (error 1042). Use one of these:

- Serve the target from another zone, for example with a custom domain.
- Deploy the test Worker with the compatibility flag `global_fetch_strictly_public`. The flag sends
  such a request through the front door of Cloudflare. Do not add it to `wrangler.jsonc`.

`GET /dev/probe` fetches the target once. If that fails, the script refuses to start.

### How it stays safe

- `--target` is required. There is no default instance.
- The script refuses unless `GET /dev/probe` answers 200. That route exists only with
  `DEV_FAKE_CALENDARS=1` and an admin session, so a production deployment answers 404.
- `GET /dev/probe` answers 409 as soon as any user of the instance has an account that does not
  match `sim-*`. So the script never runs on an instance with real calendars in reach.
- It calls only the `/dev` routes. They create and reset accounts named `sim-*`, which hold
  simulated calendars inside the Durable Objects with the token `fake`. No provider is called.
- It changes the window setting (`daysAhead`) of the admin user whose cookie it gets, and of the
  rules between simulated accounts. Use a dedicated test user.

### Free plan budget

| Store                     | Written rows per day | Read rows per day |
| ------------------------- | -------------------- | ----------------- |
| SQLite in Durable Objects | 100,000              | 5 million         |
| D1                        | 100,000              | 5 million         |

Both limits are separate and reset at 00:00 UTC (Cloudflare pricing pages, read 2026-10-30). If a
limit is reached, further operations of that type fail. That would look like a capacity limit, but
it is a limit of the test setup.

The simulated calendars live in Durable Object SQLite, so they spend the budget that a real
provider would not. To save it, the seed stores one row per account and computes the native events.
Every mirror is still one row, and an index update would be another, so `fake_blocks` has no second
index. A reseed drops the tables, because a delete bills every row.

The default run costs about 260,000 written rows. Before it starts, the script estimates the rows
per stage. If the run does not fit into one day, it starts nothing, prints one command per day and
exits with 2. The default profile takes four days:

| Day | Window | Stages              | Written rows, about |
| --- | ------ | ------------------- | ------------------- |
| 1   | 90     | 1,000, 2,500, 5,000 | 60,000              |
| 2   | 90     | 10,000              | 71,000              |
| 3   | 365    | 1,000, 2,500, 5,000 | 60,000              |
| 4   | 365    | 10,000              | 71,000              |

Start each day after 00:00 UTC, and pass the result of the day before:

```sh
pnpm capacity:probe --target <url> --cookie <cookie> --window 90 --stages 10000 --passed-before 5000
```

`--daily-rows 0` turns the check off, for example for a local run. `--daily-rows <n>` plans with a
smaller budget. The estimate covers Durable Object rows only. D1 stays far below its limit in this
profile, as the audit log gets one row per step.

### Prerequisites

The script runs TypeScript directly, so it needs Node 22.18 or newer.

Local, to try the script:

```sh
pnpm db:migrate:local
pnpm wrangler dev -c scripts/probe-sink/wrangler.jsonc --port 8788 --inspector-port 9230
# in a second terminal
pnpm wrangler dev --var DEV_FAKE_CALENDARS:1 --var DEV_FAKE_FETCH_URL:http://localhost:8788/
```

Sign in as an admin and copy the value of the `slotmirror_session` cookie from the browser. It
lives for 12 hours. A local database with connected accounts gets the 409: use a clean one with
`--persist-to <dir>`.

For a capacity statement: a separate Worker on the **Workers Free plan** with its own D1 database,
deployed with `DEV_FAKE_CALENDARS=1` and `DEV_FAKE_FETCH_URL`, and one admin test user. Never turn
the variables on for a deployment that holds real accounts. This run measures the Worker, the
Durable Objects and D1 under the Free plan limits. It does not measure Microsoft Graph or Google
throttling, because the provider is simulated. A run against real test accounts needs a provider
variant of the probe, which does not exist yet.

### Run

```sh
pnpm capacity:probe --target https://<test-worker>.workers.dev --cookie "<session cookie>" \
  --window 90 --stages 1000,2500,5000
```

Or set `PROBE_COOKIE` instead of `--cookie`. Options: `--window 90,365`,
`--stages 1000,2500,5000,10000`, `--accounts 3`, `--quiet-s 20` (quiet time that ends a stage),
`--timeout-min 30`, `--daily-rows 100000`, `--passed-before <events>`. The Markdown report goes to
stdout, progress to stderr.

| Exit code | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| 0         | All stages passed.                                                                            |
| 1         | A stage failed. The report names the stage before it.                                         |
| 2         | Bad arguments, or the run does not fit into one day. Nothing started.                         |
| 3         | The target is not a test instance, has real accounts, or cannot reach its fetch target.       |
| 4         | The run broke: a 5xx, a timeout or a different profile. The report names the stage before it. |

After exit 4 the broken stage has no verdict. A 5xx can still be a Worker limit, so read
`wrangler tail` before you repeat the stage. After a stage that did not settle, the script does not
start the next window, because queued work would run into it.

Each stage reseeds the accounts, so a stage starts from clean calendars. The Durable Objects keep
their other state between stages, so the first stage on a fresh instance is the cleanest. For a
final statement, run each window on a fresh deployment or a cleaned database. Delete the test
Worker after the run: its cron keeps syncing the simulated accounts.
