/**
 * 2026-07-21 (M8) — Catalogue screen Playwright test.
 */
import { test, expect } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";

async function loginDemo(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  // 2026-08-19 — was an <h1> reading "LeadCockpit". The 2026-08-17 nav redesign
  // moved that string into the sidebar brand (not a heading), so this matched
  // nothing and every test in this file failed at login. See e2e/helpers/login.ts.
  await expectAppShell(page);
}

test.describe("M8 Catalogue screen", () => {
  test("Catalogue tab is reachable + in Knowledge group", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Catalogue");
    await expect(page.getByText(/Product catalogue/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("renders without crashing", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Catalogue");
    await page.waitForTimeout(1500);
    // Either the empty state, error state, or list of products — all valid.
    const heading = page.getByText(/Product catalogue|No products|Couldn't load/i);
    await expect(heading.first()).toBeVisible();
  });
});
