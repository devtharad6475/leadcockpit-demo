/**
 * Stage 3 / 2026-07-21 — Price-change notification service.
 *
 * When the owner changes a ProductSetting.price, this service identifies
 * which customers should be notified and renders the WhatsApp messages.
 *
 * Per docs/LOGIC.md 2026-07-21 — 6 guardrails:
 *   1. Per-workspace toggle notifyCustomersOnPriceChange (default OFF).
 *   2. Scope = OPEN commitments only (open quotes + unshipped orders).
 *   3. TWO-STEP approval: this service ONLY prepares a preview. The caller
 *      (API/UI) is responsible for actually sending after the owner clicks
 *      "Send all". This service NEVER sends anything.
 *   4. Owner-approved WhatsApp template (per workspace, stored on settings).
 *   5. Audit log of every notification SENT is written by the caller after
 *      approval, not here. (This service is pure; no I/O.)
 *   6. DNC registry respected — DNC customers are silently skipped and
 *      counted in skippedDncCount.
 *
 * This module is PURE — no repository I/O, no LLM, no WhatsApp calls. The
 * caller passes the relevant data in; the service returns the analysis
 * + rendered messages. That separation keeps the safety logic testable.
 *
 * Pinned by scripts/golden/golden-price-change-notify.ts.
 */
import type { Lead, Order, Quote } from "@/lib/types";
import { compareMoney, rupeesToPaise, paiseToRupees, formatINR } from "@/lib/money";

/**
 * The per-workspace settings that drive this feature. Lives on the
 * workspace's communication/AutomationSettings record. We accept just the
 * relevant slice here so the service stays decoupled.
 */
export type PriceChangeNotifySettings = {
  /** Guardrail 1 — toggle, default OFF. When false, no recipients are returned. */
  notifyCustomersOnPriceChange: boolean;
  /** Guardrail 4 — the owner-approved WhatsApp template id to send under. */
  templateId?: string;
};

/** Quote statuses that count as "open commitments" — customer hasn't decided yet. */
const OPEN_QUOTE_STATUSES = new Set(["draft", "sent", "accepted"]);

/** Order statuses that count as "unshipped commitments" — fulfilment hasn't completed. */
const UNSHIPPED_ORDER_STATUSES = new Set(["confirmed", "in_progress", "partial_shipped"]);

/** A single customer to notify about a price change. */
export type PriceChangeRecipient = {
  leadId: string;
  customerName: string;
  whatsappNumber?: string;
  /** The originating commitment that qualified them. */
  sourceType: "open_quote" | "unshipped_order";
  sourceId: string;
};

/** The result of analyzing who should be notified. */
export type PriceChangeRecipientsResult = {
  recipients: PriceChangeRecipient[];
  /** Customers skipped because they're on the DNC registry. */
  skippedDncCount: number;
};

/**
 * Find all customers who should be notified about a price change for the
 * given product. Implements guardrails 1, 2, 6.
 *
 * Pure function — no I/O. The caller passes the candidate leads, quotes,
 * orders, and the set of DNC'd lead ids.
 */
export function findPriceChangeRecipients(input: {
  workspaceId: string;
  productId: string;
  oldPrice: number;
  newPrice: number;
  settings: PriceChangeNotifySettings;
  leads: Lead[];
  quotes: Quote[];
  orders: Order[];
  /** Lead ids that are on the DNC registry (already resolved by caller). */
  dncLeadIds: Set<string>;
}): PriceChangeRecipientsResult {
  // Guardrail 1 — toggle OFF means no recipients, period.
  if (!input.settings.notifyCustomersOnPriceChange) {
    return { recipients: [], skippedDncCount: 0 };
  }

  const leadById = new Map(input.leads.map((l) => [l.id, l]));
  const qualifyingLeadIds = new Set<string>();
  const sources = new Map<string, { sourceType: "open_quote" | "unshipped_order"; sourceId: string }>();

  // Guardrail 2a — open quotes containing this product.
  for (const q of input.quotes) {
    if (!OPEN_QUOTE_STATUSES.has(q.status)) continue;
    if (!q.lineItems.some((li) => li.productId === input.productId)) continue;
    if (!qualifyingLeadIds.has(q.leadId)) {
      qualifyingLeadIds.add(q.leadId);
      sources.set(q.leadId, { sourceType: "open_quote", sourceId: q.id });
    }
  }

  // Guardrail 2b — unshipped orders containing this product.
  for (const o of input.orders) {
    if (!UNSHIPPED_ORDER_STATUSES.has(o.status)) continue;
    if (!o.lineItems.some((li) => li.productId === input.productId)) continue;
    if (!qualifyingLeadIds.has(o.leadId)) {
      qualifyingLeadIds.add(o.leadId);
      sources.set(o.leadId, { sourceType: "unshipped_order", sourceId: o.id });
    }
  }

  // Guardrail 6 — DNC customers are skipped + counted.
  const recipients: PriceChangeRecipient[] = [];
  let skippedDncCount = 0;
  for (const leadId of qualifyingLeadIds) {
    if (input.dncLeadIds.has(leadId)) {
      skippedDncCount += 1;
      continue;
    }
    const lead = leadById.get(leadId);
    if (!lead) continue;
    const source = sources.get(leadId)!;
    recipients.push({
      leadId,
      customerName: lead.contactName || lead.companyName || "Customer",
      whatsappNumber: lead.whatsappNumber,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
    });
  }

  return { recipients, skippedDncCount };
}

