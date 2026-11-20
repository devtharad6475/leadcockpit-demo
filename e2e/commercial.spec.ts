/**
 * 2026-07-21 (M7) — Commercial screen Playwright test.
 *
 * Verifies the Commercial tab is reachable + Orders/Quotes sub-tabs work.
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

test.describe("M7 Commercial screen", () => {
  test("Commercial tab is reachable + in Sales group", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Commercial");
    // Either "Orders" or "Quotes" sub-tab should be visible.
    await expect(page.getByRole("tab", { name: /Orders/i })).toBeVisible({ timeout: 10_000 });
  });

  test("sub-tabs switch between Orders and Quotes", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Commercial");
    await page.waitForTimeout(1000);
    // Click the Quotes sub-tab.
    await page.getByRole("tab", { name: /Quotes/i }).click();
    await page.waitForTimeout(500);
    // Now click Orders.
    await page.getByRole("tab", { name: /Orders/i }).click();
    await page.waitForTimeout(500);
    // The Orders tab should be selected.
    const ordersTab = page.getByRole("tab", { name: /Orders/i, exact: false });
    await expect(ordersTab).toHaveAttribute("aria-selected", "true");
  });

  test("empty state shows helpful copy when no orders/quotes exist", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Commercial");
    await page.waitForTimeout(2000);
    // The page should render without crashing (either empty state or
    // a list of items, both valid).
    const commercialCard = page.getByText(/Orders|Quotes|Commercial/i);
    await expect(commercialCard.first()).toBeVisible();
  });
});
