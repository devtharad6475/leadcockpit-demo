/**
 * status-transitions.ts — the ONE place that says which lifecycle move is
 * legal, for quotes and for orders (N-DATA-12).
 *
 * WHY THIS EXISTS (2026-08-20, CEO-loop session 11)
 * ------------------------------------------------
 * `POST /quotes/:id/status` and `POST /orders/:id/status` validated the TARGET
 * status against the type union and nothing else. The status a document was
 * ALREADY in was never consulted. So both of these were accepted, with a 200:
 *
 *     accepted  → draft     (a quote the customer signed, back to a draft)
 *     delivered → draft     (a delivered order, back to a draft)
 *
 * and the drawer's own dropdown offered every status except the current one,
 * so the operator was actively invited to make the move.
 *
 * The product already knew this was wrong and said so in a different route.
 * `POST /quotes/:id/revise` refuses with QUOTE_COMMITTED: "A quote the customer
 * has committed to can't be revised — create a new quote instead so the agreed
 * price stays on record." One route protects the agreed price; the sibling let
 * it be edited away by a dropdown.
 *
 * WHY THE MAP IS SHARED WITH THE UI. The route and the drawer had drifted
 * apart precisely because each held its own idea of what was offerable. The
 * drawer imports these same maps to build its options, so a status the API
 * refuses can no longer appear in the list, and a rule change lands in both
 * places at once.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   - `converted` / `superseded` (quotes) and `cancelled` / `partial_cancelled`
 *     (orders) are absent from every target list. They are owned by dedicated
 *     routes (/convert, /revise, /cancel) that do the linked work — creating
 *     the order, linking the replacement, recomputing the cancelled totals.
 *     The status routes already redirect callers there by name (F-DATA-2,
 *     F-DATA-5 / D5); this map keeps them unreachable from the generic path.
 *   - Re-entering the SAME status. `isAllowedTransition(x, x)` is true. A
 *     re-send is a real operator action, and the timestamp guards in the routes
 *     already make it non-destructive (the original sentAt survives).
 *
 * Pinned by scripts/golden/golden-status-transitions.ts (CASES A–E).
 */
import type { QuoteStatus, OrderStatus } from "@/lib/types";

/**
 * Quote lifecycle. A quote moves forward through the customer conversation and
 * then stops: once it is rejected or expired it is history, and the way to
 * quote again is a NEW quote (which is what /revise creates), not an edit of
 * the record of what was already said.
 *
 * `accepted → rejected` IS allowed: customers do back out after saying yes, and
 * that has to be recordable. `acceptedAt` is not cleared when it happens, so
 * the trail still shows that they accepted first and withdrew after.
 */
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ["sent", "rejected", "expired"],
  sent: ["accepted", "rejected", "expired"],
  accepted: ["rejected"],
  rejected: [],
  expired: [],
  // Terminal, and owned by /revise and /convert respectively.
  superseded: [],
  converted: [],
};

/**
 * Order lifecycle. Forward through fulfilment, with `returned` reachable only
 * from a state where the goods actually reached the customer — you cannot
 * return what was never shipped.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ["quoted", "confirmed"],
  quoted: ["confirmed"],
  confirmed: ["in_progress", "partial_shipped", "shipped"],
  in_progress: ["partial_shipped", "shipped"],
  partial_shipped: ["shipped", "delivered"],
  shipped: ["delivered", "returned"],
  delivered: ["returned"],
  // Terminal. Cancellation is owned by /cancel, which records the cancelled
  // quantities and the recomputed total.
  cancelled: [],
  partial_cancelled: ["partial_shipped", "shipped", "delivered"],
  returned: [],
};

export function nextQuoteStatuses(from: QuoteStatus): readonly QuoteStatus[] {
  return QUOTE_TRANSITIONS[from] ?? [];
}

export function nextOrderStatuses(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_TRANSITIONS[from] ?? [];
}

/** True when `from → to` is legal. Re-entering the same status is always legal. */
export function isAllowedQuoteTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return from === to || nextQuoteStatuses(from).includes(to);
}

/** True when `from → to` is legal. Re-entering the same status is always legal. */
export function isAllowedOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return from === to || nextOrderStatuses(from).includes(to);
}

/**
 * The refusal an operator reads. It names where the document is, what was
 * asked for, and what CAN be done from here — a bare "invalid transition"
 * leaves them clicking options to find out which ones work.
 */
export function transitionRefusal(
  kind: "quote" | "order",
  from: string,
  to: string,
  allowed: readonly string[],
): string {
  const onward = allowed.length
    ? `From "${from}" you can move to: ${allowed.join(", ")}.`
    : `"${from}" is the end of the line for a ${kind} — nothing follows it.`;
  return (
    `This ${kind} is "${from}", so it cannot be moved to "${to}". ${onward} ` +
    `A ${kind} that has already been ${from} is a record of what happened; ` +
    `to change what you are offering the customer, create a new one instead.`
  );
}
