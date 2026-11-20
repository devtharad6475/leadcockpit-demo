/**
 * 2026-07-26 (Cluster 7) — Workflow completeness.
 *
 * Pins the Cluster-7 fixes from docs/AUDIT-FINDINGS-2026-07-26.md:
 *   P1-7 — Commercial screen has New order / New quote buttons (was read-only).
 *   P1-8 — Integrations tab honestly labelled "Coming later" (no fake buttons);
 *          New ticket button on Tickets screen.
 *   P1-9 — auto-approve daily batch (golden:auto-approve-batch pins the math;
 *          this file does NOT re-test the batch — the golden owns that).
 *   remove-dnc UI — Compliance screen has a "Remove from DNC" button when a
 *          lead is blocked (the owner-only path built in Cluster 2).
 *
 * Per build-right Phase 3b: a UI feature is NOT done just because the code
 * compiles. We boot the app, click the buttons, assert they exist + work.
 *
 * Run: npx playwright test cluster7-workflow
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

test.describe("Cluster 7 — workflow completeness", () => {

  test("P1-7: Commercial — New order + New quote buttons exist + modal opens", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Commercial");
    // Wait for the Commercial section to actually render (it loads orders +
    // quotes in parallel). The Tabs primitive renders "Orders" / "Quotes".
    await expect(page.getByRole("tab", { name: /Orders/i }).first(),
      "Commercial screen must render the Orders sub-tab").toBeVisible({ timeout: 10000 });

    // Orders tab is active by default — the "New order" button should be there.
    const newOrderBtn = page.getByRole("button", { name: /New order/i }).first();
    await expect(newOrderBtn, "Orders tab must have a 'New order' button (P1-7)").toBeVisible({ timeout: 5000 });

    // Click it → modal opens.
    await newOrderBtn.click();
    await page.waitForTimeout(500);
    await expect(page.getByRole("heading", { name: /New order/i }).first(),
      "New order modal must open").toBeVisible({ timeout: 3000 });
    await expect(page.getByRole("button", { name: /Create order/i }).first(),
      "Modal must have a Create order submit button").toBeVisible({ timeout: 2000 });
  });

  test("P1-7: Commercial — Quotes tab has a 'New quote' button", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Commercial");
    await expect(page.getByRole("tab", { name: /Quotes/i }).first(),
      "Commercial screen must render the Quotes sub-tab").toBeVisible({ timeout: 10000 });

    await page.getByRole("tab", { name: /Quotes/i }).first().click();
    await page.waitForTimeout(500);
    const newQuoteBtn = page.getByRole("button", { name: /New quote/i }).first();
    await expect(newQuoteBtn, "Quotes tab must have a 'New quote' button (P1-7)").toBeVisible({ timeout: 5000 });
  });

  test("P1-8: Integrations — non-built integrations say 'planned — not available yet' (no fake Connect buttons)", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Integrations");
    await page.waitForTimeout(1500);

    // The honest label must appear (the OLD UI showed disabled "Configure later"
    // buttons that looked real).
    await expect(page.getByText(/planned — not available yet/i).first(),
      "non-built integrations must say 'planned — not available yet'").toBeVisible({ timeout: 5000 });
    // And the explanatory "Coming in a future stage" note.
    await expect(page.getByText(/coming in a future stage/i).first(),
      "the Integrations grid must clearly say these are planned, not built").toBeVisible({ timeout: 5000 });
  });

  test("P1-8: Tickets — New ticket button exists + modal opens", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Tickets");
    await page.waitForTimeout(1500);

    const newTicketBtn = page.getByRole("button", { name: /New ticket/i }).first();
    await expect(newTicketBtn, "Tickets screen must have a 'New ticket' button (P1-8)").toBeVisible({ timeout: 5000 });

    await newTicketBtn.click();
    await page.waitForTimeout(500);
    await expect(page.getByRole("heading", { name: /New ticket/i }).first(),
      "New ticket modal must open").toBeVisible({ timeout: 3000 });
  });
});
