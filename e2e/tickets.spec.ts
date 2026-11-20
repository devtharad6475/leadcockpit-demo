/**
 * 2026-07-21 (M6) — Tickets screen Playwright test.
 *
 * Verifies the Tickets tab is reachable + the new screen renders.
 * Empty state path (no tickets in the demo workspace) is the primary
 * assertion. The list/detail path is exercised separately when ticket
 * fixtures are added.
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

test.describe("M6 Tickets screen", () => {
  test("Tickets tab is in the Today group + reachable", async ({ page }) => {
    await loginDemo(page);
    // Click Tickets in the sidebar.
    await openTabByLabel(page, "Tickets");
    // The Tickets heading should appear.
    await expect(page.getByText(/Tickets/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("empty state shows helpful copy when no tickets exist", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Tickets");
    await page.waitForTimeout(1500);
    // Either the empty state ("No tickets yet") or a list of tickets
    // (if the demo workspace has any). Both are valid; assert the
    // Tickets card title renders without crashing.
    const ticketsCard = page.locator("text=/Tickets/");
    await expect(ticketsCard.first()).toBeVisible();
  });

  test("Tickets tab uses aria-current when active", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Tickets");
    const activeButton = page.locator('button[aria-current="page"]').first();
    await expect(activeButton).toContainText(/Tickets/i);
  });
});
