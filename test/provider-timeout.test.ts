import { afterEach, describe, expect, it, vi } from "vitest";
import { errorCode, errorLogFields } from "../src/audit";
import { GoogleApiError, GoogleCalendar } from "../src/providers/google-calendar";
import { GraphCalendar, GraphError } from "../src/providers/graph-calendar";
import { requestToken, TokenError } from "../src/providers/oauth-token";
import {
  BATCH_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  providerFetch,
  TOKEN_TIMEOUT_MS,
} from "../src/providers/provider-fetch";
import { throttleDelayMs } from "../src/sync/throttle";
import type { SyncAction } from "../src/sync/types";
import { shortProviderTimeouts as shortTimeouts } from "./helpers";

// Vite inlines the glob at build time. The `vite/client` types are not a dependency here.
// @ts-expect-error `import.meta.glob` is untyped without `vite/client`
const sources: Record<string, string> = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** An answer whose headers arrive and whose body never ends. */
const stalled = (init: ResponseInit) => new Response(new ReadableStream({ start: () => {} }), init);

/** A provider that accepts the request and never answers. Rejects only when the signal fires. */
function hangingFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          reject(signal.reason as Error);
        });
      }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("providerFetch", () => {
  const timedOut = () => new Error("stable timeout");

  it("gives up on a call that never answers", async () => {
    hangingFetch();
    await expect(providerFetch("https://p.example/", {}, 5, timedOut)).rejects.toThrow(
      "stable timeout",
    );
  });

  it("aborts the call at the deadline", async () => {
    const fetch = hangingFetch();
    await expect(providerFetch("https://p.example/", {}, 5, timedOut)).rejects.toThrow(
      "stable timeout",
    );
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("gives up on a call that ignores the signal", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    await expect(providerFetch("https://p.example/", {}, 5, timedOut)).rejects.toThrow(
      "stable timeout",
    );
  });

  it("gives up on a response whose body never ends", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => stalled({}));
    await expect(providerFetch("https://p.example/", {}, 5, timedOut)).rejects.toThrow(
      "stable timeout",
    );
  });

  it("keeps the status and Retry-After of a refusal whose body never ends", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      stalled({ status: 429, headers: { "Retry-After": "7" } }),
    );
    const response = await providerFetch("https://p.example/", {}, 5, timedOut);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(await response.text()).toBe("");
  });

  it("leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timersDuringCall: number[] = [];
    const outcomes: (() => Response)[] = [
      () => new Response("ok"),
      () => new Response(null, { status: 204 }),
      () => Response.json({}, { status: 429 }),
      () => {
        throw new Error("Network connection lost.");
      },
    ];
    for (const outcome of outcomes) {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        timersDuringCall.push(vi.getTimerCount());
        return outcome();
      });
      await providerFetch("https://p.example/", {}, 1000, timedOut).catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(timersDuringCall).toEqual([1, 1, 1, 1]);
  });

  it("passes the request on, with the signal", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await providerFetch("https://p.example/", { method: "POST", body: "b" }, 1000, timedOut);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://p.example/");
    expect(init).toMatchObject({ method: "POST", body: "b" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the status, the headers and the body of the provider's response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: { code: "TooMany" } },
        { status: 429, headers: { "Retry-After": "7" } },
      ),
    );
    const response = await providerFetch("https://p.example/", {}, 1000, timedOut);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(await response.json()).toEqual({ error: { code: "TooMany" } });
  });

  it("returns a response without a body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const response = await providerFetch("https://p.example/", {}, 1000, timedOut);
    expect(response.status).toBe(204);
    expect(response.ok).toBe(true);
  });

  it("keeps any other failure as it is", async () => {
    const lost = new Error("Network connection lost.");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(lost);
    await expect(providerFetch("https://p.example/", {}, 1000, timedOut)).rejects.toBe(lost);
  });
});

describe("requestToken", () => {
  it("gives a stable code if the token endpoint never answers", async () => {
    const timeouts = shortTimeouts();
    hangingFetch();
    const error = await requestToken("https://login.example/token", { grant_type: "x" }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).code).toBe("timeout");
    expect(errorCode(error)).toBe("token_timeout");
    expect(timeouts).toHaveBeenCalledWith(expect.any(Function), TOKEN_TIMEOUT_MS);
  });

  it("gives the same code if the body of the answer never ends", async () => {
    shortTimeouts();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => stalled({}));
    await expect(requestToken("https://login.example/token", {})).rejects.toThrow("timeout");
  });

  it("reports the status of a refusal whose body never ends", async () => {
    shortTimeouts();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => stalled({ status: 429 }));
    const error = await requestToken("https://login.example/token", {}).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).code).toBe("http_429");
  });
});

const WINDOW = { start: new Date("2026-11-02"), end: new Date("2026-11-03") };
const WATCH = { id: "w", resourceId: "r", expiresAt: 0 };
const ACTIONS: SyncAction[] = [{ kind: "delete", targetId: "SECRET-EVENT-ID", marker: "m" }];

