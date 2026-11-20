/**
 * Stage 3 / 2026-07-20 — Quote + Order lifecycle service.
 * Extended 2026-07-21 (Batch 2 of session 8).
 *
 * Pure functions for the commercial flow. Per operator decisions:
 *   - Quote optional. Order can be direct or from_quote.
 *   - Conversion snapshots prices.
 *   - New quotes supersede old (old kept for audit, cannot convert).
 *   - Reorders pre-fill draft Orders from a customer's last order.
 *   - NO Invoice, NO tax computation — those live in Tally/ERP.
 *
 * 2026-07-21 additions (per docs/LOGIC.md):
 *   - Order has optional sourceReplyId + sourceInteractionId (conversation
 *     link so future disputes can find the originating message instantly).
 *   - computeDiscountFlag(input) flags orders where any line's unitPrice is
 *     below the product's base price. Informational — does NOT block.
 *   - convertQuoteToOrder now returns BOTH the new order AND the updated
 *     quote (status="converted", orderId set). Double-convert throws.
 *   - createReorderDraft now accepts the current ProductSetting[] and flags
 *     price-changed lines (keeps old price for continuity; warns the owner).
 *   - cancelOrder(order, {actor, reason}) implements the 3-case cancel rule
 *     (full cancel / partial_cancelled / throw on delivered).
 *
 * Pinned by scripts/golden/golden-quote-order.ts AND
 * scripts/golden/golden-order-cancel.ts.
 */
import { NeedsActionError } from "@/lib/user-errors";
import { isAllowedQuoteTransition, nextQuoteStatuses, transitionRefusal } from "@/lib/status-transitions";
import { uid, timestamp } from "@/lib/db";
import type { Order, OrderLineItem, OrderStatus, ProductSetting, Quote, QuoteStatus } from "@/lib/types";
// Stage A+ / Cluster 10d (P2-12): money-safe arithmetic. Replaces the
// Math.round(x*100)/100 pattern that was susceptible to float drift.
import {
  computeLineTotalPaise,
  sumLineTotalsPaise,
  computeDiscountAmountPaise,
  sumDiscountAmountsPaise,
  compareMoney,
  sumQuantitiesExact,
} from "@/lib/money";

/**
 * Compute the line total = quantity × unitPrice. Stored as a snapshot so
 * the historical record doesn't drift if the system price changes later.
 *
 * Stage A+ / P2-12: routes through integer-paise arithmetic for exact math.
 */
export function computeLineTotal(quantity: number, unitPrice: number): number {
  return computeLineTotalPaise(quantity, unitPrice);
}

/**
 * Compute the grand total of a set of line items. Sum of lineTotal.
 *
 * Stage A+ / P2-12: sums in integer paise (no float drift across many items).
 */
export function computeGrandTotal(lineItems: OrderLineItem[]): number {
  return sumLineTotalsPaise(lineItems);
}

/**
 * Finalize line items: give every line a server id and its line total.
 *
 * 2026-09-27 (sector review M3): the Commercial screen sends lines with no id
 * and this kept whatever came in, so an order's lines had `id: undefined`.
 * Every per-line record is keyed by that id — shipped counts were saved as
 * {"undefined": 10} and the order could then never be cancelled (no line
 * matched). A client could also send two lines with the same id, making one
 * shipped count apply to both. The id is the server's to give: every line gets
 * a fresh one here, whatever the client sent.
 *
 * The line total is always computed here too (M2): a client-sent lineTotal is
 * checked by the schema to within half a paise of quantity × price, but that
 * check uses float maths, so the stored figure is the exact one.
 */
export function finalizeLineItems(lineItems: OrderLineItem[]): OrderLineItem[] {
  return lineItems.map((li) => ({ ...li, id: uid("li"), lineTotal: computeLineTotal(li.quantity, li.unitPrice) }));
}

export type CommercialLineItemInput = Pick<OrderLineItem, "quantity" | "unitPrice"> & Partial<Omit<OrderLineItem, "quantity" | "unitPrice">>;

