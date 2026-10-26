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
  if (options.skipCategories.length > 0) {
    const skipped = new Set(options.skipCategories.map((name) => name.trim().toLowerCase()));
    if (event.categories.some((name) => skipped.has(name.trim().toLowerCase()))) return false;
  }
  return true;
}

/**
 * The block content for a source event at the rule's detail level.
 * Events the source marks private never carry more than "busy", whatever the rule says.
 * The buffers widen timed blocks only; the times of all-day blocks are dates.
 */
export function blockContent(event: SourceEvent, options: RuleOptions): BlockContent {
  const level = event.isPrivate ? "busy" : options.detailLevel;
  const withTitle = level !== "busy" && event.subject.trim() !== "";
  return {
    start: event.allDay ? event.start : shifted(event.start, -options.bufferBefore),
    end: event.allDay ? event.end : shifted(event.end, options.bufferAfter),
    allDay: event.allDay,
    showAs: event.showAs === "unknown" ? "busy" : event.showAs,
    isPrivate: options.markPrivate || event.isPrivate,
    subject: withTitle ? event.subject : options.blockTitle,
    location: level === "title_location" || level === "full" ? event.location : "",
    body: level === "full" ? event.body : "",
    ...(options.blockColor.trim() ? { color: options.blockColor.trim() } : {}),
  };
}

/**
 * A time moved by some minutes. Without a move the text stays as the source wrote it, so that the
 * content hash of blocks without a buffer does not change.
 */
function shifted(time: string, minutes: number): string {
  const instant = Date.parse(time);
  if (minutes === 0 || Number.isNaN(instant)) return time;
  return new Date(instant + minutes * 60_000).toISOString();
}

/** Marker for a block: SHA-256 of rule ID and occurrence key, so no source ID leaves the source. */
export async function markerFor(ruleId: string, occurrenceKey: string): Promise<string> {
  return shortHash(`${ruleId}\u0000${occurrenceKey}`);
}

/**
 * Tag of a rule, written into each of its blocks. A rule only ever updates or deletes blocks with
 * its own tag, so several rules can write into one target calendar.
 */
export async function ruleTagFor(ruleId: string): Promise<string> {
  return (await shortHash(`rule\u0000${ruleId}`)).slice(0, 12);
}

/**
 * Rule IDs in precedence order: by rule tag. Where several rules write the same event into one
 * calendar, the rule with the smallest tag keeps it (see `desiredBlocks`). Running the rules in
 * this order lets the keeping rule write first, so that the others never write a copy.
 */
export async function inPrecedenceOrder(ruleIds: string[]): Promise<string[]> {
  const tagged = await Promise.all(ruleIds.map(async (id) => ({ id, tag: await ruleTagFor(id) })));
  return tagged.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)).map(({ id }) => id);
}

/**
 * Key of a block as people see it: times, title, status and privacy, hashed with a per-user scope.
 * Two blocks with the same key block the same way, so one of them is enough. The same match in two
 * subscribed calendars gets one key; so do two private "Busy" blocks at the same time. A tentative
 * block never stands in for a busy one, and an open block never for a private one. The times are
 * those of the event, without buffers, so that rules with different buffers find the same meeting;
 * see `desiredBlocks` for which block stays.
 */
export async function dedupKeyFor(scope: string, content: BlockContent): Promise<string> {
  const subject = content.subject.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
  const allDay = content.allDay ? "all-day" : "timed";
  const privacy = content.isPrivate ? "private" : "open";
  const parts = [
    "dedup",
    scope,
    allDay,
    content.start,
    content.end,
    subject,
    content.showAs,
    privacy,
  ];
  return shortHash(parts.join("\u0000"));
}

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Times of the blocks that rules with precedence wrote, by dedup key. */
export type Claims = ReadonlyMap<string, readonly { start: string; end: string }[]>;

/** The claims of blocks that rules with precedence wrote. Blocks without a dedup key claim nothing. */
export function claimsFrom(blocks: { dedupKey: string; start: string; end: string }[]): Claims {
  const claims = new Map<string, { start: string; end: string }[]>();
  for (const { dedupKey, start, end } of blocks) {
    if (dedupKey === "") continue;
    claims.set(dedupKey, [...(claims.get(dedupKey) ?? []), { start, end }]);
  }
  return claims;
}

