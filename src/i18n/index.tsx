import type { Context } from "hono";
import { createContext, useContext, type Child } from "hono/jsx";
import { de } from "./de";
import { en, type Messages } from "./en";

export type { Messages };

/** First entry is the fallback. Add a locale here and in CATALOGS. */
export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = { en: "English", de: "Deutsch" };

const CATALOGS: Record<Locale, Messages> = { en, de };

export function isLocale(value: string | undefined): value is Locale {
  return (LOCALES as readonly string[]).includes(value ?? "");
}

export interface I18n {
  locale: Locale;
  t: Messages;
  /** IANA time zone in which dates and times are shown. */
  timeZone: string;
  /** Date without time, in the locale's style. Timestamps are stored in UTC. */
  formatDate: (iso: string) => string;
  /** Date and time in the display time zone. The zone is named only if it is UTC. */
  formatTimestamp: (iso: string) => string;
  /** Time relative to `now`, e.g. "5 min ago" or "vor 5 Min.". */
  formatRelative: (iso: string, now?: number) => string;
}

/** Steps for relative times, largest first: unit and its length in seconds. */
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** Formatters per locale and time zone, built once per isolate: Intl setup costs CPU time. */
const cache = new Map<string, I18n>();

export function i18nFor(locale: Locale, timeZone = "UTC"): I18n {
  const key = `${locale}|${timeZone}`;
  let i18n = cache.get(key);
  if (!i18n) {
    i18n = buildI18n(locale, timeZone);
    cache.set(key, i18n);
  }
  return i18n;
}

function buildI18n(locale: Locale, timeZone: string): I18n {
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone });
  const timestampFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  return {
    locale,
    t: CATALOGS[locale],
    timeZone,
    formatDate: (iso) => dateFormat.format(new Date(iso)),
    formatTimestamp: (iso) => {
      const text = timestampFormat.format(new Date(iso));
      return timeZone === "UTC" ? `${text} UTC` : text;
    },
    formatRelative: (iso, now = Date.now()) => {
      const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
      for (const [unit, length] of RELATIVE_UNITS) {
        if (Math.abs(seconds) >= length) {
          return relativeFormat.format(Math.round(seconds / length), unit);
        }
      }
      return relativeFormat.format(0, "second");
    },
  };
}

/** Valid time zones, checked once per isolate. */
const checkedTimeZones = new Map<string, boolean>();

/** `value` if it is a time zone that Intl knows, otherwise UTC. */
export function displayTimeZone(value: string | undefined): string {
  const zone = value?.trim();
  if (!zone) return "UTC";
  let valid = checkedTimeZones.get(zone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      valid = true;
    } catch {
      valid = false;
    }
    checkedTimeZones.set(zone, valid);
  }
  return valid ? zone : "UTC";
}

/** Locale chosen by the language detector middleware, or the fallback. */
export function i18nFromContext(c: Context): I18n {
  const language = c.get("language") as string | undefined;
  const env = c.env as { TIME_ZONE?: string } | undefined;
  return i18nFor(isLocale(language) ? language : LOCALES[0], displayTimeZone(env?.TIME_ZONE));
}

const I18nContext = createContext<I18n>(i18nFor(LOCALES[0]));

export function I18nProvider(props: { value: I18n; children: Child }) {
  return <I18nContext.Provider value={props.value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