/** Resolve optional catalogue references into factual document snapshots before saving. */
export function hydrateCommercialLineItems(
  lineItems: CommercialLineItemInput[], products: ProductSetting[], currencyCode = "INR",
): OrderLineItem[] {
  const productById = new Map(products.map((product) => [product.id, product]));
  return lineItems.map((line) => {
    const productId = line.productId?.trim() || undefined;
    const product = productId ? productById.get(productId) : undefined;
    if (productId && !product) throw new NeedsActionError("The selected product was not found in your workspace. Choose it again.", 404);
    const variantId = line.productVariantId?.trim() || undefined;
    const variant = variantId ? product?.variants?.find((item) => item.id === variantId) : undefined;
    if (variantId && !variant) throw new NeedsActionError("The selected variant does not belong to this product. Choose it again.", 400);
    const productName = line.productName?.trim() || product?.name?.trim();
    if (!productName) throw new NeedsActionError("Each line needs a product name or a valid catalogue product.", 400);
    const unit = line.unit?.trim() || (variant?.priceUnit || product?.priceUnit || "").replace(/^per\s+/i, "").trim();
    return {
      ...line, id: line.id || "", productId, productVariantId: variantId, productName,
      sku: line.sku || variant?.sku, unit, currencyCode: line.currencyCode || currencyCode,
      lineTotal: computeLineTotal(line.quantity, line.unitPrice),
    };
  });
}

/**
 * A quote's lines carried onto its order keep their ids (the quote's lines
 * were given server ids when it was made), but a quote saved before that fix
 * may have lines with no id or a repeated one. Those get a fresh id so every
 * line on the order can be shipped and cancelled on its own (M3).
 */
function snapshotLinesWithIds(lineItems: OrderLineItem[]): OrderLineItem[] {
  const seen = new Set<string>();
  return lineItems.map((li) => {
    const id = li.id && !seen.has(li.id) ? li.id : uid("li");
    seen.add(id);
    return { ...li, id };
  });
}

/**
 * The one guarded way a quote's status changes (2026-09-27, sector review M1).
 *
 * POST /quotes/:id/status checked the move; the Copilot's "approve" wrote
 * status "sent" with no check at all. So a quote already turned into an order
 * could be put back to "sent" and converted again (two orders from one quote),
 * a rejected / expired / replaced quote came back to life, a quote with an
 * unpriced line was marked sent, and sentAt was never stamped. Both paths now
 * go through this function, which:
 *   - refuses any move the shared lifecycle map (status-transitions.ts) does
 *     not allow — converted, superseded, rejected and expired are ends;
 *   - refuses "sent" while any line has no price (the rule the Needs-you
 *     screen already states: nothing sends until every line has a rate);
 *   - stamps sentAt / acceptedAt the first time only.
 * Returns the patch to save. Pinned by scripts/golden/golden-commercial-money-review.ts.
 */
export function quoteStatusPatch(quote: Quote, toStatus: QuoteStatus, now: string = timestamp()): Partial<Quote> {
  if (!isAllowedQuoteTransition(quote.status, toStatus)) {
    throw new NeedsActionError(transitionRefusal("quote", quote.status, toStatus, nextQuoteStatuses(quote.status)), 409);
  }
  if (toStatus === "sent") {
    const unpriced = (quote.lineItems || []).filter((li) => !(li.unitPrice > 0));
    if (unpriced.length > 0) {
      const names = unpriced.map((li) => li.productName || "an item").join(", ");
      throw new NeedsActionError(`${names} ${unpriced.length === 1 ? "has" : "have"} no price yet. Put a rate on every line before this quote is sent.`, 409);
    }
  }
  const patch: Partial<Quote> = { status: toStatus };
  if (toStatus === "sent" && !quote.sentAt) patch.sentAt = now;
  if (toStatus === "accepted" && !quote.acceptedAt) patch.acceptedAt = now;
  return patch;
}

