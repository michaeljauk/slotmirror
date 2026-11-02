# Suite v1

The list and the target states of this version, frozen on 2026-10-30. `manifest.json` names the
scenarios and their order. Each file in `scenarios/` holds one scenario and its hand-written target
state. No target state comes from the code of a tool.

## Freeze rule

A commit may change a scenario or its target state, or remove a scenario, only if it says so and
gives the reason. A result is no reason by itself. If a scenario is red because the tool behaves
wrongly, it stays red. A larger change gets a new version folder.

Before the first publication, a review may tighten this version. Such a change removes no scenario,
weakens no target state, and stands in `CHANGELOG.md` with the review finding that is its reason.

## What a scenario checks

Scenarios check coverage in time: the target must be busy where the source is busy and free where
the source is free. The suite computes the union of all busy entries, so merged blocks are no
failure. It does not count "one event, one block". `noDuplicates` is the only exception: two entries
with exactly the same times are a failure.

`expect.busy` and `expect.busyDates` together give all busy time in `expect.window`. All other time
in the window must be free. An expectation with `forbidden` and `minEntries` only checks data.
`required` names text that at least one entry must hold, so that a rule that should copy details
cannot pass without copying them.

`localLimit` says in one sentence what a run on simulated calendars cannot show for this scenario.
It does not change the target state, and a result repeats it as `local_limit`.

## Time expressions

`<anchor>[+Nd|-Nd][@HH:MM[Z]]`

| Anchor       | Meaning                                                 |
| ------------ | ------------------------------------------------------- |
| `today`      | The UTC date of the start of the scenario               |
| `week`       | The first Monday at least seven days ahead              |
| `dst-spring` | The next date on which the offset of `anchorZone` rises |
| `dst-fall`   | The next date on which the offset of `anchorZone` falls |

- With `Z`, the expression is an instant in UTC. Every target state uses this form.
- Without `Z`, it is a wall-clock time in the `timeZone` of the event.
- Without `@`, it is a date. All-day events and `busyDates` use this form, and an end is exclusive.

The expressions keep the list independent of the day of the run, so that a run against real
calendars can use the same list.

## Steps

| Step              | Effect                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| `write`           | Change an event: `create`, `update`, `delete`, or one occurrence of a series  |
| `sync`            | Wait for the tool until `expect` holds, let `settleSeconds` pass, check again |
| `expect`          | Check now                                                                     |
| `control`         | Inject a fault or change the state of an account                              |
| `wait-for-fault`  | Wait until the tool ran into the injected fault                               |
| `expect-no-calls` | Let `seconds` pass and check that the tool made no call to that calendar      |
| `expect-calls`    | Let `seconds` pass and check that the tool made a call to that calendar       |
| `advance`         | Move the clock                                                                |

`requires` lists what a driver must offer for the scenario. Without it, the scenario is `not_run`.
