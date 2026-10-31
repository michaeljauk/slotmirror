# Results

A run writes one file `<time>-<driver>.json` here. Git ignores these files, so a run commits nothing.
To publish a result, add its file with `git add -f`.

| Field          | Content                                               |
| -------------- | ----------------------------------------------------- |
| `suiteVersion` | The version folder, for example `v1`                  |
| `frozenAt`     | Freeze date of that version                           |
| `commit`       | Full commit SHA of the run                            |
| `dirty`        | True if tracked files differ from that commit         |
| `listHash`     | SHA-256 over the files of the version folder          |
| `runAt`        | ISO time of the run                                   |
| `driver`       | `{ name, mode, modeSource, allowForeign }`, see below |
| `scope`        | `all`, or `selected` for a run with `--scenario`      |
| `summary`      | `{ pass, fail, not_run }`: scenarios per status       |
| `scenarios`    | One entry per scenario, in the order of the manifest  |
| `latency`      | Latency, or null for a run with `--scenario`          |

`mode` is `real-time` or `simulated-clock`. `modeSource` is `driver`, or `adapter` if an outside
program stated the mode. The suite cannot verify such a statement, so read it as a statement.
`allowForeign` is the number of IDs that `--allow-foreign` named, so 0 without that option. The checks
of the run do not see foreign entries with these IDs.

An entry of `scenarios`:

| Field          | Content                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `id`           | Name of the file in `v1/scenarios/`                                                                |
| `title`        | One line for the table                                                                             |
| `covers`       | The item of the coverage list                                                                      |
| `status`       | `pass`, `fail` or `not_run`. A failed direction makes the entry `fail`                             |
| `stopped`      | True if an exception ended a run, so that no check failed. Then `fail` says nothing about the tool |
| `expectedText` | The hand-written target state in words                                                             |
| `local_limit`  | What a pass does not show on simulated calendars, or null                                          |
| `expected`     | `{ window, busy, checks }` of the last check, or null if none ran                                  |
| `observed`     | `{ window, busy }` of what the calendar showed                                                     |
| `text`         | `As expected.`, or what went wrong                                                                 |
| `durationMs`   | Real run time of all directions                                                                    |
| `failedStep`   | The number of the step that stopped the run, from 1, else null                                     |
| `directions`   | The same fields per direction, plus `direction`                                                    |

`window` is `{ start, end }`, and `busy` is a list of them, as ISO instants in UTC. A failed check
stops its scenario, so `expected` and `observed` then show the check that failed.

`checks` is `times`, or `data` for a check that looks at text only. Such a check has no target state
for times: its `busy` is null, and its `observed` only shows what the calendar held.

`latency`:

| Field                 | Content                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- |
| `mode`                | `simulated-clock`: the calendars or the clock are not real                             |
| `samplesPerDirection` | Samples per direction, timeouts included. The plan asks for 20                         |
| `timedOut`            | Samples that reached the limit. They count as the limit                                |
| `incomplete`          | True if a sample timed out or a direction lacks samples                                |
| `pollMs`              | The grid of the samples: a value can be this much too high. Null without polling       |
| `p50Ms`, `p95Ms`      | Time from the write until the target shows it, nearest rank. Null in `simulated-clock` |
| `selfTestMs`          | `{ p50, p95 }` in `simulated-clock`, else null. No measurement of delay                |

## Result on the website

The page `website/src/pages/_suite.astro` renders at build time from exactly one file:
`website/src/data/suite-result.json`. It also reads `suite/v1/manifest.json`, the scenario files
and `known-red.json`. The page holds no figure of its own.

The underscore keeps the page out of the website build. The page links each scenario to the commit
of the run, so the first publication needs a run from a commit on `main`. Rename the page to
`suite.astro` for that publication.

To publish a run:

1. Run `pnpm suite`. The result lands in `suite/results/`.
2. Copy that file to `website/src/data/suite-result.json`, replacing the old one.
3. Run `pnpm check`. `pnpm suite:published` and `test/suite-page.test.ts` fail if the file has a wrong
   form, contradicts itself, does not match the manifest or the files of `suite/v1` (`listHash`), or
   shows a red scenario that `known-red.json` does not explain. The website build stops on the first
   three.
4. Commit the file.

A file from the local driver (`simulated-clock`) makes the page show a banner: simulated run
against a fake calendar, not a live run. The page shows p50 and p95 only for a result with
`driver.mode` and `latency.mode` both `real-time`, a complete sample set, and both percentiles set.