/**
 * 2026-07-21 — Detect discount flags for an order.
 *
 * A line item is "discounted" if its unitPrice is strictly lower than the
 * matched product's base price (same currency). Higher prices are NOT
 * flagged (legitimate markup for special service / urgency / small qty).
 * Lines with no productId or whose product has no price are never flagged
 * (ad-hoc line — no base price to compare).
 *
 * Pure function — does NOT mutate input. Returns the flag + breakdown.
 */
export function computeDiscountFlag(input: {
  lineItems: OrderLineItem[];
  products: ProductSetting[];
  /** Catalogue base prices are INR; no implicit exchange-rate conversion is permitted. */
  currencyCode?: string;
}): {
  discountGiven: boolean;
  totalDiscountAmount: number;
  lineDiscounts: Array<{ lineItemId: string; productId: string; basePrice: number; unitPrice: number; discountAmount: number }>;
} {
  const productById = new Map(input.products.map((p) => [p.id, p]));
  const lineDiscounts: Array<{ lineItemId: string; productId: string; basePrice: number; unitPrice: number; discountAmount: number }> = [];
  const perLineDiscountAmounts: number[] = []; // Stage A+ / P2-12: collected for exact sum
  for (const li of input.lineItems) {
    const currency = (input.currencyCode || "INR").toUpperCase();
    if (currency !== "INR" || (li.currencyCode || currency).toUpperCase() !== currency) continue;
    if (!li.productId) continue;
    const product = productById.get(li.productId);
    if (!product || product.price === undefined) continue;
    const base = product.price;
    // 2026-07-26 Session 4 audit fix (P2-MONEY-1): use compareMoney (integer
    // paise) for the discount boundary. The raw float `<` would flag a line as
    // discounted when unitPrice=449.9999999 vs base=450 (float drift) even
    // though they're equal at paise precision (45000 = 45000). Pinned by
    // golden:order-cancel CASE L (drift-equal) + CASE M (real 1-paise).
    if (compareMoney(li.unitPrice, base) < 0) {
      // Stage A+ / P2-12: integer-paise arithmetic (was: float round).
      const discountAmount = computeDiscountAmountPaise(base, li.unitPrice, li.quantity);
      lineDiscounts.push({
        lineItemId: li.id,
        productId: li.productId,
        basePrice: base,
        unitPrice: li.unitPrice,
        discountAmount,
      });
      perLineDiscountAmounts.push(discountAmount);
    }
  }
  return {
    discountGiven: lineDiscounts.length > 0,
    // Stage A+ / P2-12: sum in paise, no float drift.
    totalDiscountAmount: sumDiscountAmountsPaise(perLineDiscountAmounts),
    lineDiscounts,
  };
}

/**
 * CASE A — Create an Order directly (no quote).
 *
 * Status handling (depth-audit fix 2026-07-29, F-UI-2): the caller may pass
 * `status` to honor the operator's choice from the Commercial create-form.
 * Defaults to "draft" for back-compat. When "confirmed" is requested we also
 * stamp `confirmedAt` (matches convertQuoteToOrder's behaviour at line ~197),
 * so a manually-confirmed order is indistinguishable from a converted quote.
 *
 * 2026-07-21: optional sourceReplyId + sourceInteractionId for the
 * conversation link. Optional products list for discount-flag computation.
 */
