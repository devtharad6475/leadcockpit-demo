/**
 * Golden test — Order cancel, conversation link, discount flag, quote
 * conversion fix (Stage 3 — Batch 2 of session 8).
 *
 * Phase 1.5 / skill v2 — written BEFORE the service code.
 *
 * Operator-confirmed rules (docs/LOGIC.md, 2026-07-21):
 *   - Order has optional sourceReplyId + sourceInteractionId (pointers to
 *     the WhatsApp/email conversation that originated it).
 *   - Discounts: unitPrice < base price (same currency) → flag the order
 *     discountGiven=true + discountAmount per line. Higher price is not a
 *     discount, not flagged.
 *   - Quote→Order conversion now returns BOTH the order AND the updated
 *     quote (status="converted", orderId set). Double-convert throws.
 *   - Reorder uses last-order prices BUT checks against current
 *     ProductSetting price → flags priceChangedSinceLastOrder.
 *   - Order cancel:
 *       * nothing shipped (draft/confirmed/in_progress) → status="cancelled".
 *       * partial_shipped → status="partial_cancelled"; shipped portion kept.
 *       * shipped/delivered → THROW (must use return flow).
 *
 * Hand-computed expected values:
 *
 *   CASE A — Order has sourceReplyId pointer; round-trips through repository.
 *
 *   CASE B — Discount: line with unitPrice=400, base price=450 →
 *     discountGiven=true, discountAmount=50.
 *
 *   CASE C — No discount: line with unitPrice=500, base price=450 →
 *     discountGiven=false (markup, not flagged).
 *
 *   CASE D — Discount on multi-line order: 2 lines, one discount, one
 *     markup → order discountGiven=true (any discount line flags order),
 *     total discount amount = 50.
 *
 *   CASE E — Quote conversion: convert sent quote → returns {order, quote}.
 *     quote.status="converted", quote.orderId=order.id.
 *
 *   CASE F — Double-convert: try to convert a "converted" quote → throws.
 *
 *   CASE G — Reorder with price change: lastOrder @ 450, current product
 *     price=480 → reorder draft unitPrice=450 (continuity) +
 *     priceChangedSinceLastOrder=true + currentPriceSnapshot=480.
 *
 *   CASE H — Reorder no price change: lastOrder @ 450, current=450 →
 *     priceChangedSinceLastOrder=false.
 *
 *   CASE I — Cancel from confirmed (nothing shipped) → status="cancelled",
 *     cancelledAt set.
 *
 *   CASE J — Cancel from partial_shipped → status="partial_cancelled",
 *     cancelledAt set. Already-shipped line items kept.
 *
 *   CASE K — Cancel from delivered → THROWS.
 *
 * Run: npx tsx scripts/golden/golden-order-cancel.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import {
  createOrderDirect,
  convertQuoteToOrder,
  createReorderDraft,
  cancelOrder,
  computeDiscountFlag,
  type ConvertQuoteResult,
} from "@/services/OrderService";
import { createRepositories, type RepositoryBundle } from "@/repositories";
import type { Order, OrderLineItem, ProductSetting, Quote } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// SESSION 7 (2026-07-28) — Test-isolation fix (build-right Ironclad Gate #8).
// Previously this golden used a fixed workspace ("ws_test") + fixed IDs ("q1",
// "o_confirmed", "lead1") against the shared demo JSON file with NO cleanup.
// Re-running accumulated rows and made CASE F (double-convert) depend on prior
// runs' state — a flaky/order-dependent test. Now every run uses a unique
// RUN_ID-prefixed workspace + IDs, and cleans up its own rows on success.
const RUN_ID = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS = `ws_golden_ordercancel_${RUN_ID}`;
const LEAD = `lead_golden_ordercancel_${RUN_ID}`;
const repos: RepositoryBundle = createRepositories("json");

async function cleanup() {
  // Best-effort: every order + quote we created shares the run-unique LEAD id,
  // so deleteByLead(WS, LEAD) sweeps them in one call. Never mask a real failure.
  try {
    await repos.order.deleteByLead(WS, LEAD);
  } catch { /* best effort */ }
  try {
    await repos.quote.deleteByLead(WS, LEAD);
  } catch { /* best effort */ }
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
  if (overrides.quantity !== undefined || overrides.unitPrice !== undefined) {
    base.lineTotal = base.quantity * base.unitPrice;
  }
  return base;
};

