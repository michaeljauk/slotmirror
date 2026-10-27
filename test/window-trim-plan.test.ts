import { describe, expect, it } from "vitest";
import { ruleOptionsSchema } from "../src/config";
import { desiredBlocks, planSync } from "../src/sync/plan";
import { startsBeyond, syncWindow, targetReadWindow } from "../src/sync/rules";
import type { DesiredBlock, ExistingBlock, SourceEvent, SyncPlan } from "../src/sync/types";

// A trim deletes the blocks beyond the sync window. The next run must not write them again, or
// every trim would start a loop of deletes and creates. Each provider filters all-day events at
// the midnights of its own calendar's time zone, so the model reads all-day dates that way.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OPTIONS = ruleOptionsSchema.parse({ skipAllDay: false, daysAhead: 30 });

type Window = { start: Date; end: Date };
type Times = { start: string; end: string; allDay: boolean };

function event(key: string, start: string, end: string): SourceEvent {
  return {
    occurrenceKey: key,
    start,
    end,
    allDay: start.length === 10,
    showAs: "busy",
    isPrivate: false,
    declined: false,
    categories: [],
    subject: "Meeting",
    location: "",
    body: "",
    isMirror: false,
  };
}

/** True if a calendar `offset` hours east of UTC returns the item for the window. */
function inRead(times: Times, window: Window, offset: number): boolean {
  const shift = times.allDay ? offset * HOUR : 0;
  return (
    Date.parse(times.start) - shift < window.end.getTime() &&
    Date.parse(times.end) - shift > window.start.getTime()
  );
}

/** A target calendar at a fixed UTC offset. */
class Target {
  readonly blocks = new Map<string, DesiredBlock>();
  private next = 0;
  constructor(readonly offset: number) {}

  read(window: Window): ExistingBlock[] {
    return [...this.blocks]
      .filter(([, block]) => inRead(block, window, this.offset))
      .map(([targetId, block]) => ({ ...block, targetId, ruleTag: "tag" }));
  }

  apply(plan: SyncPlan): void {
    for (const action of plan.actions) {
      if (action.kind === "create") this.blocks.set(`t${this.next++}`, action.block);
      else if (action.kind === "update") this.blocks.set(action.targetId, action.block);
      else this.blocks.delete(action.targetId);
    }
  }
}

/** One run of the rule, as `AccountSync` does it. */
async function run(target: Target, events: SourceEvent[], sourceOffset: number, now: Date) {
  const window = syncWindow(OPTIONS, now);
  const read = events.filter((item) => inRead(item, window, sourceOffset));
  const targetRead = targetReadWindow(window);
  const plan = planSync(await desiredBlocks("rule", read, OPTIONS), target.read(targetRead), {
    sync: window,
    target: targetRead,
  });
  target.apply(plan);
  return plan.stats;
}

const iso = (ms: number) => new Date(ms).toISOString();
const date = (ms: number) => iso(ms).slice(0, 10);

describe("a trim and the next run", () => {
  const offsets = [-12, -8, 0, 5.5, 14];
  const times = ["00:00:00", "00:30:00", "12:00:00", "23:59:59"];
  for (const source of offsets) {
    for (const zone of offsets) {
      it(`source at ${source} h, target at ${zone} h: nothing trimmed comes back`, async () => {
        for (const time of times) {
          const now = new Date(`2036-10-22T${time}Z`);
          const end = syncWindow(OPTIONS, now).end.getTime();
          // All-day and timed events around the window end.
          const events: SourceEvent[] = [];
          for (let day = -2; day <= 2; day++) {
            events.push(event(`day${day}`, date(end + day * DAY), date(end + (day + 1) * DAY)));
          }
          for (const hours of [-13, -1, -0.5, 0, 0.5, 1, 13]) {
            events.push(
              event(`at${hours}`, iso(end + hours * HOUR), iso(end + (hours + 2) * HOUR)),
            );
          }
          const target = new Target(zone);
          await run(target, events, source, now);
          await run(target, events, source, now);
          // The trim's read and filter, as `removeRuleBlocks` does them.
          const beyond = target
            .read({ start: new Date(end), end: new Date(end + 400 * DAY) })
            .filter((block) => startsBeyond(block, new Date(end)));
          for (const block of beyond) target.blocks.delete(block.targetId);
          expect({ time, stats: await run(target, events, source, now) }).toMatchObject({
            stats: { create: 0, delete: 0 },
          });
        }
      });
    }
  }
});