export async function createOrderDirect(input: {
  workspaceId: string;
  leadId: string;
  lineItems: OrderLineItem[];
  currencyCode: string;
  /** Operator-chosen initial status (default "draft"). The Commercial
   *  create-form offers draft | confirmed; other flows leave this unset. */
  status?: OrderStatus;
  notes?: string;
  sourceReplyId?: string;
  sourceInteractionId?: string;
  /** If provided, the discount flag is computed and stamped on the order. */
  products?: ProductSetting[];
}): Promise<Order> {
  const items = finalizeLineItems(input.lineItems);
  const now = timestamp();
  const status: OrderStatus = input.status ?? "draft";
  const order: Order = {
    id: uid("order"),
    workspaceId: input.workspaceId,
    orderNumber: 0, // caller assigns via repos.order.nextOrderNumber
    leadId: input.leadId,
    status,
    confirmedAt: status === "confirmed" ? now : undefined,
    lineItems: items,
    grandTotal: computeGrandTotal(items),
    currencyCode: input.currencyCode,
    origin: "direct",
    sourceReplyId: input.sourceReplyId,
    sourceInteractionId: input.sourceInteractionId,
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
  };
  if (input.products) {
    const flag = computeDiscountFlag({ lineItems: items, products: input.products, currencyCode: input.currencyCode });
    order.discountGiven = flag.discountGiven;
    order.totalDiscountAmount = flag.totalDiscountAmount;
  }
  return order;
}

/**
 * The result of converting a Quote to an Order. The caller is responsible
 * for persisting BOTH: the new Order AND the updated Quote (status moved
 * to "converted", orderId set).
 */
export type ConvertQuoteResult = { order: Order; quote: Quote };

/**
 * CASE B — Convert a Quote to an Order.
 *
 * Per operator rule (2026-07-20): the line item prices are SNAPSHOT at
 * conversion. If the system price changes later, the Order keeps the
 * original quoted prices. Throws if the quote is not in a convertible
 * status (sent or accepted — NOT superseded, expired, rejected, or
 * already converted).
 *
 * 2026-07-21: now returns BOTH the order and the updated quote. The quote
 * is marked "converted" with orderId set to the new order's id, so it
 * cannot be converted again. Double-convert throws.
 */
export async function convertQuoteToOrder(quote: Quote, options?: { products?: ProductSetting[] }): Promise<ConvertQuoteResult> {
  if (quote.status === "converted") {
    throw new NeedsActionError(`Quote ${quote.id} is already converted to order ${quote.orderId}.`, 409);
  }
  if (!["sent", "accepted"].includes(quote.status)) {
    throw new Error(`Cannot convert quote in status "${quote.status}" — only sent or accepted quotes can convert.`);
  }
  const now = timestamp();
  const orderId = uid("order");
  const order: Order = {
    id: orderId,
    workspaceId: quote.workspaceId,
    orderNumber: 0,
    leadId: quote.leadId,
    quoteId: quote.id,
    status: "confirmed",
    lineItems: snapshotLinesWithIds(quote.lineItems), // snapshot (prices kept as quoted)
    grandTotal: quote.grandTotal,
    currencyCode: quote.currencyCode,
    origin: "from_quote",
    confirmedAt: now,
    notes: quote.notes,
    createdAt: now,
    updatedAt: now,
  };
  // F-LOGIC-2 (2026-08-04 build-right audit): stamp the discount flag on
  // converted orders too. A quote negotiated below the catalog rate is exactly
  // the "discount allowed but flagged" case LOGIC.md describes; previously
  // converted orders never got the badge because the catalog wasn't passed.
  if (options?.products && options.products.length > 0) {
    const flag = computeDiscountFlag({ lineItems: order.lineItems, products: options.products, currencyCode: quote.currencyCode });
    order.discountGiven = flag.discountGiven;
    order.totalDiscountAmount = flag.totalDiscountAmount;
  }
  const updatedQuote: Quote = {
    ...quote,
    status: "converted" as QuoteStatus,
    orderId,
    updatedAt: now,
  };
  return { order, quote: updatedQuote };
}

/**
 * CASE C — Mark a new quote as superseding an old one. Returns the updated
 * old quote (status → "superseded") and the replacement quote (status →
 * same as input, but with supersedesQuoteId set).
 */
export function supersedeQuote(oldQuote: Quote, newQuote: Quote): { updated: Quote; replacement: Quote } {
  const updated: Quote = { ...oldQuote, status: "superseded" as QuoteStatus, updatedAt: timestamp() };
  const replacement: Quote = { ...newQuote, supersedesQuoteId: oldQuote.id };
  return { updated, replacement };
}