describe("calendar adapters", () => {
  const graph = new GraphCalendar("SECRET-TOKEN");
  const google = new GoogleCalendar("SECRET-TOKEN");

  it.each<[string, () => Promise<unknown>, number]>([
    ["sourceEvents", () => graph.sourceEvents("SECRET-CAL", WINDOW), CALL_TIMEOUT_MS],
    ["existingBlocks", () => graph.existingBlocks("SECRET-CAL", WINDOW, []), CALL_TIMEOUT_MS],
    ["listCalendars", () => graph.listCalendars(), CALL_TIMEOUT_MS],
    ["applyBatch", () => graph.applyBatch("SECRET-CAL", "tag", ACTIONS), BATCH_TIMEOUT_MS],
    ["watch", () => graph.watch("SECRET-CAL", "https://w.example", "t", 0), CALL_TIMEOUT_MS],
    ["renew", () => graph.renew(WATCH, 0), CALL_TIMEOUT_MS],
    ["unwatch", () => graph.unwatch(WATCH), CALL_TIMEOUT_MS],
  ])("Graph %s fails with a stable code", async (_name, call, timeoutMs) => {
    const timeouts = shortTimeouts();
    hangingFetch();
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphError);
    expect(error).toMatchObject({ status: 504, reason: "timeout" });
    expect(errorCode(error)).toBe("graph_504_timeout");
    expect(timeouts).toHaveBeenCalledWith(expect.any(Function), timeoutMs);
    expect(JSON.stringify(errorLogFields(error))).not.toContain("SECRET");
    expect((error as Error).message).not.toContain("SECRET");
  });

  it.each<[string, () => Promise<unknown>, number]>([
    ["sourceEvents", () => google.sourceEvents("SECRET-CAL", WINDOW), CALL_TIMEOUT_MS],
    ["existingBlocks", () => google.existingBlocks("SECRET-CAL", WINDOW, []), CALL_TIMEOUT_MS],
    ["listCalendars", () => google.listCalendars(), CALL_TIMEOUT_MS],
    ["changesSince", () => google.changesSince("SECRET-CAL", "token"), CALL_TIMEOUT_MS],
    ["applyBatch", () => google.applyBatch("SECRET-CAL", "tag", ACTIONS), BATCH_TIMEOUT_MS],
    ["watch", () => google.watch("SECRET-CAL", "https://w.example", "t", 0), CALL_TIMEOUT_MS],
    ["unwatch", () => google.unwatch(WATCH), CALL_TIMEOUT_MS],
  ])("Google %s fails with a stable code", async (_name, call, timeoutMs) => {
    const timeouts = shortTimeouts();
    hangingFetch();
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ status: 504, reason: "timeout" });
    expect(errorCode(error)).toBe("google_504_timeout");
    expect(timeouts).toHaveBeenCalledWith(expect.any(Function), timeoutMs);
    expect(JSON.stringify(errorLogFields(error))).not.toContain("SECRET");
    expect((error as Error).message).not.toContain("SECRET");
  });

  it.each<[string, () => Promise<unknown>, typeof GraphError | typeof GoogleApiError]>([
    ["Graph", () => graph.listCalendars(), GraphError],
    ["Google", () => google.listCalendars(), GoogleApiError],
  ])("%s keeps the wait of a throttled answer whose body never ends", async (_name, call, type) => {
    shortTimeouts();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      stalled({ status: 429, headers: { "Retry-After": "7" } }),
    );
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 7000 });
    expect(throttleDelayMs(error)).toBe(7000);
  });

  it("does not read a timeout as a throttled answer", async () => {
    shortTimeouts();
    hangingFetch();
    const error = await graph.listCalendars().catch((caught: unknown) => caught);
    expect(throttleDelayMs(error)).toBeNull();
    // An error that crosses a Durable Object boundary keeps only its message.
    const crossed = new Error((error as Error).message);
    expect(throttleDelayMs(crossed)).toBeNull();
    expect(errorCode(crossed)).toBe("graph_504_timeout");
  });

  it.each([
    ["Graph $batch failed: 504 timeout", "graph_504_timeout"],
    ["Google batch failed: 504 timeout", "google_504_timeout"],
    ["Google GET failed: 403 rateLimitExceeded", "google_403_rateLimitExceeded"],
    ["Graph subscribe failed: 500", "graph_500"],
  ])("gives the same code after a Durable Object boundary: %s", (message, code) => {
    expect(errorCode(new Error(message))).toBe(code);
  });
});

