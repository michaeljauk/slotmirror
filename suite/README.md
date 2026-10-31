# Scenario suite

An open test suite for tools that mirror busy time between calendars. It checks one thing: is the
target calendar busy where the source calendar is busy, and free where the source is free? The list
is frozen per version. Any tool can run against it through a driver.

## What it checks

`v1/` holds 32 scenarios: single events, moves, deletes, series with exceptions, all-day and
multi-day events, daylight saving, zones, free and cancelled events, private events, working hours,
buffers, loop protection, the edges of the sync window, throttling, partial write failures, paused
and disconnected accounts, and data that must never reach the target.

Each scenario holds a hand-written target state. The suite computes coverage as a union of intervals
in `lib/coverage.ts`. It imports nothing from the tool, so it cannot share a fault with it. Merged
blocks are no failure. See `v1/README.md` for the format.

## Limits

- The local driver simulates the provider. It covers the sync engine and the parsers of provider
  events. It does not cover the provider API, webhooks, the encoders of block writes, or the
  `Retry-After` header.
- A local pass does not show the following. The field `local_limit` of a result repeats this for
  each scenario:
  - The simulation flags every block as a mirror itself. How the tool recognises its own blocks in
    a real calendar stays unchecked (`loop-both-directions`).
  - Both directions raise the read error of one calendar system. The error path of the other system
    stays unchecked (`throttled-read`).
  - The simulation expands series and resolves zones itself. So `dst-spring`, `dst-fall` and
    `midnight-other-zone` test the simulation, and only a live run shows a real calendar.
  - The simulated calendar goes with a disconnected account. The last check of `disconnect-target`
    reads a snapshot from before the last alarm, and a delete in that alarm would stay unseen.
- Latency from a local run is a self-test of the runner. The result leaves `p50Ms` and `p95Ms` empty
  and gives the value as `selfTestMs`.
- A timed block with status free counts as free. So a tool that mirrors free events as free blocks
  passes `free-transparent`. A block that changes its identity on a move passes too, because it
  covers the right time.

## Run it locally

```sh
pnpm suite                         # all scenarios and the latency self-test
pnpm suite --scenario event-moved  # one scenario
```

The run needs no secrets and no account. It uses Vitest in the Workers runtime, so that the real
`AccountSync` runs its alarms against the simulated calendars. Every scenario runs in both
directions. The exit code is 0 only if at least one scenario passed and none failed, so a run
without an executed scenario fails too. A scenario that is red through a known fault of the tool
therefore keeps this exit code at 1. The result lands in `results/`, see `results/README.md`. A run
commits nothing.

`pnpm suite:gate` is the gate over all scenarios, for `pnpm check` and CI. It runs all scenarios
locally and compares the result with `known-red.json`. Each entry of that file names a scenario,
its `reason`, its `issue` (`TBD` until an issue exists) and the `step` that fails. The gate is red in
these cases:

- A scenario outside the list is red, in any direction.
- A scenario was not run, or has no result.
- A scenario of the list is green in any direction. Remove its entry in the commit of the fix.
- A scenario of the list fails in another step than its entry says, so the cause is another one.
- An exception stopped a run, in any direction. The field `stopped` of the result says so. A stop is
  no known red, also in the step of the entry: the check of that step did not run.
- The list itself has a fault: no reason, no issue, no step, or an unknown scenario.

The freeze rule stands: the list records a red scenario and changes no scenario.

`pnpm suite:proof` shows that the checks can fail. It disturbs the engine, for each class of fault,
and expects a red scenario through the local driver: a block is missing, too many, moved, a text
leaks, a foreign event goes, a later cycle writes a block again. Each case also fixes the step in
which the fault shows, so a fault that hits an earlier step does not count. It covers only the
scenarios that it names, and the gate covers the list. `pnpm check` runs both.

## Run it against another tool

Prerequisites: two test calendars that hold nothing else, one in each system, and the tool set up
between them. Never use calendars with real events.

```sh
pnpm suite --driver live --command "<adapter command>" [--scenario <id>] [--allow-foreign <ids>]
```

A lock protects a calendar in two parts:

- An adapter deletes only entries with the suite marker. `prepare`, `write` and `cleanup` carry the
  marker as `marker`. A `write` stores it in the event, and `read` reports it as `owner`.
