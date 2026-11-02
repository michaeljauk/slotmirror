import { execFile } from "node:child_process";
import { parseAdapterAnswer, type AdapterRequest, type AdapterResponse } from "./live.ts";

/** Run the adapter once per request: JSON on stdin, JSON on stdout. Its stderr stays in the error. */
export function runAdapterCommand(
  command: string,
  request: AdapterRequest,
): Promise<AdapterResponse> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/bin/sh",
      ["-c", command],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`The adapter failed on ${request.op}: ${stderr || error.message}`));
          return;
        }
        try {
          resolve(parseAdapterAnswer(request.op, stdout));
        } catch (fault) {
          reject(fault as Error);
        }
      },
    );
    child.stdin?.end(JSON.stringify(request));
  });
}
