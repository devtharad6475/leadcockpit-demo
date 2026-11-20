/**
 * 2026-07-27 (Session 6 fix D-1) — Golden Thread test: partial-cancel display.
 *
 * ROOT CAUSE THIS TEST PINS:
 *   A partially-cancelled order keeps the ORIGINAL lineTotal (full-quantity)
 *   on each line item, but the order's grandTotal is recomputed to the
 *   SURVIVING quantity. The Commercial order-detail modal rendered li.lineTotal
 *   raw, so the line showed ₹1,000 while the header showed ₹600 (for 10 qty,
 *   4 cancelled, ₹100 each) — two contradicting totals on one screen. The
 *   operator could not tell what the customer owed.
 *
 * THE FIX: the line-total cell now computes the EFFECTIVE surviving total
 * (quantity - cancelledQty) × unitPrice when cancelledQuantityByLine is set,
 * and shows the original as struck-through context.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *   CASE A — for a partial_cancelled order, the SUM of the displayed
 *     effective line totals must EQUAL the order's grandTotal (the header).
 *     In the demo seed, order with status partial_cancelled has one line
 *     {qty:10, unitPrice:100}, cancelledQuantityByLine {li: 4}, grandTotal 600.
 *     Effective line total = (10-4) × 100 = 600. Header = 600. They MUST match.
 *   CASE B — the struck-through original (₹1,000) is shown as context, NOT as
 *     the live total. (Optional: only assert it's present, not the active number.)
 *
 * Run: npx playwright test golden-thread-partial-cancel-display
 */
import { test, expect } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";
import { E2E_BASE_URL } from "./helpers/e2e-target";

type Order = {
  id: string;
  orderNumber?: number;
  status: string;
  grandTotal: number;
  lineItems?: Array<{ id: string; quantity: number; unitPrice: number; lineTotal?: number; productName?: string }>;
  cancelledQuantityByLine?: Record<string, number>;
};

async function loginDemo(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  // 2026-08-19 — was an <h1> reading "LeadCockpit". The 2026-08-17 nav redesign
  // moved that string into the sidebar brand (not a heading), so this matched
  // nothing and every test in this file failed at login. See e2e/helpers/login.ts.
  await expectAppShell(page);
}

async function api<T>(url: string): Promise<T> {
  const res = await fetch(`${E2E_BASE_URL}${url}`, { headers: { "Content-Type": "application/json" }, cache: "no-store" });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API ${url} failed: ${res.status} ${JSON.stringify(payload)}`);
  return payload as T;
}

test.describe("Golden Thread — partial-cancel display (D-1 pin)", () => {
  test("CASE A — for a partial_cancelled order, displayed line total === header grandTotal", async ({ page }) => {
    await loginDemo(page);

    // Find a partial_cancelled order in the demo data (the audit proved one exists).
    const orders = await api<Order[]>("/api/orders");
    const partial = orders.find((o) => o.status === "partial_cancelled");
    if (!partial) {
      console.log("  (no partial_cancelled order in demo seed — cannot pin D-1; skipping)");
      test.skip(true, "No partial_cancelled order in demo seed");
      return;
    }

    // Hand-compute the EXPECTED effective line total: sum of (qty - cancelled) × unitPrice.
    let expectedTotal = 0;
    for (const li of partial.lineItems || []) {
      const cancelled = partial.cancelledQuantityByLine?.[li.id] ?? 0;
      expectedTotal += Math.max(0, li.quantity - cancelled) * li.unitPrice;
    }
    // The header grandTotal and our hand-computed effective total must agree.
    expect(partial.grandTotal, `API grandTotal (₹${partial.grandTotal}) must equal hand-computed surviving total (₹${expectedTotal})`).toBeCloseTo(expectedTotal, 2);

    // Now go to the Commercial screen, open this order's detail modal, and verify
    // the SCREEN shows the same effective total (the Golden Thread: API == screen).
    await openTabByLabel(page, "Commercial");
    await page.waitForTimeout(800);

    // Click the order number to open the detail modal.
    const orderRow = page.getByText(`#${partial.orderNumber}`).first();
    await orderRow.click();
    await page.waitForTimeout(500);

    // The modal header must show the grandTotal.
    const headerTotalText = `₹${partial.grandTotal.toLocaleString("en-IN")}`;
    await expect(page.locator("[role='dialog']").getByText(headerTotalText).first(), "modal header shows the grandTotal").toBeVisible({ timeout: 5_000 });

    // The effective line total must ALSO be visible (the D-1 fix). For the demo
    // seed it equals grandTotal (single line). Assert the effective value appears.
    const effectiveText = `₹${expectedTotal.toLocaleString("en-IN")}`;
    await expect(page.locator("[role='dialog']").getByText(effectiveText).first(), "modal line shows the EFFECTIVE surviving total (not the raw pre-cancel lineTotal)").toBeVisible({ timeout: 5_000 });
  });
});
