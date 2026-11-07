/**
 * The telemetry adapter of the Node runtime: one JSON line per record on stdout, where Docker and
 * other log collectors read it. Spans do nothing yet. An OpenTelemetry adapter later replaces
 * `noopTracer` and the sink here, and `src/telemetry.ts` stays as it is.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { logLine } from "../console-sink";
import {
  noopTracer,
  type ContextPort,
  type Fields,
  type LogSink,
  type Telemetry,
} from "../../telemetry";

/** Writes each record as one JSON line, with its time, to `out`. */
export function jsonLineSink(out: { write(line: string): unknown } = process.stdout): LogSink {
  return {
    write(record) {
      const line = { time: new Date(record.time).toISOString(), ...logLine(record) };
      out.write(`${JSON.stringify(line)}\n`);
    },
  };
}

export function nodeTelemetry(out?: { write(line: string): unknown }): Telemetry {
  const storage = new AsyncLocalStorage<Fields>();
  const context: ContextPort = {
    run: (fields, fn) => storage.run(fields, fn),
    current: () => storage.getStore(),
  };
  return { sink: jsonLineSink(out), tracer: noopTracer, context };
}
