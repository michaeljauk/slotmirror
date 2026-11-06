import { describe, expect, it } from "vitest";
import { runtime } from "./runtime";

// The `node` project has no shims yet. This test proves that the project runs on Node, not on
// workerd, and that `runtime` names it. Later work moves the other test files onto both projects.
describe("the node test project", () => {
  it("runs on Node", () => {
    expect(runtime).toBe("node");
    expect(typeof process.versions.node).toBe("string");
    expect(navigator.userAgent).not.toBe("Cloudflare-Workers");
  });
});
