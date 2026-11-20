/**
 * Golden test — product pricing resolution (T1.2).
 *
 * Phase 1.5 / skill v2 — written BEFORE the resolver code.
 *
 * Operator-confirmed rules (from docs/LOGIC.md, 2026-07-20):
 *   - Simple product: one ProductSetting with price + priceUnit. That's the price.
 *   - Variant product: ProductSetting has variants[], each with own price.
 *     The variant's price overrides the product's headline price.
 *   - No price set → return undefined (caller must NOT quote; per the
 *     no-guess rule from 2026-07-19).
 *
 * Hand-computed expected values:
 *
 *   CASE A — Simple product with price:
 *     ProductSetting { price: 450, priceUnit: "per kg" }
 *     resolveProductPrice(product) → { price: 450, priceUnit: "per kg" }
 *
 *   CASE B — Simple product with NO price:
 *     ProductSetting {} (no price fields)
 *     resolveProductPrice(product) → undefined (no quote allowed)
 *
 *   CASE C — Variant product, headline price + variant overrides:
 *     ProductSetting {
 *       price: 450, priceUnit: "per kg",  // headline
 *       variants: [
 *         { name: "Gold", price: 500 },   // override
 *         { name: "Silver", price: 400 }, // override
 *         { name: "Copper" }              // inherits headline
 *       ]
 *     }
 *     resolveVariantPrice(product, variantIndex=0) → { price: 500, priceUnit: "per kg" }
 *     resolveVariantPrice(product, variantIndex=1) → { price: 400, priceUnit: "per kg" }
 *     resolveVariantPrice(product, variantIndex=2) → { price: 450, priceUnit: "per kg" } (headline)
 *
 *   CASE D — Variant product, NO headline, variant has price:
 *     ProductSetting {
 *       variants: [{ name: "Gold", price: 500, priceUnit: "per box" }]
 *     }
 *     resolveVariantPrice(product, 0) → { price: 500, priceUnit: "per box" }
 *     resolveVariantPrice(product, 99) → undefined (variant not found)
 *
 *   CASE E — Empty product (no price, no variants):
 *     resolveProductPrice({}) → undefined
 *
 * Run: npx tsx scripts/golden/golden-product-pricing.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { resolveProductPrice, resolveVariantPrice } from "@/lib/product-pricing";
import type { ProductSetting } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function makeProduct(overrides: Partial<ProductSetting>): ProductSetting {
  return { id: "p1", name: "Test Product", ...overrides } as ProductSetting;
}

async function main() {
  // === CASE A — Simple product with price ===
  const a = resolveProductPrice(makeProduct({ price: 450, priceUnit: "per kg" }));
  assert(a?.price === 450, `CASE A: expected price 450, got ${a?.price}`);
  assert(a?.priceUnit === "per kg", `CASE A: expected unit "per kg", got ${a?.priceUnit}`);
  console.log("  CASE A OK: simple product → 450 per kg.");

  // === CASE B — Simple product with NO price ===
  const b = resolveProductPrice(makeProduct({}));
  assert(b === undefined, `CASE B: expected undefined, got ${JSON.stringify(b)}`);
  console.log("  CASE B OK: simple product no price → undefined.");

  // === CASE C — Variant product, variant overrides + inherits ===
  const cProduct = makeProduct({
    price: 450,
    priceUnit: "per kg",
    variants: [
      { id: "v1", name: "Gold", price: 500 },
      { id: "v2", name: "Silver", price: 400 },
      { id: "v3", name: "Copper" }, // inherits headline
    ],
  });
  const cGold = resolveVariantPrice(cProduct, 0);
  assert(cGold?.price === 500, `CASE C (Gold): expected 500, got ${cGold?.price}`);
  const cSilver = resolveVariantPrice(cProduct, 1);
  assert(cSilver?.price === 400, `CASE C (Silver): expected 400, got ${cSilver?.price}`);
  const cCopper = resolveVariantPrice(cProduct, 2);
  assert(cCopper?.price === 450, `CASE C (Copper, inherits): expected 450, got ${cCopper?.price}`);
  assert(cCopper?.priceUnit === "per kg", `CASE C (Copper unit): expected "per kg", got ${cCopper?.priceUnit}`);
  console.log("  CASE C OK: variants — Gold=500, Silver=400, Copper inherits 450.");

  // === CASE D — No headline, variant has price ===
  const dProduct = makeProduct({
    variants: [{ id: "v1", name: "Gold", price: 500, priceUnit: "per box" }],
  });
  const dKnown = resolveVariantPrice(dProduct, 0);
  assert(dKnown?.price === 500 && dKnown?.priceUnit === "per box", `CASE D: expected 500 per box, got ${JSON.stringify(dKnown)}`);
  const dMissing = resolveVariantPrice(dProduct, 99);
  assert(dMissing === undefined, `CASE D (missing variant): expected undefined, got ${JSON.stringify(dMissing)}`);
  console.log("  CASE D OK: no headline, variant=500 per box, missing variant=undefined.");

  // === CASE E — Empty product ===
  const e = resolveProductPrice(makeProduct({}));
  assert(e === undefined, `CASE E: expected undefined, got ${JSON.stringify(e)}`);
  console.log("  CASE E OK: empty product → undefined.");

  console.log("PASS golden-product-pricing: all 5 cases match the operator-confirmed rules.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
