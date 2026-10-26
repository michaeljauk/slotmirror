/**
 * Account colours for the slotmirror pages. They mark which account a calendar belongs to; they
 * never reach a calendar. Each colour gives white text a contrast of at least 5.4:1.
 */
export const ACCOUNT_COLORS = {
  green: "#00775a",
  vermilion: "#b5420a",
  purple: "#9a3f7a",
  orange: "#9a5b00",
  blue: "#0b62a8",
  sky: "#246f99",
  indigo: "#4b47b8",
  slate: "#3f4654",
} as const;

export type AccountColor = keyof typeof ACCOUNT_COLORS;

/** Picker order of the colours. */
export const ACCOUNT_COLOR_KEYS = Object.keys(ACCOUNT_COLORS) as AccountColor[];

/**
 * Order for automatic colours. Blue comes last, because the pages use blue for the accent, the
 * detail levels and unsaved changes.
 */
const AUTO_ORDER: readonly AccountColor[] = [
  "green",
  "vermilion",
  "purple",
  "orange",
  "sky",
  "indigo",
  "slate",
  "blue",
];

export function isAccountColor(value: unknown): value is AccountColor {
  return typeof value === "string" && Object.hasOwn(ACCOUNT_COLORS, value);
}

/** Prefix of a stored colour that slotmirror picked, as opposed to one the user chose. */
const AUTO_PREFIX = "auto:";

export interface ResolvedColor {
  color: AccountColor;
  /** True if the user picked the colour, false if slotmirror assigned it. */
  chosen: boolean;
  /** The value for `accounts.color`. Differs from the input when a colour was assigned now. */
  stored: string;
}

/**
 * The colour of each account, in the given order. A colour the user chose stays. An assigned
 * colour ("auto:<key>") stays too, so that choosing a colour for one account does not move the
 * others; it changes only if a chosen colour takes it. Accounts without a colour, or with an
 * unknown key, get the next colour that no account uses yet; after all eight the order starts
 * again.
 */
export function resolveAccountColorState(stored: (string | null)[]): ResolvedColor[] {
  const used = new Set(stored.filter(isAccountColor));
  const kept = stored.map((value) => {
    const key = value?.startsWith(AUTO_PREFIX) ? value.slice(AUTO_PREFIX.length) : null;
    if (!isAccountColor(key) || used.has(key)) return null;
    used.add(key);
    return key;
  });
  let next = 0;
  return stored.map((value, index) => {
    if (isAccountColor(value)) return { color: value, chosen: true, stored: value };
    const keep = kept[index];
    if (keep) return { color: keep, chosen: false, stored: `${AUTO_PREFIX}${keep}` };
    const free = AUTO_ORDER.filter((color) => !used.has(color));
    const pool = free.length > 0 ? free : AUTO_ORDER;
    const color = pool[free.length > 0 ? 0 : next++ % pool.length] ?? "slate";
    used.add(color);
    return { color, chosen: false, stored: `${AUTO_PREFIX}${color}` };
  });
}

/** The colour of each account, in the given order. See resolveAccountColorState. */
export function resolveAccountColors(stored: (string | null)[]): AccountColor[] {
  return resolveAccountColorState(stored).map((entry) => entry.color);
}
