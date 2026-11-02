import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, signIn } from "./helpers";

async function page(path: string, cookie?: string): Promise<string> {
  const headers = cookie ? { cookie } : undefined;
  const response = await exports.default.fetch(`${BASE}${path}`, { headers });
  return response.text();
}

describe("page frame", () => {
  it("keeps the sidebar on the privacy page for a signed-in user", async () => {
    const { cookie } = await signIn("admin@example.com");
    const html = await page("/privacy", cookie);
    expect(html).toContain('class="sidebar"');
    expect(html).toContain("admin@example.com");
  });

  it("shows no sidebar on the privacy page for a visitor", async () => {
    const html = await page("/privacy");
    expect(html).not.toContain('class="sidebar"');
    expect(html).toContain('class="topbar"');
  });
});