/**
 * CASE D — Create a draft reorder from a customer's last order. Pre-fills
 * the same line items. The owner reviews and confirms. The new order
 * references the original via reorderedFromOrderId.
 *
 * 2026-07-21: now accepts the current ProductSetting[] and flags lines
 * whose price has changed since the last order. Keeps the old unitPrice
 * (customer continuity) + sets priceChangedSinceLastOrder + currentPriceSnapshot
 * so the UI can warn the owner before sending.
 */
export async function createReorderDraft(
  lastOrder: Order,
  options?: { products?: ProductSetting[] },
): Promise<Order> {
  const now = timestamp();
  const productById = options?.products ? new Map(options.products.map((p) => [p.id, p])) : new Map<string, ProductSetting>();
  const lineItems = lastOrder.lineItems.map((li) => {
    const item: OrderLineItem = { ...li, id: uid("li") };
    const currency = (lastOrder.currencyCode || "INR").toUpperCase();
    if (currency !== "INR" || (li.currencyCode || currency).toUpperCase() !== currency) {
      item.priceChangedSinceLastOrder = false;
      item.currentPriceSnapshot = undefined;
      return item;
    }
    const product = productById.get(li.productId || "");
    // 2026-07-26 Session 4 audit fix (P2-MONEY-1): use compareMoney (integer
    // paise) for the price-change detection. Raw float `!==` would flag a
    // price change for unitPrice=449.9999999 vs current=450 (float drift)
    // even though they're equal at paise precision.
    if (product && product.price !== undefined && compareMoney(product.price, li.unitPrice) !== 0) {
      item.priceChangedSinceLastOrder = true;
      item.currentPriceSnapshot = product.price;
    }
    // Clear any stale flag if no change (defensive)
    if (product && product.price !== undefined && compareMoney(product.price, li.unitPrice) === 0) {
      item.priceChangedSinceLastOrder = false;
      item.currentPriceSnapshot = undefined;
    }
    return item;
  });
  const finalizedItems = finalizeLineItems(lineItems);
  return {
    id: uid("order"),
    workspaceId: lastOrder.workspaceId,
    orderNumber: 0,
    leadId: lastOrder.leadId,
    status: "draft",
    lineItems: finalizedItems,
    grandTotal: computeGrandTotal(finalizedItems),
    currencyCode: lastOrder.currencyCode,
    origin: "direct",
    reorderedFromOrderId: lastOrder.id,
    notes: `Reorder of order #${lastOrder.orderNumber}.`,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Check a "shipped so far" count per line before it is stored.
 *
 * 2026-09-26 (break test): the order status route stored whatever it was
 * sent. "Shipped 50" on a line of 10, a line the order does not have, a
 * negative or a word were all saved — and cancel math reads these numbers
 * (cancellable = ordered − shipped), so one bad entry made the order
 * impossible to cancel. A second partial shipment could also LOWER a count
 * already shipped. Each line must be a whole-or-decimal number from the
 * previous shipped count up to the ordered quantity, and something must
 * have shipped.
 */
export function validateShippedQuantities(order: Order, shipped: unknown): Record<string, number> {
  if (!shipped || typeof shipped !== "object" || Array.isArray(shipped)) {
    throw new NeedsActionError("Say how many of each item have shipped.", 400);
  }
  const lines = new Map(order.lineItems.map((li) => [li.id, li]));
  const before = order.shippedQuantityByLine || {};
  const out: Record<string, number> = { ...before };
  for (const [lineId, qty] of Object.entries(shipped as Record<string, unknown>)) {
    const line = lines.get(lineId);
    if (!line) throw new NeedsActionError("One of the shipped items is not on this order. Refresh the order and try again.", 400);
    const name = line.productName || "an item";
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty < 0) {
      throw new NeedsActionError(`The shipped amount for ${name} must be a number of 0 or more.`, 400);
    }
    const remaining = Math.max(0, sumQuantitiesExact(line.quantity, -(order.cancelledQuantityByLine?.[line.id] || 0)));
    if (qty > remaining) {
      throw new NeedsActionError(`Only ${remaining} of ${name} remain after cancellations, so ${qty} cannot have shipped.`, 400);
    }
    if (qty < (before[lineId] || 0)) {
      throw new NeedsActionError(`${before[lineId]} of ${name} have already shipped; the count cannot go back to ${qty}.`, 409);
    }
    out[lineId] = qty;
  }
  if (!Object.values(out).some((q) => q > 0)) {
    throw new NeedsActionError("Nothing is marked as shipped yet — enter how many of at least one item went out.", 400);
  }
  return out;
}

/**
 * What a move to a shipping status records (2026-09-27, sector review M8).
 *
 * Two holes the reviewer reproduced:
 *   - "partial_shipped" sent with no counts was recorded as EVERYTHING shipped,
 *     which is the opposite of what the status says;
 *   - partial_shipped → delivered was allowed while 2 of 10 had shipped, so the
 *     order read "delivered" with 8 units never sent.
 * Now a partial shipment must say how many of each item went out, "shipped"
 * records the whole remainder (ordered − cancelled) as shipped explicitly, and
 * "delivered" from a partial state is refused until every remaining unit has
 * shipped — mark the order shipped first. Returns the fields to save.
 */
export function shipmentPatchFor(order: Order, toStatus: OrderStatus, shippedInput: unknown): Partial<Order> {
  const cancelled = order.cancelledQuantityByLine || {};
  const toShip = (li: OrderLineItem) => Math.max(0, sumQuantitiesExact(li.quantity, -(cancelled[li.id] || 0)));
  if (toStatus === "partial_shipped") {
    if (shippedInput === undefined) {
      throw new NeedsActionError("Say how many of each item have shipped — a part shipment needs the count for every item that went out.", 400);
    }
    return { shippedQuantityByLine: validateShippedQuantities(order, shippedInput) };
  }
  if (toStatus === "shipped") {
    return { shippedQuantityByLine: Object.fromEntries(order.lineItems.map((li) => [li.id, toShip(li)])) };
  }
  if (toStatus === "delivered" && (order.status === "partial_shipped" || order.status === "partial_cancelled")) {
    const shipped = order.shippedQuantityByLine || {};
    const short = order.lineItems.filter((li) => (shipped[li.id] || 0) < toShip(li));
    if (short.length > 0) {
      const detail = short.map((li) => `${shipped[li.id] || 0} of ${toShip(li)} ${li.productName || "items"}`).join(", ");
      throw new NeedsActionError(`Only ${detail} have shipped, so the order cannot be delivered yet. Mark it shipped once the rest has gone out.`, 409);
    }
  }
  return {};
}

/**
 * CASE E — Cancel an order. Per docs/LOGIC.md 2026-07-21:
 *   - Status in {draft, confirmed, in_progress} (nothing shipped) → full
 *     cancel, status → "cancelled". All line quantities are recorded as
 *     cancelled in cancelledQuantityByLine for audit. grandTotal is
 *     preserved (the order is dead; its total is informational).
 *   - Status "partial_shipped" → status → "partial_cancelled". The caller
 *     MUST pass cancelQuantitiesByLine ({ lineItemId: qtyToCancel }).
 *     grandTotal is RECOMPUTED to only the surviving quantities (the
 *     shipped portion the customer still takes). shippedQuantityByLine is
 *     preserved. cancelledQuantityByLine records exactly what was cancelled.
 *     Operator decision 2026-07-21: "Reduce total — Total drops to the
 *     remaining items."
 *   - Status in {shipped, delivered} → THROWS. A delivered order cannot be
 *     cancelled; that's a return (different flow).
 *   - 2026-09-27 (M4): cancels ADD UP. A partial_cancelled order can be
 *     cancelled again, but only for what is still cancellable (ordered −
 *     shipped − already cancelled); shipped units are never cancelled, and
 *     once anything has shipped the quantities must be given.
 * Returns the order patch (status + cancelledAt + cancelledBy + cancelReason
 * + cancelledQuantityByLine + recomputed grandTotal). Caller persists.
 *
 * Pinned by scripts/golden/golden-partial-cancel-math.ts.
 */
export async function cancelOrder(
  order: Order,
  input: { actor: string; reason?: string; cancelQuantitiesByLine?: Record<string, number> },
): Promise<Order> {
  if (order.status === "shipped" || order.status === "delivered") {
    throw new NeedsActionError(
      `Order ${order.orderNumber || order.id} has already been ${order.status}, so it cannot be cancelled — record a return instead.`,
    );
  }
  // 2026-09-26 (break test): cancelling a cancelled order again overwrote who
  // cancelled it, when and why — the record the audit trail is there to keep.
  if (order.status === "cancelled") {
    throw new NeedsActionError(`Order ${order.orderNumber || order.id} is already cancelled.`);
  }
  const now = timestamp();
  const passedQtyByLine = input.cancelQuantitiesByLine || {};
  const shippedByLine = order.shippedQuantityByLine || {};
  // 2026-09-27 (sector review M4): cancelling is CUMULATIVE. A second cancel on
  // a partial_cancelled order used to start again from the original quantities:
  // it replaced the first cancel's record (un-cancelling those units) and
  // rewrote the total, and a cancel with no quantities after a partial shipment
  // marked the SHIPPED units cancelled too. Now what can still be cancelled on
  // a line is ordered − shipped − already cancelled, and each cancel adds to
  // the record rather than replacing it. Shipped units are never cancellable.
  const cancelledBefore = order.cancelledQuantityByLine || {};
  const stillCancellable = (li: OrderLineItem) =>
    Math.max(0, sumQuantitiesExact(li.quantity, -(shippedByLine[li.id] || 0), -(cancelledBefore[li.id] || 0)));
  const anythingShipped = Object.values(shippedByLine).some((q) => q > 0);

  // Once anything has shipped, the caller MUST say what is being cancelled
  // (it is then a choice between "the rest of the order" and "some of it").
  // Without it, we can't compute the new grandTotal honestly.
  if (anythingShipped && Object.keys(passedQtyByLine).length === 0) {
    throw new NeedsActionError(
      `Order ${order.orderNumber || order.id} is partly shipped, so say how many of each item to cancel (cancelQuantitiesByLine). Shipped items cannot be cancelled.`,
    );
  }
  if (order.lineItems.every((li) => stillCancellable(li) <= 0)) {
    throw new NeedsActionError(
      `Nothing on order ${order.orderNumber || order.id} is left to cancel — every item has either shipped or already been cancelled.`,
    );
  }

  // 2026-07-26 Session 4 audit fix (P2-PARTIALCANCEL-1) — validate the caller's
  // cancelQuantitiesByLine BEFORE recording it in the audit trail. The audit
  // found 3 ways the un-validated input produced a lying audit record:
  //   (F) over-cancel: caller passes qty > unshipped → impossible qty persisted.
  //   (G) typo line id: caller passes a line id that doesn't exist on this
  //       order → fake audit-trail entry persisted forever.
  //   (H) qty=0: marks the order partial_cancelled despite nothing changing.
  // All 3 must throw now. Pinned by golden:partial-cancel-math CASES F/G/H.
  const knownLineIds = new Set(order.lineItems.map((li) => li.id));
  for (const [lineId, qty] of Object.entries(passedQtyByLine)) {
    if (!knownLineIds.has(lineId)) {
      throw new NeedsActionError(
        `cancelQuantitiesByLine references unknown line id "${lineId}" — this line is not on order ${order.id}. Check for typos; the audit trail only records real line items.`,
      );
    }
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) {
      throw new NeedsActionError(
        `cancelQuantitiesByLine.${lineId}=${qty} is invalid — cancel quantity must be a positive number. Use 0 entries to skip a line, not to mark it cancelled.`,
      );
    }
    const line = order.lineItems.find((li) => li.id === lineId)!;
    const alreadyShipped = shippedByLine[lineId] || 0;
    const alreadyCancelled = cancelledBefore[lineId] || 0;
    const cancellableQty = stillCancellable(line);
    if (qty > cancellableQty) {
      throw new NeedsActionError(
        `cancelQuantitiesByLine.${lineId}=${qty} exceeds cancellable quantity (${cancellableQty}; ${alreadyShipped} already shipped and ${alreadyCancelled} already cancelled on order ${order.orderNumber || order.id}). Audit trail cannot record more cancelled than was cancellable.`,
      );
    }
  }

  // The cumulative record: everything cancelled before, plus this cancel. With
  // no quantities (allowed only when nothing has shipped) this cancel takes
  // everything still cancellable.
  const thisCancel: Record<string, number> = Object.keys(passedQtyByLine).length > 0
    ? passedQtyByLine
    : Object.fromEntries(order.lineItems.map((li) => [li.id, stillCancellable(li)]).filter(([, q]) => (q as number) > 0));
  const cancelledQuantityByLine: Record<string, number> = { ...cancelledBefore };
  for (const [lineId, qty] of Object.entries(thisCancel)) {
    cancelledQuantityByLine[lineId] = sumQuantitiesExact(cancelledQuantityByLine[lineId] || 0, qty);
  }
  // Fully cancelled = every unit of every line is now cancelled. Anything
  // shipped, or any unit left to ship, keeps the order partial_cancelled.
  const isPartial = order.lineItems.some((li) => (cancelledQuantityByLine[li.id] || 0) < li.quantity);
  let newGrandTotal = order.grandTotal;

  if (isPartial) {
    // Recompute grandTotal = sum over lines of (surviving qty × unitPrice),
    // where surviving qty = originalQty − cancelledQty.
    //
    // 2026-08-05 audit fix (F-DATA-21): this MUST be `survivingQty`
    // unconditionally — it already includes the shipped portion, because
    // the validation block above caps `cancelledQty ≤ unshippedQty`
    // (unshippedQty = quantity − alreadyShipped). So shipped units are
    // NEVER inside cancelledQty, which means survivingQty always equals
    // (shipped units) + (unshipped units not cancelled) — exactly what
    // the customer keeps. The OLD code picked `shippedByLine[li.id]`
    // whenever the key existed, which dropped the surviving unshipped
    // units when the caller cancelled only SOME of the unshipped remainder
    // (hand-computed: qty=10, shipped=4, cancel=3 → expected ₹700, was ₹400).
    // Pinned by golden:audit-fixes-aug05 CASE A (the cancelQty < unshipped
    // case the prior golden:partial-cancel-math CASE B masks — that case
    // cancels the entire unshipped remainder where survivingQty == shipped).
    //
    // Stage A+ / P2-12: sum in integer paise (no float drift). Build a
    // synthetic lineItems-like array and reuse sumLineTotalsPaise.
    const survivingItems = order.lineItems.map((li) => {
      const cancelledQty = cancelledQuantityByLine[li.id] || 0;
      const survivingQty = Math.max(0, sumQuantitiesExact(li.quantity, -cancelledQty));
      return { quantity: survivingQty, unitPrice: li.unitPrice };
    });
    newGrandTotal = sumLineTotalsPaise(survivingItems);
  }
  // Full cancel: cancelledQuantityByLine already records every line's full
  // quantity (audit); grandTotal is left as it was (the order is dead).

  const newStatus = isPartial ? "partial_cancelled" : "cancelled";
  return {
    ...order,
    status: newStatus,
    grandTotal: newGrandTotal,
    cancelledAt: now,
    cancelledBy: input.actor,
    cancelReason: input.reason,
    cancelledQuantityByLine,
    updatedAt: now,
  };
}
