import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_AFTER_MS,
  formatStatuses,
  parseRetryAfter,
  summarizeBatch,
  throttleDelayMs,
} from "../src/sync/throttle";
import { GraphError } from "../src/providers/graph-calendar";
import type { SyncAction } from "../src/sync/types";

const remove = (targetId: string): SyncAction => ({ kind: "delete", targetId, marker: "m" });

describe("parseRetryAfter", () => {
  it("reads delay seconds and HTTP dates", () => {
    expect(parseRetryAfter("12")).toBe(12_000);
    const now = Date.parse("2026-10-25T18:00:00Z");
    expect(parseRetryAfter("Sun, 25 Oct 2026 18:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
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
    expect(throttleDelayMs("429")).toBeNull();
  });
});