const product = (overrides: Partial<ProductSetting>): ProductSetting => ({
  id: "p1",
  name: "Test Product",
  price: 450,
  priceUnit: "per kg",
  ...overrides,
});

async function main() {
  // === CASE A — Order has sourceReplyId pointer ===
  const orderWithLink = await createOrderDirect({
    workspaceId: WS,
    leadId: LEAD,
    lineItems: [line({ id: "li1", quantity: 10, unitPrice: 450 })],
    currencyCode: "INR",
    sourceReplyId: "reply_abc",
    sourceInteractionId: "interaction_xyz",
  });
  assert(orderWithLink.sourceReplyId === "reply_abc", `CASE A: sourceReplyId should be set`);
  assert(orderWithLink.sourceInteractionId === "interaction_xyz", `CASE A: sourceInteractionId should be set`);
  console.log(`  CASE A OK: order has conversation link (reply + interaction).`);

  // === CASE B — Discount: lower price → flagged ===
  const discounted = computeDiscountFlag({
    lineItems: [line({ id: "li1", productId: "p1", unitPrice: 400, lineTotal: 400 })],
    products: [product({ id: "p1", price: 450 })],
  });
  assert(discounted.discountGiven === true, `CASE B: discount should be flagged true`);
  assert(discounted.lineDiscounts[0].discountAmount === 50, `CASE B: discountAmount should be 50, got ${discounted.lineDiscounts[0].discountAmount}`);
  console.log(`  CASE B OK: discount detected (₹50).`);

  // === CASE C — No discount: higher price → not flagged ===
  const markup = computeDiscountFlag({
    lineItems: [line({ id: "li1", productId: "p1", unitPrice: 500, lineTotal: 500 })],
    products: [product({ id: "p1", price: 450 })],
  });
  assert(markup.discountGiven === false, `CASE C: higher price should NOT flag discount`);
  console.log(`  CASE C OK: markup not flagged.`);

  // === CASE D — Multi-line: 1 discount + 1 markup → order flagged, total = 50 ===
  const multi = computeDiscountFlag({
    lineItems: [
      line({ id: "li1", productId: "p1", quantity: 1, unitPrice: 400, lineTotal: 400 }),
      line({ id: "li2", productId: "p2", quantity: 1, unitPrice: 500, lineTotal: 500 }),
    ],
    products: [
      product({ id: "p1", price: 450 }),
      product({ id: "p2", price: 450 }),
    ],
  });
  assert(multi.discountGiven === true, `CASE D: order with any discount line flagged`);
  assert(multi.totalDiscountAmount === 50, `CASE D: total discount = 50, got ${multi.totalDiscountAmount}`);
  console.log(`  CASE D OK: multi-line discount detected (₹50 total).`);

  // === CASE L (2026-07-26 Session 4 audit, P2-MONEY-1) — Float-precision
  // boundary. The audit found computeDiscountFlag used raw float `<` for the
  // boundary check: `unitPrice < base`. A float artifact like 449.99999 (which
  // could arise from currency conversion or a percentage discount calc) would
  // pass `449.99999 < 450` as TRUE → falsely flag a non-discounted line.
  //
  // Hand-computed: 449.99999 rupees rounds to 449.99999 × 100 = 44999.999
  // paise → 44999 paise (truncate) OR 45000 paise (round-half-up). Either way,
  // 44999 ≠ 45000 in integer-paise math, so it IS a 1-paise discount. The fix
  // uses compareMoney which converts to integer paise first. The exact boundary
  // we want to pin is the EXACT-equal case: unitPrice=450.00, base=450.00 →
  // equal in paise (45000 = 45000) → NOT a discount. Pre-fix: `450 < 450` was
  // already false (no bug for the EXACT case). The drift case is unitPrice just
  // BARELY below base due to float: 449.9999999 in JS = exactly 450 in float
  // storage. Let's verify compareMoney treats them as equal.
  //
  // Hand-computed:
  //   unitPrice = 449.9999999  → rupeesToPaise → 44999.99999 → round → 45000 paise
  //   base      = 450.00       → rupeesToPaise → 45000       → 45000 paise
  //   compareMoney returns 0 (equal). discountGiven must be FALSE.
  const driftEqual = computeDiscountFlag({
    lineItems: [line({ id: "li1", productId: "p1", unitPrice: 449.9999999, lineTotal: 449.9999999 })],
    products: [product({ id: "p1", price: 450 })],
  });
  assert(driftEqual.discountGiven === false, `CASE L: float-drift 449.9999999 vs 450 must compare equal in paise → no discount flag, got discountGiven=${driftEqual.discountGiven}`);
  console.log(`  CASE L OK: float-precision drift handled (449.9999999 ≈ 450 in paise → not flagged).`);

  // === CASE M (same audit) — Real 1-paise discount: 449.99 vs 450.00.
  //   449.99 → 44999 paise; 450 → 45000 paise; difference 1 paise → IS a discount.
  //   Pre-fix this case worked (449.99 < 450 in float). Post-fix must still work.
  const realDiscount = computeDiscountFlag({
    lineItems: [line({ id: "li1", productId: "p1", unitPrice: 449.99, lineTotal: 449.99 })],
    products: [product({ id: "p1", price: 450 })],
  });
  assert(realDiscount.discountGiven === true, `CASE M: real 1-paise discount (449.99 vs 450) must be flagged, got discountGiven=${realDiscount.discountGiven}`);
  console.log(`  CASE M OK: real 1-paise discount detected.`);

  // === CASE E — Quote conversion: returns {order, quote} ===
  const quote: Quote = {
    id: `q_${RUN_ID}`,
    workspaceId: WS,
    quoteNumber: 1,
    leadId: LEAD,
    status: "sent",
    lineItems: [line({ id: "qli1", quantity: 10, unitPrice: 10, lineTotal: 100 })],
    grandTotal: 100,
    currencyCode: "INR",
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
  };
  const result: ConvertQuoteResult = await convertQuoteToOrder(quote);
  assert(result.order.origin === "from_quote", `CASE E: order origin from_quote`);
  assert(result.order.quoteId === `q_${RUN_ID}`, `CASE E: order references quote`);
  assert(result.quote.status === "converted", `CASE E: quote status now "converted", got ${result.quote.status}`);
  assert(result.quote.orderId === result.order.id, `CASE E: quote.orderId matches order.id`);
  console.log(`  CASE E OK: conversion returns {order, quote.converted}.`);

  // === CASE F — Double-convert throws ===
  let doubleThrew = false;
  try {
    await convertQuoteToOrder(result.quote);
  } catch {
    doubleThrew = true;
  }
  assert(doubleThrew, `CASE F: converting an already-converted quote should throw`);
  console.log(`  CASE F OK: double-convert throws.`);

  // === CASE G — Reorder with price change ===
  const lastOrder = await createOrderDirect({
    workspaceId: WS,
    leadId: LEAD,
    lineItems: [line({ id: "li_last", productId: "p1", productName: "Zari", quantity: 10, unitPrice: 450, lineTotal: 4500 })],
    currencyCode: "INR",
  });
  const reorderChanged = await createReorderDraft(lastOrder, {
    products: [product({ id: "p1", price: 480 })],
  });
  assert(reorderChanged.lineItems[0].unitPrice === 450, `CASE G: reorder keeps last price (450), got ${reorderChanged.lineItems[0].unitPrice}`);
  assert(reorderChanged.lineItems[0].priceChangedSinceLastOrder === true, `CASE G: price-changed flag should be true`);
  assert(reorderChanged.lineItems[0].currentPriceSnapshot === 480, `CASE G: snapshot should be 480`);
  console.log(`  CASE G OK: reorder keeps old price + flags change.`);

  // === CASE H — Reorder no price change ===
  const reorderSame = await createReorderDraft(lastOrder, {
    products: [product({ id: "p1", price: 450 })],
  });
  assert(reorderSame.lineItems[0].priceChangedSinceLastOrder === false, `CASE H: no-change flag should be false`);
  assert(reorderSame.lineItems[0].currentPriceSnapshot === undefined, `CASE H: snapshot should be undefined when no change`);
  console.log(`  CASE H OK: reorder with same price → no flag.`);

  // === CASE I — Cancel from confirmed (nothing shipped) ===
  const confirmed: Order = {
    ...lastOrder,
    id: "o_confirmed",
    status: "confirmed",
    confirmedAt: "2026-07-21T10:00:00Z",
  };
  const cancelled = await cancelOrder(confirmed, { actor: "owner_1", reason: "customer changed mind" });
  assert(cancelled.status === "cancelled", `CASE I: status should be "cancelled", got ${cancelled.status}`);
  assert(cancelled.cancelledAt !== undefined, `CASE I: cancelledAt should be set`);
  console.log(`  CASE I OK: full cancel from confirmed.`);

  // === CASE J — Cancel from partial_shipped ===
  // 2026-07-21 (Cluster C fix, session 19): partial cancel now REQUIRES
  // cancelQuantitiesByLine and REDUCES grandTotal to the surviving portion.
  // Previously this case omitted the arg and grandTotal was unchanged (bug).
  // See golden:partial-cancel-math for the full math pin.
  const partial: Order = {
    ...lastOrder,
    id: "o_partial",
    status: "partial_shipped",
    // 2026-09-27 (M3): createOrderDirect now gives every line a server id and
    // ignores the client's "li_last", so this fixture names its line itself.
    lineItems: lastOrder.lineItems.map((li) => ({ ...li, id: "li_last" })),
    shippedAt: "2026-07-21T10:00:00Z",
    shippedQuantityByLine: { li_last: 6 }, // 6 of 10 kg shipped
  };
  const unitPrice = partial.lineItems.find((li) => li.id === "li_last")?.unitPrice || 0;
  const partialCancelled = await cancelOrder(partial, {
    actor: "owner_1",
    reason: "customer cancelled rest",
    cancelQuantitiesByLine: { li_last: 4 },
  });
  assert(partialCancelled.status === "partial_cancelled", `CASE J: status should be "partial_cancelled", got ${partialCancelled.status}`);
  assert(partialCancelled.cancelledAt !== undefined, `CASE J: cancelledAt set`);
  assert((partialCancelled.shippedQuantityByLine as Record<string, number>).li_last === 6, `CASE J: shipped portion preserved`);
  assert((partialCancelled.cancelledQuantityByLine as Record<string, number>).li_last === 4, `CASE J: 4 cancelled recorded`);
  assert(partialCancelled.grandTotal === 6 * unitPrice, `CASE J: grandTotal reduced to 6 × ${unitPrice} = ${6 * unitPrice}, got ${partialCancelled.grandTotal}`);
  console.log(`  CASE J OK: partial cancel from partial_shipped; grandTotal reduced to ${partialCancelled.grandTotal}.`);

  // === CASE K — Cancel from delivered THROWS ===
  const delivered: Order = {
    ...lastOrder,
    id: "o_delivered",
    status: "delivered",
    deliveredAt: "2026-07-21T10:00:00Z",
  };
  let deliveredCancelThrew = false;
  try {
    await cancelOrder(delivered, { actor: "owner_1" });
  } catch {
    deliveredCancelThrew = true;
  }
  assert(deliveredCancelThrew, `CASE K: cancelling a delivered order should throw`);
  console.log(`  CASE K OK: cancel from delivered throws.`);

  console.log("PASS golden-order-cancel: all 11 cases match operator-confirmed rules.");
  await cleanup();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await cleanup();
  process.exit(1);
});
