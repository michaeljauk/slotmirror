import { CRON_TICK_MS, SILENCE_CHECK_SUBREQUESTS } from "./alerts";

/** The Free plan's subrequests per invocation. */
export const MAX_CRON_SUBREQUESTS = 50;

/** The read of the accounts and the purge of the audit log. */
export const CRON_FIXED_SUBREQUESTS = 2;

/** The ticks of every invocation, also of one that keeps subrequests for the silence check. */
export const MIN_CRON_TICKS =
  MAX_CRON_SUBREQUESTS - CRON_FIXED_SUBREQUESTS - SILENCE_CHECK_SUBREQUESTS;

/**
 * The accounts that one cron invocation ticks. With more accounts than `limit`, the accounts split
 * into rounds of `MIN_CRON_TICKS` or fewer, and each invocation takes the next round. The time
 * gives the round, so this costs no state and no subrequest.
 *
 * An account waits at most `ceil(accounts / 44)` times 10 minutes. Its full cycle starts at its
 * first tick after one hour, and the silence check alerts after 3 hours without a successful run:
 * - Up to 88 accounts: a full cycle every 80 minutes. One failed cycle stays below the 3 hours.
 * - Up to 704 accounts: a full cycle every 170 minutes. Every cycle must succeed.
 * - From 705 accounts: 180 minutes or more, so a healthy rule can alert.
 *
 * The read of the accounts must sort them. A new or removed account moves the start of a round by
 * one place at most, which can cost the account at that place one turn. At a multiple of 44 the
 * number of rounds changes and the turn jumps to another round, once. One wait can then last as
 * long as two rounds. Up to about 260 accounts this stays below the 3 hours.
 */
export function accountsToTick(ids: string[], scheduledTime: number, limit: number): string[] {
  if (ids.length <= limit) return ids;
  const rounds = Math.ceil(ids.length / MIN_CRON_TICKS);
  const round = Math.floor(scheduledTime / CRON_TICK_MS) % rounds;
  const start = Math.floor((round * ids.length) / rounds);
  return [...ids.slice(start), ...ids].slice(0, limit);
}
