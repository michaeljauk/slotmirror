/**
 * Logs, traces and the context of a request, behind one port.
 *
 * The core logs through `log` and opens spans through `span`. It never calls `console` and never
 * imports a tracing library. Each runtime installs its adapter once, with `setTelemetry`:
 *
 * - Cloudflare (`src/runtime/workers/telemetry.ts`): JSON objects through `console`, which Workers
 *   Logs indexes as fields; spans through `tracing` of `cloudflare:workers`.
 * - Node (`src/runtime/node/telemetry.ts`): one JSON line per record on stdout; no spans yet. An
 *   OpenTelemetry adapter replaces it without a change here.
 * - Tests (`test/telemetry.ts`): records in memory.
 *
 * The context of a request (its ID, the account) lives in the adapter's `ContextPort`, which
 * follows `await`. A Durable Object call starts a new context, so a caller passes `carrier()` as
 * the last argument and the instance continues with `resumeRequest`.
 *
 * This file imports nothing from `cloudflare:*` or `node:*`.
 */
import { errorFields, type ErrorFields } from "./error-fields";
import { consoleSink } from "./runtime/console-sink";

export type { ErrorFields } from "./error-fields";

/** A value that a log record or a span attribute holds. Never event content or a token. */
export type Scalar = string | number | boolean | null;

/** Fields of a log record or attributes of a span. An undefined field is left out. */
export type Fields = Readonly<Record<string, Scalar | undefined>>;

/**
 * A stable name of what happened, in dotted lower case: "calendars.list_failed". A filter in a log
 * view uses it, so do not change a name without a reason. `test/log-hygiene.test.ts` checks the
 * form of every name in the code.
 */
export type EventName = `${Lowercase<string>}.${Lowercase<string>}`;

export type Level = "error" | "warn" | "info";

/** One log record, as the core hands it to a `LogSink`. */
export interface LogRecord {
  level: Level;
  event: EventName;
  /** Unix ms. */
  time: number;
  /** The context of the request, the logger's own fields and the fields of the call. */
  fields: Fields;
  error?: ErrorFields;
  /** The active span, if the runtime traces this invocation. */
  traceId?: string;
  spanId?: string;
}

export interface Logger {
  /** Something failed. `error` is the caught value; the logger keeps only its `errorFields`. */
  error(event: EventName, fields?: Fields, error?: unknown): void;
  /** Something unexpected that the code handled. */
  warn(event: EventName, fields?: Fields, error?: unknown): void;
  info(event: EventName, fields?: Fields): void;
  /** A logger that adds `context` to each record. */
  with(context: Fields): Logger;
}

/** What a span offers to the code inside it. */
export interface Span {
  setAttributes(attributes: Fields): void;
  recordError(error: unknown): void;
}

/** Where log records go. `write` must not throw. */
export interface LogSink {
  write(record: LogRecord): void;
}

/** The span of a trace that is active now. */
export interface SpanContext {
  traceId: string;
  spanId: string;
}

/** A span inside a tracing port, which gets the error already reduced to `ErrorFields`. */
export interface PortSpan {
  setAttributes(attributes: Fields): void;
  recordError(error: ErrorFields): void;
}

export interface TracerPort {
  /** Runs `fn` inside a new child span of the active span. The span ends when `fn` settles. */
  span<T>(name: string, attributes: Fields, fn: (span: PortSpan) => T): T;
  /** The active span, or undefined if this invocation is not traced. */
  current(): SpanContext | undefined;
  /** Adds the active trace context to `carrier`, for a call into another instance. */
  inject(carrier: Record<string, string>): void;
  /** Runs `fn` with the trace context of `carrier` as the parent. */
  extract<T>(carrier: Carrier, fn: () => T): T;
}

/** The context of a request, kept across `await` by the runtime. */
export interface ContextPort {
  run<T>(context: Fields, fn: () => T): T;
  current(): Fields | undefined;
}

export interface Telemetry {
  sink: LogSink;
  tracer: TracerPort;
  context: ContextPort;
}

/**
 * The context that a call into a Durable Object passes on: the request ID and, if the adapter
 * propagates traces, its headers. A plain object, so that RPC can copy it.
 */
export type Carrier = Readonly<{ requestId: string } & Record<string, string>>;

/** What started a request: an HTTP request, a cron run, an alarm, or a call from another instance. */
export type Trigger = "http" | "cron" | "alarm" | "rpc";

/** A tracer that traces nothing. */
export const noopTracer: TracerPort = {
  span: (_name, _attributes, fn) =>
    fn({
      setAttributes() {},
      recordError() {},
    }),
  current: () => undefined,
  inject() {},
  extract: (_carrier, fn) => fn(),
};

