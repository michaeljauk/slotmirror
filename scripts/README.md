# scripts

## Capacity probe (`pnpm capacity:probe`)

Measures how much load one slotmirror instance takes before the sync fails. It runs a fixed load
profile in stages and stops at the first stage that fails. The stage before it is the answer for
`limits.md`. A local run or a run with a warning gives no statement for `limits.md`: it proves that
the script works.

### Load profile

- 1 user with 3 simulated accounts in the block group: 6 rules. Several rules share a target.
- Stages: 1,000, 2,500, 5,000 and 10,000 native events per source calendar in the window.
- Windows: 90 days (default) and one run with 365 days. The seed writes the window into the rules
  and the script compares it before it measures.
- Every target holds its native events plus the mirrors of the other accounts. All events have
  their own start and end, so every stage must create `events × 6` blocks. Events of one calendar
  and of different calendars overlap in time. The dedup rule does not merge them, because it
  compares start and end. An overlap costs no extra read or write.
- After the first sync of a stage, a burst changes 50 events of one account. The sync must update
  their 100 mirrors. A burst is a second full cycle, started by the script.

The plan asks for 3 users × 3 accounts. This profile has 1 user × 3 accounts, on purpose: a seed
works for the user of the cookie, and the mirrors of further users would use the daily row budget
without a new load on one Durable Object. Rules and alarms of one account stay the same. What
this does not show: the Worker, D1 and the account quota under 3 users at the same time.

### When a stage passes

All of these must hold after the stage start. Otherwise the stage failed.

- The sync settles before the timeout: no new provider call and no new run for `--quiet-s`.
- Every alarm step that started a rule has a finished run: `sync_run` or `sync_failed`.
- Every rule has a finished run with `failed` = 0 and `remaining` = 0 as its last run.
- No run failed, and no write failed.
- The calendars hold exactly the expected number of blocks. The script compares the counter and,
  at the end of the stage, a `COUNT(*)` per calendar.
- The burst settles, with exactly one update per mirror.

Silence is no pass. An alarm that a Worker limit stops writes no audit row, and Cloudflare repeats
it. The repeat can end with `failed` = 0, and the gaps between the repeats can be shorter than
`--quiet-s`. So each step counts on disk before it runs, and one step without a run fails the
stage. A step that a limit stops after its audit row is not found this way. Read the statuses for
that (see Manual readings).

### What it measures per stage

Convergence time (accurate to the poll of 5 seconds), number of steps (sync runs) and of started
steps, simulated provider calls, writes, blocks, failed and throttled writes, the longest step, audit rows, the rows that the
simulation writes, and the same for the burst. With a fetch target, each provider call is one
subrequest, so the report shows the sum of subrequests per stage. The profile is part of every
result. The report and its JSON block name the warnings and the times of each stage.

Once per run, `GET /dev/rpc-budget` answers if Durable Object RPC counts as a subrequest. The
Cloudflare limits page does not say. One instance fetches until the runtime refuses. Then it calls
another instance 25 times and fetches again. The report says `counted`, `not counted` or `unclear`.
The check runs from an RPC into the instance, not from an alarm. A run with `unclear` keeps its
statement, but do not use the number.

### Manual readings

The script cannot see these numbers. Read them after each day of the run, for the times in the
report. Sources were read on 2026-10-30. The Cloudflare documentation does not list all fields of
each dataset and advises GraphQL introspection for the rest.

| Number                      | Source                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| CPU time per invocation     | Worker > Observability > Invocations, field `$workers.cpuTimeMs`. Keep the highest value.                             |
| Status per invocation       | Field `outcome` in `wrangler tail`. Under load it can drop messages and shows a warning.                              |
| Worker requests by status   | GraphQL `workersInvocationsAdaptive`: `sum.requests`, `sum.subrequests`, dimension `status`.                          |
| Durable Object invocations  | GraphQL `durableObjectsInvocationsAdaptiveGroups`. Find the status field by introspection.                            |
| Durable Object subrequests  | GraphQL `durableObjectsSubrequestsAdaptiveGroups`.                                                                    |
| Durable Object CPU sum      | GraphQL `durableObjectsPeriodicGroups`, `sum.cpuTime`.                                                                |
| Durable Object rows per day | GraphQL `durableObjectsPeriodicGroups`. Find the row fields by introspection.                                         |
| D1 rows per day             | D1 > database > Metrics, or GraphQL `d1AnalyticsAdaptiveGroups`: `sum.rowsRead`, `sum.rowsWritten`, dimension `date`. |

The Worker Metrics page shows sums and quantiles. It cannot show one invocation, so it cannot say
which step ended with "Exceeded resources". Use the first two rows for that.

Questions for the run:

- **CPU limit of an alarm.** The Workers limits page names 10 ms per HTTP request and per Cron
  Trigger on the Free plan. The Durable Objects limits page names 30 seconds per invocation for
  SQLite-backed objects, alarms included. Check with `$workers.cpuTimeMs` which limit stops an alarm.
  If a step passes 10 ms and goes on, the sync does not run under the limit of 10 ms that this
  repository assumes.
- **Does `GET /dev/probe` pass its own limit?** It makes 51 fetches in a request of 10 ms CPU. If it
  answers 5xx, the script refuses to start. Repeat the request once and read the status.

### What it does not measure

- **Provider behavior.** Throttling and `Retry-After` of Graph and Google are simulated away. Write
  batches fetch a small file: the JSON of a real batch is missing. The simulation adds CPU of its
  own: it computes the native events and reads the blocks from SQLite. The read pages are always
  full, also for a read of a few events. A step therefore costs some more CPU than in production.
