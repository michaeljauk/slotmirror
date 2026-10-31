import { MAX_BUFFER_MINUTES, type RuleOptions } from "../config";
import { blockStatusOf, type BlockStatus, type ExistingBlock, type SourceEvent } from "./types";
import { inWorkingHours } from "./working-hours";

/**
 * The comparison of a target calendar with its sources. It tells what the calendar should hold from
 * the source events and the rule options alone, so it imports nothing from the planner: a planner
 * bug must not cancel itself out. Marker, tag and filters here are second, hand-written versions.
 * Options helpers such as `inWorkingHours` and the source parsers stay shared; that is one common
 * source of error, which only a hand-written expected state can cover.
 *
 * A scan reads one slice per alarm, so that each step stays inside the limits of an invocation. No
 * event reaches storage or the audit log: only counts and marker hashes.
 *
 * Known limits: `hasStandIn` hides a deleted block under a wider block of a rule with precedence,
 * and a comparison does not compare privacy, because `ExistingBlock` does not carry it.
 */

/** Days of a slice. A slice starts and ends at midnight UTC, so that all-day dates fall into one. */
export const SLICE_DAYS = 7;

/** Provider reads of a step. Above this, the slice is too large. */
export const MAX_SLICE_READS = 40;

/** Events and blocks of a step. Above this, hashing them could use up the CPU time of a step. */
export const MAX_SLICE_ITEMS = 400;

/** Entries of the list of marker hashes in storage and in a result. */
export const MAX_HITS = 50;

/**
 * Days that a scan of a calendar without a rule covers: the largest `daysAhead`. No rule can have
 * written a block beyond them.
 */
export const LEFTOVER_DAYS = 365;

/**
 * The target read starts this early. Google compares `timeMin` with the end of an event, excluded,
 * so a read that starts at a block without duration does not return it.
 */
const BLOCK_READ_MARGIN_MS = 60_000;

/**
 * Time for a scan, and for the wait for a confirmation. A rule that never runs successfully must
 * not keep the calendar's one open comparison.
 */
export const COMPARE_TIMEOUT_MS = 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/**
 * "full" compares the whole horizon, "near" the first slice, every day. "leftover" reads a calendar
 * without an active rule, as part of a full comparison: every block there is left over.
 */
export type CompareMode = "full" | "near" | "leftover";

export type CompareFailureReason =
  | "removal_queue"
  | "token_lost"
  | "paused"
  | "throttled"
  | "config_changed"
  | "source_unavailable"
  | "read_failed"
  | "slice_too_large"
  | "empty_horizon"
  | "timeout"
  | "superseded";

export interface CompareFailure {
  reason: CompareFailureReason;
  /** The error code, if an error caused the failure. */
  code?: string;
}

/** What a comparison needs of a rule. */
export interface CompareRule {
  id: string;
  options: RuleOptions;
  /** The source calendar: the key of its events in `SliceInput.events`. */
  source: string;
}

export interface SliceWindow {
  /** Unix ms. */
  start: number;
  /** Unix ms, excluded. */
  end: number;
}

export interface CompareCounts {
  /** The target lacks a wanted block. */
  missing: number;
  /** The target holds a block that no active rule wants. */
  surplus: number;
  /** A block differs from what its rule wants in its times, all-day flag or status. */
  mismatched: number;
  /** The same marker twice, or a block that a block of a rule with precedence covers. */
  duplicates: number;
}

export interface SliceInput {
  rules: readonly CompareRule[];
  /** The events of each source calendar, read with `sourceReadWindow(slice)`. */
  events: ReadonlyMap<string, readonly SourceEvent[]>;
  /** Blocks of every tag that overlap the slice. */
  blocks: readonly ExistingBlock[];
  slice: SliceWindow;
  /** Start of the scan. All windows of a scan derive from it. */
  startedAt: number;
  /**
   * Active rules that write into the same remote calendar through another calendar row. The
   * comparison of that row judges their blocks.
   */
  others?: readonly string[];
}

export interface SliceResult {
  counts: CompareCounts;
  /** Unique entries of the form `<kind>:<marker>`. A marker is a hash; see `markerOf`. */
  hits: string[];
  /** Blocks that the rules want in this slice. */
  expected: number;
}

/** The audit row that ends a comparison. */
export type CompareReport =
  | { kind: "compare_run"; detail: CompareRunDetail }
  | { kind: "compare_failed"; detail: CompareFailedDetail };

