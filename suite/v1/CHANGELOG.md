# Changelog of suite v1

Changes to the list after the freeze on 2026-10-30 and before the first publication. Every reason is
a finding of the review of that date, not a result. No change removes a scenario or weakens a target
state.

## Added scenarios

| Scenario                    | Reason                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `private-event-full-detail` | `private-event` stays green without the rule that private events show nothing: the default level copies nothing.    |
| `privacy-description`       | The list checked title, location and attendee, but not the description.                                             |
| `window-past-block-delete`  | The review suspects that a block stays if its event ends before midnight UTC and goes after it. No scenario had it. |
| `working-hours-other-date`  | `working-hours` has no event whose date differs between UTC and the zone of the hours.                              |

## Changed scenarios

| Scenario                    | Change                                                                  | Reason                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `window-edge-all-day`       | `advance` lands five minutes off the 10-minute grid, new `expect-calls` | The deadline of the wait fell on the cron tick. The tick set its alarm 5 s behind the deadline, so no cycle ran before the check that the block stays. |
| `window-start-edge`         | The same                                                                | The same                                                                                                                                               |
| `window-edge-all-day`       | `requires` adds `provider-calls`                                        | The new `expect-calls` step counts calls. A driver without this capability gets `not_run`.                                                             |
| `window-start-edge`         | The same                                                                | The same                                                                                                                                               |
| `window-start-edge`         | `expectedText` says five minutes instead of ten minutes                 | The text named another time than the `advance`. The target state does not change.                                                                      |
| `disconnect-target`         | New `settleSeconds`, new `localLimit`                                   | The wait ended with the removal of the block, before the account was gone. The check now holds after the disconnect has ended.                         |
| `buffer`                    | New `noDuplicates`                                                      | Coverage alone does not see two blocks with the same times.                                                                                            |
| `series-occurrence-deleted` | New `noDuplicates`                                                      | The same                                                                                                                                               |
| `private-event`             | New `noDuplicates`                                                      | The same                                                                                                                                               |
| `buffer`                    | New `settleSeconds`                                                     | `noDuplicates` saw only the first cycle. 4300 s span an hourly cycle on a 10-minute grid, so a block from a later cycle shows.                         |
| `private-event`             | New `settleSeconds`                                                     | The same                                                                                                                                               |
| `loop-both-directions`      | `settleSeconds` 4300 instead of 3700, `expectedText` says 4300 s        | Tightened before the first publication. In a local run, 3700 s ended before the next hourly cycle, so no second cycle ran. The target state stays.     |
| `window-edge-all-day`       | `expectedText` says 03:05 UTC instead of 03:00 UTC                      | The text named another time than the `advance`. The target state does not change.                                                                      |
| See below                   | New `localLimit`                                                        | A local pass must say what it does not show.                                                                                                           |
| All with `measure`          | `measure` removed                                                       | The runner discarded the value, so the field changed no result.                                                                                        |

`localLimit` is new in `dst-spring`, `dst-fall`, `midnight-other-zone`, `loop-both-directions`,
`throttled-read` and `disconnect-target`.

## Format

- `required` in an expectation: text that at least one entry must hold.
- `expect-calls` step: the proof that a cycle ran before a check.
- `detail` in a rule, with the capability `detail-levels`: how much of an event the rule copies.
- `localLimit` in a scenario: see `README.md`.
