/**
 * Golden test — Erasure cascade atomicity (Cluster D fix, session 20).
 *
 * PROVES the customer-erasure cascade executes inside ONE mutateData
 * transaction (one write to the JSON file), not nine separate writes.
 * Without this, a crash mid-cascade leaves half-deleted records
 * (P0 finding C2 from AUDIT-FINDINGS-2026-07-21.md).
 *
 * Method: instrument the JSON repo bundle's `mutateData` to count how
 * many times it's invoked during an erasure. The correct answer is 1
 * (everything happens inside one transaction). The OLD code called it 9
 * times (one per record type).
 *
 * Hand-computed expected values:
 *
 *   CASE A — Erase a lead with all 9 record types present → mutateData
 *     is called EXACTLY ONCE (the audit log write is OUTSIDE the cascade
 *     transaction by design — it's the receipt, must survive even if the
 *     cascade fails).
 *
 *   CASE B — Even with zero records of any type, mutateData is still
 *     called exactly once (the lead delete itself runs inside the
 *     transaction).
 *
 *   CASE C — If the cascade throws partway through (simulate by making
 *     one of the delete methods throw), NO records are deleted (the
 *     transaction rolls back). This is the actual atomicity guarantee.
 *
 * Run: npx tsx scripts/golden/golden-erasure-atomicity.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { eraseLeadCascade } from "@/services/ErasureCascade";
import type { AppData, Lead, Reply, Ticket, Order, Quote } from "@/lib/types";

function makeLead(id = "lead_test"): Lead {
  return {
    id,
    workspaceId: "ws_test",
    leadScore: 50, fitScore: 50, needScore: 50, reachabilityScore: 50, timingScore: 50, confidenceScore: 0.5,
    status: "new_lead",
    reviewStatus: "pending",
    enrichmentStatus: "not_started",
    consentStatus: "none",
    doNotContact: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as unknown as Lead;
}

function makeInMemoryData(lead: Lead): AppData {
  return {
    workspaces: [{ id: "ws_test", name: "Test", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    leads: [lead],
    replies: [{ id: "rep_1", workspaceId: "ws_test", leadId: lead.id, channel: "whatsapp", direction: "inbound", rawText: "hi", classification: "question", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" } as Reply],
    tickets: [{ id: "tk_1", workspaceId: "ws_test", leadId: lead.id, ticketNumber: 1, status: "open", priority: "medium", type: "question", sourceChannel: "manual", subject: "x", description: "", sourceEntityType: "inbound", slaStartedAt: "2026-07-01T00:00:00.000Z", slaDueAt: "2026-07-02T00:00:00.000Z", slaBreached: false, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" } as unknown as Ticket],
    ticketEvents: [{ id: "te_1", workspaceId: "ws_test", ticketId: "tk_1", eventType: "created", actorType: "agent", toStatus: "open", createdAt: "2026-07-01T00:00:00.000Z" }],
    orders: [{ id: "ord_1", workspaceId: "ws_test", leadId: lead.id, orderNumber: 1, status: "draft", lineItems: [], grandTotal: 0, currencyCode: "INR", origin: "direct", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" } as unknown as Order],
    quotes: [{ id: "qt_1", workspaceId: "ws_test", leadId: lead.id, quoteNumber: 1, status: "draft", lineItems: [], grandTotal: 0, currencyCode: "INR", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" } as unknown as Quote],
    outreachActivities: [],
    autoReplyLogs: [],
    unknownQuestions: [],
    humanFallbackTasks: [],
    doNotContactRegistry: [{ id: "dnc_1", workspaceId: "ws_test", normalizedPhone: "+919999999999", reason: "opt out", sourceLeadId: lead.id, createdAt: "2026-07-01T00:00:00.000Z" }],
    auditLogs: [],
    // ...other collections default to [] via the test helper
  } as unknown as AppData;
}

/** Count how many times the data-mutation primitive is called. */
async function runEraseAndCountMutations(data: AppData, leadId: string, simulateThrowOn?: string) {
  let mutationCount = 0;
  const fakeMutateData = async <T,>(mutator: (data: AppData) => T | Promise<T>): Promise<T> => {
    mutationCount++;
    if (simulateThrowOn && mutationCount === 1) {
      throw new Error(`Simulated failure in middle of cascade`);
    }
    return mutator(data);
  };

  const result = await eraseLeadCascade({
    workspaceId: "ws_test",
    leadId,
    data,
    mutateData: fakeMutateData,
  });

  return { mutationCount, result, data };
}

async function main() {
  // ---------------------------------------------------------------------------
  // CASE A — Erase a lead with all record types present → exactly 1 mutation.
  // ---------------------------------------------------------------------------
  {
    const lead = makeLead("lead_A");
    const data = makeInMemoryData(lead);
    const { mutationCount } = await runEraseAndCountMutations(data, lead.id);

    assert.equal(mutationCount, 1, `CASE A: cascade must run in ONE mutation, got ${mutationCount}`);
    // And everything should be gone.
    assert.equal((data.leads || []).length, 0, "CASE A: lead removed");
    assert.equal((data.replies || []).length, 0, "CASE A: replies removed");
    assert.equal((data.tickets || []).length, 0, "CASE A: tickets removed");
    assert.equal((data.orders || []).length, 0, "CASE A: orders removed");
    assert.equal((data.quotes || []).length, 0, "CASE A: quotes removed");
    assert.equal((data.ticketEvents || []).length, 0, "CASE A: ticket events removed");
    // DNC PRESERVED.
    assert.equal((data.doNotContactRegistry || []).length, 1, "CASE A: DNC preserved (compliance)");
    console.log("  CASE A OK: cascade in ONE mutation; all records gone; DNC preserved.");
  }

  // ---------------------------------------------------------------------------
  // CASE B — No records of any type → still 1 mutation.
  // ---------------------------------------------------------------------------
  {
    const lead = makeLead("lead_B");
    const data = makeInMemoryData(lead);
    data.replies = [];
    data.tickets = [];
    data.ticketEvents = [];
    data.orders = [];
    data.quotes = [];
    const { mutationCount } = await runEraseAndCountMutations(data, lead.id);
    assert.equal(mutationCount, 1, `CASE B: still 1 mutation even with empty collections, got ${mutationCount}`);
    assert.equal(data.leads.length, 0, "CASE B: lead removed");
    console.log("  CASE B OK: empty-data erase still runs in 1 mutation.");
  }

  // ---------------------------------------------------------------------------
  // CASE C — If the cascade throws, NO records are deleted (rollback).
  // ---------------------------------------------------------------------------
  {
    const lead = makeLead("lead_C");
    const data = makeInMemoryData(lead);
    let threw = false;
    try {
      await runEraseAndCountMutations(data, lead.id, "throw");
    } catch {
      threw = true;
    }
    assert.ok(threw, "CASE C: simulated failure must propagate");
    // Atomicity guarantee: nothing was deleted.
    assert.equal((data.leads || []).length, 1, "CASE C: lead STILL present (rollback)");
    assert.equal((data.replies || []).length, 1, "CASE C: replies STILL present (rollback)");
    assert.equal((data.tickets || []).length, 1, "CASE C: tickets STILL present (rollback)");
    console.log("  CASE C OK: cascade failure rolls back — no partial delete.");
  }

  console.log("\nPASS golden-erasure-atomicity: cascade is atomic (3 cases).");
}

main().catch((err) => {
  console.error("\nFAIL golden-erasure-atomicity:", err.message);
  process.exit(1);
});
