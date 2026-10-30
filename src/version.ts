import pkg from "../package.json";

/**
 * Set at deploy time: `wrangler deploy --define '__BUILD_COMMIT__:"<hash>"'`.
 * It stays undefined in `pnpm dev` and in deploys that do not set it.
 */
declare const __BUILD_COMMIT__: string | undefined;

/** The version line for the footer, or null if the build has neither a release nor a commit. */
export function versionLabel(version: string, commit: string | undefined): string | null {
  const release = version && version !== "0.0.0" ? `v${version}` : "";
  const hash = commit?.trim().slice(0, 9) ?? "";
  if (release && hash) return `${release} (${hash})`;
  return release || hash || null;
}

/** The label of this build: the package version and the commit set at deploy time. */
export function buildVersionLabel(): string | null {
  return versionLabel(
    pkg.version,
    typeof __BUILD_COMMIT__ === "undefined" ? undefined : __BUILD_COMMIT__,
  );
}
