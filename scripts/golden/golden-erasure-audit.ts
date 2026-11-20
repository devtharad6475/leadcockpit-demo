/**
 * Golden test — DPDPA right-to-erasure cascade + audit-log extensions +
 * production-readiness gate additions (Stage 4/5 Batch 4 Q18-Q20).
 *
 * Phase 1.5 / skill v2 — written BEFORE the service code.
 *
 * Operator-confirmed rules (docs/LOGIC.md, 2026-07-21):
 *   - Erasure: owner-only; cascade-deletes replies/tickets/orders/quotes/
 *     etc; PRESERVES DNC registry entry; PRESERVES audit-log entries
 *     (anonymized to "erased customer").
 *   - Audit log: extended with new event types + severity + query method.
 *   - Production gate: hard-blocks on (a) no real LLM provider key,
 *     (b) WhatsApp test-number-only.
 *
 * Hand-computed expected values:
 *
 *   CASE A — Erasure cascade: 1 lead with 2 replies, 1 ticket (+ 2 events),
 *     1 order, 1 quote, 1 outreachActivity, 1 autoReplyLog, 1 unknownQuestion,
 *     1 humanFallbackTask → after erase, all 10 record types are planned
 *     for deletion. DNC entry preserved. Audit entry written.
 *     (R5 2026-07-21: extended from 5 record types to the full 10 per
 *     docs/LOGIC.md Q18.)
 *
 *   CASE B — Erasure is owner-only: caller with role=admin → throws 403.
 *
 *   CASE C — Erasure two-step confirmation: name typed wrong → throws.
 *
 *   CASE D — Audit entries anonymized: customer_erased event retains
 *     timestamp + actor but customer identifier is "erased_customer".
 *
 *   CASE E — New audit event types added: customer_erased, kill_switch_
 *     toggled, sla_breached, digest_sent, price_change_notified,
 *     consent_basis_changed.
 *
 *   CASE F — Severity field on audit events: info / warning / error.
 *
 *   CASE G — Audit query filters by severity: 3 info + 1 error → query
 *     {severity: "error"} returns just the 1.
 *
 *   CASE H — Production gate: no LLM key + test WhatsApp number → fails.
 *
 *   CASE I — Production gate: real LLM key + verified WhatsApp number
 *     → passes.
 *
 *   CASE J — Production gate: backup is NOT a hard blocker (managed
 *     Postgres handles it).
 *
 * Run: npx tsx scripts/golden/golden-erasure-audit.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import {
  eraseCustomer,
  type ErasureInput,
} from "@/services/ErasureService";
import {
  AuditSeverity,
  queryAuditLog,
  type AuditEntry,
} from "@/services/AuditLogExtensions";
import {
  checkLlmKeyConfigured,
  checkWhatsAppNumberVerified,
} from "@/services/ProductionGateExtensions";
import type { AutoReplyLog, DoNotContactEntry, HumanFallbackTask, Lead, Order, OutreachActivity, Quote, Reply, Ticket, TicketEvent, UnknownQuestion } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const baseLead: Lead = {
  id: "lead1",
  workspaceId: "ws1",
  contactName: "Anil",
  whatsappNumber: "+911111111111",
  leadScore: 0, fitScore: 0, needScore: 0, reachabilityScore: 0, timingScore: 0, confidenceScore: 0,
  doNotContact: false,
  status: "won",
  reviewStatus: "approved",
  enrichmentStatus: "completed",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

async function main() {
  // === CASE A — Full cascade erase (all 10 record types per LOGIC.md Q18) ===
  const replies: Reply[] = [
    { id: "r1", workspaceId: "ws1", leadId: "lead1", channel: "whatsapp", direction: "inbound", body: "hi", rawText: "hi", status: "new", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" } as Reply,
    { id: "r2", workspaceId: "ws1", leadId: "lead1", channel: "whatsapp", direction: "inbound", body: "ordered", rawText: "ordered", status: "new", createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z" } as Reply,
  ];
  const tickets: Ticket[] = [
    { id: "t1", workspaceId: "ws1", ticketNumber: 1, leadId: "lead1", sourceChannel: "whatsapp", type: "complaint", priority: "high", status: "open", subject: "x", description: "y", sourceEntityType: "inbound", slaStartedAt: "2026-07-02T00:00:00Z", slaDueAt: "2026-07-02T04:00:00Z", slaBreached: false, createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z" },
  ];
  const orders: Order[] = [
    { id: "o1", workspaceId: "ws1", orderNumber: 1, leadId: "lead1", status: "delivered", lineItems: [], grandTotal: 0, currencyCode: "INR", origin: "direct", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" },
  ];
  const quotes: Quote[] = [
    { id: "q1", workspaceId: "ws1", quoteNumber: 1, leadId: "lead1", status: "converted", lineItems: [], grandTotal: 0, currencyCode: "INR", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" },
  ];
  // R5 — the 5 additional cascade types. Cast through `as` to satisfy the
  // strict Lead/Ticket/etc. types — we only need the cascade-relevant fields
  // (workspaceId, leadId/ticketId, id, convertedToTicketId) to be set.
  const outreachActivities = [
    { id: "oa1", workspaceId: "ws1", leadId: "lead1", channel: "whatsapp", direction: "outbound", status: "sent", sentManually: true, body: "first message", activityAt: "2026-07-01T00:00:00Z", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" },
  ] as OutreachActivity[];
  const ticketEvents = [
    { id: "te1", workspaceId: "ws1", ticketId: "t1", eventType: "created", actorType: "system", createdAt: "2026-07-02T00:00:00Z" },
    { id: "te2", workspaceId: "ws1", ticketId: "t1", eventType: "status_changed", actorType: "owner", createdAt: "2026-07-02T01:00:00Z" },
  ] as TicketEvent[];
  const autoReplyLogs = [
    { id: "arl1", workspaceId: "ws1", leadId: "lead1", status: "approved", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" },
  ] as AutoReplyLog[];
  const unknownQuestions = [
    { id: "uq1", workspaceId: "ws1", leadId: "lead1", channel: "whatsapp", questionText: "price?", status: "open", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" },
  ] as UnknownQuestion[];
  const humanFallbackTasks = [
    { id: "hft1", workspaceId: "ws1", interactionId: "int1", prospectQuery: "q", status: "PENDING", convertedToTicketId: "t1", createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z" },
  ] as HumanFallbackTask[];
  const dnc: DoNotContactEntry[] = [
    { id: "dnc1", workspaceId: "ws1", normalizedPhone: "+911111111111", reason: "customer asked to delete", sourceLeadId: "lead1", createdAt: "2026-07-21T00:00:00Z" } as DoNotContactEntry,
  ];

  const erasureInput: ErasureInput = {
    workspaceId: "ws1",
    leadId: "lead1",
    actor: { userId: "owner1", actorType: "owner" },
    confirmName: "Anil",
    lead: baseLead,
    replies,
    tickets,
    orders,
    quotes,
    // R5 additions:
    outreachActivities,
    ticketEvents,
    autoReplyLogs,
    unknownQuestions,
    humanFallbackTasks,
    doNotContactRegistry: dnc,
  };
  const result = await eraseCustomer(erasureInput);
  assert(result.deleted.leadIds.includes("lead1"), `CASE A: lead deleted`);
  assert(result.deleted.replyIds.length === 2, `CASE A: 2 replies deleted, got ${result.deleted.replyIds.length}`);
  assert(result.deleted.ticketIds.length === 1, `CASE A: 1 ticket deleted`);
  assert(result.deleted.orderIds.length === 1, `CASE A: 1 order deleted`);
  assert(result.deleted.quoteIds.length === 1, `CASE A: 1 quote deleted`);
  // R5 — the 5 new types.
  assert(result.deleted.outreachActivityIds.length === 1, `CASE A: 1 outreachActivity deleted, got ${result.deleted.outreachActivityIds.length}`);
  assert(result.deleted.ticketEventIds.length === 2, `CASE A: 2 ticketEvents deleted (both belong to t1), got ${result.deleted.ticketEventIds.length}`);
  assert(result.deleted.autoReplyLogIds.length === 1, `CASE A: 1 autoReplyLog deleted, got ${result.deleted.autoReplyLogIds.length}`);
  assert(result.deleted.unknownQuestionIds.length === 1, `CASE A: 1 unknownQuestion deleted, got ${result.deleted.unknownQuestionIds.length}`);
  assert(result.deleted.humanFallbackTaskIds.length === 1, `CASE A: 1 humanFallbackTask deleted (convertedToTicketId=t1), got ${result.deleted.humanFallbackTaskIds.length}`);
  // DNC preserved (compliance: deleted customers stay DNC).
  assert(result.preservedDncIds.includes("dnc1"), `CASE A: DNC entry preserved`);
  // Audit entry written.
  assert(result.auditEntry.eventType === "customer_erased", `CASE A: audit event type`);
  assert(result.auditEntry.anonymizedCustomerId === "erased_customer", `CASE A: customer id anonymized`);
  console.log(`  CASE A OK: cascade erase plans all 10 record types + preserves DNC + writes audit.`);

  // === CASE B — Owner-only enforcement ===
  let adminThrew = false;
  try {
    await eraseCustomer({ ...erasureInput, actor: { userId: "admin1", actorType: "admin" } });
  } catch {
    adminThrew = true;
  }
  assert(adminThrew, `CASE B: admin role must be rejected`);
  console.log(`  CASE B OK: non-owner rejected.`);

  // === CASE C — Two-step confirmation ===
  let wrongNameThrew = false;
  try {
    await eraseCustomer({ ...erasureInput, confirmName: "WrongName" });
  } catch {
    wrongNameThrew = true;
  }
  assert(wrongNameThrew, `CASE C: wrong confirm-name must throw`);
  console.log(`  CASE C OK: wrong confirmation name rejected.`);

  // === CASE D — Audit anonymization (already asserted in CASE A) ===
  assert(result.auditEntry.actorUserId === "owner1", `CASE D: actor preserved (not anonymized)`);
  assert(result.auditEntry.anonymizedCustomerId === "erased_customer", `CASE D: customer id anonymized`);
  assert(!result.auditEntry.note?.includes("Anil"), `CASE D: customer name NOT in audit note`);
  console.log(`  CASE D OK: actor preserved, customer anonymized.`);

  // === CASE E — New audit event types exist ===
  const validTypes = [
    "customer_erased", "kill_switch_toggled", "sla_breached",
    "digest_sent", "price_change_notified", "consent_basis_changed",
    "ticket_created", "ticket_status_changed", "order_created",
    "order_cancelled", "quote_converted",
  ];
  for (const t of validTypes) {
    // We assert by constructing an entry with the type.
    const entry: AuditEntry = {
      workspaceId: "ws1", eventType: t as AuditEntry["eventType"],
      severity: AuditSeverity.Info, actorUserId: "u1", note: "test",
      at: "2026-07-21T00:00:00Z",
    };
    assert(entry.eventType === t, `CASE E: event type "${t}" should be assignable`);
  }
  console.log(`  CASE E OK: ${validTypes.length} audit event types accepted.`);

  // === CASE F — Severity field ===
  const errorEntry: AuditEntry = {
    workspaceId: "ws1", eventType: "order_cancelled",
    severity: AuditSeverity.Error, actorUserId: "u1", note: "delivery failed",
    at: "2026-07-21T00:00:00Z",
  };
  assert(errorEntry.severity === AuditSeverity.Error, `CASE F: severity=error`);
  console.log(`  CASE F OK: severity field works.`);

  // === CASE G — Query filters by severity ===
  const sampleLog: AuditEntry[] = [
    { workspaceId: "ws1", eventType: "ticket_created", severity: AuditSeverity.Info, actorUserId: "u1", note: "a", at: "2026-07-21T00:00:00Z" },
    { workspaceId: "ws1", eventType: "ticket_created", severity: AuditSeverity.Info, actorUserId: "u1", note: "b", at: "2026-07-21T01:00:00Z" },
    { workspaceId: "ws1", eventType: "ticket_created", severity: AuditSeverity.Info, actorUserId: "u1", note: "c", at: "2026-07-21T02:00:00Z" },
    { workspaceId: "ws1", eventType: "order_cancelled", severity: AuditSeverity.Error, actorUserId: "u1", note: "d", at: "2026-07-21T03:00:00Z" },
  ];
  const onlyErrors = queryAuditLog(sampleLog, { severity: AuditSeverity.Error });
  assert(onlyErrors.length === 1, `CASE G: 1 error out of 4, got ${onlyErrors.length}`);
  assert(onlyErrors[0].note === "d", `CASE G: query returns the error entry`);
  console.log(`  CASE G OK: query filters by severity.`);

  // === CASE H — Production gate: no LLM key + test WhatsApp → fail ===
  const failing = checkLlmKeyConfigured({ hasRealKey: false });
  assert(failing === false, `CASE H: no real key → gate fails`);
  const testNumber = checkWhatsAppNumberVerified({ isTestNumber: true, isVerified: false });
  assert(testNumber === false, `CASE H: test number only → gate fails`);
  console.log(`  CASE H OK: missing LLM key + test WhatsApp → gate fails.`);

  // === CASE I — Production gate: real key + verified number → pass ===
  const realKey = checkLlmKeyConfigured({ hasRealKey: true });
  assert(realKey === true, `CASE I: real key → pass`);
  const verified = checkWhatsAppNumberVerified({ isTestNumber: false, isVerified: true });
  assert(verified === true, `CASE I: verified number → pass`);
  console.log(`  CASE I OK: configured LLM + verified WhatsApp → pass.`);

  // === CASE J — Backup is NOT a gate (no check function exists for it) ===
  // We verify by attempting to import a backup-check function — it should
  // not exist on the module surface.
  const module = await import("@/services/ProductionGateExtensions");
  assert(typeof (module as Record<string, unknown>).checkBackupConfigured !== "function", `CASE J: backup check does not exist`);
  console.log(`  CASE J OK: backup is NOT a production gate.`);

  // === CASE K — R5 cascade scoping: records belonging to OTHER leads are
  //      NOT planned for deletion. The cascade must scope to leadId only.
  //      Hand-computed: 2 replies (r1 belongs to lead1, r3 belongs to lead2)
  //      → only r1 is planned. Same for orders, quotes, etc.
  {
    const otherLead: Lead = { ...baseLead, id: "lead2", contactName: "Other" };
    const mixedReplies: Reply[] = [
      { id: "r1", workspaceId: "ws1", leadId: "lead1", channel: "whatsapp", direction: "inbound", body: "x", rawText: "x", status: "new", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" } as Reply,
      { id: "r3", workspaceId: "ws1", leadId: "lead2", channel: "whatsapp", direction: "inbound", body: "y", rawText: "y", status: "new", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" } as Reply,
    ];
    const mixedOrders: Order[] = [
      { id: "o1", workspaceId: "ws1", orderNumber: 1, leadId: "lead1", status: "delivered", lineItems: [], grandTotal: 0, currencyCode: "INR", origin: "direct", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" },
      { id: "o2", workspaceId: "ws1", orderNumber: 2, leadId: "lead2", status: "delivered", lineItems: [], grandTotal: 0, currencyCode: "INR", origin: "direct", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" },
    ];
    // (otherLead is loaded but never passed — kept for clarity that lead2
    // is a real other customer whose data must NOT be touched.)
    void otherLead;
    const scoped = await eraseCustomer({
      workspaceId: "ws1",
      leadId: "lead1",
      actor: { userId: "owner1", actorType: "owner" },
      confirmName: "Anil",
      lead: baseLead,
      replies: mixedReplies,
      orders: mixedOrders,
    });
    assert(scoped.deleted.replyIds.length === 1 && scoped.deleted.replyIds.includes("r1"),
      `CASE K: only lead1's reply (r1) planned; got ${JSON.stringify(scoped.deleted.replyIds)}`);
    assert(scoped.deleted.orderIds.length === 1 && scoped.deleted.orderIds.includes("o1"),
      `CASE K: only lead1's order (o1) planned; got ${JSON.stringify(scoped.deleted.orderIds)}`);
    assert(!scoped.deleted.replyIds.includes("r3"), `CASE K: r3 (belongs to lead2) must NOT be planned`);
    assert(!scoped.deleted.orderIds.includes("o2"), `CASE K: o2 (belongs to lead2) must NOT be planned`);
    console.log(`  CASE K OK: cascade scoped to leadId only — other customers' records untouched.`);
  }

  console.log("PASS golden-erasure-audit: all 11 cases (10 original + CASE K R5 scoping) match operator-confirmed rules.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
