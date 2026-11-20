/**
 * Golden test — Price-change notification system (Stage 3 — Batch 2 Q9 extended).
 *
 * Phase 1.5 / skill v2 — written BEFORE the service code.
 *
 * Operator-confirmed rules (docs/LOGIC.md 2026-07-21 — 6 guardrails):
 *   1. Per-workspace toggle `notifyCustomersOnPriceChange` (default OFF).
 *   2. Scope = open commitments only: open Quotes (not expired/rejected/
 *      converted) AND unshipped Orders (confirmed/in_progress/partial_shipped)
 *      containing this product. NOT past customers who already received.
 *   3. Two-step approval: preview → owner clicks send (no instant auto-send).
 *   4. Owner-approved WhatsApp template (per workspace).
 *   5. Audit log entry per notification sent.
 *   6. DNC registry respected — DNC customers are silently skipped + counted.
 *
 * This test focuses on the PURE functions:
 *   - findPriceChangeRecipients(input) → who should be notified
 *   - previewPriceChangeNotifications(input) → no sends, just a preview
 *   - renderPriceChangeMessage(input) → fills the template
 *
 * Hand-computed expected values:
 *
 *   CASE A — Toggle OFF: returns 0 recipients (no matter what data exists).
 *
 *   CASE B — Toggle ON + 1 open quote for the product → 1 recipient.
 *
 *   CASE C — Toggle ON + expired/rejected/converted quotes → 0 recipients
 *     (only open quotes count).
 *
 *   CASE D — Toggle ON + 1 unshipped order containing the product → 1
 *     recipient.
 *
 *   CASE E — Toggle ON + delivered/shipped order containing the product →
 *     0 recipients (already shipped, customer doesn't need to know).
 *
 *   CASE F — DNC customer skipped: 1 open quote but lead is DNC → 0
 *     recipients in the "to notify" list, 1 in the "skipped: DNC" list.
 *
 *   CASE G — Multiple recipients across quotes + orders: de-duplicated by
 *     leadId (same customer has both an open quote AND an unshipped order →
 *     counts once).
 *
 *   CASE H — previewPriceChangeNotifications returns the rendered message
 *     per recipient with old/new/diff filled in. No sends happen.
 *
 *   CASE I — renderPriceChangeMessage math: old=450, new=480 → diff=30,
 *     direction="increased". old=480, new=450 → diff=30, direction=
 *     "decreased".
 *
 *   CASE J — No recipients → preview summary shows count=0, no messages.
 *
 * Run: npx tsx scripts/golden/golden-price-change-notify.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import {
  findPriceChangeRecipients,
  previewPriceChangeNotifications,
  renderPriceChangeMessage,
} from "@/services/PriceChangeNotifyService";
import type { Lead, Order, Quote } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const lead = (overrides: Partial<Lead>): Lead => ({
  id: "lead1",
  workspaceId: "ws1",
  contactName: "Test Customer",
  whatsappNumber: undefined,
  leadScore: 0,
  fitScore: 0,
  needScore: 0,
  reachabilityScore: 0,
  timingScore: 0,
  confidenceScore: 0,
  doNotContact: false,
  status: "needs_review",
  reviewStatus: "pending",
  enrichmentStatus: "not_started",
  createdAt: "2026-07-21T00:00:00Z",
  updatedAt: "2026-07-21T00:00:00Z",
  ...overrides,
});

const quoteWithProduct = (overrides: Partial<Omit<Quote, "leadId" | "status" | "quoteNumber">> & { leadId: string; status: Quote["status"] }): Quote => {
  const base: Quote = {
    id: "q1",
    workspaceId: "ws1",
    quoteNumber: 1,
    leadId: overrides.leadId,
    status: overrides.status,
    lineItems: [{
      id: "qli1",
      productId: "p1",
      productName: "Zari",
      quantity: 10,
      unit: "kg",
      unitPrice: 450,
      currencyCode: "INR",
      lineTotal: 4500,
    }],
    grandTotal: 4500,
    currencyCode: "INR",
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
  };
  return { ...base, ...overrides };
};

const orderWithProduct = (overrides: Partial<Omit<Order, "leadId" | "status" | "orderNumber">> & { leadId: string; status: Order["status"] }): Order => {
  const base: Order = {
    id: "o1",
    workspaceId: "ws1",
    orderNumber: 1,
    leadId: overrides.leadId,
    status: overrides.status,
    lineItems: [{
      id: "oli1",
      productId: "p1",
      productName: "Zari",
      quantity: 10,
      unit: "kg",
      unitPrice: 450,
      currencyCode: "INR",
      lineTotal: 4500,
    }],
    grandTotal: 4500,
    currencyCode: "INR",
    origin: "direct",
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
  };
  return { ...base, ...overrides };
};

async function main() {
  // === CASE A — Toggle OFF ===
  const toggleOff = findPriceChangeRecipients({
    workspaceId: "ws1",
    productId: "p1",
    oldPrice: 450,
    newPrice: 480,
    settings: { notifyCustomersOnPriceChange: false, templateId: "tpl1" },
    leads: [lead({ id: "lead1" })],
    quotes: [quoteWithProduct({ leadId: "lead1", status: "sent" })],
    orders: [],
    dncLeadIds: new Set<string>(),
  });
  assert(toggleOff.recipients.length === 0, `CASE A: toggle OFF → 0 recipients`);
  console.log(`  CASE A OK: toggle OFF → 0 recipients.`);

  // === CASE B — Toggle ON + 1 open quote → 1 recipient ===
  const oneOpen = findPriceChangeRecipients({
    workspaceId: "ws1",
    productId: "p1",
    oldPrice: 450,
    newPrice: 480,
    settings: { notifyCustomersOnPriceChange: true, templateId: "tpl1" },
    leads: [lead({ id: "lead1", whatsappNumber: "+911234567890" })],
    quotes: [quoteWithProduct({ leadId: "lead1", status: "sent" })],
    orders: [],
    dncLeadIds: new Set<string>(),
  });
  assert(oneOpen.recipients.length === 1, `CASE B: expected 1 recipient, got ${oneOpen.recipients.length}`);
  assert(oneOpen.recipients[0].leadId === "lead1", `CASE B: recipient is lead1`);
  console.log(`  CASE B OK: 1 open quote → 1 recipient.`);

  // === CASE C — Toggle ON + only expired/rejected/converted quotes → 0 ===
  const noOpen = findPriceChangeRecipients({
    workspaceId: "ws1",
    productId: "p1",
    oldPrice: 450,
    newPrice: 480,
    settings: { notifyCustomersOnPriceChange: true, templateId: "tpl1" },
    leads: [lead({ id: "lead1", whatsappNumber: "+911234567890" })],
    quotes: [
      quoteWithProduct({ leadId: "lead1", status: "expired" }),
      quoteWithProduct({ leadId: "lead1", status: "rejected" }),
      quoteWithProduct({ leadId: "lead1", status: "converted" }),
    ],
    orders: [],
    dncLeadIds: new Set<string>(),
  });
  assert(noOpen.recipients.length === 0, `CASE C: only expired/rejected/converted → 0 recipients`);
  console.log(`  CASE C OK: closed quote statuses → 0 recipients.`);

  // === CASE D — Toggle ON + unshipped order containing product → 1 ===
  const unshipped = findPriceChangeRecipients({
    workspaceId: "ws1",
    productId: "p1",
    oldPrice: 450,
    newPrice: 480,
    settings: { notifyCustomersOnPriceChange: true, templateId: "tpl1" },
    leads: [lead({ id: "lead1", whatsappNumber: "+911234567890" })],
    quotes: [],
    orders: [orderWithProduct({ leadId: "lead1", status: "confirmed" })],
    dncLeadIds: new Set<string>(),
  });
  assert(unshipped.recipients.length === 1, `CASE D: unshipped order → 1 recipient`);
  console.log(`  CASE D OK: unshipped order → 1 recipient.`);

  // === CASE E — Delivered order → 0 recipients ===
  const delivered = findPriceChangeRecipients({
    workspaceId: "ws1",
    productId: "p1",
    oldPrice: 450,
    newPrice: 480,
    settings: { notifyCustomersOnPriceChange: true, templateId: "tpl1" },
    leads: [lead({ id: "lead1", whatsappNumber: "+911234567890" })],
    quotes: [],
    orders: [orderWithProduct({ leadId: "lead1", status: "delivered" })],
    dncLeadIds: new Set<string>(),
  });
  assert(delivered.recipients.length === 0, `CASE E: delivered order → 0 recipients`);
  console.log(`  CASE E OK: delivered order → 0 recipients.`);

  // === CASE F — DNC customer skipped + counted ===
  const dnc = findPriceChangeRecipients({
    workspaceId: "ws1",
    productId: "p1",
    oldPrice: 450,
    newPrice: 480,
    settings: { notifyCustomersOnPriceChange: true, templateId: "tpl1" },
    leads: [lead({ id: "lead1", whatsappNumber: "+911234567890" })],
    quotes: [quoteWithProduct({ leadId: "lead1", status: "sent" })],
    orders: [],
    dncLeadIds: new Set(["lead1"]),
  });
  assert(dnc.recipients.length === 0, `CASE F: DNC customer not in recipients`);
  assert(dnc.skippedDncCount === 1, `CASE F: DNC skip count = 1, got ${dnc.skippedDncCount}`);
  console.log(`  CASE F OK: DNC customer skipped + counted.`);

  // === CASE G — De-duplicated by leadId ===
  const dupes = findPriceChangeRecipients({
    workspaceId: "ws1",
    productId: "p1",
    oldPrice: 450,
    newPrice: 480,
    settings: { notifyCustomersOnPriceChange: true, templateId: "tpl1" },
    leads: [lead({ id: "lead1", whatsappNumber: "+911234567890" })],
    quotes: [quoteWithProduct({ leadId: "lead1", status: "sent" })],
    orders: [orderWithProduct({ leadId: "lead1", status: "confirmed" })],
    dncLeadIds: new Set<string>(),
  });
  assert(dupes.recipients.length === 1, `CASE G: lead with both quote+order counts once, got ${dupes.recipients.length}`);
  console.log(`  CASE G OK: de-duplicated by leadId.`);

  // === CASE H — previewPriceChangeNotifications returns rendered msgs ===
  const preview = previewPriceChangeNotifications({
    workspaceId: "ws1",
    productId: "p1",
    productName: "Zari",
    oldPrice: 450,
    newPrice: 480,
    settings: { notifyCustomersOnPriceChange: true, templateId: "tpl1" },
    leads: [lead({ id: "lead1", contactName: "Anil", whatsappNumber: "+911234567890" })],
    quotes: [quoteWithProduct({ leadId: "lead1", status: "sent" })],
    orders: [],
    dncLeadIds: new Set<string>(),
  });
  assert(preview.recipientCount === 1, `CASE H: preview count = 1`);
  assert(preview.messages.length === 1, `CASE H: 1 rendered message`);
  assert(preview.messages[0].body.includes("Anil"), `CASE H: message addresses customer by name`);
  assert(preview.messages[0].body.includes("450"), `CASE H: message contains old price`);
  assert(preview.messages[0].body.includes("480"), `CASE H: message contains new price`);
  console.log(`  CASE H OK: preview renders messages with old/new price.`);

  // === CASE I — renderPriceChangeMessage math ===
  const increased = renderPriceChangeMessage({
    customerName: "Anil",
    productName: "Zari",
    oldPrice: 450,
    newPrice: 480,
  });
  assert(increased.direction === "increased", `CASE I: 450→480 = increased`);
  assert(increased.diff === 30, `CASE I: diff = 30, got ${increased.diff}`);
  assert(increased.body.includes("increased"), `CASE I: body mentions "increased"`);
  const decreased = renderPriceChangeMessage({
    customerName: "Anil",
    productName: "Zari",
    oldPrice: 480,
    newPrice: 450,
  });
  assert(decreased.direction === "decreased", `CASE I: 480→450 = decreased`);
  assert(decreased.diff === 30, `CASE I: diff = 30`);
  console.log(`  CASE I OK: direction + diff math correct.`);

  // === CASE J — No recipients → empty preview ===
  const empty = previewPriceChangeNotifications({
    workspaceId: "ws1",
    productId: "p1",
    productName: "Zari",
    oldPrice: 450,
    newPrice: 480,
    settings: { notifyCustomersOnPriceChange: true, templateId: "tpl1" },
    leads: [],
    quotes: [],
    orders: [],
    dncLeadIds: new Set<string>(),
  });
  assert(empty.recipientCount === 0, `CASE J: empty preview count = 0`);
  assert(empty.messages.length === 0, `CASE J: no messages`);
  console.log(`  CASE J OK: no recipients → empty preview.`);

  console.log("PASS golden-price-change-notify: all 10 cases match the 6 guardrails.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
