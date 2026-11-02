import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_AFTER_MS,
  errorReason,
  formatStatuses,
  isThrottled,
  parseRetryAfter,
  summarizeBatch,
  throttleDelayMs,
} from "../src/sync/throttle";
import { GraphError } from "../src/providers/graph-calendar";
import type { DesiredBlock, SyncAction } from "../src/sync/types";

const remove = (targetId: string): SyncAction => ({ kind: "delete", targetId, marker: "m" });

function write(kind: "create" | "update", allDay: boolean): SyncAction {
  const block = { allDay } as DesiredBlock;
  return kind === "create" ? { kind, block } : { kind, targetId: "t", block };
}

describe("parseRetryAfter", () => {
  it("reads delay seconds and HTTP dates", () => {
    expect(parseRetryAfter("12")).toBe(12_000);
    const now = Date.parse("2026-10-25T18:00:00Z");
    expect(parseRetryAfter("Sun, 25 Oct 2026 18:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("isThrottled", () => {
  it("treats Google's rate-limit 403 as throttling, but not its abuse quota", () => {
    expect(isThrottled(429)).toBe(true);
    expect(isThrottled(503)).toBe(true);
    expect(isThrottled(403, "rateLimitExceeded")).toBe(true);
    expect(isThrottled(403, "userRateLimitExceeded")).toBe(true);
    expect(isThrottled(403, "quotaExceeded")).toBe(false);
    expect(isThrottled(403)).toBe(false);
  });
});

describe("errorReason", () => {
  it("reads Graph and Google codes and drops anything that is not an identifier", () => {
    expect(errorReason({ error: { code: "ApplicationThrottled", message: "x" } })).toBe(
      "ApplicationThrottled",
    );
    expect(errorReason({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } })).toBe(
      "rateLimitExceeded",
    );
    expect(errorReason({ error: { code: "Meeting with Alice" } })).toBeUndefined();
    expect(errorReason(null)).toBeUndefined();
  });
});

describe("summarizeBatch", () => {
  it("separates throttled from failed actions and counts statuses", () => {
    const actions = [remove("a"), remove("b"), remove("c"), remove("d"), remove("e")];
    const outcomes = [
      { status: 204 },
      { status: 404 },
      { status: 429, retryAfterMs: 5_000 },
      { status: 429, retryAfterMs: 9_000 },
      { status: 400 },
    ];
    expect(summarizeBatch(actions, (index) => outcomes[index] ?? { status: undefined })).toEqual({
      failed: 1,
      throttled: 2,
      statuses: { 400: 1, 429: 2 },
      retryAfterMs: 9_000,
    });
  });

  it("counts the writes of all-day blocks that a provider refused with 400", () => {
    const actions = [write("create", true), write("update", true), write("create", true)];
    const statuses = [400, 400, 201];
    expect(summarizeBatch(actions, (index) => ({ status: statuses[index] })).allDayRefused).toBe(2);
  });

  it("counts the writes of all-day blocks that a provider accepted", () => {
    const actions = [write("create", true), write("update", true), write("create", true)];
    const statuses = [201, 200, 400];
    expect(summarizeBatch(actions, (index) => ({ status: statuses[index] })).allDayAccepted).toBe(
      2,
    );
  });

  it("does not count another action as an accepted all-day write", () => {
    const actions = [write("create", false), write("update", false), remove("a")];
    expect(summarizeBatch(actions, () => ({ status: 200 })).allDayAccepted).toBeUndefined();
    expect(summarizeBatch(actions, () => ({ status: 404 })).allDayAccepted).toBeUndefined();
    const failed = [write("create", true)];
    expect(summarizeBatch(failed, () => ({ status: 500 })).allDayAccepted).toBeUndefined();
  });

  it("does not count a 400 for another action, or another status for an all-day write", () => {
    const refused = (action: SyncAction, status: number) =>
      summarizeBatch([action], () => ({ status })).allDayRefused;
    expect(refused(write("create", false), 400)).toBeUndefined();
    expect(refused(write("update", false), 400)).toBeUndefined();
    expect(refused(remove("a"), 400)).toBeUndefined();
    for (const status of [401, 403, 404, 409, 429, 500, 503, 504]) {
      expect(refused(write("create", true), status)).toBeUndefined();
    }
  });

  it("counts a missing status as failed", () => {
    expect(summarizeBatch([remove("a")], () => ({ status: undefined }))).toMatchObject({
      failed: 1,
      statuses: { 0: 1 },
    });
  });
});

describe("formatStatuses", () => {
  it("lists the most frequent status first", () => {
    expect(formatStatuses({ 400: 2, 429: 13 })).toBe("429:13,400:2");
    expect(formatStatuses({})).toBe("");
  });
});

describe("throttleDelayMs", () => {
  it("uses Retry-After of a typed error and clamps it", () => {
    expect(throttleDelayMs(new GraphError(429, "Graph GET failed: 429", 10_000))).toBe(10_000);
    expect(throttleDelayMs(new GraphError(503, "Graph GET failed: 503", 1))).toBe(2_000);
    expect(throttleDelayMs(new GraphError(429, "Graph GET failed: 429", 3_600_000))).toBe(300_000);
    expect(throttleDelayMs(new GraphError(401, "Graph GET failed: 401"))).toBeNull();
  });

  it("recognises a throttled error that lost its class over RPC", () => {
    expect(throttleDelayMs(new Error("Graph GET failed: 429"))).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(throttleDelayMs(new Error("Google batch failed: 503"))).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(throttleDelayMs(new Error("Graph GET failed: 404"))).toBeNull();
    expect(throttleDelayMs(new Error("Graph GET failed: 429 ApplicationThrottled"))).toBe(
      DEFAULT_RETRY_AFTER_MS,
    );
    expect(throttleDelayMs(new Error("Google GET failed: 403 rateLimitExceeded"))).toBe(
      DEFAULT_RETRY_AFTER_MS,
    );
    expect(throttleDelayMs(new Error("Google GET failed: 403 quotaExceeded"))).toBeNull();
    expect(throttleDelayMs("429")).toBeNull();
  });
});
