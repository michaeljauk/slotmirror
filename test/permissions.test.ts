import { describe, expect, it } from "vitest";
import { app, permissionGate } from "../src/app";
import {
  ACTIONS,
  can,
  parseMcpForMembers,
  permitted,
  type Action,
  type McpForMembers,
} from "../src/permissions";
import { ROUTE_NEEDS } from "../src/route-permissions";
import type { Role } from "../src/access";

/**
 * The expected grants, written out by hand so that a change to the mapping shows here. Columns:
 * member with MCP off, member with MCP for all members, admin (the setting does not matter).
 */
const EXPECTED: Record<Action, [boolean, boolean, boolean]> = {
  "accounts:read": [true, true, true],
  "accounts:write": [true, true, true],
  "rules:read": [true, true, true],
  "rules:write": [true, true, true],
  "activity:read": [true, true, true],
  "account:delete": [true, true, true],
  "tokens:read": [true, true, true],
  "tokens:create": [false, true, true],
  "tokens:revoke": [true, true, true],
  "apps:connect": [false, true, true],
  "mcp:read": [false, true, true],
  "mcp:write": [false, false, false],
  "users:read": [false, false, true],
  "users:manage": [false, false, true],
  "org:audit": [false, false, true],
  "org:operate": [false, false, true],
  "org:policy": [false, false, true],
  "dev:tools": [false, false, true],
};

describe("can", () => {
  it("covers every action of the catalog in the expected table", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ACTIONS].sort());
  });

  const principals: [string, Role, McpForMembers, 0 | 1 | 2][] = [
    ["member, MCP off", "member", "off", 0],
    ["member, MCP for members", "member", "all", 1],
    ["admin, MCP off for members", "admin", "off", 2],
    ["admin, MCP for members", "admin", "all", 2],
  ];
  for (const [label, role, mcpForMembers, column] of principals) {
    it(`grants the expected actions to a ${label}`, () => {
      const actual = Object.fromEntries(
        ACTIONS.map((action) => [action, can({ role, mcpForMembers }, action)]),
      );
      const expected = Object.fromEntries(
        ACTIONS.map((action) => [action, EXPECTED[action][column]]),
      );
      expect(actual).toEqual(expected);
    });
  }

  it("keeps only the items whose action the principal has", () => {
    const tools = [
      { name: "read", action: "mcp:read" as const },
      { name: "write", action: "mcp:write" as const },
    ];
    const names = (role: Role, mcpForMembers: McpForMembers) =>
      permitted({ role, mcpForMembers }, tools).map((tool) => tool.name);
    expect(names("admin", "off")).toEqual(["read"]);
    expect(names("member", "all")).toEqual(["read"]);
    expect(names("member", "off")).toEqual([]);
  });

  it("reads an unknown stored setting as off", () => {
    expect(parseMcpForMembers("all")).toBe("all");
    expect(parseMcpForMembers("off")).toBe("off");
    expect(parseMcpForMembers("ALL")).toBe("off");
    expect(parseMcpForMembers(null)).toBe("off");
    expect(parseMcpForMembers(1)).toBe("off");
  });
});

describe("route needs", () => {
  // `use()` registers middleware with method "ALL"; the app has no `all()` route after the session.
  const registered = [
    ...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`)),
  ].sort();

  it("names an action or 'public' for every route of the app", () => {
    const missing = registered.filter((route) => !(route in ROUTE_NEEDS));
    expect(missing).toEqual([]);
  });

  it("names no route that the app does not have", () => {
    const stale = Object.keys(ROUTE_NEEDS).filter((route) => !registered.includes(route));
    expect(stale).toEqual([]);
  });

  it("registers every route after the permission gate, except those with their own check", () => {
    const gate = app.routes.findIndex((route) => route.handler === permissionGate);
    expect(gate).toBeGreaterThan(0);
    const before = [
      ...new Set(
        app.routes
          .slice(0, gate)
          .filter((route) => route.method !== "ALL")
          .map((route) => `${route.method} ${route.path}`),
      ),
    ].sort();
    // Each of these checks its own credential: a webhook signature, a token, an OAuth client.
    expect(before).toEqual(
      [
        "GET /.well-known/oauth-authorization-server",
        "GET /.well-known/oauth-protected-resource",
        "GET /.well-known/oauth-protected-resource/mcp",
        "GET /healthz",
        "GET /privacy",
        "POST /mcp",
        "POST /oauth/register",
        "POST /oauth/revoke",
        "POST /oauth/token",
        "POST /webhooks/google",
        "POST /webhooks/microsoft",
      ].sort(),
    );
    const selfChecked = before.filter((route) => ROUTE_NEEDS[route] !== "public");
    expect(selfChecked).toEqual(["POST /mcp", "POST /oauth/token"]);
  });

  it("names only actions of the catalog", () => {
    const unknown = Object.values(ROUTE_NEEDS).filter(
      (need) => need !== "public" && !(ACTIONS as readonly string[]).includes(need),
    );
    expect(unknown).toEqual([]);
  });

  it("keeps the admin and dev routes away from 'public'", () => {
    const open = Object.entries(ROUTE_NEEDS)
      .filter(([route]) => /^\w+ \/(admin|dev|tokens|accounts|rules)\b/.test(route))
      .filter(([, need]) => need === "public")
      .map(([route]) => route);
    expect(open).toEqual([]);
  });
});
