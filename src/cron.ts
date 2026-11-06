import {
  checkSilentRules,
  CRON_TICK_MS,
  isHourlyTick,
  pingHeartbeat,
  SILENCE_CHECK_SUBREQUESTS,
  silenceCheckCost,
} from "./alerts";
import { errorCode, purgeAuditEvents } from "./audit";
import { accountSync } from "./durable";
import { heldRulesStatement, releaseHeldRules, type HeldRule } from "./offboarding";

/** The Free plan's subrequests per invocation. */
export const MAX_CRON_SUBREQUESTS = 50;

/** The read of the accounts and the purge of the audit log. */
export const CRON_FIXED_SUBREQUESTS = 2;

/** The ticks of every invocation, also of one that keeps subrequests for the silence check. */
export const MIN_CRON_TICKS =
  MAX_CRON_SUBREQUESTS - CRON_FIXED_SUBREQUESTS - SILENCE_CHECK_SUBREQUESTS;

/** The subrequests left for other work, so that `tickLimit` still ticks every account due. */
export function spareSubrequests(accounts: number, tickLimit: number): number {
  return Math.max(tickLimit - MIN_CRON_TICKS, tickLimit - accounts, 0);
}

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

/**
 * One cron invocation: the silence check, the audit purge, the release of held rules, the account
 * ticks and the heartbeat. Each runtime calls it from its own scheduler.
 */
export async function runCron(env: Env, scheduledTime: number): Promise<void> {
  // Before the ticks: it must still run if they use up the subrequests of this invocation.
  const checkCost = silenceCheckCost(env, scheduledTime);
  if (checkCost > 0) {
    try {
      await checkSilentRules(env, scheduledTime);
    } catch (error) {
      console.error("Silence check failed", errorCode(error));
    }
  }
  const { results } = await env.DB.prepare("SELECT id FROM accounts ORDER BY id").all<{
    id: string;
  }>();
  const tickLimit = MAX_CRON_SUBREQUESTS - CRON_FIXED_SUBREQUESTS - checkCost;
  if (results.length > tickLimit) {
    console.error("Cron ticks rotate at the subrequest limit", tickLimit, results.length);
  }
  const spare = spareSubrequests(results.length, tickLimit);
  let held: HeldRule[] = [];
  try {
    const now = scheduledTime;
    held = await purgeAuditEvents<HeldRule>(env.DB, heldRulesStatement(env, now, spare), now);
  } catch (error) {
    console.error("Audit purge failed", errorCode(error));
  }
  let holdsCost = 0;
  try {
    holdsCost = await releaseHeldRules(env, held, scheduledTime, spare);
  } catch (error) {
    holdsCost = spare;
    console.error("Releasing held rules failed", errorCode(error));
  }
  const ids = results.map(({ id }) => id);
  for (const id of accountsToTick(ids, scheduledTime, tickLimit - holdsCost)) {
    // One failing account must not stop the ticks of the others.
    try {
      await accountSync(env, id).tick();
    } catch (error) {
      console.error("Cron tick failed", id, errorCode(error));
    }
  }
  // Last, so that a call proves a finished run, and only with a subrequest left over.
  if (isHourlyTick(scheduledTime) && ids.length + holdsCost < tickLimit) {
    await pingHeartbeat(env);
  }
}
