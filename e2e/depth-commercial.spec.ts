/**
 * 2026-07-29 — DEPTH AUDIT: Commercial (₹) — Slice B, Batch 1.
 *
 * Full end-to-end persistence + Golden Thread proof for the Commercial tab's
 * money flows. For each flow: fill EVERY form field → submit → read the JSON
 * file off disk → assert the persisted grandTotal === the hand-computed value
 * → re-open in the UI → assert the rendered ₹ matches (round-trip). Then edge
 * cases (negative qty, 0 qty, negative price, empty product).
 *
 * Golden Thread formula (verified from source — see D-2026-07-29-p):
 *   grandTotal = round( Σ (qty_i × round(unitPrice_i × 100)) ) / 100
 *   No tax, no shipping, no discount subtraction. Money is integer-paise
 *   (src/lib/money.ts).  orderNumber / quoteNumber = 1-based per-workspace
 *   integer counter (= max(existing) + 1, NOT reused after cancel).
 *   Persisted in top-level `orders[]` / `quotes[]` arrays of app-data.json.
 *   Zod validation failures return HTTP 422 (src/lib/api-response.ts).
 *
 * Test-Honesty note (Gate #7): we never hardcode an expected orderNumber /
 * quoteNumber, because the seed already ships with 4 orders (#1–4) and 1
 * quote (#1) in workspace_demo. We CAPTURE the number from the create
 * response and look that up instead. This makes the test order-independent.
 *
 * Isolation (Gate #8): beforeEach restores the snapshot. Every test starts
 * from identical clean state, so the next-number counter is deterministic.
 *
 * Run: npx playwright test depth-commercial --reporter=list
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { restoreDemoData, waitForServerQuiescent } from "./helpers/demo-data-snapshot";

import { readAppData } from "./helpers/app-data";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";
import { formatINR, formatMoney } from "../src/lib/money";
import { E2E_BASE_URL } from "./helpers/e2e-target";

const REPO_ROOT = path.resolve(__dirname, "..");
// 2026-08-19 (N-TEST-5) — was `path.join(REPO_ROOT, ".leadgen-data", "app-data.json")`.
// The suite moved onto its own data directory earlier the same session, so this
// pointed at the PRODUCT file while the server wrote to the suite's file: every
// assertion below read a value the test had never written. See e2e/helpers/data-dir.ts.
const DEMO_COOKIE = { name: "lc_demo", value: "1", url: E2E_BASE_URL };

/** Hand-compute grandTotal exactly as the backend does (integer paise). */
function computeGrandTotal(items: { quantity: number; unitPrice: number }[]): number {
  let totalPaise = 0;
  for (const li of items) {
    const unitPricePaise = Math.round(li.unitPrice * 100);
    totalPaise += li.quantity * unitPricePaise;
  }
  return Math.round(totalPaise) / 100;
}

/** Read the current persisted data fresh from disk (proves file-write happened). */

/** Find an order/quote in workspace_demo by its integer number. */
function findByNumber(coll: "orders" | "quotes", num: number): any {
  const data = readAppData();
  const rows = (data[coll] || []).filter((r: any) => r.workspaceId === "workspace_demo");
  return rows.find((r: any) => Number(r.orderNumber || r.quoteNumber) === num);
}

