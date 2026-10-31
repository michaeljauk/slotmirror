import { describe, expect, it } from "vitest";
import type { Manifest, Scenario } from "../suite/lib/scenario";
import { manifestProblems, scenarioProblems } from "../suite/lib/validate";

// @ts-expect-error `import.meta.glob` is untyped without `vite/client`
const suiteFiles: Record<string, string> = import.meta.glob("../suite/**/*.{ts,json,md}", {
  eager: true,
  query: "?raw",
  import: "default",
});
// @ts-expect-error `import.meta.glob` is untyped without `vite/client`
const workerFiles: Record<string, string> = import.meta.glob("../src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** SHA-256 of tool names in lower case, so that the repository does not hold the names. */
const TOOL_NAME_HASHES = new Set([
  "574f8402187918a73792c53ac8ad233d50ad33f306c7211d2f0cceb60acec997",
  "00aa8942525b763cbe72e4a0fbfbb027b909dd8299e9c6c85c28d3d42d2cc28b",
  "e687aed2bfef953483cac1d5bd3f4105f81b883a3de9ecf1250927da4d3959b6",
]);

const entries = Object.entries(suiteFiles);
const scenarios = entries
  .filter(([path]) => path.includes("/v1/scenarios/"))
  .map(([, raw]) => JSON.parse(raw) as Scenario);
const manifest = JSON.parse(suiteFiles["../suite/v1/manifest.json"] ?? "{}") as Manifest;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function wordHashes(text: string): Promise<Set<string>> {
  const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g));
  return new Set(await Promise.all([...words].map(sha256)));
}

/** Value imports of a file, so without `import type`. */
function valueImports(source: string): string[] {
  const imports = source.matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gms);
  return [...imports].flatMap((match) => (match[1] ? [match[1]] : []));
}

describe("suite list", () => {
  it("has a readable file for every listed scenario", () => {
    expect(manifest.version).toBe("v1");
    expect(manifestProblems(manifest, scenarios)).toEqual([]);
  });

  it("covers the whole coverage list", () => {
    const covered = new Set(scenarios.map((scenario) => scenario.covers));
    for (const item of [
      "single event",
      "moved event",
      "deleted event",
      "series with an exception",
      "deleted occurrence of a series",
      "all-day event",
      "multi-day event",
      "daylight saving change",
      "midnight in another time zone",
      "free or transparent event",
      "cancelled event",
      "private event",
      "working hours filter",
      "buffer",
      "loop protection in both directions",
      "window boundary",
      "throttling with Retry-After",
      "partial failure in a batch",
      "paused account",
      "disconnect",
      "data that must not reach the target",
    ]) {
      expect(covered).toContain(item);
    }
  });

  it("names no provider", () => {
    const names = /google|microsoft|outlook|\bgraph\b|office ?365/i;
    const named = entries.filter(([path, raw]) => names.test(path) || names.test(raw));
    expect(named.map(([path]) => path)).toEqual([]);
  });

  it("names no other tool", async () => {
    const hashes = await wordHashes(entries.flat().join(" "));
    expect([...hashes].filter((hash) => TOOL_NAME_HASHES.has(hash))).toEqual([]);
  });

  it("hashes the words of a text in lower case", async () => {
    expect(await wordHashes("Probe-word")).toEqual(
      new Set([await sha256("probe"), await sha256("word")]),
    );
  });

  it("takes no value from the tool in the oracle, the runner or the list", () => {
    const independent = entries.filter(
      ([path]) => path.includes("/suite/lib/") || path.endsWith("/suite/cli.ts"),
    );
    expect(independent.length).toBeGreaterThan(4);
    for (const [, source] of independent) {
      for (const specifier of valueImports(source)) {
        expect(specifier).toMatch(/^(\.\/|\.\.\/lib\/|\.\/drivers\/|node:)/);
        expect(specifier).not.toMatch(/src\//);
      }
    }
  });

  it("imports only the simulated calendars from the Worker in the local driver", () => {
    const fromWorker = valueImports(suiteFiles["../suite/drivers/local.ts"] ?? "").filter(
      (specifier) => specifier.includes("/src/"),
    );
    expect(fromWorker).toEqual(["../../src/providers/fake-calendar.ts"]);
  });

  it("stays out of the Worker bundle", () => {
    const paths = Object.keys(workerFiles);
    expect(paths.length).toBeGreaterThan(20);
    for (const source of Object.values(workerFiles)) {
      expect(source).not.toMatch(/from "[^"]*suite\//);
    }
  });
});

describe("scenarioProblems", () => {
  const WINDOW: [string, string] = ["week@00:00Z", "week+7d@00:00Z"];

  function withExpectation(expect: Extract<Scenario["steps"][number], { do: "sync" }>["expect"]) {
    return scenarioProblems({
      id: "probe",
      title: "A probe",
      covers: "single event",
      expectedText: "Busy.",
      calendars: { source: { timeZone: "UTC" }, target: { timeZone: "America/Los_Angeles" } },
      steps: [{ do: "sync", expect }],
    });
  }

  it("takes an expectation that checks something", () => {
    expect(withExpectation({ window: WINDOW, busy: [] })).toEqual([]);
    expect(withExpectation({ window: WINDOW, required: ["text"] })).toEqual([]);
  });

  it("refuses an empty list of required text, which checks nothing", () => {
    expect(withExpectation({ window: WINDOW, required: [] })).toEqual([
      "step 1: the expectation checks nothing",
    ]);
  });

  it.each([
    ["an empty text", { required: [""] }],
    ["a blank text", { required: ["  "] }],
    ["an empty text next to another", { required: ["text", ""] }],
    ["an empty forbidden text", { forbidden: [""], minEntries: 1 }],
  ])("refuses %s, which checks nothing", (_name, fields) => {
    expect(withExpectation({ window: WINDOW, ...fields })).toEqual([
      "step 1: an empty text checks nothing",
    ]);
  });

  it("refuses a window that ends before it starts", () => {
    const [start, end] = WINDOW;
    expect(withExpectation({ window: [end, start], busy: [] })).toEqual([
      expect.stringContaining("step 1: the window"),
    ]);
  });

  it("refuses busy time and busy dates outside the window", () => {
    const outside = withExpectation({
      window: WINDOW,
      busy: [["week+7d@10:00Z", "week+7d@11:00Z"]],
    });
    expect(outside).toEqual([expect.stringContaining("outside the window")]);
    const dates = withExpectation({ window: WINDOW, busyDates: [["week+6d", "week+7d"]] });
    expect(dates).toEqual([expect.stringContaining("outside the window")]);
  });

  it("refuses busy time that ends before it starts", () => {
    const twisted = withExpectation({
      window: WINDOW,
      busy: [["week+1d@11:00Z", "week+1d@10:00Z"]],
    });
    expect(twisted).toEqual([expect.stringContaining("ends before it starts")]);
  });

  it("refuses a time that the expectation cannot resolve", () => {
    const wallClock = withExpectation({
      window: WINDOW,
      busy: [["week+1d@10:00", "week+1d@11:00"]],
    });
    expect(wallClock).toEqual([expect.stringContaining("Expected a UTC time")]);
  });
});
