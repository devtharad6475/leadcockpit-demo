/**
 * 2026-07-21 (M9) — Workspace settings Playwright test (kill-switch + insights).
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

test.describe("M9 Workspace settings", () => {
  test("Workspace tab is reachable", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Workspace");
    await page.getByRole("tab", { name: "Message controls", exact: true }).click();
    await expect(page.getByText(/Stop all automatic messages/i)).toBeVisible({ timeout: 10_000 });
  });

  test("kill-switch card shows current state", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Workspace");
    await page.getByRole("tab", { name: "Message controls", exact: true }).click();
    await page.waitForTimeout(1500);
    // Either "ENGAGED" or "Disengaged" state should be visible.
    const stateBadge = page.getByText(/nothing goes out by itself|automatic messages allowed/i).first();
    await expect(stateBadge).toBeVisible();
  });

  test("insights notebook accepts a note", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Workspace");
    await page.getByRole("tab", { name: "Notes and activity", exact: true }).click();
    await page.waitForTimeout(1500);
    // Type a note into the textarea + click Add.
    const textarea = page.getByRole("textbox", { name: "New workspace note", exact: true });
    await textarea.fill("Test insight from Playwright");
    await page.getByRole("button", { name: /^Add$/ }).click();
    // The new note should appear in the list.
    await expect(page.getByText("Test insight from Playwright").first()).toBeVisible({ timeout: 5_000 });
  });
});