- **Other profiles.** See Load profile for the 3 × 3 gap. Recurring series are not part of the load.

### Fetch target

Without a real `fetch`, the simulation can never reach the limit of 50 subrequests. With
`DEV_FAKE_FETCH_URL`, every simulated page and every write batch fetches once. The variable works
only together with `DEV_FAKE_CALENDARS=1`. Without it, nothing is fetched, and the run gives no
statement for `limits.md`.

The target must belong to you, so that the load hits no foreign service.
`scripts/probe-sink/` is such a target: a Worker with static files and no script. Cloudflare
documents requests to static assets as free and unlimited.

A simulated read fetches a page in real size below the target: `pages/microsoft.json` holds 500
events, `pages/google.json` 2,500. Each event has the fields and ID lengths of the provider. The
fake parses the page with the parser of the real client, so the CPU of a large read is real. The
events of the page stay unused. Wrangler builds the pages before `dev` and `deploy`
(`scripts/probe-sink/build-pages.ts`), so they are not in the repository.

```sh
pnpm wrangler deploy -c scripts/probe-sink/wrangler.jsonc
```

A Worker cannot reach a Worker on its own zone with `fetch` (error 1042). Use one of these:

- Serve the target from another zone, for example with a custom domain.
- Deploy the test Worker with the compatibility flag `global_fetch_strictly_public`. The flag sends
  such a request through the front door of Cloudflare. Put it into `wrangler.probe.jsonc`, not into
  `wrangler.jsonc`.

### How it stays safe

- `--target` is required. There is no default instance. A remote target must use `https`, because
  every request carries the session cookie.
- The script refuses unless `GET /dev/probe` answers 200. That route exists only with
  `DEV_FAKE_CALENDARS=1` and an admin session, so a production deployment answers 404.
- `GET /dev/probe` and `POST /dev/seed` answer 409 as soon as any user of the instance has an
  account that does not match `sim-*`. So the script never runs on an instance with real calendars
  in reach.
- `GET /dev/probe` makes 51 fetches to the fetch target. On the Free plan the runtime refuses the
  51st. If it succeeds, the instance runs on a plan with a higher limit, and the script refuses to
  start, unless the target is local. This shows the subrequest limit only. A Paid account that
  lowers its own limits passes, so use an account as described in Prerequisites.
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
| 1   | 90     | 1,000, 2,500, 5,000 | 61,000              |
| 2   | 90     | 10,000              | 71,000              |
| 3   | 365    | 1,000, 2,500, 5,000 | 61,000              |
| 4   | 365    | 10,000              | 71,000              |

Start each day after 00:00 UTC, and pass the result of the day before:

```sh
pnpm capacity:probe --target <url> --window 90 --stages 10000 --passed-before 5000
```

`--passed-before` takes only the stage directly below the first stage of the command. The report
marks that value as a result of an earlier run.

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

For a capacity statement:

1. Create a **separate Cloudflare account on the Workers Free plan**. The limit of 100,000 requests
   per day applies per account, so a test Worker beside another deployment shares its quota. A
   separate Worker does not separate them. Run nothing else in that account during the run.
2. Copy `wrangler.jsonc` to `wrangler.probe.jsonc` and change it: a new `name`, the ID of a new D1
   database, and `"triggers": { "crons": [] }`. **The test Worker must have no cron.** The cron of
   `wrangler.jsonc` starts sync work every 10 minutes, and that work would count as part of the
   stage. An empty list removes the trigger; a missing `triggers` key keeps it. Use the file with
   `-c wrangler.probe.jsonc` for `deploy` and `d1 migrations apply --remote`.
3. Set `DEV_FAKE_CALENDARS=1`, `DEV_FAKE_FETCH_URL` and the sign-in settings, and create one admin
   test user. Never turn the variables on for a deployment that holds real accounts.

This run measures the Worker, the Durable Objects and D1 under the Free plan limits. It does not
measure Microsoft Graph or Google throttling, because the provider is simulated. A run against real
test accounts needs a provider variant of the probe, which does not exist yet.

### Run

```sh
export PROBE_COOKIE="<session cookie>"
pnpm capacity:probe --target https://<test-worker>.workers.dev --window 90 --stages 1000,2500,5000
```

Use `PROBE_COOKIE`: a value on the command line lands in the shell history and in the process list.
Options: `--window 90,365`, `--stages 1000,2500,5000,10000`, `--accounts 3`, `--quiet-s 20` (quiet
time that ends a stage), `--timeout-min 30`, `--daily-rows 100000`, `--passed-before <events>`. The
Markdown report goes to stdout, progress to stderr.

| Exit code | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| 0         | All stages passed. With a warning, the run gives no statement for `limits.md`.                |
| 1         | A stage failed. The report names the stage before it.                                         |
| 2         | Bad arguments, or the run does not fit into one day. Nothing started.                         |
| 3         | No test instance, real accounts, no fetch target, or a remote target above the Free limit.    |
| 4         | The run broke: a 5xx, a timeout or a different profile. The report names the stage before it. |

After exit 4 the broken stage has no verdict. A 5xx can still be a Worker limit, so read
`wrangler tail` before you repeat the stage. After a stage that did not settle, the script does not
start the next window, because queued work would run into it.

Each stage reseeds the accounts, so a stage starts from clean calendars. The Durable Objects keep
their other state between stages, so the first stage on a fresh instance is the cleanest. For a
final statement, run each window on a fresh deployment or a cleaned database. Delete the test
Worker after the run.
