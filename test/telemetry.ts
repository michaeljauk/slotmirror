import { storageContext } from "../src/runtime/workers/telemetry";
import {
  getTelemetry,
  noopTracer,
  setTelemetry,
  type LogRecord,
  type Telemetry,
} from "../src/telemetry";

/**
 * Collects log records in memory, with a real request context. Tests and Durable Objects share
 * one isolate, so records of an instance arrive here too. `restore()` puts back the previous
 * adapter.
 */
export function captureLogs(overrides: Partial<Telemetry> = {}) {
  const previous = getTelemetry();
  const records: LogRecord[] = [];
  setTelemetry({
    sink: { write: (record) => records.push(record) },
    tracer: noopTracer,
    context: storageContext(),
    ...overrides,
  });
  return {
    records,
    events: () => records.map((record) => record.event),
    find: (event: string) => records.filter((record) => record.event === event),
    restore: () => setTelemetry(previous),
  };
}
