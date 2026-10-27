import { describe, expect, it } from "vitest";

// Vite inlines the glob at build time. The `vite/client` types are not a dependency here.
// @ts-expect-error `import.meta.glob` is untyped without `vite/client`
const sources: Record<string, string> = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * Remove string literals. A template literal keeps only its `${...}` expressions, so that
 * "${error}" is still seen and a ";" or a word inside plain text does not matter.
 */
function withoutLiterals(code: string): string {
  return code
    .replace(
      /`(?:\\.|[^`\\])*`/g,
      (template) =>
        [...template.matchAll(/\$\{([^}]*)\}/g)].map((m) => ` \${${m[1]}} `).join("") || '""',
    )
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');
}

const SAFE_CALLS = /errorLogFields\([^)]*\)|errorCode\([^)]*\)/g;

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

describe("log hygiene", () => {
  it("logs no raw error, message or stack outside errorLogFields", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const offenders = Object.entries(sources).flatMap(([path, code]) =>
      rawErrorLogs(code).map((hit) => `${path}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  it("finds a raw error in a console call", () => {
    expect(rawErrorLogs('console.error("x", id, error);')).toHaveLength(1);
    expect(rawErrorLogs('console.error("x", e.message);')).toHaveLength(1);
    expect(rawErrorLogs('console.error("x", error.stack);')).toHaveLength(1);
    expect(rawErrorLogs('console.error("x; y", id, ...errorLogFields(error));')).toHaveLength(0);
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
