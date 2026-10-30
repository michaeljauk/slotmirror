# scripts

## Capacity probe (`pnpm capacity:probe`)

Measures how much load one slotmirror instance takes before the sync fails. It runs a fixed load
profile in stages and stops at the first stage that fails. The stage before it is the answer for
`limits.md`. Local numbers are a proof that the script works, not a capacity statement. Do not
write them into `limits.md`.

### Load profile

- 3 simulated accounts in the block group: 6 rules. Several rules share a target.
- Stages: 1,000, 2,500, 5,000 and 10,000 native events per source calendar in the window.
- Windows: 90 days (default) and one run with 365 days.
- Every target holds its native events plus the mirrors of the other accounts.
- A stage passes if the sync settles before the timeout and no sync run or write fails.

### What it measures per stage

Duration until the sync is quiet, number of steps (sync runs), simulated provider calls, writes,
failed and throttled writes, the longest step, and audit rows. The profile is part of every
result.

Not measured by the script: CPU time and the real subrequests per invocation. The Worker does
not report them to the caller. Read them from the Cloudflare dashboard (Workers metrics, CPU time
percentiles) or `wrangler tail` for "Exceeded CPU" errors during the run.

### How it stays safe

- `--target` is required. There is no default instance.
- The script refuses unless `GET /dev/probe` answers 200. That route exists only with
  `DEV_FAKE_CALENDARS=1` and an admin session, so a production deployment answers 404.
- It calls only the `/dev` routes. They create and reset accounts named `sim-*`, which hold
  simulated calendars inside the Durable Objects with the token `fake`. No real calendar is
  written, and no provider is called.
- It changes the window setting (`daysAhead`) of the admin user whose cookie it gets. Use a
  dedicated test user.

### Prerequisites

Local, to try the script:

```sh
pnpm db:migrate:local
pnpm wrangler dev --var DEV_FAKE_CALENDARS:1   # in a second terminal
```

Sign in as an admin and copy the value of the `slotmirror_session` cookie from the browser. It
lives for 12 hours.

For a capacity statement: a separate Worker on the **Workers Free plan** with its own D1
database, deployed with `DEV_FAKE_CALENDARS=1`, and one admin test user. Never turn the variable
on for a deployment that holds real accounts. This run measures the Worker, the Durable Objects
and D1 under the Free plan limits. It does not measure Microsoft Graph or Google throttling,
because the provider is simulated. A run against real test accounts needs a provider variant of
the probe, which does not exist yet.

### Run

```sh
pnpm capacity:probe --target https://<test-worker>.workers.dev --cookie "<session cookie>"
```

Or set `PROBE_COOKIE` instead of `--cookie`. Options: `--window 90,365`,
`--stages 1000,2500,5000,10000`, `--accounts 3`, `--quiet-s 20` (quiet time that ends a stage),
`--timeout-min 30`. The Markdown report goes to stdout, progress to stderr. Exit code 0: all
stages passed. 1: a stage failed. 2: bad arguments. 3: the target is not a test instance.

Each stage reseeds the accounts, so a stage starts from clean calendars. The Durable Objects keep
their mapping state between stages, so the first stage on a fresh instance is the cleanest. For a
final statement, run each window on a fresh deployment or a cleaned database.