/** What storage keeps of a comparison: no event, no block. */
export interface CompareState {
  calendarId: string;
  remoteCalendarId: string;
  mode: CompareMode;
  /** Start of the first scan. Both scans of a comparison read the same window. */
  startedAt: number;
  /** "reporting": the comparison is over, and only its audit row waits for D1. */
  phase: "scanning" | "confirming" | "reporting";
  sliceStart: number;
  sliceDays: number;
  /** Slices read in this scan. */
  slices: number;
  /** `ruleSetHash` at the start of the first scan. */
  ruleHash: string;
  expected: number;
  counts: CompareCounts;
  hits: string[];
  /** More hits were found than `hits` holds. */
  capped: boolean;
  /**
   * The start of the slice that a step is reading. It stays if the step dies, for example at the
   * CPU limit. A later step then knows that this slice is too large.
   */
  attempt?: number;
  /** The result of the first scan, while the second one is due. */
  first?: { at: number; hits: string[]; capped: boolean };
  /** The audit row, in the phase "reporting". */
  report?: CompareReport;
}

/** The flat detail of a `compare_run` event. */
export interface CompareRunDetail extends CompareCounts {
  calendarId: string;
  mode: CompareMode;
  scanStartedAt: string;
  slices: number;
  /** 1 for a clean first scan, 2 with a confirmation. */
  rounds: number;
  /** Blocks that the rules wanted in the last scan. */
  expected: number;
  /** Confirmed hits. The counts above hold confirmed hits only. */
  deviations: number;
  /** Hits of the second scan only. They wait for a later comparison. */
  unconfirmed: number;
  /** Hits of the first scan that the second scan no longer found. */
  cleared: number;
  /** These hits, comma-separated: what a run repaired. */
  clearedHits: string;
  /** Confirmed hits, comma-separated. */
  hits: string;
  /** A list reached `MAX_HITS`, so the numbers above are lower bounds. */
  hitsCapped: boolean;
  /**
   * True only if this run counts as a comparison without a deviation: no confirmed hit, no
   * unconfirmed hit, no full list, and at least one wanted block.
   */
  clean: boolean;
}

/** The flat detail of a `compare_failed` event. */
export interface CompareFailedDetail {
  calendarId: string;
  mode: CompareMode;
  scanStartedAt: string;
  reason: CompareFailureReason;
  code: string;
  /** The slice that the scan had reached. */
  sliceStart: string;
}

/**
 * How a comparison treats each rule option. A new option must be added here, or the type check
 * fails; `test/compare.test.ts` then asks for a case that shows the role.
 * - `filter`: decides whether a rule wants a block for an event.
 * - `times`: moves the block.
 * - `horizon`: sets how far the rule reaches.
 * - `content`: changes what a block shows, which a comparison does not read.
 */
export const OPTION_ROLES: Record<keyof RuleOptions, "filter" | "times" | "horizon" | "content"> = {
  detailLevel: "content",
  blockTitle: "content",
  daysAhead: "horizon",
  skipAllDay: "filter",
  skipFree: "filter",
  skipTentative: "filter",
  skipDeclined: "filter",
  skipCategories: "filter",
  workDays: "filter",
  workStart: "filter",
  workEnd: "filter",
  workTimeZone: "filter",
  markPrivate: "content",
  blockColor: "content",
  bufferBefore: "times",
  bufferAfter: "times",
  showOrigin: "content",
  linkOrigin: "content",
  originLocale: "content",
};

const encoder = new TextEncoder();

/** First 16 bytes of the SHA-256 of `text`, as hex digits. */
async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest, 0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The marker that a block of this rule and occurrence must carry. */
function markerOf(ruleId: string, occurrenceKey: string): Promise<string> {
  return hash(`${ruleId}\u0000${occurrenceKey}`);
}

async function tagOf(ruleId: string): Promise<string> {
  return (await hash(`rule\u0000${ruleId}`)).slice(0, 12);
}

/**
 * A hash over the rules of a calendar and `others`, the rules through another row of it. A change
 * of either set or of any option changes it.
 */
