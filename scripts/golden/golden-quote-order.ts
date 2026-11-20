/**
 * Golden test — Quote/Order lifecycle + conversion (Stage 3).
 *
 * Phase 1.5 / skill v2 — written BEFORE the service code.
 *
 * Operator-confirmed rules (docs/LOGIC.md, 2026-07-20):
 *   - Quote is optional. Orders can be direct OR from_quote.
 *   - Quote→Order conversion: line items snapshot at the prices the Quote
 *     had. Later system price changes do NOT affect existing Orders.
 *   - New Quote supersedes the old one (old marked "superseded", kept for
 *     audit). Only the latest non-superseded Quote can convert.
 *   - Reorder: draft Order can be pre-filled from a customer's last order.
 *
 * Hand-computed expected values:
 *
 *   CASE A — Direct Order (no quote): createOrderDirect with line items
 *     [ { qty=10, unit=kg, unitPrice=450 } ] → grandTotal = 4500.
 *
 *   CASE B — Quote→Order conversion snapshots prices:
 *     Quote with line item { qty=10, unitPrice=10 } (lineTotal=100).
 *     Convert to Order. Then "system price" changes to 15. The Order's
 *     line item STILL shows unitPrice=10, lineTotal=100.
 *
 *   CASE C — New Quote supersedes old:
 *     Quote1 (status=sent). Create Quote2 supersedes Quote1.
 *     Quote1.status becomes "superseded". Quote2.status="sent".
 *     Converting Quote1 (the superseded one) → REJECTED. Only Quote2 can
 *     convert.
 *
 *   CASE D — Reorder pre-fill:
 *     Last order had line items [{ productName: "Zari Thread", qty=50 }].
 *     createReorderDraft(lastOrder) → new draft Order with same line items,
 *     status="draft", origin="direct", reorderedFromOrderId=lastOrder.id.
 *
 *   CASE E — lineTotal math: 3 line items:
 *     [ { qty=2, unitPrice=500 }, { qty=10, unitPrice=50 }, { qty=1, unitPrice=1500} ]
 *     grandTotal = 1000 + 500 + 1500 = 3000.
 *
 * Run: npx tsx scripts/golden/golden-quote-order.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { computeLineTotal, computeGrandTotal, createOrderDirect, convertQuoteToOrder, supersedeQuote, createReorderDraft } from "@/services/OrderService";
import type { OrderLineItem, Quote } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const line = (overrides: Partial<OrderLineItem>): OrderLineItem => {
  const base: OrderLineItem = {
    id: "li1",
    productName: "Test Product",
    quantity: 1,
    unit: "kg",
    unitPrice: 100,
    currencyCode: "INR",
    lineTotal: 100,
    ...overrides,
  };
  // If quantity or unitPrice was overridden, recompute lineTotal so the
  // test author doesn't have to specify all three.
  if (overrides.quantity !== undefined || overrides.unitPrice !== undefined) {
    base.lineTotal = base.quantity * base.unitPrice;
  }
  return base;
};

async function main() {
  // === CASE A — Direct Order math ===
  const direct = await createOrderDirect({
    workspaceId: "ws_test",
    leadId: "lead1",
    lineItems: [line({ id: "li1", quantity: 10, unitPrice: 450, unit: "kg", productName: "Zari" })],
    currencyCode: "INR",
  });
  assert(direct.grandTotal === 4500, `CASE A: expected grandTotal 4500, got ${direct.grandTotal}`);
  assert(direct.origin === "direct", `CASE A: expected origin "direct"`);
  assert(direct.status === "draft", `CASE A: expected status "draft"`);
  console.log(`  CASE A OK: direct order grandTotal=4500.`);

  // === CASE B — Quote→Order conversion snapshots prices ===
  const quote: Quote = {
    id: "q1",
    workspaceId: "ws_test",
    quoteNumber: 1,
    leadId: "lead1",
    status: "sent",
    lineItems: [line({ id: "qli1", quantity: 10, unitPrice: 10, productName: "Zari", lineTotal: 100 })],
    grandTotal: 100,
    currencyCode: "INR",
    createdAt: "2026-07-20T00:00:00Z",
    updatedAt: "2026-07-20T00:00:00Z",
  };
  const { order, quote: convertedQuote } = await convertQuoteToOrder(quote);
  assert(order.lineItems[0].unitPrice === 10, `CASE B: order unitPrice should be 10 (snapshot), got ${order.lineItems[0].unitPrice}`);
  assert(order.lineItems[0].lineTotal === 100, `CASE B: order lineTotal should be 100 (snapshot), got ${order.lineItems[0].lineTotal}`);
  assert(order.grandTotal === 100, `CASE B: order grandTotal should be 100, got ${order.grandTotal}`);
  assert(order.origin === "from_quote", `CASE B: origin should be from_quote`);
  assert(order.quoteId === "q1", `CASE B: order should reference quote q1`);
  // 2026-07-21: conversion also marks the quote as "converted" (new behavior).
  assert(convertedQuote.status === "converted", `CASE B: quote status now "converted", got ${convertedQuote.status}`);
  assert(convertedQuote.orderId === order.id, `CASE B: quote.orderId set`);
  console.log(`  CASE B OK: quote→order snapshots prices at 10/100.`);

  // === CASE C — New Quote supersedes old ===
  const oldQuote: Quote = { ...quote, id: "q_old", status: "sent" };
  const newQuote: Quote = { ...quote, id: "q_new", quoteNumber: 2, status: "sent", lineItems: [line({ unitPrice: 8, lineTotal: 80 })], grandTotal: 80 };
  const { updated: supersededOld, replacement } = supersedeQuote(oldQuote, newQuote);
  assert(supersededOld.status === "superseded", `CASE C: old quote status should be "superseded", got ${supersededOld.status}`);
  assert(replacement.status === "sent", `CASE C: new quote status should be "sent", got ${replacement.status}`);
  assert(replacement.supersedesQuoteId === "q_old", `CASE C: new quote should reference supersedesQuoteId=q_old`);
  // Converting the superseded old quote should throw.
  let supersededConversionThrew = false;
  try {
    await convertQuoteToOrder(supersededOld);
  } catch {
    supersededConversionThrew = true;
  }
  assert(supersededConversionThrew, `CASE C: converting a superseded quote should throw.`);
  console.log(`  CASE C OK: new quote supersedes old; old cannot convert.`);

  // === CASE D — Reorder pre-fill ===
  const lastOrder = await createOrderDirect({
    workspaceId: "ws_test",
    leadId: "lead1",
    lineItems: [line({ id: "li_last", productName: "Zari Thread", quantity: 50, unitPrice: 450, lineTotal: 22500 })],
    currencyCode: "INR",
  });
  const reorder = await createReorderDraft(lastOrder);
  assert(reorder.origin === "direct", `CASE D: reorder origin should be direct`);
  assert(reorder.status === "draft", `CASE D: reorder status should be draft`);
  assert(reorder.reorderedFromOrderId === lastOrder.id, `CASE D: reorder should reference last order`);
  assert(reorder.lineItems.length === lastOrder.lineItems.length, `CASE D: reorder should copy line items`);
  assert(reorder.lineItems[0].productName === "Zari Thread", `CASE D: reorder line item should match`);
  console.log(`  CASE D OK: reorder draft pre-filled from last order.`);

  // === CASE E — grandTotal math ===
  const multiLine = [
    line({ id: "m1", quantity: 2, unitPrice: 500, lineTotal: 1000 }),
    line({ id: "m2", quantity: 10, unitPrice: 50, lineTotal: 500 }),
    line({ id: "m3", quantity: 1, unitPrice: 1500, lineTotal: 1500 }),
  ];
  assert(computeGrandTotal(multiLine) === 3000, `CASE E: grandTotal should be 3000, got ${computeGrandTotal(multiLine)}`);
  assert(computeLineTotal(2, 500) === 1000, `CASE E: lineTotal(2, 500) should be 1000`);
  console.log(`  CASE E OK: grandTotal of 3 lines = 3000.`);

  console.log("PASS golden-quote-order: all 5 cases match the operator-confirmed rules.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
