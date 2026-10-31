import { describe, expect, it } from "vitest";
import { CRON_TICK_MS, isHourlyTick, SILENCE_CHECK_SUBREQUESTS } from "../src/alerts";
import { accountsToTick, MIN_CRON_TICKS } from "../src/cron";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The top of an hour. */
const START = Date.parse("2026-11-02T00:00:00.000Z");

function accounts(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `a-${String(index).padStart(4, "0")}`);
}

/** The ticks that the cron gives in `invocations` with or without the hourly check. */
function ticksOver(ids: string[], invocations: number, withCheck: boolean) {
  const ticks = new Map<string, number[]>(ids.map((id) => [id, []]));
  for (let index = 0; index < invocations; index++) {
    const time = START + index * CRON_TICK_MS;
    const budget = MIN_CRON_TICKS + SILENCE_CHECK_SUBREQUESTS;
    const limit = withCheck && isHourlyTick(time) ? MIN_CRON_TICKS : budget;
    const turn = accountsToTick(ids, time, limit);
    expect(turn).toHaveLength(Math.min(limit, ids.length));
    expect(new Set(turn).size).toBe(turn.length);
    for (const id of turn) ticks.get(id)?.push(time);
  }
  return ticks;
}

/** As `AccountSync.tick`: a full cycle starts at the first tick after one hour, 5 seconds later. */
function cyclesOf(ticks: number[], phase: number): number[] {
  const cycles: number[] = [];
  let last = START - phase;
  for (const time of ticks) {
    if (time - last < HOUR) continue;
    last = time + 5_000;
    cycles.push(last);
  }
  return cycles;
}

function largestStep(times: number[], over = 1): number {
  let largest = 0;
  for (let index = over; index < times.length; index++) {
    largest = Math.max(largest, (times[index] ?? 0) - (times[index - over] ?? 0));
  }
  return largest;
}

describe("rotation of cron ticks", () => {
  // Accounts, minutes between ticks, minutes between full cycles, and over two cycles.
  it.each([
    [45, 20, 80, 160],
    [49, 20, 80, 160],
    [88, 20, 80, 160],
    [100, 30, 90, 180],
    [704, 160, 170, 340],
    [744, 170, 180, 360],
  ])("gives %i accounts a tick every %i minutes", (count, tick, cycle, twoCycles) => {
    const days = 4;
    for (const withCheck of [true, false]) {
      const ticks = ticksOver(accounts(count), days * 24 * 6, withCheck);
      for (const [id, times] of ticks) {
        expect([id, largestStep(times) <= tick * MINUTE]).toEqual([id, true]);
        for (const phase of [0, 17 * MINUTE, 43 * MINUTE, 59 * MINUTE]) {
          // The first cycles still depend on the phase, not on the rotation.
          const cycles = cyclesOf(times, phase).slice(3);
          expect(largestStep(cycles)).toBeLessThanOrEqual(cycle * MINUTE);
          expect(largestStep(cycles, 2)).toBeLessThanOrEqual(twoCycles * MINUTE);
        }
      }
    }
  });

  it("keeps the rule of the 3 hours for 704 accounts, and no more for 744", () => {
    const longestCycle = (count: number) =>
      Math.max(
        ...[...ticksOver(accounts(count), 4 * 24 * 6, true).values()].map((times) =>
          largestStep(cyclesOf(times, 0).slice(3)),
        ),
      );
    expect(longestCycle(704)).toBeLessThan(3 * HOUR);
    expect(longestCycle(744)).toBeGreaterThanOrEqual(3 * HOUR);
  });

  it("returns all accounts within the limit, in their order", () => {
    const ids = accounts(40);
    expect(accountsToTick(ids, START + 7 * CRON_TICK_MS, 44)).toEqual(ids);
  });

  it("starts in the same place at the same time, whatever the seconds", () => {
    const ids = accounts(100);
    expect(accountsToTick(ids, START + 59_000, 48)).toEqual(accountsToTick(ids, START, 48));
  });

  /** The first account of each invocation in one round, as a place in the list. */
  const starts = (count: number) => {
    const ids = accounts(count);
    const rounds = Math.ceil(count / MIN_CRON_TICKS);
    return Array.from({ length: rounds }, (_, index) =>
      ids.indexOf(accountsToTick(ids, START + index * CRON_TICK_MS, 44)[0] ?? ""),
    );
  };

  it("moves the start by one place at most if the number of accounts changes by one", () => {
    const before = starts(100);
    const after = starts(101);
    expect(after).toHaveLength(before.length);
    after.forEach((place, index) => {
      expect(Math.abs(place - (before[index] ?? 0))).toBeLessThanOrEqual(1);
    });
  });

  it("changes the length of a round only at a multiple of the ticks", () => {
    expect(starts(MIN_CRON_TICKS * 3)).toHaveLength(3);
    expect(starts(MIN_CRON_TICKS * 3 + 1)).toHaveLength(4);
  });
});
