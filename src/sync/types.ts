/** How much of a source event a rule copies into the target calendar. */
export type DetailLevel = "busy" | "title" | "title_location" | "full";

export type ShowAs = "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";

/** One occurrence of an event in a source calendar, independent of the provider. */
export interface SourceEvent {
  /**
   * Stable identity of the occurrence. Series occurrences are identified by series and original
   * start, so a moved occurrence keeps its identity.
   */
  occurrenceKey: string;
  start: string; // ISO 8601 UTC, or YYYY-MM-DD for all-day events
  end: string;
  allDay: boolean;
  showAs: ShowAs;
  /** The source marks the event private or confidential. */
  isPrivate: boolean;
  /** The calendar owner declined the event. */
  declined: boolean;
  /** Outlook categories or Google color names, used by filters. */
  categories: string[];
  subject: string;
  location: string;
  body: string;
  /** True if the event is a block that slotmirror wrote itself. Such events are never mirrored. */
  isMirror: boolean;
  /**
   * Web address of the occurrence at the provider, only if the read asked for it and the provider
   * returned an https address. Absent otherwise, so that events read without it keep their shape.
   */
  link?: string;
}

/** The content a block in the target calendar should have. */
export interface BlockContent {
  start: string;
  end: string;
  allDay: boolean;
  showAs: ShowAs;
  isPrivate: boolean;
  subject: string;
  location: string;
  body: string;
  /**
   * Google event colour ID or Outlook category of the block. Absent without a colour, so that the
   * content hash of blocks without a colour stays as before.
   */
  color?: string;
}

/** A block that the target calendar should contain. */
export interface DesiredBlock extends BlockContent {
  /** Opaque marker written into the block; a hash of rule and occurrence key. */
  marker: string;
  /**
   * Hash of the block content, stored next to the marker. Graph changes text slightly when it
   * stores it (line breaks, previews), so content is compared by hash, not field by field.
   */
  contentHash: string;
  /**
   * Hash of what the block shows (times, title, status, privacy), the same for every rule of one
   * user; see `dedupKeyFor`. Rules into one target calendar use it to write one block where they
   * would write equal ones. Stored next to the marker, not in it.
   */
  dedupKey: string;
}

/** A block that slotmirror finds in the target calendar, recognised by its marker. */
export interface ExistingBlock {
  targetId: string;
  /** Tag of the rule that wrote the block; see `ruleTagFor`. */
  ruleTag: string;
  marker: string;
  contentHash: string;
  /** See `DesiredBlock.dedupKey`. Empty for blocks written before it existed. */
  dedupKey: string;
  start: string;
  end: string;
  allDay: boolean;
}

export type SyncAction =
  | { kind: "create"; block: DesiredBlock }
  | { kind: "update"; targetId: string; block: DesiredBlock }
  | { kind: "delete"; targetId: string; marker: string };

export interface SyncPlan {
  actions: SyncAction[];
  stats: { create: number; update: number; delete: number; unchanged: number };
}