/** A context port without storage: requests have no ID. The default until an adapter is set. */
export const noContext: ContextPort = {
  run: (_context, fn) => fn(),
  current: () => undefined,
};

let active: Telemetry = { sink: consoleSink, tracer: noopTracer, context: noContext };

/** Installs the adapter of a runtime. The entry of each runtime calls it once, at module load. */
export function setTelemetry(telemetry: Telemetry): void {
  active = telemetry;
}

/** The installed adapter. Tests use it to restore the previous one. */
export function getTelemetry(): Telemetry {
  return active;
}

function definedOnly(fields: Fields | undefined, into: Record<string, Scalar>): void {
  if (!fields) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) into[key] = value;
  }
}

function write(
  level: Level,
  event: EventName,
  own: Fields,
  fields: Fields | undefined,
  error: unknown,
  hasError: boolean,
): void {
  // A broken log must not break a sync or a sign-in.
  try {
    const merged: Record<string, Scalar> = {};
    const context = active.context.current();
    definedOnly(context, merged);
    definedOnly(own, merged);
    definedOnly(fields, merged);
    // A field of the call cannot replace the request ID or the trigger of the context.
    for (const key of ["requestId", "trigger"]) {
      const value = context?.[key];
      if (value !== undefined) merged[key] = value;
    }
    const record: LogRecord = { level, event, time: Date.now(), fields: merged };
    if (hasError) record.error = errorFields(error);
    const span = active.tracer.current();
    if (span) {
      record.traceId = span.traceId;
      record.spanId = span.spanId;
    }
    active.sink.write(record);
  } catch {
    // Nothing is left to report the failure to.
  }
}

class ContextLogger implements Logger {
  constructor(private readonly own: Fields) {}

  error(event: EventName, fields?: Fields, ...error: [unknown?]): void {
    write("error", event, this.own, fields, error[0], error.length > 0);
  }

  warn(event: EventName, fields?: Fields, ...error: [unknown?]): void {
    write("warn", event, this.own, fields, error[0], error.length > 0);
  }

  info(event: EventName, fields?: Fields): void {
    write("info", event, this.own, fields, undefined, false);
  }

  with(context: Fields): Logger {
    return new ContextLogger({ ...this.own, ...context });
  }
}

/** The logger of the core. It adds the context of the current request to each record. */
export const log: Logger = new ContextLogger({});

/** Runs `fn` inside a span. Without tracing it only runs `fn`. */
export function span<T>(name: string, attributes: Fields, fn: (span: Span) => T): T {
  return active.tracer.span(name, attributes, (port) =>
    fn({
      setAttributes: (more) => port.setAttributes(more),
      recordError: (error) => port.recordError(errorFields(error)),
    }),
  );
}

/** The trace ID of this invocation, or undefined if it is not traced. */
export function traceId(): string | undefined {
  return active.tracer.current()?.traceId;
}

const REQUEST_ID = /^[0-9a-f]{16}$/;

/** A new request ID: 16 hex characters. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The request ID of the current context, if there is one. */
export function requestId(): string | undefined {
  const id = active.context.current()?.requestId;
  return typeof id === "string" ? id : undefined;
}

/** Runs `fn` as a new request with a new ID. Each HTTP request, cron run and alarm starts one. */
export function startRequest<T>(trigger: Trigger, fn: () => T, context?: Fields): T {
  return active.context.run({ ...context, requestId: newRequestId(), trigger }, fn);
}

/** The context to pass as the last argument of a call into a Durable Object. */
export function carrier(): Carrier {
  const out: Record<string, string> = { requestId: requestId() ?? newRequestId() };
  active.tracer.inject(out);
  return out as Carrier;
}

/**
 * Runs `fn` as the continuation of the caller's request: the same request ID and, if the adapter
 * propagates traces, the same trace. Without a valid carrier, `fn` stays in the current request,
 * for a call inside one instance, or runs as a new request if there is none.
 */
export function resumeRequest<T>(from: Carrier | undefined, fn: () => T, context?: Fields): T {
  if (from !== undefined && REQUEST_ID.test(String(from.requestId))) {
    const fields = { ...context, requestId: from.requestId, trigger: "rpc" };
    return active.tracer.extract(from, () => active.context.run(fields, fn));
  }
  const current = active.context.current();
  if (current) return active.context.run({ ...current, ...context }, fn);
  return active.context.run({ ...context, requestId: newRequestId(), trigger: "rpc" }, fn);
}
