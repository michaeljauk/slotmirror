import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphCalendar } from "../src/providers/graph-calendar";

const ME = { mail: "me@example.com", userPrincipalName: "me@example.com" };

/** Graph answers /me with ME, and each /me/calendars URL with the page that `pages` maps it to. */
function graph(pages: Record<string, unknown>): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    if (!url.includes("/me/calendars")) return Response.json(ME);
    const page = Object.entries(pages).find(([key]) => url.includes(key));
    return page ? Response.json(page[1]) : new Response("not found", { status: 404 });
  });
  return urls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Graph calendar list", () => {
  it("lists a calendar whose owner is null, as not owned", async () => {
    // Graph sends "owner": null for some calendars, for example some shared or group calendars.
    graph({
      "/me/calendars?": {
        value: [
          { id: "c1", name: "Calendar", canEdit: true, owner: { address: "me@example.com" } },
          { id: "c2", name: "Shared", canEdit: false, owner: null },
        ],
      },
    });

    const calendars = await new GraphCalendar("token").listCalendars();
    expect(calendars.map((calendar) => [calendar.id, calendar.owned])).toEqual([
      ["c1", true],
      ["c2", false],
    ]);
  });

  it("skips a calendar that does not fit the schema and lists the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    graph({
      "/me/calendars?": {
        value: [
          { id: "c1", name: "Calendar", canEdit: true, owner: { address: "me@example.com" } },
          { id: "SECRET-ID", name: "SECRET-NAME", canEdit: "SECRET-YES" },
          { id: "c3", name: "Shared", canEdit: false },
        ],
      },
    });

    const calendars = await new GraphCalendar("token").listCalendars();
    expect(calendars.map((calendar) => calendar.id)).toEqual(["c1", "c3"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("schema invalid_type@canEdit");
    expect(logged).not.toContain("SECRET");
  });

  it("follows the next link to the calendars on later pages", async () => {
    const next = "https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=page2";
    const urls = graph({
      skiptoken: { value: [{ id: "c2", name: "Second page" }] },
      "/me/calendars?$select": {
        value: [{ id: "c1", name: "First page" }],
        "@odata.nextLink": next,
      },
    });

    const calendars = await new GraphCalendar("token").listCalendars();
    expect(calendars.map((calendar) => calendar.id)).toEqual(["c1", "c2"]);
    expect(urls).toContain(next);
  });
});
