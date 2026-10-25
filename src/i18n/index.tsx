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
  /** Date without time, in the locale's style. Timestamps are stored in UTC. */
  formatDate: (iso: string) => string;
  /** Date and time in UTC, with the zone named. */
  formatTimestamp: (iso: string) => string;
}

export function i18nFor(locale: Locale): I18n {
  return {
    locale,
    t: CATALOGS[locale],
    formatDate: (iso) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(iso),
      ),
    formatTimestamp: (iso) =>
      `${new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(iso))} UTC`,
  };
}

/** Locale chosen by the language detector middleware, or the fallback. */
export function i18nFromContext(c: Context): I18n {
  const language = c.get("language") as string | undefined;
  return i18nFor(isLocale(language) ? language : LOCALES[0]);
}

const I18nContext = createContext<I18n>(i18nFor(LOCALES[0]));

export function I18nProvider(props: { value: I18n; children: Child }) {
  return <I18nContext.Provider value={props.value}>{props.children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
