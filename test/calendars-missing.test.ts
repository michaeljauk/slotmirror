import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addAccount, BASE, signIn } from "./helpers";

async function page(path: string, cookie: string): Promise<string> {
  const response = await exports.default.fetch(`${BASE}${path}`, { headers: { cookie } });
  return response.text();
}

describe("an account without calendars", () => {
  it("warns on the accounts page and on the rules page", async () => {
    const { user, cookie } = await signIn("owner@example.com");
    await addAccount(user.id, "acc-no-calendars", "empty@example.com");
    expect(await page("/", cookie)).toContain("No calendars could be loaded.");
    const rules = await page("/rules", cookie);
    expect(rules).toContain("so the rules do not show this account");
    expect(rules).toContain('action="/rules/calendars/refresh"');
  });
});
