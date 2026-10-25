import type { RuleOptions } from "../config";
import type {
  BlockContent,
  DesiredBlock,
  ExistingBlock,
  SourceEvent,
  SyncAction,
  SyncPlan,
} from "./types";

/** Decide whether a rule mirrors a source event at all. */
export function isIncluded(event: SourceEvent, options: RuleOptions): boolean {
  if (event.isMirror) return false;
  if (options.skipAllDay && event.allDay) return false;
  if (options.skipDeclined && event.declined) return false;
  if (options.skipFree && event.showAs === "free") return false;
  if (options.skipTentative && event.showAs === "tentative") return false;
  return true;
}

/**
 * The block content for a source event at the rule's detail level.
 * Events the source marks private never carry more than "busy", whatever the rule says.
 */
export function blockContent(event: SourceEvent, options: RuleOptions): BlockContent {
  const level = event.isPrivate ? "busy" : options.detailLevel;
  const withTitle = level !== "busy" && event.subject.trim() !== "";
  return {
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    showAs: event.showAs === "unknown" ? "busy" : event.showAs,
    isPrivate: options.markPrivate || event.isPrivate,
    subject: withTitle ? event.subject : options.blockTitle,
    location: level === "title_location" || level === "full" ? event.location : "",
    body: level === "full" ? event.body : "",
  };
}

/** Marker for a block: SHA-256 of rule ID and occurrence key, so no source ID leaves the source. */
export async function markerFor(ruleId: string, occurrenceKey: string): Promise<string> {
  return shortHash(`${ruleId}\u0000${occurrenceKey}`);
}

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** All blocks the target calendar should contain for one rule. */
export async function desiredBlocks(
  ruleId: string,
  events: SourceEvent[],
  options: RuleOptions,
): Promise<DesiredBlock[]> {
  const blocks = new Map<string, DesiredBlock>();
  for (const event of events) {
    if (!isIncluded(event, options)) continue;
    const marker = await markerFor(ruleId, event.occurrenceKey);
    const content = blockContent(event, options);
    const contentHash = await shortHash(JSON.stringify(content));
    blocks.set(marker, { marker, contentHash, ...content });
  }
  return [...blocks.values()];
}

/** Times are compared directly, so that a block moved by hand in the target is moved back. */
function sameContent(existing: ExistingBlock, desired: DesiredBlock): boolean {
  return (
    existing.contentHash === desired.contentHash &&
    existing.allDay === desired.allDay &&
    sameInstant(existing.start, desired.start) &&
    sameInstant(existing.end, desired.end)
  );
}

/** Compare two times; all-day dates compare as text, timestamps as instants. */
function sameInstant(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return !Number.isNaN(ta) && ta === tb;
}

/**
 * Compare what the target should contain with what it contains, inside one sync window.
 *
 * The plan creates missing blocks, updates changed ones and deletes blocks whose source occurrence
 * is gone. Duplicates of a marker (for example after a crash between write and bookkeeping) are
 * deleted except one. It never rebuilds blocks that already match.
 */
export function planSync(desired: DesiredBlock[], existing: ExistingBlock[]): SyncPlan {
  const actions: SyncAction[] = [];
  let unchanged = 0;

  const existingByMarker = new Map<string, ExistingBlock[]>();
  for (const block of existing) {
    const list = existingByMarker.get(block.marker) ?? [];
    list.push(block);
    existingByMarker.set(block.marker, list);
  }

  for (const block of desired) {
    const [current, ...duplicates] = existingByMarker.get(block.marker) ?? [];
    existingByMarker.delete(block.marker);
    for (const duplicate of duplicates) {
      actions.push({ kind: "delete", targetId: duplicate.targetId, marker: duplicate.marker });
    }
    if (!current) {
      actions.push({ kind: "create", block });
    } else if (sameContent(current, block)) {
      unchanged++;
    } else {
      actions.push({ kind: "update", targetId: current.targetId, block });
    }
  }

  for (const orphans of existingByMarker.values()) {
    for (const orphan of orphans) {
      actions.push({ kind: "delete", targetId: orphan.targetId, marker: orphan.marker });
    }
  }

  return {
    actions,
    stats: {
      create: actions.filter((a) => a.kind === "create").length,
      update: actions.filter((a) => a.kind === "update").length,
      delete: actions.filter((a) => a.kind === "delete").length,
      unchanged,
    },
  };
}