export function ruleSetHash(
  rules: readonly CompareRule[],
  others: readonly string[] = [],
): Promise<string> {
  const sorted = [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ours = sorted.map(({ id, source, options }) => [id, source, options]);
  return hash(JSON.stringify(others.length > 0 ? [ours, [...others].sort()] : ours));
}

function utcDay(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS;
}

/** The start of the first slice of a scan: the first day of every sync window. */
export function firstSliceStart(startedAt: number): number {
  return utcDay(startedAt);
}

/**
 * The part of a rule's sync window that a scan judges. The last day stays out, and so do the
 * all-day blocks of the first day: the time zone of a calendar decides there which all-day dates a
 * read returns. Timed blocks of the first day stay in, because a run reads that whole day.
 */
function ruleHorizon(options: RuleOptions, startedAt: number, allDay: boolean): SliceWindow {
  const today = utcDay(startedAt);
  return { start: allDay ? today + DAY_MS : today, end: today + (options.daysAhead - 1) * DAY_MS };
}

/** The window that a scan covers. */
export function scanHorizon(
  rules: readonly CompareRule[],
  startedAt: number,
  mode: CompareMode,
): SliceWindow {
  const start = firstSliceStart(startedAt);
  if (mode === "leftover") return { start, end: start + LEFTOVER_DAYS * DAY_MS };
  const end = Math.max(
    start,
    ...rules.map((rule) => ruleHorizon(rule.options, startedAt, false).end),
  );
  return { start, end: mode === "near" ? Math.min(end, start + SLICE_DAYS * DAY_MS) : end };
}

/**
 * The window of a source read. A block starts up to `MAX_BUFFER_MINUTES` before its event, so an
 * event after the slice can have its block in the slice. The read is the same for all buffers.
 */
export function sourceReadWindow(slice: SliceWindow): { start: Date; end: Date } {
  const margin = MAX_BUFFER_MINUTES * 60_000;
  return { start: new Date(slice.start - margin), end: new Date(slice.end + margin) };
}

/** The window of the read of the target calendar. See `BLOCK_READ_MARGIN_MS`. */
export function blockReadWindow(slice: SliceWindow): { start: Date; end: Date } {
  return { start: new Date(slice.start - BLOCK_READ_MARGIN_MS), end: new Date(slice.end) };
}

/** The work of a step: each block, and each event once per rule that hashes it. */
export function sliceItems(
  blocks: number,
  rules: readonly CompareRule[],
  events: ReadonlyMap<string, readonly SourceEvent[]>,
): number {
  return rules.reduce((sum, rule) => sum + (events.get(rule.source)?.length ?? 0), blocks);
}

/** True if a rule wants a block for the event. */
function isWanted(event: SourceEvent, options: RuleOptions): boolean {
  if (event.isMirror) return false;
  if (options.skipAllDay && event.allDay) return false;
  if (options.skipDeclined && event.declined) return false;
  if (options.skipFree && event.showAs === "free") return false;
  if (options.skipTentative && event.showAs === "tentative") return false;
  const skipped = options.skipCategories.map((name) => name.trim().toLowerCase());
  if (event.categories.some((name) => skipped.includes(name.trim().toLowerCase()))) return false;
  return inWorkingHours(event, options);
}

interface WantedBlock {
  marker: string;
  tag: string;
  start: string;
  end: string;
  allDay: boolean;
  status: BlockStatus;
}

/** A timed block moves by the buffers. An all-day block keeps its dates. */
function moved(time: string, minutes: number): string {
  return new Date(Date.parse(time) + minutes * 60_000).toISOString();
}

function within(time: number, window: SliceWindow): boolean {
  return time >= window.start && time < window.end;
}

function covers(
  outer: { start: string; end: string },
  inner: { start: string; end: string },
): boolean {
  return (
    Date.parse(outer.start) <= Date.parse(inner.start) &&
    Date.parse(outer.end) >= Date.parse(inner.end)
  );
}

function fits(block: ExistingBlock, wanted: WantedBlock): boolean {
  return (
    block.allDay === wanted.allDay &&
    block.status === wanted.status &&
    Date.parse(block.start) === Date.parse(wanted.start) &&
    Date.parse(block.end) === Date.parse(wanted.end)
  );
}

/**
 * True if a block of a rule with precedence does the job of a missing block. A rule leaves out an
 * event whose block such a rule already wrote, if that block covers its own. The comparison cannot
 * rebuild the dedup key, so it asks for the same shape instead: a block with the same status at
 * that time. A block with another title at the same time then also counts, which hides the loss
 * of a block only where the calendar is blocked anyway. So a deleted block under a wider block of
 * such a rule stays unseen.
 */
function hasStandIn(
  wanted: WantedBlock,
  blocks: readonly ExistingBlock[],
  active: ReadonlySet<string>,
): boolean {
  return blocks.some(
    (block) =>
      active.has(block.ruleTag) &&
      block.ruleTag < wanted.tag &&
      block.allDay === wanted.allDay &&
      block.status === wanted.status &&
      covers(block, wanted),
  );
}

/**
 * The blocks among `judged` that are duplicates:
 * - The same marker twice. The block that starts first stays, so that a slice counts each extra
 *   block once. An orphan counts too: it needs no wanted event.
 * - The same dedup key across rules, where a block of a rule with precedence covers the block.
 *   The same key alone is no duplicate. A rule writes a second block on purpose if a buffer makes
 *   it wider, and neither two blocks that do not cover each other nor two events of one rule are
 *   redundant.
 */
function duplicatesAmong(
  judged: readonly ExistingBlock[],
  blocks: readonly ExistingBlock[],
  active: ReadonlySet<string>,
): ExistingBlock[] {
  const first = new Map<string, ExistingBlock>();
  for (const block of [...blocks].sort(byStart)) {
    if (!first.has(block.marker)) first.set(block.marker, block);
  }
  return judged.filter(
    (block) =>
      first.get(block.marker)?.targetId !== block.targetId ||
      (block.dedupKey !== "" &&
        active.has(block.ruleTag) &&
        blocks.some(
          (other) =>
            other.dedupKey === block.dedupKey &&
            active.has(other.ruleTag) &&
            other.ruleTag < block.ruleTag &&
            covers(other, block),
        )),
  );
}

function byStart(a: ExistingBlock, b: ExistingBlock): number {
  const order = Date.parse(a.start) - Date.parse(b.start);
  if (order !== 0) return order;
  return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
}

/**
 * Compare one slice. A block belongs to the slice in which it begins, so a block that reaches into
 * the next slice counts once. An all-day block begins at midnight UTC of its date.
 */
export async function compareSlice(input: SliceInput): Promise<SliceResult> {
  const { rules, events, blocks, slice, startedAt, others = [] } = input;
  const optionsOf = new Map<string, RuleOptions>();
  const wanted = new Map<string, WantedBlock>();
  for (const rule of rules) {
    const tag = await tagOf(rule.id);
    optionsOf.set(tag, rule.options);
    for (const event of events.get(rule.source) ?? []) {
      if (!isWanted(event, rule.options)) continue;
      const start = event.allDay ? event.start : moved(event.start, -rule.options.bufferBefore);
      const startTime = Date.parse(start);
      const horizon = ruleHorizon(rule.options, startedAt, event.allDay);
      if (!within(startTime, slice) || !within(startTime, horizon)) continue;
      const marker = await markerOf(rule.id, event.occurrenceKey);
      wanted.set(marker, {
        marker,
        tag,
        start,
        end: event.allDay ? event.end : moved(event.end, rule.options.bufferAfter),
        allDay: event.allDay,
        status: blockStatusOf(event.showAs),
      });
    }
  }

  const active = new Set(optionsOf.keys());
  const foreign = new Set(await Promise.all(others.map(tagOf)));
  const counts: CompareCounts = { missing: 0, surplus: 0, mismatched: 0, duplicates: 0 };
  const hits = new Set<string>();

  const byMarker = new Map<string, ExistingBlock[]>();
  for (const block of blocks)
    byMarker.set(block.marker, [...(byMarker.get(block.marker) ?? []), block]);
  for (const block of wanted.values()) {
    const found = byMarker.get(block.marker) ?? [];
    if (found.length === 0) {
      if (hasStandIn(block, blocks, active)) continue;
      counts.missing++;
      hits.add(`missing:${block.marker}`);
    } else if (!found.some((candidate) => fits(candidate, block))) {
      counts.mismatched++;
      hits.add(`mismatched:${block.marker}`);
    }
  }

  const judged = blocks.filter((block) => {
    if (foreign.has(block.ruleTag)) return false;
    const start = Date.parse(block.start);
    const options = optionsOf.get(block.ruleTag);
    return (
      within(start, slice) &&
      (!options || within(start, ruleHorizon(options, startedAt, block.allDay)))
    );
  });
  for (const block of judged) {
    if (wanted.has(block.marker)) continue;
    counts.surplus++;
    hits.add(`surplus:${block.marker}`);
  }
  for (const block of duplicatesAmong(judged, blocks, active)) {
    counts.duplicates++;
    hits.add(`duplicate:${block.marker}`);
  }
  return { counts, hits: [...hits], expected: wanted.size };
}

const NO_COUNTS: CompareCounts = { missing: 0, surplus: 0, mismatched: 0, duplicates: 0 };

export function newCompare(init: {
  calendarId: string;
  remoteCalendarId: string;
  mode: CompareMode;
  ruleHash: string;
  now: number;
}): CompareState {
  const { now, ...fields } = init;
  return {
    ...fields,
    startedAt: now,
    phase: "scanning",
    sliceStart: firstSliceStart(now),
    sliceDays: SLICE_DAYS,
    slices: 0,
    expected: 0,
    counts: NO_COUNTS,
    hits: [],
    capped: false,
  };
}

/** The next slice of a scan. */
export function sliceAfter(state: CompareState, horizon: SliceWindow): SliceWindow {
  return {
    start: state.sliceStart,
    end: Math.min(state.sliceStart + state.sliceDays * DAY_MS, horizon.end),
  };
}

/** Add the result of a slice. A halved slice size grows back, so that no scan stays slow. */
export function addSlice(state: CompareState, end: number, result: SliceResult): CompareState {
  const { attempt: _done, ...rest } = state;
  const hits = [...new Set([...state.hits, ...result.hits])];
  return {
    ...rest,
    sliceStart: end,
    sliceDays: Math.min(SLICE_DAYS, state.sliceDays * 2),
    slices: state.slices + 1,
    expected: state.expected + result.expected,
    counts: {
      missing: state.counts.missing + result.counts.missing,
      surplus: state.counts.surplus + result.counts.surplus,
      mismatched: state.counts.mismatched + result.counts.mismatched,
      duplicates: state.counts.duplicates + result.counts.duplicates,
    },
    hits: hits.slice(0, MAX_HITS),
    capped: state.capped || hits.length >= MAX_HITS,
  };
}

/** The state with half the slice, or null if a slice of one day was too large. */
export function halveSlice(state: CompareState): CompareState | null {
  if (state.sliceDays <= 1) return null;
  const { attempt: _done, ...rest } = state;
  return { ...rest, sliceDays: Math.floor(state.sliceDays / 2) };
}

/** The counts of a list of hits. */
export function tally(hits: readonly string[]): CompareCounts {
  const counts = { ...NO_COUNTS };
  for (const hit of hits) {
    if (hit.startsWith("missing:")) counts.missing++;
    else if (hit.startsWith("surplus:")) counts.surplus++;
    else if (hit.startsWith("mismatched:")) counts.mismatched++;
    else counts.duplicates++;
  }
  return counts;
}

function markerOfHit(hit: string): string {
  return hit.slice(hit.indexOf(":") + 1);
}

/**
 * The end of a scan: the detail of the result, or the state that waits for the second scan. A hit
 * counts only if the second scan finds its marker too, after a successful run of every rule began.
 * The kind can change: a run can write a lost block with a wrong time. Hits of the second scan
 * alone stay unconfirmed, and the result names how many there are.
 */
export function finishScan(
  state: CompareState,
  now: number,
): { detail: CompareRunDetail } | { state: CompareState } {
  const { first } = state;
  if (!first && state.hits.length > 0) {
    const { attempt: _done, ...rest } = state;
    return {
      state: {
        ...rest,
        phase: "confirming",
        first: { at: now, hits: state.hits, capped: state.capped },
      },
    };
  }
  const before = first?.hits ?? [];
  const markersBefore = new Set(before.map(markerOfHit));
  const markersNow = new Set(state.hits.map(markerOfHit));
  const confirmed = state.hits.filter((hit) => markersBefore.has(markerOfHit(hit)));
  const cleared = before.filter((hit) => !markersNow.has(markerOfHit(hit)));
  const unconfirmed = state.hits.length - confirmed.length;
  const hitsCapped = state.capped || (first?.capped ?? false);
  return {
    detail: {
      calendarId: state.calendarId,
      mode: state.mode,
      scanStartedAt: new Date(state.startedAt).toISOString(),
      slices: state.slices,
      rounds: first ? 2 : 1,
      expected: state.expected,
      ...tally(confirmed),
      deviations: confirmed.length,
      unconfirmed,
      cleared: cleared.length,
      clearedHits: cleared.join(","),
      hits: confirmed.join(","),
      hitsCapped,
      clean: confirmed.length === 0 && unconfirmed === 0 && !hitsCapped && state.expected > 0,
    },
  };
}

/**
 * The second scan of a comparison: the first scan's result stays, all else starts anew. It reads the
 * window of the first scan. After midnight UTC a later window would lose the hits of the first day,
 * and they would count as cleared. A hit that a run could no longer reach counts as confirmed.
 */
export function startConfirmScan(state: CompareState): CompareState {
  return {
    ...state,
    phase: "scanning",
    sliceStart: firstSliceStart(state.startedAt),
    sliceDays: SLICE_DAYS,
    slices: 0,
    expected: 0,
    counts: NO_COUNTS,
    hits: [],
    capped: false,
  };
}

export function failureDetail(state: CompareState, failure: CompareFailure): CompareFailedDetail {
  return {
    calendarId: state.calendarId,
    mode: state.mode,
    scanStartedAt: new Date(state.startedAt).toISOString(),
    reason: failure.reason,
    code: failure.code ?? "",
    sliceStart: new Date(state.sliceStart).toISOString(),
  };
}