/** Rendered message body + the metadata for audit logging. */
export type RenderedPriceChangeMessage = {
  leadId: string;
  customerName: string;
  whatsappNumber?: string;
  productId: string;
  productName: string;
  oldPrice: number;
  newPrice: number;
  diff: number;
  direction: "increased" | "decreased" | "unchanged";
  body: string;
  templateId?: string;
};

/** A preview bundle for the UI two-step approval flow. */
export type PriceChangePreview = {
  productId: string;
  productName: string;
  oldPrice: number;
  newPrice: number;
  recipientCount: number;
  skippedDncCount: number;
  messages: RenderedPriceChangeMessage[];
};

/**
 * Render the WhatsApp message for a single customer. Implements the
 * template format from docs/LOGIC.md guardrail 4:
 *   "Hi {name}, the price of {product} has been updated from ₹{old} to
 *    ₹{new} ({direction}₹{diff}). Reply STOP to opt out."
 *
 * Pure function. Direction is "increased" if newPrice > oldPrice, "decreased"
 * if newPrice < oldPrice, or "unchanged" if equal. diff is always positive
 * (the absolute change amount).
 *
 * Cluster 9 / P2-13 fix: when newPrice === oldPrice, returns direction
 * "unchanged" with diff 0 + a body that explicitly says "no change". The
 * OLD ternary returned "decreased" for the equal case, producing the
 * confusing "decreased by ₹0" message. Callers can use direction==="unchanged"
 * to skip the recipient entirely (no point notifying about a no-op change).
 */
export function renderPriceChangeMessage(input: {
  customerName: string;
  productName: string;
  oldPrice: number;
  newPrice: number;
  templateId?: string;
}): { direction: "increased" | "decreased" | "unchanged"; diff: number; body: string } {
  // F13 (2026-08-04 CONTINUOUS-2 audit): use integer-paise money helpers
  // instead of raw float comparison/diff. This is customer-facing money text
  // in a WhatsApp message — a float-drift boundary could label a no-op change
  // "increased by ₹0.00". LOGIC.md routes every commercial calc through money.ts.
  const cmp = compareMoney(input.newPrice, input.oldPrice);
  const direction: "increased" | "decreased" | "unchanged" =
    cmp > 0 ? "increased"
    : cmp < 0 ? "decreased"
    : "unchanged";
  const diff = paiseToRupees(Math.abs(rupeesToPaise(input.newPrice) - rupeesToPaise(input.oldPrice)));
  // N-MONEY-3 (2026-08-26, S24-16): every amount below goes through formatINR.
  // F13 moved the ARITHMETIC onto integer paise but left the RENDERING raw, so
  // a paise-equal change still printed its float: "remains ₹450.0000001 (no
  // change)", and a 450.30→450.10 move printed "(+₹0.19999999999999996)". This
  // is customer-facing WhatsApp text and money.ts's own docblock says formatINR
  // is to be used everywhere money is shown to a user. Pinned by
  // scripts/golden/golden-audit-fixes-aug04-2.ts CASE E (mutation m21).
  if (direction === "unchanged") {
    // No-op price change — honest body that says so. Callers should usually
    // skip the recipient (see findPriceChangeRecipients), but if a message
    // is rendered it must NOT say "decreased by ₹0".
    const body =
      `Hi ${input.customerName}, the price of ${input.productName} remains ` +
      `${formatINR(input.newPrice)} (no change). Reply STOP to opt out.`;
    return { direction, diff, body };
  }
  const body =
    `Hi ${input.customerName}, the price of ${input.productName} has been ` +
    `${direction} from ${formatINR(input.oldPrice)} to ${formatINR(input.newPrice)} ` +
    `(${direction === "increased" ? "+" : "-"}${formatINR(diff)}). Reply STOP to opt out.`;
  return { direction, diff, body };
}

/**
 * Build the full preview for the two-step approval flow (guardrail 3).
 * Combines findPriceChangeRecipients + renderPriceChangeMessage. Does NOT
 * send anything — the caller sends after the owner approves.
 *
 * Pure function — no I/O.
 */
export function previewPriceChangeNotifications(input: {
  workspaceId: string;
  productId: string;
  productName: string;
  oldPrice: number;
  newPrice: number;
  settings: PriceChangeNotifySettings;
  leads: Lead[];
  quotes: Quote[];
  orders: Order[];
  dncLeadIds: Set<string>;
}): PriceChangePreview {
  const { recipients, skippedDncCount } = findPriceChangeRecipients({
    workspaceId: input.workspaceId,
    productId: input.productId,
    oldPrice: input.oldPrice,
    newPrice: input.newPrice,
    settings: input.settings,
    leads: input.leads,
    quotes: input.quotes,
    orders: input.orders,
    dncLeadIds: input.dncLeadIds,
  });

  const messages: RenderedPriceChangeMessage[] = recipients.map((r) => {
    const rendered = renderPriceChangeMessage({
      customerName: r.customerName,
      productName: input.productName,
      oldPrice: input.oldPrice,
      newPrice: input.newPrice,
      templateId: input.settings.templateId,
    });
    return {
      leadId: r.leadId,
      customerName: r.customerName,
      whatsappNumber: r.whatsappNumber,
      productId: input.productId,
      productName: input.productName,
      oldPrice: input.oldPrice,
      newPrice: input.newPrice,
      diff: rendered.diff,
      direction: rendered.direction,
      body: rendered.body,
      templateId: input.settings.templateId,
    };
  });

  return {
    productId: input.productId,
    productName: input.productName,
    oldPrice: input.oldPrice,
    newPrice: input.newPrice,
    recipientCount: recipients.length,
    skippedDncCount,
    messages,
  };
}
