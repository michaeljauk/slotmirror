import { describe, expect, it } from "vitest";

// Vite inlines the glob at build time. The `vite/client` types are not a dependency here.
// @ts-expect-error `import.meta.glob` is untyped without `vite/client`
const sources: Record<string, string> = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Remove string and template literals, so a ";" or a word inside text does not matter. */
function withoutLiterals(code: string): string {
  return code
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');
}

/** Arguments of every console call that mention an error value, message or stack directly. */
function rawErrorLogs(code: string): string[] {
  const calls = [
    ...withoutLiterals(code).matchAll(/console\.(?:error|warn|log|info|debug)\(([^;]*)\);/g),
  ];
  return calls
    .map((match) => (match[1] ?? "").replace(/errorLogFields\([^)]*\)|errorCode\([^)]*\)/g, ""))
    .filter((args) => /\.(message|stack)\b|\b\w*(error|err)\b/i.test(args));
}

describe("log hygiene", () => {
  it("logs no raw error, message or stack outside errorLogFields", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const offenders = Object.entries(sources).flatMap(([path, code]) =>
      rawErrorLogs(code).map((args) => `${path}: console(${args.trim()})`),
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
});
