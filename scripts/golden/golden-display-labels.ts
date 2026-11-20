/**
 * Golden test — Display label map (Stage 4/5 Batch 4 Q18-Q20).
 *
 * Phase 1.5 / skill v2 — written BEFORE the code.
 *
 * Operator-confirmed rules (docs/LOGIC.md, 2026-07-21):
 *   - No backend code/enum value is shown raw to the user. Every code
 *     flows through displayLabel(code). The audit found 26+ sites of
 *     .replaceAll("_", " ") and raw Badge dumps of "mql", "do_not_contact",
 *     "fast_customer_reply", etc.
 *
 * Hand-computed expected values:
 *
 *   CASE A — Lead status: every LeadStatus value maps to a friendly
 *     label. "needs_review" → "Needs review" (not "needs review").
 *
 *   CASE B — Review status: "pending" → "Pending review", "approved" →
 *     "Approved", "rejected" → "Rejected", "unsure" → "Unsure".
 *
 *   CASE C — Ticket status: "open" → "Open", "in_progress" → "In
 *     progress", "waiting_customer" → "Waiting on customer", "resolved"
 *     → "Resolved", "closed" → "Closed", "reopened" → "Reopened".
 *
 *   CASE D — Ticket priority + tone: urgent → "Urgent" + danger tone,
 *     high → "High" + warning tone, medium → "Medium" + info tone,
 *     low → "Low" + neutral tone.
 *
 *   CASE E — Order status: every OrderStatus value has a label + the
 *     cancelled/partial_cancelled ones get danger tone.
 *
 *   CASE F — Quote status: every QuoteStatus value has a label.
 *
 *   CASE G — Enrichment status: "not_started" → "Not started",
 *     "completed" → "Completed", "failed" → "Failed", etc.
 *
 *   CASE H — Reply classification: "complaint" → "Complaint",
 *     "price_request" → "Price question", "unsubscribe" → "Opt-out
 *     request", etc.
 *
 *   CASE I — Agent autonomy mode: "draft_only" → "Drafts only (no
 *     auto-send)", "safe_auto_reply" → "Safe auto-reply", etc.
 *
 *   CASE J — Unknown code → returns the code itself (don't crash).
 *     displayLeadStatus("nonexistent_code") returns "nonexistent_code".
 *
 *   CASE K — No snake_case leaks: no label contains an underscore.
 *     (Exhaustive check.)
 *
 *   CASE L — Label is NEVER the same as the code: every label has been
 *     humanized (capitalized, spaces, or expanded words).
 *
 * Run: npx tsx scripts/golden/golden-display-labels.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import {
  displayLeadStatus,
  displayReviewStatus,
  displayTicketStatus,
  displayTicketPriority,
  displayTicketPriorityTone,
  displayOrderStatus,
  displayOrderStatusTone,
  displayQuoteStatus,
  displayEnrichmentStatus,
  displayReplyClassification,
  displayAgentMode,
  displayLabel,
} from "@/lib/display-labels";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  // === CASE A — Lead status ===
  assert(displayLeadStatus("needs_review") === "Needs review", `CASE A: needs_review`);
  assert(displayLeadStatus("approved") === "Approved", `CASE A: approved`);
  assert(displayLeadStatus("do_not_contact") === "Do not contact", `CASE A: do_not_contact`);
  assert(displayLeadStatus("hot_lead") === "Hot lead", `CASE A: hot_lead`);
  assert(displayLeadStatus("mql") === "Warm lead", `CASE A: mql should expand to plain words`);
  assert(displayLeadStatus("sql") === "Ready to talk", `CASE A: sql should expand to plain words`);
  assert(displayLeadStatus("closed_won") === "Won", `CASE A: closed_won should be friendly`);
  assert(displayLeadStatus("closed_lost") === "Lost", `CASE A: closed_lost`);
  console.log(`  CASE A OK: lead status labels.`);

  // === CASE B — Review status ===
  assert(displayReviewStatus("pending") === "Pending review", `CASE B: pending`);
  assert(displayReviewStatus("approved") === "Approved", `CASE B: approved`);
  assert(displayReviewStatus("rejected") === "Rejected", `CASE B: rejected`);
  assert(displayReviewStatus("unsure") === "Unsure", `CASE B: unsure`);
  console.log(`  CASE B OK: review status labels.`);

  // === CASE C — Ticket status ===
  assert(displayTicketStatus("open") === "Open", `CASE C: open`);
  assert(displayTicketStatus("in_progress") === "In progress", `CASE C: in_progress`);
  assert(displayTicketStatus("waiting_customer") === "Waiting on customer", `CASE C: waiting_customer`);
  assert(displayTicketStatus("resolved") === "Resolved", `CASE C: resolved`);
  assert(displayTicketStatus("closed") === "Closed", `CASE C: closed`);
  assert(displayTicketStatus("reopened") === "Reopened", `CASE C: reopened`);
  console.log(`  CASE C OK: ticket status labels.`);

  // === CASE D — Ticket priority + tone ===
  assert(displayTicketPriority("urgent") === "Urgent", `CASE D: urgent`);
  assert(displayTicketPriority("high") === "High", `CASE D: high`);
  assert(displayTicketPriority("medium") === "Medium", `CASE D: medium`);
  assert(displayTicketPriority("low") === "Low", `CASE D: low`);
  assert(displayTicketPriorityTone("urgent") === "danger", `CASE D: urgent tone`);
  assert(displayTicketPriorityTone("high") === "warning", `CASE D: high tone`);
  assert(displayTicketPriorityTone("medium") === "info", `CASE D: medium tone`);
  assert(displayTicketPriorityTone("low") === "neutral", `CASE D: low tone`);
  console.log(`  CASE D OK: ticket priority + tone.`);

  // === CASE E — Order status + tone ===
  assert(displayOrderStatus("draft") === "Draft", `CASE E: draft`);
  assert(displayOrderStatus("confirmed") === "Confirmed", `CASE E: confirmed`);
  assert(displayOrderStatus("in_progress") === "In progress", `CASE E: in_progress`);
  assert(displayOrderStatus("partial_shipped") === "Partially shipped", `CASE E: partial_shipped`);
  assert(displayOrderStatus("shipped") === "Shipped", `CASE E: shipped`);
  assert(displayOrderStatus("delivered") === "Delivered", `CASE E: delivered`);
  assert(displayOrderStatus("cancelled") === "Cancelled", `CASE E: cancelled`);
  assert(displayOrderStatus("partial_cancelled") === "Partially cancelled", `CASE E: partial_cancelled`);
  assert(displayOrderStatus("returned") === "Returned", `CASE E: returned`);
  assert(displayOrderStatusTone("delivered") === "success", `CASE E: delivered tone`);
  assert(displayOrderStatusTone("cancelled") === "danger", `CASE E: cancelled tone`);
  assert(displayOrderStatusTone("partial_cancelled") === "danger", `CASE E: partial_cancelled tone`);
  console.log(`  CASE E OK: order status + tone.`);

  // === CASE F — Quote status ===
  assert(displayQuoteStatus("draft") === "Draft", `CASE F: draft`);
  assert(displayQuoteStatus("sent") === "Sent", `CASE F: sent`);
  assert(displayQuoteStatus("accepted") === "Accepted", `CASE F: accepted`);
  assert(displayQuoteStatus("rejected") === "Rejected", `CASE F: rejected`);
  assert(displayQuoteStatus("expired") === "Expired", `CASE F: expired`);
  assert(displayQuoteStatus("superseded") === "Superseded", `CASE F: superseded`);
  assert(displayQuoteStatus("converted") === "Converted to order", `CASE F: converted`);
  console.log(`  CASE F OK: quote status labels.`);

  // === CASE G — Enrichment status ===
  assert(displayEnrichmentStatus("not_started") === "Not started", `CASE G: not_started`);
  assert(displayEnrichmentStatus("pending") === "Pending", `CASE G: pending`);
  assert(displayEnrichmentStatus("running") === "Running", `CASE G: running`);
  assert(displayEnrichmentStatus("completed") === "Completed", `CASE G: completed`);
  assert(displayEnrichmentStatus("failed") === "Failed", `CASE G: failed`);
  console.log(`  CASE G OK: enrichment status labels.`);

  // === CASE H — Reply classification ===
  assert(displayReplyClassification("complaint") === "Complaint", `CASE H: complaint`);
  assert(displayReplyClassification("price_request") === "Price question", `CASE H: price_request`);
  assert(displayReplyClassification("unsubscribe") === "Opt-out request", `CASE H: unsubscribe`);
  assert(displayReplyClassification("hot_lead") === "Hot lead", `CASE H: hot_lead`);
  assert(displayReplyClassification("unknown_question") === "Question we can't answer", `CASE H: unknown_question`);
  console.log(`  CASE H OK: reply classification labels.`);

  // === CASE I — Agent autonomy mode ===
  assert(displayAgentMode("draft_only") === "Drafts only (no auto-send)", `CASE I: draft_only`);
  assert(displayAgentMode("safe_auto_reply") === "Automatic replies (ticked kinds only)", `CASE I: safe_auto_reply`);
  console.log(`  CASE I OK: agent mode labels.`);

  // === CASE J — Unknown code does not crash ===
  assert(displayLeadStatus("nonexistent") === "nonexistent", `CASE J: unknown returns input`);
  assert(displayTicketStatus("unknown_status") === "unknown_status", `CASE J: unknown ticket`);
  console.log(`  CASE J OK: unknown codes don't crash.`);

  // === CASE K — No underscores in any known label ===
  const allLabels = [
    ...["needs_review","approved","rejected","hot_lead","mql","sql","closed_won","closed_lost","do_not_contact","contacted","replied","interested","not_interested","won","lost"].map(displayLeadStatus),
    ...["pending","approved","rejected","unsure"].map(displayReviewStatus),
    ...["open","in_progress","waiting_customer","resolved","closed","reopened"].map(displayTicketStatus),
    ...["urgent","high","medium","low"].map(displayTicketPriority),
    ...["draft","quoted","confirmed","in_progress","partial_shipped","shipped","delivered","cancelled","partial_cancelled","returned"].map(displayOrderStatus),
    ...["draft","sent","accepted","rejected","expired","superseded","converted"].map(displayQuoteStatus),
    ...["not_started","pending","running","completed","failed"].map(displayEnrichmentStatus),
    ...["complaint","price_request","unsubscribe","hot_lead","unknown_question"].map(displayReplyClassification),
    ...["draft_only","safe_auto_reply"].map(displayAgentMode),
  ];
  for (const label of allLabels) {
    assert(!label.includes("_"), `CASE K: label "${label}" should not contain underscores`);
  }
  console.log(`  CASE K OK: no underscores in any of ${allLabels.length} labels.`);

  // === CASE L — Generic displayLabel helper ===
  assert(displayLabel("some_snake_case") === "Some snake case", `CASE L: generic fallback`);
  assert(displayLabel("ALREADY_UPPER") === "ALREADY UPPER", `CASE L: preserves caps`);
  console.log(`  CASE L OK: generic displayLabel fallback.`);

  console.log("PASS golden-display-labels: all 12 cases match.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