- Before each `prepare`, the suite reads both calendars from 35 days back to 400 days ahead. An entry
  is foreign unless its `owner` is exactly `suite` or `tool`, so `null` or an unknown value is
  foreign too. The run then stops before the adapter gets the `prepare`. Only `--allow-foreign` with
  the `id` of each foreign entry lets the run go on. The checks then ignore these foreign entries,
  and no entry with the owner `suite` or `tool`. A result gives the number of named IDs as
  `driver.allowForeign`. Every foreign entry must stay for the whole run, also one that comes during
  a scenario. The suite keeps each one per calendar, `owner` and ID, from the first read that shows
  it. A read of a scenario counts too. An entry without an ID counts by its times. The suite reads
  both calendars before and after each `prepare` and before each `cleanup`. After a `cleanup` it reads
  them again only if it keeps a foreign entry. If an entry disappears or its `owner` changes, the run
  stops. After such a fault, or a failed read before a `cleanup`, the adapter gets
  no `cleanup`.

The adapter is your program. The suite starts it once per request, with one JSON object on stdin,
and reads one JSON object from stdout. It holds your credentials and calendar IDs, and the repository
holds none. `drivers/example-adapter.ts` shows the protocol, and `drivers/live.ts` has its types.

| `op`             | Request fields                    | `value` of the answer                         |
| ---------------- | --------------------------------- | --------------------------------------------- |
| `describe`       | none                              | `{ name, mode, directions?, capabilities? }`  |
| `prepare`        | `scenario`, `direction`, `marker` | none: marked entries gone, rule and zones set |
| `write`          | `calendar`, `change`, `marker`    | none                                          |
| `read`           | `calendar`, `window`              | a list of calendar entries                    |
| `control`        | `control`                         | none                                          |
| `faults-fired`   | none                              | true or false                                 |
| `provider-calls` | `calendar`                        | calls so far, a whole number from 0           |
| `cleanup`        | `marker`                          | none                                          |

- `calendar` is `source` or `target`.
- On every error, the adapter ends with an exit code other than 0 and writes the reason to stderr.
  It never answers an error with `{ "value": [] }`. The suite cannot tell that answer from an empty
  calendar, so the lock would see no foreign entry and the run would go on.
- `read` always gives a list, `[]` for an empty calendar. If `value` is missing, is no list, or holds
  something other than objects, the whole run stops: this is a fault of the adapter, not of the tool.
- stdout holds one JSON object, or nothing for an answer without a value. Any other output stops the
  whole run, and the error does not repeat it.
- If a `read` of the lock fails, the whole run stops: without that read the lock protects nothing. If
  a `read` in a check fails, only that scenario stops, with `stopped: true` in the result.
- `mode` is required: `real-time` for real calendars, `simulated-clock` if the calendars or the clock
  are not real. A simulated adapter gets no latency values, as in a local run. The suite cannot verify
  the statement of the adapter, so a result says `modeSource: adapter`.
- A calendar entry holds `start`, `end`, `allDay`, `status` and the text fields. Add `id`, and `owner`
  with `suite` for an entry with the marker or `tool` for a block of the tool under test.
- An answer `{ "unsupported": "<reason>" }` makes the scenario `not_run`.
- A scenario that `requires` a capability the adapter does not list is `not_run`. Scenarios that
  need `clock` cannot run live, because the live driver cannot move time.
- A scenario with `expect-calls` or `expect-no-calls` stops the whole run if `provider-calls` gives no
  count or a count that falls. The run then has no result: this is a fault of the adapter, not of the
  tool.
- Adapters use the same driver interface as the local run: `SuiteDriver` in `lib/scenario.ts`. A
  driver in TypeScript can implement it directly.

The lock has two limits, and only the adapter can close them:

- The suite knows a calendar only as `source` or `target`, never its real identity. So the adapter
  fixes its calendar IDs and does not change them during a run.
- The suite cannot close the gap between its last read and the delete. An entry that comes in this
  gap and goes with the `cleanup` stays unseen. So `cleanup` deletes only entries that hold the
  adapter's own marker.

A live run also samples latency: 20 changes per direction, from the write until the target shows it.
A sample that times out counts as the limit of 900 s, and the result then says `incomplete`. The
suite reads the target every 10 s, and a sample ends at the first read that shows the change. So
`p50Ms` and `p95Ms` lie on that grid and can be up to 10 s too high. The result gives the grid as
`latency.pollMs`.

## Freeze rule

The list and the target states come before any result. See `v1/README.md`, and
`v1/CHANGELOG.md` for the changes of the review before the first publication. A result does not
change the list. A red scenario stays red until the tool is fixed, or a commit says why the scenario was
wrong.
