import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ruleOptionsSchema } from "../src/config";
import { GoogleCalendar, parseBatchStatuses } from "../src/providers/google-calendar";
import { fromGoogleEvent, toGoogleBlock } from "../src/sync/google-events";
import { desiredBlocks } from "../src/sync/plan";
import type { SourceEvent } from "../src/sync/types";
import fixture from "./fixtures/google/events.json";
import { base64url } from "../src/session";
import { OAUTH_COOKIE } from "../src/oauth";
import { BASE, signIn } from "./helpers";

function events(): SourceEvent[] {
  return fixture.items.map(fromGoogleEvent).filter((e): e is SourceEvent => e !== null);
}

function byKey(suffix: string): SourceEvent | undefined {
  return events().find((event) => event.occurrenceKey.endsWith(suffix));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fromGoogleEvent", () => {
  it("drops cancelled occurrences", () => {
    expect(events()).toHaveLength(9);
    expect(events().some((event) => event.start.startsWith("2026-11-09"))).toBe(false);
  });

  it("keeps the identity of a moved occurrence and returns UTC instants", () => {
    const moved = events().find((event) => event.start === "2026-11-17T17:00:00.000Z");
    expect(moved?.occurrenceKey).toBe("series:weekly:2026-11-16T09:00:00.000Z");
  });

  it("maps transparency, visibility and the user's own response", () => {
    expect(byKey(":free1")?.showAs).toBe("free");
    expect(byKey(":private1")?.isPrivate).toBe(true);
    expect(byKey(":declined1")?.declined).toBe(true);
    expect(byKey(":tentative1")?.showAs).toBe("tentative");
    expect(byKey(":allday1")).toMatchObject({
      allDay: true,
      start: "2026-10-29",
      end: "2026-10-30",
    });
    expect(byKey(":mirror1")?.isMirror).toBe(true);
  });

  it("mirrors the same events as the Graph adapter would with default options", async () => {
    const blocks = await desiredBlocks("rule", events(), ruleOptionsSchema.parse({}));
    // single, private, tentative and two football occurrences; not all-day, free, declined, mirror
    expect(blocks).toHaveLength(5);
  });
});

describe("toGoogleBlock", () => {
  it("writes a private block without attendees or reminders and with the marker", async () => {
    const [block] = await desiredBlocks(
      "rule",
      [byKey(":single1") as SourceEvent],
      ruleOptionsSchema.parse({}),
    );
    const body = toGoogleBlock(block!, "tag123456789");
    expect(body).toMatchObject({
      summary: "Busy",
      transparency: "opaque",
      visibility: "private",
      reminders: { useDefault: false, overrides: [] },
      start: { dateTime: "2026-10-27T13:00:00.000Z", timeZone: "UTC" },
    });
    expect(body).not.toHaveProperty("attendees");
    expect(body.extendedProperties.private.freebusySyncMarker).toMatch(
      /^tag123456789\.[0-9a-f]{32}\.[0-9a-f]{32}$/,
    );
  });
});

describe("Google batch", () => {
  it("reads statuses by Content-ID, in any order", () => {
    const body = [
      "--batch_x",
      "Content-Type: application/http",
      "Content-ID: <response-item1>",
      "",
      "HTTP/1.1 410 Gone",
      "",
      "--batch_x",
      "Content-Type: application/http",
      "Content-ID: <response-item0>",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json",
      "",
      "{}",
      "--batch_x--",
    ].join("\r\n");
    expect(parseBatchStatuses(body, "multipart/mixed; boundary=batch_x")).toEqual(
      new Map([
        [0, 200],
        [1, 410],
      ]),
    );
  });

  it("sends one multipart request and counts a delete of a gone block as success", async () => {
    let sent = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent = init?.body as string;
      return new Response(
        [
          "--r",
          "Content-ID: <response-item0>",
          "",
          "HTTP/1.1 200 OK",
          "--r",
          "Content-ID: <response-item1>",
          "",
          "HTTP/1.1 410 Gone",
          "--r--",
        ].join("\r\n"),
        { headers: { "content-type": "multipart/mixed; boundary=r" } },
      );
    });
    const [block] = await desiredBlocks(
      "rule",
      [byKey(":single1") as SourceEvent],
      ruleOptionsSchema.parse({}),
    );
    const result = await new GoogleCalendar("token").applyBatch("primary", "tag", [
      { kind: "create", block: block! },
      { kind: "delete", targetId: "old", marker: "m" },
    ]);
    expect(result).toEqual({ failed: 0, throttled: 0, statuses: {} });
    expect(sent).toContain("POST /calendar/v3/calendars/primary/events HTTP/1.1");
    expect(sent).toContain("DELETE /calendar/v3/calendars/primary/events/old HTTP/1.1");
  });
});

