import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { displayTimeZone, i18nFor } from "../src/i18n";
import { BASE } from "./helpers";

/** Every leaf key of a catalog, e.g. "nav.signOut". */
function keys(catalog: object, prefix = ""): string[] {
  return Object.entries(catalog).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? keys(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe("dates and times", () => {
  const at = "2026-10-25T18:00:00.000Z";

  it("names UTC, but not a local time zone", () => {
    expect(i18nFor("en").formatTimestamp(at)).toMatch(/6:00\sPM UTC$/);
    expect(i18nFor("de", "Europe/Vienna").formatTimestamp(at)).toBe("25.10.2026, 19:00");
  });

  it("formats relative times in the locale", () => {
    const now = Date.parse(at);
    expect(i18nFor("en").formatRelative(at, now + 5 * 60_000)).toBe("5 min. ago");
    expect(i18nFor("de").formatRelative(at, now + 5 * 60_000)).toBe("vor 5 Min.");
    expect(i18nFor("de").formatRelative(at, now + 20_000)).toBe("jetzt");
    expect(i18nFor("en").formatRelative(at, now + 3 * 86_400_000)).toBe("3 days ago");
  });

  it("falls back to UTC for an unknown time zone", () => {
    expect(displayTimeZone("Europe/Vienna")).toBe("Europe/Vienna");
    expect(displayTimeZone("Mars/Olympus")).toBe("UTC");
    expect(displayTimeZone("")).toBe("UTC");
  });
});

describe("i18n", () => {
  it("has the same keys in every catalog", () => {
    expect(keys(de).sort()).toEqual(keys(en).sort());
  });

  it("renders German for a German browser", async () => {
    const response = await exports.default.fetch(`${BASE}/`, {
      headers: { "accept-language": "de-AT,de;q=0.9,en;q=0.8" },
    });
    const html = await response.text();
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("Mit Microsoft 365 anmelden");
  });

  it("falls back to English for an unsupported language", async () => {
    const response = await exports.default.fetch(`${BASE}/`, {
      headers: { "accept-language": "fr-FR" },
    });
    expect(await response.text()).toContain("Sign in with Microsoft 365");
  });

  it("switches with ?lang= and remembers the choice in a cookie", async () => {
    const response = await exports.default.fetch(`${BASE}/?lang=de`, {
      headers: { "accept-language": "en" },
    });
    expect(await response.text()).toContain("Anmelden");
    expect(response.headers.get("set-cookie")).toContain("lang=de");
  });
});

describe("privacy page", () => {
  it("is public and names the Google Limited Use requirement", async () => {
    const response = await exports.default.fetch(`${BASE}/privacy`, {
      headers: { "accept-language": "en" },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Limited Use");
    expect(html).toContain(
      "Event titles, descriptions, locations and attendees are read during a sync and not stored",
    );
  });
});
