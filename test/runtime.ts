declare const __TEST_RUNTIME__: "workers" | "node";

/**
 * The runtime that the current Vitest project tests: "workers" (workerd) or "node". Each project
 * sets it with `define`. A test that checks a value only one runtime has uses
 * `it.skipIf(runtime === "node")`.
 */
export const runtime = __TEST_RUNTIME__;
