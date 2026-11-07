/**
 * The telemetry adapter of the Cloudflare runtime. `src/index.tsx` installs it.
 *
 * - Logs: `consoleSink`. Workers Logs indexes each key of the object.
 * - Spans: `tracing` of `cloudflare:workers`, with `enterSpan`, which ends the span when the callback
 *   settles. With observability off, the IDs are zeros and `current()` returns undefined.
 * - Context: `AsyncLocalStorage`. The compatibility date turns on `nodejs_compat`, which provides it.
 *
 * Cloudflare links the spans of a Durable Object call to the caller's span by itself, so `inject`
 * and `extract` do nothing here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { tracing } from "cloudflare:workers";
import { consoleSink } from "../console-sink";
import type { ContextPort, Fields, SpanContext, Telemetry, TracerPort } from "../../telemetry";

const ZERO_TRACE = /^0+$/;

/** Span attributes without undefined values, as `Span.setAttributes` takes them. */
function attributes(fields: Fields): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

export const workersTracer: TracerPort = {
  span(name, attrs, fn) {
    return tracing.enterSpan(name, (span) => {
      span.setAttributes(attributes(attrs));
      return fn({
        setAttributes: (more) => {
          span.setAttributes(attributes(more));
        },
        recordError: (error) => {
          span.recordException({
            name: error.name,
            ...(error.code ? { code: error.code } : {}),
            ...(error.message ? { message: error.message } : {}),
            stack: error.frames,
          });
          span.setStatus({ code: "error" });
        },
      });
    });
  },
  current(): SpanContext | undefined {
    const context = tracing.getActiveSpan()?.spanContext();
    if (!context || ZERO_TRACE.test(context.traceId)) return undefined;
    return { traceId: context.traceId, spanId: context.spanId };
  },
  inject() {},
  extract: (_carrier, fn) => fn(),
};

/** A context port on `AsyncLocalStorage`. */
export function storageContext(): ContextPort {
  const storage = new AsyncLocalStorage<Fields>();
  return {
    run: (context, fn) => storage.run(context, fn),
    current: () => storage.getStore(),
  };
}

export function workersTelemetry(): Telemetry {
  return { sink: consoleSink, tracer: workersTracer, context: storageContext() };
}
