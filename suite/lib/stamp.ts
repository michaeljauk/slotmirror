import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** What a result needs to name the code and the list of its run. */
export interface RunStamp {
  commit: string;
  dirty: boolean;
  listHash: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** SHA-256 over the sorted paths and contents of the version folder. */
export function hashFolder(folder: string): string {
  const hash = createHash("sha256");
  const paths = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();
  for (const path of paths) {
    hash.update(`${relative(folder, path)}\0`);
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function runStamp(suiteDir: string): RunStamp {
  const root = dirname(suiteDir);
  return {
    commit: git(root, "rev-parse", "HEAD"),
    // Untracked files do not count: a new file in the list changes `listHash`.
    dirty: git(root, "status", "--porcelain", "--untracked-files=no") !== "",
    listHash: hashFolder(join(suiteDir, "v1")),
  };
}
