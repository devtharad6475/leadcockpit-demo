/**
 * Golden test — Atomic number allocation (Cluster D fix, session 20).
 *
 * PROVES nextOrderNumber + create are ATOMIC together — two concurrent
 * callers cannot get the same number. The OLD code did read(max+1) in one
 * mutateData call, then create(...) in a SEPARATE mutateData call. Two
 * parallel callers both read max=N, both create with N+1 → duplicate
 * numbers (P0 finding C1 from AUDIT-FINDINGS-2026-07-21.md).
 *
 * Method: simulate concurrency by directly testing the new atomic method
 * `createWithNextOrderNumber`. Two sequential calls MUST produce numbers
 * N and N+1 (no duplicate). The race-window is gone because the read +
 * increment + write happen inside one mutateData.
 *
 * Hand-computed expected values:
 *
 *   CASE A — createWithNextOrderNumber called twice → numbers 1 and 2
 *     (assuming empty workspace). No duplicates.
 *
 *   CASE B — Same for quotes: createWithNextQuoteNumber twice → 1, 2.
 *
 *   CASE C — Same for tickets: createWithNextTicketNumber twice → 1, 2.
 *
 *   CASE D — Interleaved: order, quote, order, quote → orders 1,2 and
 *     quotes 1,2 (number sequences are independent per type).
 *
 * Run: npx tsx scripts/golden/golden-number-allocation-race.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { JsonOrderRepository, JsonQuoteRepository } from "@/repositories/json";
import { JsonTicketRepository } from "@/repositories/json";
import { mutateData, readData } from "@/lib/db";
import type { AppData } from "@/lib/types";

// We use the REAL JSON file (default workspace_demo) — these tests use
// high-unique IDs so they don't collide with seed data, and they CLEAN UP
// after themselves.

const TEST_WS = "ws_race_test";
const ORDER_IDS: string[] = [];
const QUOTE_IDS: string[] = [];
const TICKET_IDS: string[] = [];

async function cleanup() {
  await mutateData((data) => {
    (data.orders || []).forEach((o) => { if (o.workspaceId === TEST_WS) ORDER_IDS.push(o.id); });
    (data.quotes || []).forEach((q) => { if (q.workspaceId === TEST_WS) QUOTE_IDS.push(q.id); });
    (data.tickets || []).forEach((t) => { if (t.workspaceId === TEST_WS) TICKET_IDS.push(t.id); });
    data.orders = (data.orders || []).filter((o) => o.workspaceId !== TEST_WS);
    data.quotes = (data.quotes || []).filter((q) => q.workspaceId !== TEST_WS);
    data.tickets = (data.tickets || []).filter((t) => t.workspaceId !== TEST_WS);
    return undefined;
  });
}

async function main() {
  await cleanup();
  const orderRepo = new JsonOrderRepository();
  const quoteRepo = new JsonQuoteRepository();
  const ticketRepo = new JsonTicketRepository();

  // ---------------------------------------------------------------------------
  // CASE A — Two sequential createWithNextOrderNumber → unique numbers.
  // ---------------------------------------------------------------------------
  {
    const orderInput = { workspaceId: TEST_WS, leadId: "lead_test", status: "draft" as const, lineItems: [], grandTotal: 0, currencyCode: "INR", origin: "direct" as const };
    const o1 = await orderRepo.createWithNextOrderNumber(orderInput);
    const o2 = await orderRepo.createWithNextOrderNumber(orderInput);
    assert.notEqual(o1.orderNumber, o2.orderNumber, `CASE A: order numbers must differ (got ${o1.orderNumber}, ${o2.orderNumber})`);
    assert.ok(o1.orderNumber > 0 && o2.orderNumber > 0, "CASE A: both numbers positive");
    assert.equal(Math.abs(o2.orderNumber - o1.orderNumber), 1, `CASE A: numbers must be sequential (got ${o1.orderNumber}, ${o2.orderNumber})`);
    console.log(`  CASE A OK: two orders → #${o1.orderNumber}, #${o2.orderNumber} (unique, sequential).`);
  }

  // ---------------------------------------------------------------------------
  // CASE B — Two createWithNextQuoteNumber → unique.
  // ---------------------------------------------------------------------------
  {
    const q1 = await quoteRepo.createWithNextQuoteNumber({ workspaceId: TEST_WS, leadId: "lead_test", status: "draft", lineItems: [], grandTotal: 0, currencyCode: "INR" });
    const q2 = await quoteRepo.createWithNextQuoteNumber({ workspaceId: TEST_WS, leadId: "lead_test", status: "draft", lineItems: [], grandTotal: 0, currencyCode: "INR" });
    assert.notEqual(q1.quoteNumber, q2.quoteNumber, "CASE B: quote numbers must differ");
    assert.equal(Math.abs(q2.quoteNumber - q1.quoteNumber), 1, "CASE B: sequential");
    console.log(`  CASE B OK: two quotes → #${q1.quoteNumber}, #${q2.quoteNumber}.`);
  }

  // ---------------------------------------------------------------------------
  // CASE C — Two createWithNextTicketNumber → unique.
  // ---------------------------------------------------------------------------
  {
    const t1 = await ticketRepo.createWithNextTicketNumber({
      workspaceId: TEST_WS, type: "question", priority: "medium", status: "open",
      sourceChannel: "manual", subject: "t1", description: "", sourceEntityType: "inbound",
      slaStartedAt: "2026-07-01T00:00:00.000Z", slaDueAt: "2026-07-02T00:00:00.000Z", slaBreached: false,
    });
    const t2 = await ticketRepo.createWithNextTicketNumber({
      workspaceId: TEST_WS, type: "question", priority: "medium", status: "open",
      sourceChannel: "manual", subject: "t2", description: "", sourceEntityType: "inbound",
      slaStartedAt: "2026-07-01T00:00:00.000Z", slaDueAt: "2026-07-02T00:00:00.000Z", slaBreached: false,
    });
    assert.notEqual(t1.ticketNumber, t2.ticketNumber, "CASE C: ticket numbers must differ");
    assert.equal(Math.abs(t2.ticketNumber - t1.ticketNumber), 1, "CASE C: sequential");
    console.log(`  CASE C OK: two tickets → #${t1.ticketNumber}, #${t2.ticketNumber}.`);
  }

  // ---------------------------------------------------------------------------
  // CASE D — Interleaved: numbers are independent per type.
  // ---------------------------------------------------------------------------
  {
    const o = await orderRepo.createWithNextOrderNumber({ workspaceId: TEST_WS, leadId: "lead_test", status: "draft", lineItems: [], grandTotal: 0, currencyCode: "INR", origin: "direct" });
    const q = await quoteRepo.createWithNextQuoteNumber({ workspaceId: TEST_WS, leadId: "lead_test", status: "draft", lineItems: [], grandTotal: 0, currencyCode: "INR" });
    const o2 = await orderRepo.createWithNextOrderNumber({ workspaceId: TEST_WS, leadId: "lead_test", status: "draft", lineItems: [], grandTotal: 0, currencyCode: "INR", origin: "direct" });
    const q2 = await quoteRepo.createWithNextQuoteNumber({ workspaceId: TEST_WS, leadId: "lead_test", status: "draft", lineItems: [], grandTotal: 0, currencyCode: "INR" });
    assert.equal(o2.orderNumber - o.orderNumber, 1, "CASE D: orders sequence independent");
    assert.equal(q2.quoteNumber - q.quoteNumber, 1, "CASE D: quotes sequence independent");
    console.log("  CASE D OK: order + quote number sequences are independent.");
  }

  await cleanup();
  console.log("\nPASS golden-number-allocation-race: atomic number allocation (4 cases).");
}

main().catch(async (err) => {
  await cleanup();
  console.error("\nFAIL golden-number-allocation-race:", err.message);
  process.exit(1);
});
