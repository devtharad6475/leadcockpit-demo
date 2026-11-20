/**
 * 2026-07-21 (M5) — Rebuilt Dashboard test.
 *
 * Per docs/UI-DESIGN.md M5, the dashboard is now:
 *   1. Today's work queue (primary — the 10-minute day)
 *   2. Numbers strip (compact, secondary)
 *   3. Recent activity (kept from old design)
 *   4. Workspace status (compact, replaces 3-panel grid)
 *
 * Verifies the new structure renders + the queue items are clickable.
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
  // 2026-08-19 (N-TEST-4) — and the landing screen is no longer the dashboard.
  // The redesign made "Needs you" the leaf the app opens on, so every assertion
  // in this file was being made against the WRONG SCREEN: the dashboard was
  // fine, the tests just never went there.
  await openTabByLabel(page, "Dashboard");
  await page.waitForTimeout(600);
}

test.describe("M5 Dashboard", () => {
  test("today's work queue is the first section", async ({ page }) => {
    await loginDemo(page);
    // Wait for the dashboard data to load.
    await page.waitForTimeout(3000);
    // The "Today" card title should be visible.
    const todayCard = page.locator("section, article, div").filter({ hasText: "Today" }).first();
    await expect(todayCard).toBeVisible({ timeout: 10_000 });

    // Queue items: each has a count Badge + an Open button. Match by
    // the specific queue-item aria-labels.
    const reviewBtn = page.locator('button[aria-label="Open Leads to review"]');
    await expect(reviewBtn).toBeVisible({ timeout: 10_000 });
    // 2026-08-19 — the card is labelled "Outreach drafts to approve" (page.tsx
    // queueItems); "Message drafts to approve" was the 2026-07-21 wording.
    const draftBtn = page.locator('button[aria-label="Open Outreach drafts to approve"]');
    await expect(draftBtn).toBeVisible({ timeout: 10_000 });
  });

  test("the headline numbers are on the dashboard (now inside 'Pipeline at a glance')", async ({ page }) => {
    await loginDemo(page);
    // 2026-08-19 — was `section[aria-label="Workspace numbers"]`. The 2026-08-02
    // Phase 4 redesign replaced the equal-weight 6-tile strip with a
    // length-encoded bar chart, and folded the headline totals into it as inline
    // chips. The section is gone; the numbers are not. Assert what survived.
    const pipeline = page.getByText("Pipeline at a glance").first();
    await expect(pipeline).toBeVisible({ timeout: 10_000 });
    for (const label of ["Approved", "Hot leads", "Do not contact"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    }
  });

  test("recent activity card renders", async ({ page }) => {
    await loginDemo(page);
    // The "Recent activity" card title.
    await expect(page.getByText("Recent activity").first()).toBeVisible({ timeout: 10_000 });
  });

  test("workspace status card replaces the old 3-panel grid", async ({ page }) => {
    await loginDemo(page);
    await expect(page.getByText("Workspace status").first()).toBeVisible({ timeout: 10_000 });
    // Old panel titles should NOT be present anymore.
    const oldPanels = await page.getByText("Sales health").count();
    expect(oldPanels, "old 'Sales health' panel should be removed").toBe(0);
  });

  test("dashboard no longer duplicates 'Follow-ups due' in 2 places", async ({ page }) => {
    await loginDemo(page);
    // Old dashboard had "Follow-ups due" in BOTH the intelligence cards
    // AND the 12-card metric grid. New dashboard has it ONCE (in the
    // Today queue). Count occurrences in the main content area.
    await page.waitForTimeout(2000);
    const allFollowups = await page.getByText(/Follow-ups due/i).count();
    expect(allFollowups, "Follow-ups due should appear once, not multiple times").toBeLessThanOrEqual(1);
  });

  test("no raw snake_case status codes visible (campaign status uses displayLabel)", async ({ page }) => {
    await loginDemo(page);
    await page.waitForTimeout(2000);
    // The Workspace status card renders campaign status via displayLabel.
    // Snake_case codes like "needs_review" or "in_progress" should NOT
    // appear in the rendered text.
    const bodyText = await page.locator("body").textContent() || "";
    // Filter out non-user-facing code (we only care about visible labels).
    // We check that no common snake_case leak patterns appear.
    const snakeCaseLeaks = [
      "needs_review", "in_progress", "do_not_contact", "fast_customer_reply",
      "draft_only", "safe_auto_reply",
    ].filter((code) => bodyText.includes(code));
    expect(snakeCaseLeaks, `raw snake_case codes leaked: ${snakeCaseLeaks.join(", ")}`).toEqual([]);
  });
});
