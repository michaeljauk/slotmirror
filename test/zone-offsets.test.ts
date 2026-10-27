import { describe, expect, it } from "vitest";

/**
 * `src/sync/working-hours.ts` reads a zone's offset once per UTC week and assumes at most one
 * change in a week. This guard reads every zone the runtime knows, every 12 hours for the next three
 * years, and fails if a week holds two changes. Two changes less than 12 hours apart would slip
 * through; no zone has those.
 */
const FALLBACK_ZONES = [
  "Africa/Casablanca",
  "America/Santiago",
  "America/Havana",
  "America/St_Johns",
  "Asia/Gaza",
  "Asia/Tehran",
  "Australia/Lord_Howe",
  "Europe/Vienna",
  "Pacific/Auckland",
  "Pacific/Chatham",
];

const HOUR_MS = 3_600_000;
const STEP_MS = 12 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;

function zones(): string[] {
  const intl = Intl as { supportedValuesOf?: (key: "timeZone") => string[] };
  return typeof intl.supportedValuesOf === "function"
    ? intl.supportedValuesOf("timeZone")
    : FALLBACK_ZONES;
}

/** Weeks (by number) with more than one offset change in [from, to). */
function weeksWithTwoChanges(zone: string, from: number, to: number): number[] {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "longOffset",
  });
  const offset = (instant: number) => formatter.format(instant).split(", ")[1];
  const changes = new Map<number, number>();
  let previous = offset(from);
  for (let instant = from + STEP_MS; instant <= to; instant += STEP_MS) {
    const current = offset(instant);
    if (current !== previous) {
      // Steps of 12 hours never cross a week boundary inside (instant - step, instant].
      const week = Math.floor((instant - 1) / WEEK_MS);
      changes.set(week, (changes.get(week) ?? 0) + 1);
      previous = current;
    }
  }
  return [...changes].filter(([, count]) => count > 1).map(([week]) => week);
}

describe("zone offsets", () => {
  it("change at most once per UTC week in every zone for the next three years", () => {
    const from = Math.floor(Date.now() / WEEK_MS) * WEEK_MS;
    const to = from + 3 * 53 * WEEK_MS;
    const all = zones();
    expect(all.length).toBeGreaterThan(5);
    const found = all.flatMap((zone) =>
      weeksWithTwoChanges(zone, from, to).map(
        (week) => `${zone} ${new Date(week * WEEK_MS).toISOString()}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
