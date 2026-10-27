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
  return included(event, options, skippedCategories(options));
}

/** The skipped categories of a rule, trimmed and in lower case; null if it skips none. */
function skippedCategories(options: RuleOptions): ReadonlySet<string> | null {
  if (options.skipCategories.length === 0) return null;
  return new Set(options.skipCategories.map((name) => name.trim().toLowerCase()));
}

function included(
  event: SourceEvent,
  options: RuleOptions,
  skipped: ReadonlySet<string> | null,
): boolean {
  if (event.isMirror) return false;
  if (options.skipAllDay && event.allDay) return false;
  if (options.skipDeclined && event.declined) return false;
  if (options.skipFree && event.showAs === "free") return false;
  if (options.skipTentative && event.showAs === "tentative") return false;
  if (skipped && event.categories.some((name) => skipped.has(name.trim().toLowerCase()))) {
    return false;
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
  return shortHash(markerText(ruleId, occurrenceKey));
}

function markerText(ruleId: string, occurrenceKey: string): string {
  return `${ruleId}\u0000${occurrenceKey}`;
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
  return shortHash(dedupText(scope, content));
}

function dedupText(scope: string, content: BlockContent): string {
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
  return parts.join("\u0000");
}

/** First 16 bytes of the SHA-256 of `text`, as 32 hex digits. */
async function shortHash(text: string): Promise<string> {
  const hash = cachedHash(text);
  return typeof hash === "string" ? hash : await hash;
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
const encoder = new TextEncoder();

/**
 * Hashes of recent inputs. A rule runs every few minutes over mostly the same events, so most
 * hashes of a run repeat those of the run before. The cache lives in memory only. It is bounded,
 * and it keeps no long inputs, such as content hashes of events with a body.
 */
const hashCache = new Map<string, string>();
const HASH_CACHE_ENTRIES = 10_000;
const HASH_CACHE_INPUT_LENGTH = 400;

/** Like `shortHash`, but without a promise if the hash is cached. */
function cachedHash(text: string): string | Promise<string> {
  const cached = hashCache.get(text);
  if (cached !== undefined) return cached;
  return crypto.subtle.digest("SHA-256", encoder.encode(text)).then((digest) => {
    const bytes = new Uint8Array(digest, 0, 16);
    let hash = "";
    for (const byte of bytes) hash += HEX[byte];
    if (text.length <= HASH_CACHE_INPUT_LENGTH) {
      if (hashCache.size >= HASH_CACHE_ENTRIES) hashCache.clear();
      hashCache.set(text, hash);
    }
    return hash;
  });
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

/**
 * True if a rule with precedence claimed the event. A rule without buffers leaves out every event
 * with a claimed dedup key. A rule with buffers leaves it out only if a claimed block covers its
 * own block, so that a wider buffer is never lost. A set of keys claims by key alone.
 */
function isClaimed(
  content: BlockContent,
  claimed: ReadonlySet<string> | Claims | undefined,
  dedupKey: string,
  buffered: boolean,
): boolean {
  if (!claimed?.has(dedupKey)) return false;
  if (!buffered || !(claimed instanceof Map)) return true;
  return ((claimed as Claims).get(dedupKey) ?? []).some(
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
  dedup: { scope: string; claimed?: ReadonlySet<string> | Claims } = { scope: "" },
): Promise<DesiredBlock[]> {
  const blocks = new Map<string, DesiredBlock>();
  const buffered = options.bufferBefore > 0 || options.bufferAfter > 0;
  const skipped = skippedCategories(options);
  // Most hashes are cached; the loop awaits only those that are not.
  for (const event of events) {
    if (!included(event, options, skipped)) continue;
    const content = blockContent(event, options);
    // The dedup key uses the event's times, so that rules with different buffers find one meeting.
    const keyed = buffered ? { ...content, start: event.start, end: event.end } : content;
    const dedupHash = cachedHash(dedupText(dedup.scope, keyed));
    const dedupKey = typeof dedupHash === "string" ? dedupHash : await dedupHash;
    if (isClaimed(content, dedup.claimed, dedupKey, buffered)) continue;
    const markerHash = cachedHash(markerText(ruleId, event.occurrenceKey));
    const marker = typeof markerHash === "string" ? markerHash : await markerHash;
    const contentText = JSON.stringify(content);
    const contentHashed = cachedHash(contentText);
    const contentHash = typeof contentHashed === "string" ? contentHashed : await contentHashed;
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

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** The windows of one run: sync window, target read and source read; see `planSync`. */
export interface PlanWindows {
  sync: TimeWindow;
  target?: TimeWindow;
  /** The wider source read of a buffered rule; a rule without a buffer reads `sync`. */
  read?: TimeWindow | undefined;
}

/** True if a block overlaps a window. All-day dates count from midnight UTC. */
function overlaps(block: { start: string; end: string }, window: TimeWindow): boolean {
  return (
    Date.parse(block.start) < window.end.getTime() && Date.parse(block.end) > window.start.getTime()
  );
}

/** The largest distance of a calendar time zone from UTC, in either direction. */
const MAX_ZONE_OFFSET_MS = 14 * 60 * 60 * 1000;

/**
 * True if every target read of `read` returns the all-day block, whatever the time zone of the
 * target calendar. Each provider filters all-day events at the midnights of its own calendar's
 * time zone, but returns them as dates; see `planSync`.
 */
function isInEveryRead(block: DesiredBlock, read: TimeWindow): boolean {
  return (
    Date.parse(block.start) + MAX_ZONE_OFFSET_MS < read.end.getTime() &&
    Date.parse(block.end) - MAX_ZONE_OFFSET_MS > read.start.getTime()
  );
}

/**
 * True if an existing block can be the block of a desired one. A timed block outside the sync
 * window only stands in for a desired block outside it too, so that the wider target read changes
 * nothing for timed blocks inside the window.
 */
function standsIn(existing: ExistingBlock, desired: DesiredBlock, sync: TimeWindow): boolean {
  return existing.allDay || overlaps(existing, sync) || !overlaps(desired, sync);
}

/**
 * True if a timed block lies in the margin of the source read only: in the read window, at its
 * edges included, but outside the sync window. Its event reached the read through a buffer.
 */
function isInMarginOnly(block: DesiredBlock, windows: PlanWindows): boolean {
  if (block.allDay || !windows.read || overlaps(block, windows.sync)) return false;
  return (
    Date.parse(block.start) <= windows.read.end.getTime() &&
    Date.parse(block.end) >= windows.read.start.getTime()
  );
}

/**
 * Compare what the target should contain with what it contains, inside one sync window.
 *
 * The plan creates missing blocks, updates changed ones and deletes blocks whose source occurrence
 * is gone. Duplicates of a marker (for example after a crash between write and bookkeeping) are
 * deleted except one. It never rebuilds blocks that already match.
 *
 * Each provider filters all-day events at the midnights of its own calendar's time zone, but
 * returns them as dates. So the source read returns all-day dates up to one day outside the sync
 * window, and the target calendar's zone decides which of them a target read of the sync window
 * returns. West of UTC after midnight UTC, the current local day is such a date. So `windows.target`
 * is wider than `windows.sync`, and the plan then works as follows:
 * - It creates an all-day block outside the sync window only if every target read returns it, so
 *   that the next run finds it. Without `windows.target`, it creates no such block.
 * - It never deletes a block outside the sync window for a missing source event. The source read
 *   may not return the event, whatever its zone.
 * - A timed block outside the sync window stands in for no desired block inside it; see `standsIn`.
 *
 * Known limitation: the plan cannot tell "the source read did not return the event" from "the
 * event is gone". So some blocks outside the sync window stay for good:
 * - Source and target at UTC-8: if the user deletes today's all-day event between 00:00 and
 *   08:00 UTC, its block stays. Earlier versions deleted it.
 * - After a rule is deleted, `cleanupWindow` starts at 00:00 UTC. In a target east of UTC, it
 *   does not return the all-day block of the day before, so that block stays.
 * - A block that ends exactly at 00:00 UTC lies outside the sync window and is never deleted.
 * A possible follow-up: read the source one day wider too, and delete an outside block only if
 * the source read returns its date for every time zone.
 *
 * `windows.read` is the window of the source read of a buffered rule: the sync window with the
 * largest buffer added on each side, so that a block that reaches into the sync window has its
 * event in the read. A rule without a buffer passes no `windows.read`.
 * The read margin can return an event whose block, with a small buffer, stays outside the sync
 * window. The plan writes no such block, as if the read had not returned the event. The one
 * exception: its block reaches into the sync window now, for example before a lower buffer. Then
 * the block moves with its event, so that it is not deleted while the event exists.
 */
export function planSync(
  desired: DesiredBlock[],
  existing: ExistingBlock[],
  windows?: PlanWindows,
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
    const found = existingByMarker.get(block.marker) ?? [];
    existingByMarker.delete(block.marker);
    // Blocks that cannot stand in stay untouched, as if the target read had not returned them.
    const [current, ...duplicates] = windows
      ? found.filter((candidate) => standsIn(candidate, block, windows.sync))
      : found;
    if (windows && isInMarginOnly(block, windows)) {
      // As if the read had not returned the event, unless its block reaches into the window now.
      if (!found.some((candidate) => overlaps(candidate, windows.sync))) continue;
    }
    for (const duplicate of duplicates) {
      actions.push({ kind: "delete", targetId: duplicate.targetId, marker: duplicate.marker });
    }
    if (!current) {
      // If a target read can miss this all-day date, a create could repeat on every run.
      const outside = windows && block.allDay && !overlaps(block, windows.sync);
      if (outside && !(windows.target && isInEveryRead(block, windows.target))) continue;
      actions.push({ kind: "create", block });
    } else if (sameContent(current, block)) {
      unchanged++;
    } else {
      actions.push({ kind: "update", targetId: current.targetId, block });
    }
  }

  for (const orphans of existingByMarker.values()) {
    for (const orphan of orphans) {
      // Outside the sync window, the source read may not return the event of the block.
      if (windows && !overlaps(orphan, windows.sync)) continue;
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
