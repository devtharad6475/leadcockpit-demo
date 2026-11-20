/**
 * Golden test — Partial-cancel money math (Cluster C fix, session 19).
 *
 * PROVES that partially cancelling an order (1) reduces grandTotal to only
 * the surviving items, and (2) records exactly which items + quantities were
 * cancelled. Operator-confirmed rule (2026-07-21):
 *   "Reduce total — Total drops to the remaining items. The system ALSO
 *    remembers '4 items were cancelled' so you have a full record."
 *
 * Without this test, the partial-cancel bug (P1 finding D8 from
 * AUDIT-FINDINGS-2026-07-21.md) returns silently: an order keeps its
 * original grandTotal forever, over-stating committed revenue.
 *
 * Hand-computed expected values (BEFORE looking at the cancelOrder code):
 *
 *   CASE A — Full cancel (nothing shipped): 10 × ₹100 = ₹1000 → cancelled.
 *     grandTotal UNCHANGED at 1000 (the order is dead; its total is
 *     informational). cancelledQuantityByLine records all 10.
 *
 *   CASE B — Partial cancel from partial_shipped (the operator's example):
 *     Order: 10 items × ₹100 each = ₹1000 total. 4 of those items are
 *     cancelled (the other 6 already shipped). New grandTotal = 600.
 *     cancelledQuantityByLine = { li_1: 4 }. Status = "partial_cancelled".
 *
 *   CASE C — Multi-line partial cancel:
 *     Order has 2 lines: lineX (5 × ₹50 = 250), lineY (3 × ₹100 = 300).
 *     grandTotal = 550. Cancel 2 of lineY. New grandTotal = 250 + 100 = 350.
 *     cancelledQuantityByLine = { lineY_id: 2 }. Surviving lineY qty = 1.
 *
 *   CASE D — Cancel from delivered/shipped throws (no math change).
 *
 *   CASE E — Empty cancel input on partial_shipped throws (caller must
 *     specify what's being cancelled, otherwise we can't compute the new
 *     total).
 *
 * Run: npx tsx scripts/golden/golden-partial-cancel-math.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { cancelOrder } from "@/services/OrderService";
import type { Order, OrderLineItem } from "@/lib/types";

function makeLine(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  return {
    id: overrides.id || "li_1",
    productId: overrides.productId || "p_1",
    productName: overrides.productName || "Widget",
    quantity: overrides.quantity ?? 1,
    unitPrice: overrides.unitPrice ?? 100,
    lineTotal: overrides.lineTotal ?? (overrides.quantity ?? 1) * (overrides.unitPrice ?? 100),
    ...overrides,
  } as OrderLineItem;
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order_1",
    workspaceId: "ws_test",
    orderNumber: 1,
    leadId: "lead_1",
    status: "confirmed",
    lineItems: [makeLine({ id: "li_1", quantity: 10, unitPrice: 100, lineTotal: 1000 })],
    grandTotal: 1000,
    currencyCode: "INR",
    origin: "direct",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as Order;
}

async function main() {
  // ---------------------------------------------------------------------------
  // CASE A — Full cancel: grandTotal unchanged, all quantities in cancelledByLine.
  // ---------------------------------------------------------------------------
  {
    const order = makeOrder({ status: "confirmed" });
    const result = await cancelOrder(order, { actor: "owner_1", reason: "Customer changed mind" });
    assert.equal(result.status, "cancelled", "CASE A: full cancel");
    assert.equal(result.grandTotal, 1000, "CASE A: grandTotal unchanged on full cancel");
    assert.equal(result.cancelledBy, "owner_1", "CASE A: cancelledBy recorded");
    // Full cancel records the cancelled quantities for audit.
    assert.equal(result.cancelledQuantityByLine?.li_1, 10, "CASE A: all 10 recorded as cancelled");
    console.log("  CASE A OK: full cancel preserves grandTotal + records all cancelled qty.");
  }

  // ---------------------------------------------------------------------------
  // CASE B — Partial cancel: grandTotal reduced, partial quantities recorded.
  // ---------------------------------------------------------------------------
  {
    const order = makeOrder({
      status: "partial_shipped",
      shippedQuantityByLine: { li_1: 6 },
    });
    // Customer cancels the 4 unshipped items.
    const result = await cancelOrder(order, {
      actor: "owner_1",
      reason: "Customer cut order size",
      cancelQuantitiesByLine: { li_1: 4 },
    });
    assert.equal(result.status, "partial_cancelled", "CASE B: status");
    // Surviving = original 10 - shipped 6 - cancelled 4 = 0. grandTotal = 0.
    // Wait — re-read: 10 ordered, 6 shipped, 4 cancelled. Surviving (still
    // to ship) = 0. But the customer IS still taking the 6 shipped. So
    // grandTotal should be 6 × 100 = 600 (the shipped portion they keep).
    assert.equal(result.grandTotal, 600, `CASE B: grandTotal must drop to 600 (shipped portion only), got ${result.grandTotal}`);
    assert.equal(result.cancelledQuantityByLine?.li_1, 4, "CASE B: 4 items recorded as cancelled");
    console.log("  CASE B OK: partial cancel reduces grandTotal to 600 + records 4 cancelled.");
  }

  // ---------------------------------------------------------------------------
  // CASE C — Multi-line partial cancel.
  // ---------------------------------------------------------------------------
  {
    const lineX = makeLine({ id: "li_X", quantity: 5, unitPrice: 50, lineTotal: 250, productId: "p_X", productName: "Thread" });
    const lineY = makeLine({ id: "li_Y", quantity: 3, unitPrice: 100, lineTotal: 300, productId: "p_Y", productName: "Border" });
    const order = makeOrder({
      status: "confirmed",
      lineItems: [lineX, lineY],
      grandTotal: 550,
    });
    // Cancel 2 of lineY (3 → 1 surviving).
    const result = await cancelOrder(order, {
      actor: "owner_1",
      reason: "Customer cut border quantity",
      cancelQuantitiesByLine: { li_Y: 2 },
    });
    assert.equal(result.status, "partial_cancelled", "CASE C: status");
    // New total = lineX (250) + lineY surviving (1 × 100 = 100) = 350.
    assert.equal(result.grandTotal, 350, `CASE C: grandTotal must drop to 350, got ${result.grandTotal}`);
    assert.equal(result.cancelledQuantityByLine?.li_Y, 2, "CASE C: 2 of lineY recorded as cancelled");
    assert.equal(result.cancelledQuantityByLine?.li_X, undefined, "CASE C: lineX untouched");
    console.log("  CASE C OK: multi-line partial cancel → grandTotal 550 → 350.");
  }

  // ---------------------------------------------------------------------------
  // CASE D — Cancel from delivered/shipped throws.
  // ---------------------------------------------------------------------------
  {
    const shipped = makeOrder({ status: "shipped" });
    let threw = false;
    try {
      await cancelOrder(shipped, { actor: "owner_1" });
    } catch (err) {
      threw = true;
      assert.ok(/cannot be cancelled/i.test(err instanceof Error ? err.message : String(err)), "CASE D: error must mention cannot be cancelled");
    }
    assert.ok(threw, "CASE D: shipped cancel must throw");

    const delivered = makeOrder({ status: "delivered" });
    threw = false;
    try {
      await cancelOrder(delivered, { actor: "owner_1" });
    } catch (err) {
      threw = true;
      assert.ok(/cannot be cancelled/i.test(err instanceof Error ? err.message : String(err)), "CASE D: delivered error");
    }
    assert.ok(threw, "CASE D: delivered cancel must throw");
    console.log("  CASE D OK: shipped + delivered cancel both throw (use return flow).");
  }

  // ---------------------------------------------------------------------------
  // CASE E — Partial_shipped without specifying what's cancelled throws.
  // ---------------------------------------------------------------------------
  {
    const order = makeOrder({
      status: "partial_shipped",
      shippedQuantityByLine: { li_1: 6 },
    });
    let threw = false;
    try {
      await cancelOrder(order, { actor: "owner_1" });
    } catch (err) {
      threw = true;
      assert.ok(/cancel|specify/i.test(err instanceof Error ? err.message : String(err)), "CASE E: error must tell caller to specify");
    }
    assert.ok(threw, "CASE E: partial_shipped without cancelQuantities must throw");
    console.log("  CASE E OK: partial_shipped cancel without specifying what's cancelled throws.");
  }

  // ---------------------------------------------------------------------------
  // 2026-07-26 Session 4 audit (P2-PARTIALCANCEL-1) — 3 audit-trail integrity
  // cases. The audit found that `cancelOrder` blindly copies whatever the
  // caller passes into `cancelledQuantityByLine` with NO validation, so:
  //   - over-cancel records an IMPOSSIBLE quantity in the audit trail
  //   - a typo line id (e.g. "li_TYPO") is persisted forever as audit fact
  //   - qty=0 marks the order partial_cancelled despite nothing changing
  // All 3 must now THROW (after the fix). These cases were written BEFORE the
  // fix and confirmed FAIL-first against the un-validated code.
  //
  //   CASE F — over-cancel: caller passes qty=50 on a line with only 4
  //     unshipped units. Must throw "exceeds cancellable quantity."
  //
  //   CASE G — typo line id: caller passes { li_TYPO: 4 } for a line id that
  //     doesn't exist on the order. Must throw "unknown line id."
  //
  //   CASE H — qty=0: caller passes { li_1: 0 }. Must throw "must be > 0"
  //     (zero-cancel is a no-op; recording it as a partial_cancel is a lie).
  // ---------------------------------------------------------------------------
  {
    const order = makeOrder({
      status: "partial_shipped",
      shippedQuantityByLine: { li_1: 6 },
    });
    let threw = false;
    try {
      await cancelOrder(order, {
        actor: "owner_1",
        reason: "should not succeed",
        cancelQuantitiesByLine: { li_1: 50 }, // only 4 unshipped (10 − 6)
      });
    } catch (err) {
      threw = true;
      assert.ok(/exceed|too many|cancellable/i.test(err instanceof Error ? err.message : String(err)), `CASE F: error must mention exceeding cancellable qty, got: ${err instanceof Error ? err.message : err}`);
    }
    assert.ok(threw, "CASE F: over-cancel (qty > unshipped) must throw, not silently record impossible qty");
    console.log("  CASE F OK: over-cancel throws (no impossible qty in audit trail).");
  }

  {
    const order = makeOrder({
      status: "partial_shipped",
      shippedQuantityByLine: { li_1: 6 },
    });
    let threw = false;
    try {
      await cancelOrder(order, {
        actor: "owner_1",
        reason: "should not succeed",
        cancelQuantitiesByLine: { li_TYPO: 4 }, // line id doesn't exist on this order
      });
    } catch (err) {
      threw = true;
      assert.ok(/unknown|not found|invalid line/i.test(err instanceof Error ? err.message : String(err)), `CASE G: error must mention unknown line id, got: ${err instanceof Error ? err.message : err}`);
    }
    assert.ok(threw, "CASE G: typo line id must throw, not silently persist a fake audit entry");
    console.log("  CASE G OK: typo line id throws (no fake audit-trail entry).");
  }

  {
    const order = makeOrder({
      status: "partial_shipped",
      shippedQuantityByLine: { li_1: 6 },
    });
    let threw = false;
    try {
      await cancelOrder(order, {
        actor: "owner_1",
        reason: "should not succeed",
        cancelQuantitiesByLine: { li_1: 0 }, // zero-cancel = no-op, must not flip status
      });
    } catch (err) {
      threw = true;
      assert.ok(/> 0|positive|must be/i.test(err instanceof Error ? err.message : String(err)), `CASE H: error must mention qty must be > 0, got: ${err instanceof Error ? err.message : err}`);
    }
    assert.ok(threw, "CASE H: qty=0 must throw, not silently mark order partial_cancelled");
    console.log("  CASE H OK: qty=0 throws (no false partial_cancelled status).");
  }

  console.log("\nPASS golden-partial-cancel-math: partial-cancel reduces grandTotal + records qty + validates input (8 cases).");
}

main().catch((err) => {
  console.error("\nFAIL golden-partial-cancel-math:", err.message);
  process.exit(1);
});
