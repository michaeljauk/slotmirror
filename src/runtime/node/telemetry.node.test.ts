import { afterEach, describe, expect, it } from "vitest";
import { getTelemetry, log, requestId, setTelemetry, startRequest } from "../../telemetry";
import { nodeTelemetry } from "./telemetry";

const previous = getTelemetry();

afterEach(() => {
  setTelemetry(previous);
});

describe("the Node telemetry adapter", () => {
  it("writes one JSON line per record, with the request context", async () => {
    const lines: string[] = [];
    setTelemetry(nodeTelemetry({ write: (line) => lines.push(line) }));
    const id = await startRequest("cron", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const error = new Error("secret for alice@corp.example");
      // A field named like the timestamp does not replace it.
      log.error("test.failed", { accountId: "a-1", time: "x" }, error);
      return requestId();
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(lines[0]).not.toContain("alice@");
    const line = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "error",
      event: "test.failed",
      message: "test.failed",
      accountId: "a-1",
      requestId: id,
      trigger: "cron",
      error: { name: "Error" },
    });
    expect(Date.parse(String(line.time))).not.toBeNaN();
  });
});
