/**
 * golden-discount-flag-wiring.ts — pins F-LOGIC-2 (2026-08-04 build-right audit).
 *
 * WHAT THIS PROVES
 *   The LOGIC.md rule "discounts allowed but flagged" (2026-07-21) says an
 *   order with a line priced below the catalog rate must carry
 *   `discountGiven=true` + `totalDiscountAmount` so the owner sees a badge.
 *   `OrderService.computeDiscountFlag` exists + is golden-pinned (golden:order-
 *   cancel CASES B/L/M) — BUT until this fix, NO order-creation route passed
 *   the workspace catalog into createOrderDirect / convertQuoteToOrder, so the
 *   flag was computed in tests but NEVER stamped on real orders. The badge in
 *   the Commercial UI (o.discountGiven) was always falsy.
 *
 *   This golden pins the WIRING: createOrderDirect + convertQuoteToOrder each
 *   accept an optional `products` param and, when provided, stamp the flag.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — createOrderDirect WITH products, line below catalog:
 *     catalog: p1 price = 450 (₹4.50, integer paise 45000 under the hood)
 *     line:    p1, qty 10, unitPrice 400 (₹4.00, below catalog)
 *     → discountGiven=true, totalDiscountAmount = (450-400) × 10 = 500 (₹5.00)
 *
 *   CASE B — createOrderDirect WITH products, line AT catalog (no discount):
 *     catalog: p1 price = 450
 *     line:    p1, qty 10, unitPrice 450 (equal)
 *     → discountGiven=false, totalDiscountAmount=0
 *
 *   CASE C — createOrderDirect WITHOUT products (back-compat):
 *     no products param passed (the pre-fix behaviour every route had)
 *     → discountGiven=undefined (NOT stamped — the order still creates, just
 *       without the flag, exactly as before the fix). Proves the fix is
 *       additive: callers that don't pass products get unchanged behaviour.
 *
 *   CASE D — convertQuoteToOrder WITH products stamps the flag on the order:
 *     catalog: p1 price = 450
 *     quote line: p1, qty 5, unitPrice 420 (negotiated below catalog)
 *     → converted order.discountGiven=true,
 *       order.totalDiscountAmount = (450-420) × 5 = 150 (₹1.50)
 *
 *   CASE E — convertQuoteToOrder WITHOUT products (back-compat):
 *     → order.discountGiven=undefined (unchanged behaviour for callers that
 *       don't pass the catalog).
 *
 * Run: npm run golden:discount-flag-wiring
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createOrderDirect, convertQuoteToOrder } from "@/services/OrderService";
import type { OrderLineItem, ProductSetting, Quote } from "@/lib/types";

const WS = "ws_discount_test";
const LEAD = "lead_discount_test";

function product(p: Partial<ProductSetting> & { id: string }): ProductSetting {
  return { id: p.id, name: p.name || "Test Product", price: p.price, priceUnit: p.priceUnit || "per metre" };
}
function line(li: Partial<OrderLineItem> & { id: string; productId: string; quantity: number; unitPrice: number }): OrderLineItem {
  const lineTotal = li.lineTotal ?? li.quantity * li.unitPrice;
  return { id: li.id, productId: li.productId, productName: li.productName || "Test Product", quantity: li.quantity, unit: li.unit || "metre", unitPrice: li.unitPrice, lineTotal, currencyCode: li.currencyCode || "INR" };
}

const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

// CASE A — createOrderDirect WITH products, line below catalog → flagged.
test("CASE A — createOrderDirect: line below catalog stamps discountGiven + totalDiscountAmount", async () => {
  const order = await createOrderDirect({
    workspaceId: WS,
    leadId: LEAD,
    lineItems: [line({ id: "li1", productId: "p1", quantity: 10, unitPrice: 400 })],
    currencyCode: "INR",
    // The fix: pass the workspace catalog.
    products: [product({ id: "p1", price: 450 })],
  });
  if (order.discountGiven !== true) throw new Error(`CASE A: expected discountGiven=true, got ${order.discountGiven}`);
  // Hand-computed: (450 - 400) × 10 = 500.
  if (order.totalDiscountAmount !== 500) throw new Error(`CASE A: expected totalDiscountAmount=500, got ${order.totalDiscountAmount}`);
  console.log(`  CASE A OK: discountGiven=true, totalDiscountAmount=500 ((450-400)×10).`);
});

// CASE B — createOrderDirect WITH products, line AT catalog → NOT flagged.
test("CASE B — createOrderDirect: line at catalog price → no discount flag", async () => {
  const order = await createOrderDirect({
    workspaceId: WS,
    leadId: LEAD,
    lineItems: [line({ id: "li1", productId: "p1", quantity: 10, unitPrice: 450 })],
    currencyCode: "INR",
    products: [product({ id: "p1", price: 450 })],
  });
  if (order.discountGiven === true) throw new Error(`CASE B: expected discountGiven to NOT be true (price equals catalog), got ${order.discountGiven}`);
  if ((order.totalDiscountAmount ?? 0) !== 0) throw new Error(`CASE B: expected totalDiscountAmount=0, got ${order.totalDiscountAmount}`);
  console.log(`  CASE B OK: at-catalog price → no flag.`);
});

// CASE C — createOrderDirect WITHOUT products (back-compat) → flag undefined.
test("CASE C — createOrderDirect: no products param → discountGiven stays undefined (back-compat)", async () => {
  const order = await createOrderDirect({
    workspaceId: WS,
    leadId: LEAD,
    lineItems: [line({ id: "li1", productId: "p1", quantity: 10, unitPrice: 400 })],
    currencyCode: "INR",
    // No products — the pre-fix behavior every route had.
  });
  if (order.discountGiven !== undefined) throw new Error(`CASE C: expected discountGiven=undefined (no products passed = back-compat), got ${order.discountGiven}`);
  console.log(`  CASE C OK: no products → flag undefined (back-compat preserved).`);
});

// CASE D — convertQuoteToOrder WITH products stamps the flag on the order.
test("CASE D — convertQuoteToOrder: negotiated-below-catalog line → order flagged", async () => {
  const quote: Quote = {
    id: "q1",
    workspaceId: WS,
    leadId: LEAD,
    quoteNumber: 1,
    status: "sent",
    lineItems: [line({ id: "qli1", productId: "p1", productName: "Zari", quantity: 5, unitPrice: 420 })],
    grandTotal: 420 * 5,
    currencyCode: "INR",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };
  const { order } = await convertQuoteToOrder(quote, { products: [product({ id: "p1", price: 450 })] });
  if (order.discountGiven !== true) throw new Error(`CASE D: expected converted order.discountGiven=true, got ${order.discountGiven}`);
  // Hand-computed: (450 - 420) × 5 = 150.
  if (order.totalDiscountAmount !== 150) throw new Error(`CASE D: expected totalDiscountAmount=150, got ${order.totalDiscountAmount}`);
  console.log(`  CASE D OK: converted order flagged, totalDiscountAmount=150 ((450-420)×5).`);
});

// CASE E — convertQuoteToOrder WITHOUT products (back-compat) → flag undefined.
test("CASE E — convertQuoteToOrder: no products param → flag undefined (back-compat)", async () => {
  const quote: Quote = {
    id: "q2",
    workspaceId: WS,
    leadId: LEAD,
    quoteNumber: 2,
    status: "sent",
    lineItems: [line({ id: "qli2", productId: "p1", productName: "Zari", quantity: 5, unitPrice: 420 })],
    grandTotal: 420 * 5,
    currencyCode: "INR",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  };
  const { order } = await convertQuoteToOrder(quote); // no options
  if (order.discountGiven !== undefined) throw new Error(`CASE E: expected discountGiven=undefined (no products passed = back-compat), got ${order.discountGiven}`);
  console.log(`  CASE E OK: no products → flag undefined (back-compat preserved).`);
});

async function main() {
  console.log("=== golden: discount-flag-wiring (F-LOGIC-2) ===");
  let failed = 0;
  for (const c of cases) {
    try { await c.fn(); }
    catch (e) {
      failed++;
      console.error(`❌ ${c.name} FAILED: ${(e as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`\n=== ${failed} case(s) FAILED ===`);
    process.exit(1);
  }
  console.log(`\n=== ${cases.length} cases passed — F-LOGIC-2 wiring proven (discount flag stamps on real order creation + conversion). ===`);
}

void main();