describe("a Graph subscription that a timeout left behind", () => {
  const CALENDAR = "calendar-1";
  const HOOK = "https://w.example/webhooks/microsoft?account=a";
  const graph = new GraphCalendar("token");
  const watch = () => graph.watch(CALENDAR, HOOK, "t", 0);
  const orphan = (id: string, notificationUrl = HOOK) => ({
    id,
    resource: `me/calendars/${CALENDAR}/events`,
    notificationUrl,
  });

  /** Graph with these subscriptions. It refuses a second one for a resource with 409. */
  function fakeSubscriptions(stored: ReturnType<typeof orphan>[]) {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.replace("https://graph.microsoft.com/v1.0", "")}`);
      if (method === "POST") {
        const body = JSON.parse(init?.body as string) as { resource: string };
        if (stored.some((item) => item.resource === body.resource)) {
          return Response.json({ error: { code: "ExtensionError" } }, { status: 409 });
        }
        return Response.json(
          { id: "fresh", expirationDateTime: "2026-11-05T00:00:00Z" },
          { status: 201 },
        );
      }
      if (method === "DELETE") {
        const index = stored.findIndex((item) => url.endsWith(`/${item.id}`));
        stored.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      return Response.json({ value: stored });
    });
    return calls;
  }

  it("makes one call if nothing was left behind", async () => {
    const calls = fakeSubscriptions([]);
    expect(await watch()).toMatchObject({ id: "fresh" });
    expect(calls).toEqual(["POST /subscriptions"]);
  });

  it("replaces the subscription behind a 409", async () => {
    const calls = fakeSubscriptions([orphan("left-behind")]);
    expect(await watch()).toMatchObject({ id: "fresh" });
    expect(calls).toEqual([
      "POST /subscriptions",
      "GET /subscriptions",
      "DELETE /subscriptions/left-behind",
      "POST /subscriptions",
    ]);
  });

  it("finds it if Graph writes the resource in another form", async () => {
    const stored = { ...orphan("left-behind"), resource: `Users/1/Calendars/${CALENDAR}/Events` };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return Response.json({ value: [stored] });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return vi.mocked(globalThis.fetch).mock.calls.length === 1
        ? new Response(null, { status: 409 })
        : Response.json({ id: "fresh", expirationDateTime: "2026-11-05T00:00:00Z" });
    });
    expect(await watch()).toMatchObject({ id: "fresh" });
  });

  it("reads every page of subscriptions", async () => {
    const pages = [
      {
        value: [orphan("other-deployment", "https://other.example/")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/subscriptions?page=2",
      },
      { value: [orphan("left-behind")] },
    ];
    const deleted: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return Response.json(pages.shift());
      if (method === "DELETE") {
        deleted.push(input instanceof Request ? input.url : String(input));
        return new Response(null, { status: 204 });
      }
      return deleted.length === 0
        ? new Response(null, { status: 409 })
        : Response.json({ id: "fresh", expirationDateTime: "2026-11-05T00:00:00Z" });
    });
    expect(await watch()).toMatchObject({ id: "fresh" });
    expect(deleted).toEqual(["https://graph.microsoft.com/v1.0/subscriptions/left-behind"]);
  });

  it("keeps a 409 and the subscription of another deployment", async () => {
    const stored = [orphan("other-deployment", "https://other.example/")];
    const calls = fakeSubscriptions(stored);
    const error = await watch().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphError);
    expect(error).toMatchObject({ status: 409, reason: "ExtensionError" });
    expect(calls).toEqual(["POST /subscriptions", "GET /subscriptions"]);
    expect(stored).toHaveLength(1);
  });
});

describe("provider calls", () => {
  /** A call of the global `fetch`. A method such as `app.fetch(` calls no provider. */
  const BARE_FETCH = /(?<![\w$.])(?:(?:globalThis|self)\s*\.\s*)?fetch\s*\(/g;
  const bareCalls = (code: string) => [...code.matchAll(BARE_FETCH)].length;

  /**
   * The bare calls of each file. alerts.ts calls the operator's webhook, with its own timeout. The
   * simulated calendars and the /dev routes call the probe target only, never a provider.
   */
  const ALLOWED: Record<string, number> = {
    "../src/providers/provider-fetch.ts": 1,
    "../src/alerts.ts": 1,
    "../src/providers/fake-calendar.ts": 2,
    "../src/routes/dev.tsx": 1,
  };

  it.each(["await fetch(url)", "fetch (url)", "globalThis.fetch(url)", "self.fetch(url)"])(
    "finds the bare call in `%s`",
    (code) => {
      expect(bareCalls(code)).toBe(1);
    },
  );

  it.each(["app.fetch(request)", "stub.fetch(url)", "prefetch(url)", "the `fetch` call"])(
    "finds no bare call in `%s`",
    (code) => {
      expect(bareCalls(code)).toBe(0);
    },
  );

  it("use providerFetch everywhere", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const bare = Object.entries(sources)
      .filter(([path, code]) => bareCalls(code) !== (ALLOWED[path] ?? 0))
      .map(([path]) => path);
    expect(bare).toEqual([]);
  });
});
