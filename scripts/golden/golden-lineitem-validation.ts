/**
 * Golden test — LineItem validation schemas (Cluster C fix B, session 19).
 *
 * PROVES the zod schemas reject the dangerous inputs that previously went
 * straight through to createOrderDirect:
 *   - negative quantity (e.g., -5) → produces negative line totals
 *   - negative unitPrice → produces negative totals
 *   - thousands of line items → DoS / runaway
 *
 * Hand-computed expected values:
 *
 *   CASE A — valid input: 3 lines, all positive qty + nonneg price → passes.
 *
 *   CASE B — negative quantity (-5 × ₹1000) → schema REJECTS.
 *
 *   CASE C — negative unitPrice (5 × -₹1000) → schema REJECTS.
 *
 *   CASE D — zero quantity (0 × ₹100) → REJECTS (must be positive, not just
 *     non-negative; a 0-qty line is meaningless and shouldn't reach the DB).
 *
 *   CASE E — zero unitPrice (5 × ₹0) → ACCEPTS (free samples are legitimate).
 *
 *   CASE F — 201 line items → REJECTS (over MAX_ORDER_LINE_ITEMS = 200 cap).
 *
 *   CASE G — 200 line items → ACCEPTS (exactly at the cap).
 *
 * Run: npx tsx scripts/golden/golden-lineitem-validation.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  orderCreateSchema,
  quoteCreateSchema,
  orderLineItemInputSchema,
  MAX_ORDER_LINE_ITEMS,
} from "@/validation/schemas";

function validLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // 2026-09-26: a line needs a product (id or name); a nameless line printed
  // as a blank row on the customer's quote.
  return { productName: "Zari thread", quantity: 1, unitPrice: 100, ...overrides };
}

async function main() {
  // ---------------------------------------------------------------------------
  // CASE A — valid input passes.
  // ---------------------------------------------------------------------------
  {
    const result = orderCreateSchema.safeParse({
      leadId: "lead_1",
      lineItems: [
        validLine({ quantity: 10, unitPrice: 100 }),
        validLine({ quantity: 5, unitPrice: 50 }),
        validLine({ quantity: 1, unitPrice: 0 }), // free sample
      ],
      currencyCode: "INR",
    });
    assert.ok(result.success, `CASE A: valid input should pass (${JSON.stringify(result.error?.format())})`);
    console.log("  CASE A OK: valid input (incl. free sample) accepted.");
  }

  // ---------------------------------------------------------------------------
  // CASE B — negative quantity rejected.
  // ---------------------------------------------------------------------------
  {
    const result = orderCreateSchema.safeParse({
      lineItems: [validLine({ quantity: -5, unitPrice: 1000 })],
    });
    assert.ok(!result.success, "CASE B: negative quantity must be rejected");
    console.log("  CASE B OK: negative quantity rejected (would have produced -₹5000 total).");
  }

  // ---------------------------------------------------------------------------
  // CASE C — negative unitPrice rejected.
  // ---------------------------------------------------------------------------
  {
    const result = orderCreateSchema.safeParse({
      lineItems: [validLine({ quantity: 5, unitPrice: -1000 })],
    });
    assert.ok(!result.success, "CASE C: negative unitPrice must be rejected");
    console.log("  CASE C OK: negative unitPrice rejected.");
  }

  // ---------------------------------------------------------------------------
  // CASE D — zero quantity rejected (must be > 0, not >= 0).
  // ---------------------------------------------------------------------------
  {
    const result = orderLineItemInputSchema.safeParse({ productName: "Zari thread", quantity: 0, unitPrice: 100 });
    assert.ok(!result.success, "CASE D: zero quantity must be rejected");
    console.log("  CASE D OK: zero quantity rejected (positive required, not just non-negative).");
  }

  // ---------------------------------------------------------------------------
  // CASE E — zero unitPrice ACCEPTED (free samples legitimate).
  // ---------------------------------------------------------------------------
  {
    const result = orderLineItemInputSchema.safeParse(validLine({ quantity: 5, unitPrice: 0 }));
    assert.ok(result.success, "CASE E: zero unitPrice should be accepted (free sample)");
    console.log("  CASE E OK: zero unitPrice accepted (free sample is legitimate).");
  }

  // ---------------------------------------------------------------------------
  // CASE F — over the cap rejected.
  // ---------------------------------------------------------------------------
  {
    const tooMany = Array.from({ length: MAX_ORDER_LINE_ITEMS + 1 }, () => validLine());
    const result = orderCreateSchema.safeParse({ lineItems: tooMany });
    assert.ok(!result.success, `CASE F: ${MAX_ORDER_LINE_ITEMS + 1} items must be rejected`);
    console.log(`  CASE F OK: ${MAX_ORDER_LINE_ITEMS + 1} line items rejected (cap is ${MAX_ORDER_LINE_ITEMS}).`);
  }

  // ---------------------------------------------------------------------------
  // CASE G — exactly at the cap accepted.
  // ---------------------------------------------------------------------------
  {
    const atCap = Array.from({ length: MAX_ORDER_LINE_ITEMS }, () => validLine());
    const result = orderCreateSchema.safeParse({ lineItems: atCap });
    assert.ok(result.success, `CASE G: exactly ${MAX_ORDER_LINE_ITEMS} items should pass`);
    console.log(`  CASE G OK: exactly ${MAX_ORDER_LINE_ITEMS} line items accepted.`);
  }

  // ---------------------------------------------------------------------------
  // CASE H — quote schema also enforces the same rules (mirror check).
  // ---------------------------------------------------------------------------
  {
    const badQuote = quoteCreateSchema.safeParse({
      lineItems: [validLine({ quantity: -1, unitPrice: 100 })],
    });
    assert.ok(!badQuote.success, "CASE H: quote schema must also reject negative qty");
    console.log("  CASE H OK: quote schema rejects the same dangerous inputs.");
  }

  // ---------------------------------------------------------------------------
  // CASE I — D-2 fractional quantity must compute the CORRECT total (not rounded).
  // Audit 2026-07-27 S6/D-2: money.ts did Math.round(quantity) before multiplying,
  // so 1.5m × ₹100 → ₹200 instead of ₹150. The fix removed the round. This case
  // pins the correct fractional math. Schema ALLOWS fractional quantities (a
  // textile B2B sells by the metre / kg — 1.5m, 0.5kg are real).
  // Hand-computed:
  //   1.5 × ₹100 = ₹150  (was wrongly ₹200 before the fix)
  //   0.5 × ₹100 = ₹50   (was wrongly ₹100)
  //   2.4 × ₹50  = ₹120  (was wrongly ₹100)
  // ---------------------------------------------------------------------------
  {
    const { computeLineTotalPaise, sumLineTotalsPaise } = await import("@/lib/money");
    assert.strictEqual(computeLineTotalPaise(1.5, 100), 150, "CASE I: 1.5 × ₹100 = ₹150 (fractional qty, exact)");
    assert.strictEqual(computeLineTotalPaise(0.5, 100), 50, "CASE I: 0.5 × ₹100 = ₹50");
    assert.strictEqual(computeLineTotalPaise(2.4, 50), 120, "CASE I: 2.4 × ₹50 = ₹120");
    // Whole quantities still exact.
    assert.strictEqual(computeLineTotalPaise(10, 100), 1000, "CASE I: 10 × ₹100 = ₹1000 (whole qty regression)");
    // sumLineTotalsPaise must also respect fractional qty when no lineTotal is supplied.
    const sum = sumLineTotalsPaise([
      { quantity: 1.5, unitPrice: 100 },
      { quantity: 0.5, unitPrice: 100 },
    ]);
    assert.strictEqual(sum, 200, "CASE I: (1.5 + 0.5) × ₹100 = ₹200 (sum honours fractional qty)");
    console.log("  CASE I OK: fractional quantities compute exact totals (D-2 fix pinned).");
  }

  // ---------------------------------------------------------------------------
  // CASE J — D-3 a client-supplied lineTotal must NOT bypass the money chokepoint.
  // Audit 2026-07-27 S6/D-3: lineTotal was optional + unconstrained, so a client
  // could POST {qty:5, unitPrice:100, lineTotal:-9999} and create a ₹-9999 order.
  // Fix: when lineTotal is supplied it MUST equal qty × unitPrice (tolerance 0.01),
  // else the schema REJECTS. This forces every lineTotal through the chokepoint.
  // Hand-computed:
  //   qty 5 × ₹100 = ₹500 → lineTotal 500 ACCEPTS, lineTotal -9999 REJECTS,
  //   lineTotal 499.99 REJECTS (a full paise off = real disagreement),
  //   lineTotal 500.004 ACCEPTS (within half-paise tolerance — legit rounding).
  // ---------------------------------------------------------------------------
  {
    // Correct lineTotal accepted.
    const ok = orderLineItemInputSchema.safeParse({ productName: "Zari thread", quantity: 5, unitPrice: 100, lineTotal: 500 });
    assert.ok(ok.success, "CASE J: lineTotal === qty×unitPrice (500) accepts");
    // Wrong lineTotal rejected.
    const wrongNeg = orderLineItemInputSchema.safeParse({ productName: "Zari thread", quantity: 5, unitPrice: 100, lineTotal: -9999 });
    assert.ok(!wrongNeg.success, "CASE J: negative lineTotal (-9999) rejects");
    const wrongOff = orderLineItemInputSchema.safeParse({ productName: "Zari thread", quantity: 5, unitPrice: 100, lineTotal: 499.99 });
    assert.ok(!wrongOff.success, "CASE J: lineTotal a full paise off (499.99 vs 500) rejects");
    // Within half-paise tolerance accepted (legit rounding between code paths).
    const within = orderLineItemInputSchema.safeParse({ productName: "Zari thread", quantity: 5, unitPrice: 100, lineTotal: 500.004 });
    assert.ok(within.success, "CASE J: lineTotal within half-paise (0.004) tolerance accepts");
    // No lineTotal at all still accepted (the service computes it).
    const none = orderLineItemInputSchema.safeParse({ productName: "Zari thread", quantity: 5, unitPrice: 100 });
    assert.ok(none.success, "CASE J: no lineTotal supplied accepts (service computes)");
    console.log("  CASE J OK: client lineTotal must equal qty×unitPrice (D-3 fix pinned).");
  }

  // ---------------------------------------------------------------------------
  // CASE K — D-4 an order/quote with EMPTY lineItems must REJECT.
  // Audit 2026-07-27 S6/D-4: lineItems had .max(200) but no .min(1), so an empty
  // lineItems:[] was valid → created a ₹0 phantom order. Fix: require ≥1 line.
  // Hand-computed: empty array REJECTS; 1-item array ACCEPTS.
  // ---------------------------------------------------------------------------
  {
    const empty = orderCreateSchema.safeParse({ leadId: "lead_1", lineItems: [] });
    assert.ok(!empty.success, "CASE K: order with empty lineItems rejects");
    const oneOk = orderCreateSchema.safeParse({ leadId: "lead_1", lineItems: [validLine()] });
    assert.ok(oneOk.success, "CASE K: order with 1 line item accepts");
    const emptyQuote = quoteCreateSchema.safeParse({ lineItems: [] });
    assert.ok(!emptyQuote.success, "CASE K: quote with empty lineItems rejects");
    console.log("  CASE K OK: empty lineItems rejected (D-4 fix pinned).");
  }

  // ---------------------------------------------------------------------------
  // CASE L — W-3 money overflow guard: extreme inputs throw instead of silently
  // corrupting the total. Audit 2026-07-27 S6 W-3: computeLineTotalPaise with
  // quantity=200, unitPrice=1e15 produced 2e19 paise (exceeds MAX_SAFE_INTEGER
  // ~9e15) → silent precision loss. Now it throws MoneyOverflowError. Also the
  // schema caps unitPrice at ₹1e9 so the fat-finger entry is rejected at the
  // boundary before reaching the math.
  // Hand-computed:
  //   unitPrice 1e15 (₹1 quadrillion) → schema REJECTS (> 1e9 cap).
  //   computeLineTotalPaise(200, 1e15) → throws MoneyOverflowError (defensive).
  //   computeLineTotalPaise(10, 100) → 1000 (normal case unaffected).
  // ---------------------------------------------------------------------------
  {
    const { computeLineTotalPaise, MoneyOverflowError } = await import("@/lib/money");
    // Normal case unaffected.
    assert.strictEqual(computeLineTotalPaise(10, 100), 1000, "CASE L: normal total unaffected");
    // Extreme unitPrice overflows → throws.
    let threw = false;
    try { computeLineTotalPaise(200, 1e15); } catch (e) { threw = e instanceof MoneyOverflowError; }
    assert.strictEqual(threw, true, "CASE L: extreme input throws MoneyOverflowError (no silent corruption)");
    // Schema cap: unitPrice > 1e9 rejected at the boundary.
    const tooBig = orderLineItemInputSchema.safeParse({ productName: "Zari thread", quantity: 1, unitPrice: 1e15 });
    assert.ok(!tooBig.success, "CASE L: unitPrice > ₹1e9 rejected by schema cap");
    // unitPrice exactly at the cap accepted.
    const atCap = orderLineItemInputSchema.safeParse({ productName: "Zari thread", quantity: 1, unitPrice: 1_000_000_000 });
    assert.ok(atCap.success, "CASE L: unitPrice at ₹1e9 cap accepted");
    console.log("  CASE L OK: money overflow guarded (W-3 fix pinned).");
  }

  console.log(`\nPASS golden-lineitem-validation: order + quote schemas enforce qty>0, price>=0, cap=${MAX_ORDER_LINE_ITEMS}, exact fractional math, lineTotal consistency, ≥1 line, overflow guard (12 cases).`);
}

main().catch((err) => {
  console.error("\nFAIL golden-lineitem-validation:", err.message);
  process.exit(1);
});