function fakeIdToken(claims: Record<string, unknown>): string {
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

async function startGoogleFlow(path: string, cookie: string) {
  const response = await exports.default.fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: { cookie },
  });
  const location = new URL(response.headers.get("location") ?? "");
  const value = new RegExp(`${OAUTH_COOKIE}=([^;]+)`).exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  return {
    location,
    cookie: `${OAUTH_COOKIE}=${value}`,
    state: location.searchParams.get("state") ?? "",
  };
}

describe("Google sign-in and connect", () => {
  it("asks for offline access and consent only when connecting", async () => {
    const { cookie } = await signIn("owner@example.com");
    const login = await startGoogleFlow("/auth/google/login", "");
    expect(login.location.origin).toBe("https://accounts.google.com");
    expect(login.location.searchParams.get("access_type")).toBeNull();
    const connect = await startGoogleFlow("/auth/google/connect", cookie);
    expect(connect.location.searchParams.get("access_type")).toBe("offline");
    expect(connect.location.searchParams.get("prompt")).toBe("consent");
    expect(connect.location.searchParams.get("scope")).toContain("calendar.events");
  });

  it("stores a connected Google account with provider google", async () => {
    const { cookie } = await signIn("owner@example.com");
    const flow = await startGoogleFlow("/auth/google/connect", cookie);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        access_token: "g-access",
        refresh_token: "g-refresh",
        expires_in: 3600,
        id_token: fakeIdToken({ sub: "1", email: "Private@Gmail.com", email_verified: true }),
      }),
    );
    const response = await exports.default.fetch(
      `${BASE}/auth/google/callback?code=c&state=${flow.state}`,
      {
        headers: { cookie: `${flow.cookie}; ${cookie}` },
        redirect: "manual",
      },
    );
    expect(response.status).toBe(302);
    const account = await env.DB.prepare(
      "SELECT id, provider, tenant_id AS tenantId FROM accounts WHERE email = 'private@gmail.com'",
    ).first<{ id: string; provider: string; tenantId: string | null }>();
    expect(account).toMatchObject({ provider: "google", tenantId: null });
    expect(await env.ACCOUNT_SYNC.getByName(account!.id).hasTokens()).toBe(true);
  });

  it("refuses an unverified Google address", async () => {
    const { cookie } = await signIn("owner@example.com");
    const flow = await startGoogleFlow("/auth/google/connect", cookie);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        id_token: fakeIdToken({ sub: "2", email: "x@gmail.com", email_verified: false }),
      }),
    );
    const response = await exports.default.fetch(
      `${BASE}/auth/google/callback?code=c&state=${flow.state}`,
      {
        headers: { cookie: `${flow.cookie}; ${cookie}` },
        redirect: "manual",
      },
    );
    expect(response.status).toBe(502);
  });
});

describe("rule across providers", () => {
  it("mirrors a Google calendar into a Microsoft calendar", async () => {
    const { user } = await signIn("owner@example.com");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('g-src', ?, 'google', 'me@gmail.com')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO accounts (id, user_id, provider, email) VALUES ('m-dst', ?, 'microsoft', 'me@work.example')",
      ).bind(user.id),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES ('g-cal', 'g-src', 'primary', 'Private', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO calendars (id, account_id, remote_id, name, can_edit) VALUES ('m-cal', 'm-dst', 'work-cal', 'Work', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO rules (id, user_id, source_calendar_id, target_calendar_id) VALUES ('x-rule', ?, 'g-cal', 'm-cal')",
      ).bind(user.id),
    ]);
    const tokens = { refreshToken: "r", accessToken: "a", accessExpiresAt: Date.now() + 3_600_000 };
    await env.ACCOUNT_SYNC.getByName("g-src").storeTokens("g-src", tokens, "google");
    const target = env.ACCOUNT_SYNC.getByName("m-dst");
    await target.storeTokens("m-dst", tokens, "microsoft");

    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
        return Response.json({ items: fixture.items });
      }
      if (url.includes("/calendars/work-cal/calendarView")) return Response.json({ value: [] });
      return new Response("unexpected", { status: 500 });
    });

    const result = await target.runRule("x-rule", { dryRun: true });
    expect(result.stats).toMatchObject({ create: 5, delete: 0 });
    expect(urls.some((url) => url.includes("singleEvents=true"))).toBe(true);
  });
});
