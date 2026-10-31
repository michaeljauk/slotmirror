import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { I18nProvider, i18nFor } from "../src/i18n";
import { Layout } from "../src/pages/layout";
import { buildVersionLabel, versionLabel } from "../src/version";

describe("versionLabel", () => {
  it("shows only the commit while the version is 0.0.0", () => {
    expect(versionLabel("0.0.0", "10beb8c5a1234")).toBe("10beb8c5a");
  });

  it("shows version and commit for a release", () => {
    expect(versionLabel("1.4.0", "10beb8c5a")).toBe("v1.4.0 (10beb8c5a)");
  });

  it("shows only the version if the build has no commit", () => {
    expect(versionLabel("1.4.0", undefined)).toBe("v1.4.0");
    expect(versionLabel("1.4.0", "  ")).toBe("v1.4.0");
  });

  it("returns null if there is nothing to show", () => {
    expect(versionLabel("0.0.0", undefined)).toBeNull();
    expect(versionLabel("0.0.0", "")).toBeNull();
  });

  it("reads the build commit and the package version by default", () => {
    expect(buildVersionLabel()).toBe("testcommi");
  });
});

describe("sidebar", () => {
  async function page(role: "member" | "admin"): Promise<string> {
    const user = { id: "u", orgId: "o", email: "a.b@example.com", role };
    const app = new Hono();
    app.get("/", (c) =>
      c.html(
        <I18nProvider value={i18nFor("en")} languagePage="/">
          <Layout title="Test" user={user as never} active="rules">
            x
          </Layout>
        </I18nProvider>,
      ),
    );
    return (await app.request("/")).text();
  }

  it("marks the current page and shows Admin to admins only", async () => {
    const admin = await page("admin");
    expect(admin).toContain('<a href="/rules" aria-current="page">');
    expect(admin).toContain('href="/admin"');
    expect(await page("member")).not.toContain('href="/admin"');
  });

  it("keeps the version in the footer of a signed-in page", async () => {
    expect((await page("member")).split("<footer")[1]).toContain('class="version"');
  });
});

describe("footer", () => {
  async function footer(): Promise<string> {
    const app = new Hono();
    app.get("/", (c) =>
      c.html(
        <I18nProvider value={i18nFor("en")} languagePage="/">
          <Layout title="Test">x</Layout>
        </I18nProvider>,
      ),
    );
    return (await (await app.request("/")).text()).split("<footer")[1] ?? "";
  }

  it("shows the commit after the privacy link", async () => {
    const html = await footer();
    expect(html).toContain('<span class="version" title="Version">testcommi</span>');
    expect(html).not.toContain("undefined");
  });
});
