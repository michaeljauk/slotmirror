/**
 * A minimal adapter for the live driver, to show the protocol. It simulates a tool that copies
 * timed UTC events from source to target at once, in a file. It is no calendar access and no
 * reference for correct behavior. Its file holds nothing else, so all it stores has the marker: a
 * real adapter stores `marker` in the event and deletes only events that hold it.
 *
 *   pnpm suite --driver live --command "node suite/drivers/example-adapter.ts" --scenario single-event
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import type { AdapterRequest, AdapterResponse } from "./live.ts";
import type { CalendarEntry, CalendarSide, ResolvedEvent } from "../lib/scenario.ts";

const FILE = join(tmpdir(), "suite-example-adapter.json");

type State = Record<string, ResolvedEvent>;

function load(): State {
  return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as State) : {};
}

function entry(event: ResolvedEvent, calendar: CalendarSide): CalendarEntry {
  const time = (value: ResolvedEvent["start"]) =>
    value && "dateTime" in value ? `${value.dateTime}Z` : "";
  return {
    start: time(event.start),
    end: time(event.end),
    allDay: false,
    status: "busy",
    owner: calendar === "source" ? "suite" : "tool",
  };
}

function handle(request: AdapterRequest): AdapterResponse {
  switch (request.op) {
    case "describe":
      return {
        value: {
          name: "example",
          mode: "simulated-clock",
          directions: ["forward"],
          capabilities: [],
        },
      };
    case "prepare":
      if (request.scenario.rule?.direction === "both") {
        return { unsupported: "This example copies in one direction only." };
      }
      writeFileSync(FILE, "{}");
      return {};
    case "write": {
      const state = load();
      const { change, key, event } = request.change;
      if (change === "create" && event) state[key] = event;
      else if (change === "update" && event) state[key] = { ...state[key], ...event };
      else if (change === "delete") delete state[key];
      else return { unsupported: `This example has no ${change}.` };
      writeFileSync(FILE, JSON.stringify(state));
      return {};
    }
    case "read":
      return { value: Object.values(load()).map((event) => entry(event, request.calendar)) };
    case "cleanup":
      writeFileSync(FILE, "{}");
      return {};
    default:
      return { unsupported: `This example has no ${request.op}.` };
  }
}

let input = "";
for await (const chunk of stdin) input += String(chunk);
stdout.write(JSON.stringify(handle(JSON.parse(input) as AdapterRequest)));
