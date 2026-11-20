/**
 * T1.2 / 2026-07-20 — Product price resolution.
 *
 * Pure helpers that turn a ProductSetting (+ optional variant index) into a
 * concrete { price, priceUnit } pair, or `undefined` when no price is set.
 *
 * Operator-confirmed rules (docs/LOGIC.md 2026-07-20):
 *   - Simple product: ProductSetting.price is THE price.
 *   - Variant product: each variant overrides the headline price. A variant
 *     without its own price inherits the headline.
 *   - No price anywhere → return undefined. Callers MUST NOT quote; per the
 *     2026-07-19 no-guess rule, they create an Information Needed card
 *     and/or send the safe-fallback reply.
 *
 * Pure functions — no I/O, no side effects. Pinned by
 * scripts/golden/golden-product-pricing.ts.
 */

export type ResolvedPrice = {
  price: number;
  priceUnit?: string;
};

/**
 * Resolve the price of a simple product (no variant selection).
 * Returns undefined when the product has no price set.
 *
 * For a variant-mode product, this returns the headline price (which may
 * or may not be set). Callers resolving a specific variant should use
 * resolveVariantPrice instead.
 */
export function resolveProductPrice(product: { price?: number; priceUnit?: string } | undefined | null): ResolvedPrice | undefined {
  if (!product) return undefined;
  if (typeof product.price !== "number" || !Number.isFinite(product.price) || product.price < 0) return undefined;
  return { price: product.price, priceUnit: product.priceUnit };
}

/**
 * Resolve the price of a specific variant by index. Falls back to the
 * parent product's headline price when the variant doesn't define its own.
 * Returns undefined when neither the variant nor the headline has a price.
 */
export function resolveVariantPrice(
  product: { price?: number; priceUnit?: string; variants?: Array<{ price?: number; priceUnit?: string }> } | undefined | null,
  variantIndex: number,
): ResolvedPrice | undefined {
  if (!product) return undefined;
  const variant = product.variants?.[variantIndex];
  if (!variant) return undefined;
  // Variant's own price wins if it's a valid number.
  if (typeof variant.price === "number" && Number.isFinite(variant.price) && variant.price >= 0) {
    return { price: variant.price, priceUnit: variant.priceUnit || product.priceUnit };
  }
  // Otherwise inherit from the headline.
  return resolveProductPrice(product);
}