/** True if a claimed block covers the times of a block, so that the block adds nothing. */
function isCovered(content: BlockContent, claims: Claims | undefined, dedupKey: string): boolean {
  return (claims?.get(dedupKey) ?? []).some(
    (claim) =>
      Date.parse(claim.start) <= Date.parse(content.start) &&
      Date.parse(claim.end) >= Date.parse(content.end),
  );
}

/**
 * All blocks the target calendar should contain for one rule.
 *
 * `dedup.scope` scopes the dedup keys, normally to the user. `dedup.claimed` holds the blocks
 * that rules with precedence wrote into the same calendar. The rule leaves out an event whose
 * block would look the same and that such a block covers, buffers included, so that an event in
 * several source calendars is blocked once. A rule with a wider buffer still writes its own block.
 */
export async function desiredBlocks(
  ruleId: string,
  events: SourceEvent[],
  options: RuleOptions,
  dedup: { scope: string; claimed?: Claims } = { scope: "" },
): Promise<DesiredBlock[]> {
  const blocks = new Map<string, DesiredBlock>();
  for (const event of events) {
    if (!isIncluded(event, options)) continue;
    const content = blockContent(event, options);
    const dedupKey = await dedupKeyFor(dedup.scope, {
      ...content,
      start: event.start,
      end: event.end,
    });
    if (isCovered(content, dedup.claimed, dedupKey)) continue;
    const marker = await markerFor(ruleId, event.occurrenceKey);
    const contentHash = await shortHash(JSON.stringify(content));
    blocks.set(marker, { marker, contentHash, dedupKey, ...content });
  }
  return [...blocks.values()];
}

/**
 * Times are compared directly, so that a block moved by hand in the target is moved back. A
 * missing dedup key counts as a change, so that blocks from before it existed get one.
 */
function sameContent(existing: ExistingBlock, desired: DesiredBlock): boolean {
  return (
    existing.contentHash === desired.contentHash &&
    existing.dedupKey === desired.dedupKey &&
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

/** True if a block overlaps a window. All-day dates count from midnight UTC. */
function overlaps(block: { start: string; end: string }, window: SyncWindow): boolean {
  return (
    Date.parse(block.start) < window.end.getTime() && Date.parse(block.end) > window.start.getTime()
  );
}

/** True if a block reaches into a window from before its start. */
function startsBefore(block: { start: string; end: string }, window: SyncWindow): boolean {
  return Date.parse(block.start) < window.start.getTime() && overlaps(block, window);
}

export interface SyncWindow {
  start: Date;
  end: Date;
}

/**
 * Compare what the target should contain with what it contains, inside one sync window.
 *
 * The plan creates missing blocks, updates changed ones and deletes blocks whose source occurrence
 * is gone. Duplicates of a marker (for example after a crash between write and bookkeeping) are
 * deleted except one. It never rebuilds blocks that already match.
 *
 * With the `window` of the run, the plan writes no all-day block outside it. The source is read
 * wider than the window for the buffers, so the read can hold an all-day event of yesterday, which
 * gets no buffer; the target read would never find its block again. A timed event in the read
 * always has its buffered block in the window. A block that starts before the window and has no
 * source event any more stays as a record: its event can lie outside the source read, for example
 * after the buffer went down.
 */
export function planSync(
  desired: DesiredBlock[],
  existing: ExistingBlock[],
  window?: SyncWindow,
): SyncPlan {
  const actions: SyncAction[] = [];
  let unchanged = 0;

  const existingByMarker = new Map<string, ExistingBlock[]>();
  for (const block of existing) {
    const list = existingByMarker.get(block.marker) ?? [];
    list.push(block);
    existingByMarker.set(block.marker, list);
  }

  for (const block of desired) {
    if (window && block.allDay && !overlaps(block, window)) continue;
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
    for (const [index, orphan] of orphans.entries()) {
      if (index === 0 && window && startsBefore(orphan, window)) {
        unchanged++;
        continue;
      }
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
