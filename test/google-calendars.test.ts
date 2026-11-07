import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendar } from "../src/providers/google-calendar";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Google calendar list", () => {
  it("skips a calendar that does not fit the schema and lists the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        items: [
          { id: "c1", summary: "Calendar", accessRole: "owner", primary: true },
          { id: "SECRET-ID", summary: "SECRET-NAME", accessRole: "reader", primary: "SECRET" },
          { id: "c3", summary: "Shared", accessRole: "reader" },
        ],
      }),
    );

    const calendars = await new GoogleCalendar("token").listCalendars();
    expect(calendars.map((calendar) => calendar.id)).toEqual(["c1", "c3"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("schema invalid_type@primary");
    expect(logged).not.toContain("SECRET");
  });
});
