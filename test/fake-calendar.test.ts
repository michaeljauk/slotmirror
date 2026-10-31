import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  addFakeEvent,
  changeFakeWireEvent,
  FakeCalendar,
  graphWireEvent,
  readFakeCalendar,
} from "../src/providers/fake-calendar";
import type { DesiredBlock } from "../src/sync/types";

const START = "2031-02-11T10:00:00.000Z";
const END = "2031-02-11T11:00:00.000Z";
const TIMES = {
  start: { dateTime: "2031-02-11T10:00:00", timeZone: "UTC" },
  end: { dateTime: "2031-02-11T11:00:00", timeZone: "UTC" },
};

const BLOCK: DesiredBlock = {
  marker: "marker",
  contentHash: "hash",
  dedupKey: "key",
  start: START,
  end: END,
  allDay: false,
  showAs: "busy",
  isPrivate: false,
  subject: "Busy",
  location: "",
  body: "",
};

function inCalendar<T>(work: (sql: SqlStorage) => Promise<T>): Promise<T> {
  const stub = env.ACCOUNT_SYNC.getByName(crypto.randomUUID());
  return runInDurableObject(stub, (_instance, state) => work(state.storage.sql));
}

describe("simulated calendar", () => {
  it("hands every field the engine writes back to the reader", async () => {
    await inCalendar(async (sql) => {
      const fake = new FakeCalendar(sql, "google");
      const block = { ...BLOCK, subject: "Title", attendees: ["guest@example.invalid"] };
      await fake.applyBatch("main", "tag", [{ kind: "create", block }]);
      expect(readFakeCalendar(sql)).toEqual([
        expect.objectContaining({ title: "Title", attendees: ["guest@example.invalid"] }),
      ]);
    });
  });

  it("offers the attendees of an event in the wire format that lacked them", () => {
    const attendees = ["guest@example.invalid"];
    const event = { ...TIMES, id: "e", calendarZone: "UTC", attendees };
    const occurrence = { fields: event, index: null, changed: false, originalStart: event.start };
    expect(graphWireEvent(event, occurrence, "UTC")).toMatchObject({
      attendees: [{ emailAddress: { address: attendees[0] } }],
    });
  });

  it("deletes any event of the calendar by its ID, as a provider does", async () => {
    await inCalendar(async (sql) => {
      const fake = new FakeCalendar(sql, "google");
      addFakeEvent(sql, { id: "added", start: START, end: END });
      const write = (key: string, repeat?: { every: "day"; count: number }) =>
        changeFakeWireEvent(
          sql,
          { change: "create", key, event: { ...TIMES, ...(repeat ? { repeat } : {}) } },
          "UTC",
        );
      write("own");
      write("kept");
      write("series", { every: "day", count: 3 });
      const remove = (targetId: string) => ({ kind: "delete" as const, targetId, marker: "" });
      await fake.applyBatch("main", "tag", [remove("own"), remove("series-1"), remove("added")]);
      expect(sql.exec(`SELECT id FROM fake_events`).toArray()).toEqual([]);
      expect(readFakeCalendar(sql).map((entry) => entry.start)).toEqual([
        START,
        START,
        "2031-02-13T10:00:00.000Z",
      ]);
    });
  });

  it("leaves the events of another calendar alone", async () => {
    await inCalendar(async (sql) => {
      const fake = new FakeCalendar(sql, "google");
      changeFakeWireEvent(sql, { change: "create", key: "own", event: TIMES }, "UTC");
      await fake.applyBatch("other", "tag", [{ kind: "delete", targetId: "own", marker: "" }]);
      expect(readFakeCalendar(sql)).toHaveLength(1);
    });
  });
});
