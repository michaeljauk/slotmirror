import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import { BASE } from "./helpers";

/** Every leaf key of a catalog, e.g. "nav.signOut". */
function keys(catalog: object, prefix = ""): string[] {
  return Object.entries(catalog).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? keys(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

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
