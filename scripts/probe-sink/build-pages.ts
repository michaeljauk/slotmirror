/** Write the calendar pages for the sink. Wrangler runs this before `dev` and `deploy`, from the repository root. */
import { mkdirSync, writeFileSync } from "node:fs";
import { PAGE_ITEMS, providerPage, type PageProvider } from "./pages.ts";

const directory = new URL("public/pages/", import.meta.url);
mkdirSync(directory, { recursive: true });
for (const provider of Object.keys(PAGE_ITEMS) as PageProvider[]) {
  writeFileSync(new URL(`${provider}.json`, directory), providerPage(provider));
}
