import { afterAll, describe, expect, it, vi } from "vitest";
import type { Manifest, Scenario } from "../lib/scenario.ts";
import { runSuite } from "../lib/runner.ts";
import { LocalDriver } from "./local.ts";

declare const __SUITE_INPUT__: {
  manifest: Manifest;
  scenarios: Scenario[];
  scenarioId: string;
  commit: string;
  dirty: boolean;
  listHash: string;
  runAt: string;
};

/**
 * The local run. One test holds the whole suite, because the driver owns the clock of the isolate.
 * The result leaves through the outbound service of `suite/vitest.config.ts`.
 */
describe("suite", () => {
  afterAll(() => {
    vi.useRealTimers();
  });

  it("runs on the simulated calendars", { timeout: 900_000 }, async () => {
    const input = __SUITE_INPUT__;
    const { manifest, scenarios, scenarioId, ...stamp } = input;
    const result = await runSuite(manifest, scenarios, new LocalDriver(), {
      ...(scenarioId ? { scenarioId } : {}),
      ...stamp,
    });
    const response = await fetch("https://suite-result.test/", {
      method: "POST",
      body: JSON.stringify(result),
    });
    expect(response.ok).toBe(true);
  });
});
