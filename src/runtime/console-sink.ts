import type { LogRecord, LogSink } from "../telemetry";

/**
 * The flat object that a sink writes for one record. `message` repeats the event, because log
 * views show that field as the line's text. The reserved keys come last, so that a field of the
 * same name cannot hide them.
 */
export function logLine(record: LogRecord): Record<string, unknown> {
  const line: Record<string, unknown> = { ...record.fields };
  line.level = record.level;
  line.event = record.event;
  line.message = record.event;
  if (record.error) line.error = record.error;
  if (record.traceId) line.traceId = record.traceId;
  if (record.spanId) line.spanId = record.spanId;
  return line;
}

/**
 * Writes each record as an object through `console`, with the method of its level. Workers Logs
 * indexes the keys of a logged object as fields and keeps the level. This is also the default
 * sink until a runtime installs its own; the only file in `src/` outside the adapters that calls
 * `console`.
 */
export const consoleSink: LogSink = {
  write(record) {
    const line = logLine(record);
    if (record.level === "error") console.error(line);
    else if (record.level === "warn") console.warn(line);
    else console.log(line);
  },
};