/** Wait for the actual persisted create, not an assumed two-second latency. */
async function submitCommercialCreate(page: Page, kind: "order" | "quote") {
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/${kind}s`
    && response.request().method() === "POST");
  await page.getByRole("button", { name: `Create ${kind}`, exact: true }).click();
  const response = await responsePromise;
  expect(response.ok(), `Creating the ${kind} must succeed before checking persistence`).toBe(true);
  await expect(page.getByRole("dialog", { name: `New ${kind}`, exact: true })).toBeHidden();
}

async function openWorkspace(page: Page) {
  await page.context().addCookies([DEMO_COOKIE]);
  await page.goto(`${E2E_BASE_URL}/`, { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await nav.isVisible({ timeout: 2000 }).catch(() => false)) break;
    const demoBtn = page.getByRole("button", { name: "Continue in Demo Mode" });
    if (await demoBtn.count() > 0) {
      await demoBtn.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(800);
    }
  }
  await nav.waitFor({ timeout: 30000 });
  // 2026-08-19 (N-TEST-5) — was `expect(page.getByText(/Leads to review/))`.
  // That card only renders when the queue actually HAS leads to review, so a
  // login helper was asserting a DATA condition: any test that emptied the
  // queue made every later login look like a failed login. Assert the shell.
  await expectAppShell(page);
}

async function openCommercial(page: Page) {
  // 2026-08-19 (N-TEST-4) — was two raw `getByRole("button", { name: … })`
  // clicks. Since the 2026-08-17 redesign the drawers start COLLAPSED, so the
  // "Quotes & Orders" button does not exist until "Customers" is opened; a
  // force-click on a locator matching nothing waits out the whole test budget
  // and reports as if the SCREEN were broken. openTabByLabel opens the drawer
  // the tab lives in first, and throws by name if the tab is gone.
  await openTabByLabel(page, "Quotes & Orders");
  await page.waitForTimeout(900);
}

/** Fill the create-modal fields (product, qty, price) + optional customer. */
async function fillCreateForm(page: Page, product: string, qty: string, price: string, customerIdx = 0) {
  await page.locator("#create-product").fill(product);
  await page.locator("#create-qty").fill(qty);
  await page.locator("#create-price").fill(price);
  if (customerIdx > 0) {
    await page.locator("#create-lead").selectOption({ index: customerIdx });
  }
}

// 2026-09-05 (N-TEST-17) — the three table/modal assertions below used to look
// for `${formatINR(total)} INR`, i.e. the amount with the currency CODE spelled
// out after it. The screens stopped rendering it that way when they moved to
// `formatMoney(amount, currencyCode)`, which uses Intl currency formatting and
// prints "₹7,500.00" — the symbol already says which currency it is, so the
// trailing "INR" was redundant and was dropped.
//
// So these three had been red on a display change, not on a defect: every API
// assertion in the same tests (status, line items, stamped lineTotal) passed.
// They now format the expected value with the SAME function the screen uses,
// which is the rule this file already adopted in N-TEST-7 — a test that
// hard-codes a format is a test that goes red the next time the format is
// improved, and gets ignored.
// 2026-08-19 (N-TEST-7) — this file used to carry its OWN formatINR:
//
//     function formatINR(value: number) { return value.toLocaleString("en-IN"); }
//
// which produces "1,000". The product's shared formatter (src/lib/money.ts,
// the P2-1 chokepoint) produces "₹1,000.00" — Indian grouping AND two
// decimals. So every ₹ round-trip assertion here was comparing the screen
// against a second, wrong idea of how the screen formats money, and read as
// "the total is missing" ("₹1,000 INR" not found) or "the total is wrong"
// (Expected "7500.00", Received "Total: ₹7,500.00").
//
// The spec now imports the SAME function the UI renders with (see the import
// block above), so a formatting change can never again fail as a money bug.
// Note it already includes the ₹ symbol — do not prefix another one.

// ════════════════════════════════════════════════════════════════════════════
// NEW ORDER — full field persist + ₹ Golden Thread + UI round-trip
// ════════════════════════════════════════════════════════════════════════════
test.describe("Commercial depth — New order", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("create order persists every field + ₹ matches hand-computed total (UI + file)", async ({ page }) => {
    await openWorkspace(page);
    await openCommercial(page);

    // Open New order modal
    await page.getByRole("button", { name: "New order" }).first().click();
    await page.waitForTimeout(500);

    const PRODUCT = "Gold Zari Thread (5kg pack)";
    const QTY = 5;
    const PRICE = 1500;
    const EXPECTED_TOTAL = computeGrandTotal([{ quantity: QTY, unitPrice: PRICE }]); // 7500

    // FIX #1: fillCreateForm FIRST — the modal opens with defaults qty=1/price=0
    // (openCreate resets form to ₹0.00 at Commercial.tsx:120-121), so the live
    // preview only shows the hand-computed total AFTER the fields are filled.
    await fillCreateForm(page, PRODUCT, String(QTY), String(PRICE), 1);

    // Verify the live UI preview total BEFORE submit (Commercial.tsx:371)
    const preview = page.getByText(/^Total: ₹/);
    await expect(preview).toContainText(formatINR(EXPECTED_TOTAL));

    await submitCommercialCreate(page, "order");

    // FIX #2: don't hardcode orderNumber=1 — the seed already ships orders #1-4.
    // Find the order we just created by matching product + grandTotal.
    const data = readAppData();
    const order = (data.orders || [])
      .filter((o: any) => o.workspaceId === "workspace_demo")
      .find((o: any) => o.lineItems?.some((li: any) => li.productName === PRODUCT));
    expect(order, "order with this product must exist in app-data.json after create").toBeDefined();

    expect(order.grandTotal, "persisted grandTotal must equal hand-computed").toBe(EXPECTED_TOTAL);
    expect(order.currencyCode).toBe("INR");
    expect(order.workspaceId).toBe("workspace_demo");
    // F-UI-2 (2026-07-29): the form's status picker defaults to "confirmed"
    // and the backend now honors it. Status must round-trip the operator's
    // choice (previously the API silently dropped it → always "draft").
    expect(order.status).toBe("confirmed");
    expect(order.confirmedAt, "confirmed order must stamp confirmedAt").toBeTruthy();
    expect(order.lineItems).toHaveLength(1);
    expect(order.lineItems[0].productName).toBe(PRODUCT);
    expect(order.lineItems[0].quantity).toBe(QTY);
    expect(order.lineItems[0].unitPrice).toBe(PRICE);
    expect(order.lineItems[0].lineTotal).toBe(EXPECTED_TOTAL); // lineTotal stamped by finalizeLineItems
    const num = Number(order.orderNumber);

    // ── UI round-trip: the table cell + detail modal must show the same ₹ ──
    const rowTotalCell = page.getByText(formatMoney(EXPECTED_TOTAL, "INR")).first();
    await expect(rowTotalCell).toBeVisible({ timeout: 8000 });

    // Open the detail modal + assert the ₹ total there too
    await page.getByRole("button", { name: `View details for order #${num}` }).click();
    await page.waitForTimeout(600);
    const detailTotal = page.getByText("Total:").locator("..");
    await expect(detailTotal.getByText(formatINR(EXPECTED_TOTAL))).toBeVisible();
  });

  test("order with decimal unit price (₹49.99 × 2) computes ₹99.98 exactly", async ({ page }) => {
    await openWorkspace(page);
    await openCommercial(page);
    await page.getByRole("button", { name: "New order" }).first().click();
    await page.waitForTimeout(500);

    const PRODUCT = "Border sample";
    const QTY = 2, PRICE = 49.99;
    const EXPECTED = computeGrandTotal([{ quantity: QTY, unitPrice: PRICE }]); // 99.98
    expect(EXPECTED).toBe(99.98);

    await fillCreateForm(page, PRODUCT, String(QTY), String(PRICE));
    await submitCommercialCreate(page, "order");

    // Find the order we just created by product (not by hardcoded number).
    const data = readAppData();
    const order = (data.orders || [])
      .filter((o: any) => o.workspaceId === "workspace_demo")
      .find((o: any) => o.lineItems?.some((li: any) => li.productName === PRODUCT));
    expect(order, "decimal-price order must exist").toBeDefined();
    expect(order.grandTotal).toBe(EXPECTED);
    expect(order.lineItems[0].lineTotal).toBe(EXPECTED);
  });

  test("status picker: choosing 'Draft' saves a draft with no confirmedAt (F-UI-2)", async ({ page }) => {
    // F-UI-2 regression guard: the picker must round-trip BOTH options.
    // (The companion test above covers the default 'confirmed' path.)
    await openWorkspace(page);
    await openCommercial(page);
    await page.getByRole("button", { name: "New order" }).first().click();
    await page.waitForTimeout(500);

    const PRODUCT = "Draft-only sample";
    await fillCreateForm(page, PRODUCT, "1", "100");
    // Switch the picker from its default (confirmed) to Draft.
    await page.locator("#create-status").selectOption("draft");
    await submitCommercialCreate(page, "order");

    const data = readAppData();
    const order = (data.orders || [])
      .filter((o: any) => o.workspaceId === "workspace_demo")
      .find((o: any) => o.lineItems?.some((li: any) => li.productName === PRODUCT));
    expect(order, "draft order must exist").toBeDefined();
    expect(order.status, "picker 'Draft' must persist as draft").toBe("draft");
    expect(order.confirmedAt, "draft order must NOT stamp confirmedAt").toBeUndefined();
  });

  test("multi-line order sums correctly (3 lines)", async ({ page, request }) => {
    // The UI create-modal only supports ONE line item, so for a multi-line
    // Golden Thread we POST directly (the API is the backend source of truth)
    // then verify the file math + that the UI table renders the sum.
    await restoreDemoData(); await waitForServerQuiescent();
    const lines = [
      { productName: "Zari lace A", quantity: 3, unitPrice: 100 },   // 300
      { productName: "Border B", quantity: 2, unitPrice: 49.99 },     // 99.98
      { productName: "Trim C", quantity: 10, unitPrice: 12.5 },       // 125
    ];
    const EXPECTED = computeGrandTotal(lines); // 524.98
    expect(EXPECTED).toBe(524.98);

    const resp = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { lineItems: lines, currencyCode: "INR", status: "confirmed" },
    });
    expect(resp.status()).toBeLessThan(400);
    const created = await resp.json();

    // File math (look up by the number the API returned — never hardcoded)
    const order = findByNumber("orders", created.orderNumber);
    expect(order.grandTotal, "multi-line grandTotal must equal hand-computed sum").toBe(EXPECTED);

    // Now verify the UI renders it: open Commercial, find the row total.
    await openWorkspace(page);
    await openCommercial(page);
    await expect(page.getByText(formatMoney(EXPECTED, "INR")).first()).toBeVisible({ timeout: 8000 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// NEW QUOTE — same Golden Thread (quote path computes grandTotal directly)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Commercial depth — New quote", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("create quote persists ₹ + UI round-trip", async ({ page }) => {
    await openWorkspace(page);
    await openCommercial(page);
    // Switch to Quotes tab. The Tabs component renders role="tab" (not button),
    // and the label includes a count badge ("Quotes 1"), so match by substring.
    await page.getByRole("tab", { name: /Quotes/ }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "New quote" }).first().click();
    await page.waitForTimeout(500);

    const PRODUCT = "Festive sample pack";
    const QTY = 4, PRICE = 250;
    const EXPECTED = computeGrandTotal([{ quantity: QTY, unitPrice: PRICE }]); // 1000
    await fillCreateForm(page, PRODUCT, String(QTY), String(PRICE));
    await submitCommercialCreate(page, "quote");

    // FIX #2 (quotes): don't hardcode quoteNumber=1 — seed has quote #1.
    const data = readAppData();
    const quote = (data.quotes || [])
      .filter((q: any) => q.workspaceId === "workspace_demo")
      .find((q: any) => q.lineItems?.some((li: any) => li.productName === PRODUCT));
    expect(quote, "quote with this product must exist").toBeDefined();
    expect(quote.grandTotal).toBe(EXPECTED);
    // UI round-trip
    await expect(page.getByText(formatMoney(EXPECTED, "INR")).first()).toBeVisible({ timeout: 8000 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EDGE CASES — validation rejects bad input
// ════════════════════════════════════════════════════════════════════════════
test.describe("Commercial depth — edge cases (validation)", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("UI blocks empty product name (client-side guard at submitCreate)", async ({ page }) => {
    await openWorkspace(page);
    await openCommercial(page);
    // 2026-08-19 (N-TEST-7) — count the orders BEFORE, instead of asserting the
    // literal 1 the seed happened to ship when this was written. The seed now
    // ships 3, so the test failed with "Expected length: 1, Received length: 3"
    // — a message that says nothing about the guard it is supposed to check.
    // What this test is actually about is the DELTA: the client-side guard must
    // stop the POST, so the count must not move.
    const ordersBefore = (readAppData().orders || []).filter((o: any) => o.workspaceId === "workspace_demo").length;
    await page.getByRole("button", { name: "New order" }).first().click();
    await page.waitForTimeout(500);
    // Leave product empty; qty/price valid
    await fillCreateForm(page, "", "2", "100");
    await page.getByRole("button", { name: "Create order" }).click();
    await page.waitForTimeout(800);
    // The UI should show its own error message and NOT create.
    await expect(page.getByText(/Product name is required/i)).toBeVisible();
    const data = readAppData();
    expect(
      (data.orders || []).filter((o: any) => o.workspaceId === "workspace_demo"),
      "the client-side guard must block the POST — no order may be created",
    ).toHaveLength(ordersBefore);
  });

  test("UI blocks quantity ≤ 0", async ({ page }) => {
    await openWorkspace(page);
    await openCommercial(page);
    await page.getByRole("button", { name: "New order" }).first().click();
    await page.waitForTimeout(500);
    await fillCreateForm(page, "Valid product", "0", "100");
    await page.getByRole("button", { name: "Create order" }).click();
    await page.waitForTimeout(800);
    await expect(page.getByText(/Quantity must be a positive number/i)).toBeVisible();
  });

  test("API rejects negative unit price (zod → 422)", async ({ request }) => {
    await restoreDemoData(); await waitForServerQuiescent();
    const resp = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { lineItems: [{ productName: "X", quantity: 1, unitPrice: -5 }], currencyCode: "INR" },
    });
    // FIX #4: zod validation failures return 422 (validationErrorResponse).
    expect(resp.status(), "negative price must be rejected").toBe(422);
    const body = await resp.json();
    expect(JSON.stringify(body)).toMatch(/cannot be negative|unit price|validation/i);
  });

  test("API rejects quantity 0 (zod .positive → 422)", async ({ request }) => {
    await restoreDemoData(); await waitForServerQuiescent();
    const resp = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { lineItems: [{ productName: "X", quantity: 0, unitPrice: 10 }], currencyCode: "INR" },
    });
    expect(resp.status()).toBe(422);
  });

  test("API accepts unit price = 0 (free sample)", async ({ request }) => {
    await restoreDemoData(); await waitForServerQuiescent();
    const resp = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { lineItems: [{ productName: "Free sample", quantity: 1, unitPrice: 0 }], currencyCode: "INR" },
    });
    expect(resp.status()).toBeLessThan(400);
    const created = await resp.json();
    expect(created.grandTotal).toBe(0);
  });

  test("API rejects empty lineItems array (zod .min(1) → 422)", async ({ request }) => {
    await restoreDemoData(); await waitForServerQuiescent();
    const resp = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { lineItems: [], currencyCode: "INR" },
    });
    expect(resp.status()).toBe(422);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CANCEL ORDER — status transition + ripple (grandTotal preserved)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Commercial depth — Cancel order", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("cancel a confirmed order sets status=cancelled + cancelledAt (grandTotal preserved)", async ({ page, request }) => {
    // FIX #5: create OUR OWN order via API and capture its id + number, so we
    // cancel a known target instead of guessing which seeded row to click.
    const EXPECTED_TOTAL = 1000; // 2 × ₹500
    const create = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { lineItems: [{ productName: "To cancel", quantity: 2, unitPrice: 500 }], currencyCode: "INR", status: "confirmed" },
    });
    expect(create.status()).toBeLessThan(400);
    const created = await create.json();
    const id = created.id;
    const num = created.orderNumber;
    expect(created.grandTotal).toBe(EXPECTED_TOTAL);

    // Cancel via the UI. 2026-08-19 (N-TEST-7): this used to click a bare
    // "Cancel" button in the row. The 2026-08-02 UX pass collapsed the row
    // actions into a ⋯ menu (Commercial.tsx:334-352), so that button has not
    // existed for two weeks and the click waited out the full 90s budget on a
    // locator matching nothing — reported as if CANCELLING were broken.
    //
    // The real path is three steps, and the last two share a name: the menu
    // item and the ConfirmModal's confirm button are BOTH "Cancel order".
    // They are told apart by role — Radix renders the item as `menuitem`.
    await openWorkspace(page);
    await openCommercial(page);
    await page.getByRole("button", { name: `View details for order #${num}` }).waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: `More actions for order #${num}` }).click();
    await page.getByRole("menuitem", { name: "Cancel order" }).click();
    await page.waitForTimeout(500);
    // ConfirmModal confirm button is labelled "Cancel order"
    const cancelledResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/orders/${id}/cancel`
      && response.request().method() === "POST");
    await page.getByRole("button", { name: "Cancel order" }).click();
    expect((await cancelledResponse).ok()).toBe(true);

    // File: status flipped to cancelled, grandTotal PRESERVED (not zeroed).
    const order = findByNumber("orders", num);
    expect(order.status).toBe("cancelled");
    expect(order.cancelledAt).toBeTruthy();
    expect(order.grandTotal, "grandTotal must be preserved on cancel (audit record)").toBe(EXPECTED_TOTAL);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// NUMBER ALLOCATION — deterministic max+1 counter (no collision, no reuse)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Commercial depth — order/quote number allocation", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("sequential creates get max+1, max+2, max+3 (no reuse of cancelled numbers)", async ({ request }) => {
    // FIX #3: the seed ships 4 orders (#1-4), so the next 3 numbers are 5,6,7.
    // Don't hardcode 1,2,3. Instead compute the expected base from the file.
    const base = readAppData().orders
      .filter((o: any) => o.workspaceId === "workspace_demo")
      .reduce((acc: number, o: any) => Math.max(acc, Number(o.orderNumber || 0)), 0);
    const expectedSeq = [base + 1, base + 2, base + 3];

    const nums: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await request.post(`${E2E_BASE_URL}/api/orders`, {
        headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
        data: { lineItems: [{ productName: `P${i}`, quantity: 1, unitPrice: 10 }], currencyCode: "INR", status: "confirmed" },
      });
      const body = await r.json();
      nums.push(body.orderNumber);
    }
    expect(nums, "sequential creates must be max+1, max+2, max+3").toEqual(expectedSeq);

    // Cancel the MIDDLE one, then create another — the new number must be
    // max+4 (NOT the freed middle number). Proves no reuse.
    const middleNum = expectedSeq[1];
    const middleId = readAppData().orders.find((o: any) => Number(o.orderNumber) === middleNum).id;
    const cancelResp = await request.post(`${E2E_BASE_URL}/api/orders/${middleId}/cancel`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { actor: "test", reason: "ripple check" },
    });
    expect(cancelResp.status()).toBeLessThan(400);

    const r4 = await request.post(`${E2E_BASE_URL}/api/orders`, {
      headers: { Cookie: "lc_demo=1", "Content-Type": "application/json" },
      data: { lineItems: [{ productName: "P4", quantity: 1, unitPrice: 10 }], currencyCode: "INR", status: "confirmed" },
    });
    const num4 = (await r4.json()).orderNumber;
    expect(num4, "cancelled number must NOT be reused").toBe(base + 4);
    expect(num4, "cancelled number must NOT be reused").not.toBe(middleNum);
  });
});
