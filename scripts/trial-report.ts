/**
 * `pnpm trial:report`: a list of what the audit log holds per active rule. It only reads.
 *
 *   pnpm trial:report [--remote] [--config <file>] [--since 7d] [--db DB] [--limit 5000]
 *
 * Without `--remote` it reads the local database (`wrangler dev` state). `--remote` reads the
 * deployed database and counts against the D1 read quota; the period and the row limit keep that
 * small. `--config` goes to wrangler, for an instance with its own `wrangler.local.jsonc`.
 */
import { execFileSync } from "node:child_process";
import { argv, exit, stderr, stdout } from "node:process";
import {
  AUDIT_ROW_LIMIT,
  DEFAULT_SINCE_MS,
  collectReport,
  formatReport,
  parseSince,
  readOption,
  type Exec,
} from "./trial-report-lib.ts";

const option = (name: string) => readOption(argv, name);

const exec: Exec = (args) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });

try {
  const nowMs = Date.now();
  const since = option("--since");
  const limit = option("--limit");
  const report = collectReport(exec, {
    database: option("--db") ?? "DB",
    remote: argv.includes("--remote"),
    config: option("--config"),
    sinceMs: since ? parseSince(since, nowMs) : nowMs - DEFAULT_SINCE_MS,
    nowMs,
    limit: limit ? Number(limit) : AUDIT_ROW_LIMIT,
  });
  stdout.write(`${formatReport(report)}\n`);
} catch (error) {
  stderr.write(`trial:report failed: ${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}
