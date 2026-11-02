/**
 * Calendar pages in real size for the fetch target of the capacity probe. `FakeCalendar` fetches
 * and parses them, so that a simulated read costs the CPU of a real one. The events are invented.
 * The fields follow `graphEventSelect` and `googleEventFields`; the lengths of IDs and links follow
 * the values that the providers return.
 */

/** Events per page: Graph `$top`, Google `maxResults`. */
export const PAGE_ITEMS = { microsoft: 500, google: 2500 } as const;

export type PageProvider = keyof typeof PAGE_ITEMS;

const pad = (i: number, length: number) => String(i).padStart(length, "0");

function times(i: number) {
  const start = Date.UTC(2026, 10, 2, 7) + i * 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "");
  return { start: iso(start), end: iso(start + 1_800_000) };
}

function graphEvent(i: number) {
  const { start, end } = times(i);
  return {
    id: `AAMkAGI2T${pad(i, 143)}`,
    type: i % 3 === 0 ? "occurrence" : "singleInstance",
    ...(i % 3 === 0
      ? { seriesMasterId: `AAMkAGI2S${pad(i, 143)}`, originalStart: `${start}Z` }
      : {}),
    start: { dateTime: `${start}.0000000`, timeZone: "UTC" },
    end: { dateTime: `${end}.0000000`, timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    sensitivity: "normal",
    categories: [],
    responseStatus: { response: "organizer", time: "0001-01-01T00:00:00Z" },
    subject: `Planning session ${i}`,
    location: {
      displayName: `Room ${i % 40}`,
      locationType: "default",
      uniqueIdType: "unknown",
      address: {},
      coordinates: {},
    },
    bodyPreview: `Agenda for session ${i}: review the open items, agree on the next steps.`,
  };
}

function googleEvent(i: number) {
  const { start, end } = times(i);
  return {
    id: `${pad(i, 26)}`,
    status: "confirmed",
    summary: `Planning session ${i}`,
    location: `Room ${i % 40}`,
    start: { dateTime: `${start}+00:00`, timeZone: "UTC" },
    end: { dateTime: `${end}+00:00`, timeZone: "UTC" },
    ...(i % 3 === 0
      ? { recurringEventId: pad(i, 26), originalStartTime: { dateTime: `${start}+00:00` } }
      : {}),
    attendees: [{ self: true, responseStatus: "accepted" }],
  };
}

/** The body of one full page as the provider sends it, with a link to a next page. */
export function providerPage(provider: PageProvider): string {
  const items = Array.from({ length: PAGE_ITEMS[provider] }, (_, i) => i);
  if (provider === "microsoft") {
    return JSON.stringify({
      "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#Collection(event)",
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/calendarView?$skip=${pad(0, 900)}`,
      value: items.map(graphEvent),
    });
  }
  return JSON.stringify({ nextPageToken: pad(0, 180), items: items.map(googleEvent) });
}
