import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphCalendar } from "../src/providers/graph-calendar";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Graph calendar list", () => {
  it("lists a calendar whose owner is null, as not owned", async () => {
    // Graph sends "owner": null for some calendars, for example some shared or group calendars.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      return Response.json(
        url.includes("/me/calendars")
          ? {
              value: [
                { id: "c1", name: "Calendar", canEdit: true, owner: { address: "me@example.com" } },
                { id: "c2", name: "Shared", canEdit: false, owner: null },
              ],
            }
          : { mail: "me@example.com", userPrincipalName: "me@example.com" },
      );
    });

    const calendars = await new GraphCalendar("token").listCalendars();
    expect(calendars.map((calendar) => [calendar.id, calendar.owned])).toEqual([
      ["c1", true],
      ["c2", false],
    ]);
  });
});
