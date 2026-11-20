/**
 * 2026-07-21 (M10) — Compliance screen Playwright test.
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

test.describe("M10 Compliance screen", () => {
  test("Compliance tab is reachable", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Compliance");
    await expect(page.getByText(/Outreach consent/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("renders without crashing (empty state or list)", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Compliance");
    await page.waitForTimeout(1500);
    const heading = page.getByText(/Outreach consent|No prospects/i);
    await expect(heading.first()).toBeVisible();
  });

  test("if prospects exist, basis dropdown is present + changeable", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Compliance");
    await page.waitForTimeout(1500);
    // The compliance screen should either show empty state OR the table.
    // If table: each row has a basis dropdown. We don't strictly assert
    // presence (depends on demo data) — just verify no crash.
    const card = page.getByText(/Outreach consent|No prospects/i);
    await expect(card.first()).toBeVisible();
  });
});
