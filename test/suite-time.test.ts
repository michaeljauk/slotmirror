import { describe, expect, it } from "vitest";
import {
  dateOf,
  instantOf,
  localMidnight,
  resolveAnchors,
  resolveTime,
  zoneOffset,
} from "../suite/lib/time";

const NOW = Date.parse("2031-02-03T09:15:00Z");

function day(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

describe("anchors", () => {
  it("takes the first Monday a full week ahead", () => {
    expect(resolveAnchors(NOW).week).toBe(day("2031-02-10"));
    expect(resolveAnchors(Date.parse("2031-02-04T00:00:00Z")).week).toBe(day("2031-02-17"));
  });

  it("finds the changes of a zone, also when the next one is a year away", () => {
    const anchors = resolveAnchors(NOW, "Europe/Vienna");
    expect(anchors["dst-spring"]).toBe(day("2031-03-30"));
    expect(anchors["dst-fall"]).toBe(day("2031-10-26"));
    const later = resolveAnchors(Date.parse("2031-04-01T00:00:00Z"), "Europe/Vienna");
    expect(later["dst-spring"]).toBe(day("2032-03-28"));
  });
});

describe("expressions", () => {
  const anchors = resolveAnchors(NOW, "Europe/Vienna");

  it("resolves instants, dates and wall-clock times", () => {
    expect(new Date(instantOf("week+1d@10:30Z", anchors)).toISOString()).toBe(
      "2031-02-11T10:30:00.000Z",
    );
    expect(dateOf("dst-spring-5d", anchors)).toBe("2031-03-25");
    expect(resolveTime("week@09:00", anchors, "Asia/Tokyo")).toEqual({
      dateTime: "2031-02-10T09:00:00",
      timeZone: "Asia/Tokyo",
    });
    expect(resolveTime("week@09:00Z", anchors)).toEqual({
      dateTime: "2031-02-10T09:00:00",
      timeZone: "UTC",
    });
    expect(resolveTime("week+2d", anchors)).toEqual({ date: "2031-02-12" });
  });

  it("refuses what it cannot read", () => {
    expect(() => instantOf("week@10:00", anchors)).toThrow("Expected a UTC time");
    expect(() => dateOf("week@10:00Z", anchors)).toThrow("Expected a date");
    expect(() => instantOf("monday@10:00Z", anchors)).toThrow("Invalid time expression");
    expect(() => resolveTime("week@10:00", anchors)).toThrow("needs a zone");
    expect(() => instantOf("dst-fall@10:00Z", resolveAnchors(NOW))).toThrow("anchorZone");
  });
});

describe("zones", () => {
  it("reads offsets on both sides of a change", () => {
    expect(zoneOffset("Europe/Vienna", Date.parse("2031-03-30T00:59:00Z"))).toBe(3_600_000);
    expect(zoneOffset("Europe/Vienna", Date.parse("2031-03-30T01:00:00Z"))).toBe(7_200_000);
  });

  it("finds local midnight on the day of a change", () => {
    expect(new Date(localMidnight("2031-03-30", "Europe/Vienna")).toISOString()).toBe(
      "2031-03-29T23:00:00.000Z",
    );
    expect(new Date(localMidnight("2031-03-31", "Europe/Vienna")).toISOString()).toBe(
      "2031-03-30T22:00:00.000Z",
    );
    expect(new Date(localMidnight("2031-02-11", "America/New_York")).toISOString()).toBe(
      "2031-02-11T05:00:00.000Z",
    );
  });
});
