import { describe, expect, it } from "vitest";

// Vite inlines the glob at build time. The `vite/client` types are not a dependency here.
// @ts-expect-error `import.meta.glob` is untyped without `vite/client`
const sources: Record<string, string> = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Comments, then string literals, in one pass from left to right: whichever starts first wins. So
 * a backtick in a comment does not open a template literal that hides code, and "//" in a string
 * is no comment. A comment becomes a space. A template literal keeps only its `${...}` expressions,
 * so that "${error}" is still seen and a ";" or a word inside plain text does not matter.
 */
const TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;

function withoutLiterals(code: string): string {
  return code.replace(TOKEN, (token) => {
    if (token.startsWith("/")) return " ";
    if (token.startsWith("`")) {
      return [...token.matchAll(/\$\{([^}]*)\}/g)].map((m) => ` \${${m[1]}} `).join("") || '""';
    }
    return '""';
  });
}

const SAFE_CALLS = /errorFields\([^)]*\)|errorCode\([^)]*\)/g;

/** The arguments of the call whose "(" is at `open`, split at top-level commas. */
function callArgs(code: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const char = code[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        args.push(code.slice(start, i));
        return args.map((arg) => arg.trim()).filter((arg) => arg !== "");
      }
    } else if (char === "," && depth === 1) {
      args.push(code.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

/** Names that hold a caught error: any `catch (name)` or `.catch((name) =>`, plus common ones. */
function errorNames(code: string): string[] {
  const names = new Set(["error", "err", "e", "cause"]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*(\w+)/g)) names.add(m[1] as string);
  for (const m of code.matchAll(
    /\.catch\(\s*(?:async\s*)?(?:function\s*)?\(?\s*(\w+)\s*\)?\s*(?:=>|\{)/g,
  )) {
    names.add(m[1] as string);
  }
  return [...names];
}

/** Places that send a raw error, message or stack toward a log. Empty if there are none. */
export function rawErrorLogs(source: string): string[] {
  const code = withoutLiterals(source);
  const names = errorNames(code);
  const word = new RegExp(`\\b(?:${names.join("|")})\\b`);
  const found: string[] = [];
  // A console call that names an error value, `.message` or `.stack`.
  for (const m of code.matchAll(/console\.(?:error|warn|log|info|debug)\(([^;]*)\);/g)) {
    const args = (m[1] ?? "").replace(SAFE_CALLS, "");
    if (/\.(message|stack)\b/.test(args) || word.test(args)) found.push(`console(${args.trim()})`);
  }
  // A logger call. The third argument is the caught value itself: the logger keeps only its
  // `errorFields`. The event and the fields must not name an error, `.message` or `.stack`.
  for (const m of code.matchAll(/\blog\.(?:error|warn|info)\(/g)) {
    const [event = "", fields = "", error, ...extra] = callArgs(code, m.index + m[0].length - 1);
    const named = [event, fields, ...extra].join(", ").replace(SAFE_CALLS, "");
    if (/\.(message|stack)\b/.test(named) || word.test(named)) found.push(`log(${named})`);
    if (error !== undefined && !/^\w+$/.test(error)) found.push(`log(..., ${error})`);
  }
  // `.catch(console.error)` passes the raw error as the argument.
  for (const m of code.matchAll(/\.catch\(\s*console\.\w+\s*\)/g)) found.push(m[0]);
  // The error turned into text: `${error}`, `${e.message}`, JSON.stringify(err), String(err).
  const textual = new RegExp(
    `\\$\\{\\s*(?:${names.join("|")})\\s*(?:\\.(?:message|stack)\\b[^}]*)?\\}|JSON\\.stringify\\(\\s*(?:${names.join("|")})\\b|\\bString\\(\\s*(?:${names.join("|")})\\s*\\)`,
    "g",
  );
  for (const m of code.matchAll(textual)) found.push(m[0]);
  return found;
}

/**
 * Places that must turn an error into text, and why. The test fails if one of them is gone or
 * occurs twice, so the list stays exact.
 */
const ERROR_TEXT_ALLOWED = [
  // The Node runtime copies D1's error form "D1_ERROR: <SQLite message>"; safeMessage() then
  // decides what reaches a log, as on Cloudflare.
  "../src/runtime/node/sql-database.ts: String(error)",
  "../src/runtime/node/sql-database.ts: ${error.message}",
  // A failed migration stops the start and names the file and the SQLite error of its static SQL.
  "../src/runtime/node/migrations.ts: String(error)",
  // Not a log: a sign-in tests the text for D1's UNIQUE refusal and keeps it nowhere.
  "../src/users.ts: String(error)",
];

describe("log hygiene", () => {
  it("logs no raw error, message or stack outside errorFields", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const hits = Object.entries(sources).flatMap(([path, code]) =>
      rawErrorLogs(code).map((hit) => `${path}: ${hit}`),
    );
    expect(hits.filter((hit) => !ERROR_TEXT_ALLOWED.includes(hit))).toEqual([]);
    // Each allowed place occurs exactly once: not gone, and not copied.
    expect(hits.filter((hit) => ERROR_TEXT_ALLOWED.includes(hit)).sort()).toEqual(
      [...ERROR_TEXT_ALLOWED].sort(),
    );
  });

  it("calls console only in the runtime adapters", () => {
    const calls = Object.entries(sources).flatMap(([path, code]) =>
      path.startsWith("../src/runtime/")
        ? []
        : [...withoutLiterals(code).matchAll(/\bconsole\.\w+/g)].map((m) => `${path}: ${m[0]}`),
    );
    expect(calls).toEqual([]);
  });

  it("names every log event in dotted lower case", () => {
    const events = Object.entries(sources).flatMap(([path, code]) =>
      [...code.matchAll(/\blog\.(?:error|warn|info)\(\s*([^,)]*)/g)].map((m) => ({
        path,
        event: (m[1] ?? "").trim(),
      })),
    );
    expect(events.length).toBeGreaterThan(70);
    const bad = events.filter(({ event }) => !/^"[a-z][a-z_]*(\.[a-z][a-z_]*)+"$/.test(event));
    expect(bad).toEqual([]);
  });

  it("sees code after a backtick in a comment, and no comment inside a string", () => {
    expect(rawErrorLogs("// a `quote\nconsole.error(error);\n// end`")).toHaveLength(1);
    expect(rawErrorLogs('const url = "https://x"; console.error(error);')).toHaveLength(1);
    expect(rawErrorLogs("/* console.error(error); */ const x = 1;")).toHaveLength(0);
  });

  it("finds a raw error in a logger call", () => {
    expect(rawErrorLogs('log.error("x.y", { id }, error);')).toHaveLength(0);
    expect(rawErrorLogs('log.error("x.y", { error });')).toHaveLength(1);
    expect(rawErrorLogs('log.error("x.y", { text: e.message });')).toHaveLength(1);
    expect(rawErrorLogs('log.warn("x.y", { stack: error.stack }, error);')).toHaveLength(1);
    expect(rawErrorLogs('log.error("x.y", {}, error.message);')).toHaveLength(1);
    expect(rawErrorLogs('log.error("x.y", { code: errorCode(error) }, error);')).toHaveLength(0);
    expect(rawErrorLogs("try { x(); } catch (boom) { log.error('x.y', { boom }); }")).toHaveLength(
      1,
    );
  });

  it("finds a raw error in a console call", () => {
    expect(rawErrorLogs('console.error("x", id, error);')).toHaveLength(1);
    expect(rawErrorLogs('console.error("x", e.message);')).toHaveLength(1);
    expect(rawErrorLogs('console.error("x", error.stack);')).toHaveLength(1);
    expect(rawErrorLogs('console.error("x; y", id, errorFields(error));')).toHaveLength(0);
    expect(rawErrorLogs('console.error("x", errorCode(error));')).toHaveLength(0);
  });

  it("finds an error inside a template string", () => {
    expect(rawErrorLogs("console.error(`failed: ${error}`);").length).toBeGreaterThan(0);
    expect(rawErrorLogs("console.error(`failed: ${e.message}`);").length).toBeGreaterThan(0);
    expect(rawErrorLogs("const text = `failed: ${error}`;")).toHaveLength(1);
    expect(rawErrorLogs("console.error(`${provider} failed`, id);")).toHaveLength(0);
  });

  it("tracks the name of a catch parameter", () => {
    expect(
      rawErrorLogs("try { x(); } catch (problem) { console.error('x', problem); }"),
    ).toHaveLength(1);
    expect(
      rawErrorLogs("try { x(); } catch (boom) { console.error(`x ${boom}`); }").length,
    ).toBeGreaterThan(0);
    expect(rawErrorLogs("x().catch((reason) => console.error('x', reason));")).toHaveLength(1);
    expect(rawErrorLogs("try { x(); } catch (problem) { console.error('x', id); }")).toHaveLength(
      0,
    );
  });

  it("finds a stringified error", () => {
    expect(rawErrorLogs("console.error('x', JSON.stringify(err));").length).toBeGreaterThan(0);
    expect(rawErrorLogs("const t = JSON.stringify(error);")).toHaveLength(1);
    expect(rawErrorLogs("const t = String(error);")).toHaveLength(1);
  });

  it("finds .catch(console.error)", () => {
    expect(rawErrorLogs("promise.catch(console.error);")).toHaveLength(1);
    expect(rawErrorLogs("promise.catch( console.warn );")).toHaveLength(1);
  });
});
