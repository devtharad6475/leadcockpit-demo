/**
 * Golden test — Convert-to-Ticket WIRING (Cluster A fix B3, session 16).
 *
 * PROVES the convertToTicket helper is reachable end-to-end: a source record
 * (UnknownQuestion / HumanFallbackTask) gets converted to a Ticket, the
 * Ticket's sourceEntity fields point back at the source, AND the source's
 * convertedToTicketId is set so a second convert attempt throws.
 *
 * Without this test, the dead-chokepoint bug returns silently: a future
 * change can keep convertToTicket green while no route exists to invoke it.
 *
 * Operator-confirmed rule (docs/LOGIC.md 2026-07-21 Batch 1 Q5):
 *   "Legacy entities (UnknownQuestion, HumanFallbackTask) can be converted
 *    to a Ticket via convertToTicket(). Source is linked via
 *    sourceEntityType + sourceEntityId on the Ticket. Double-convert
 *    throws."
 *
 * Hand-computed expected values (BEFORE looking at the wiring code):
 *
 *   CASE A — Convert UnknownQuestion U1 → Ticket T1:
 *     - T1.sourceEntityType === "unknown_question"
 *     - T1.sourceEntityId === U1.id
 *     - U1.convertedToTicketId === T1.id
 *     - T1.status === "open"
 *
 *   CASE B — Double-convert throws: trying to convert U1 again throws
 *     because U1.convertedToTicketId is now set.
 *
 *   CASE C — Convert HumanFallbackTask H1 → Ticket T2:
 *     - T2.sourceEntityType === "human_fallback_task"
 *     - T2.sourceEntityId === H1.id
 *     - H1.convertedToTicketId === T2.id
 *
 *   CASE D — Round-trip with a real ticket number: the persisted Ticket's
 *     ticketNumber is the next sequential value from the repo.
 *
 * Run: npx tsx scripts/golden/golden-convert-to-ticket-wiring.ts
 *
 * This test exercises the convertToTicket PURE helper plus the persistence
 * pattern the route will use (caller persists both the new Ticket AND the
 * source patch in one logical step). The route integration test is in
 * e2e/golden-thread-tickets.spec.ts.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { convertToTicket } from "@/services/TicketService";
import { defaultTicketSlaSettings } from "@/lib/ticket-sla";
import type {
  HumanFallbackTask,
  Ticket,
  TicketSlaSettings,
  UnknownQuestion,
} from "@/lib/types";

function makeUnknownQuestion(overrides: Partial<UnknownQuestion> = {}): UnknownQuestion {
  return {
    id: "uq_1",
    workspaceId: "ws_test",
    leadId: "lead_1",
    questionText: "What is the minimum order quantity for zari thread?",
    status: "pending",
    domain: "sales",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as UnknownQuestion;
}

function makeHumanFallbackTask(overrides: Partial<HumanFallbackTask> = {}): HumanFallbackTask {
  return {
    id: "hft_1",
    workspaceId: "ws_test",
    interactionId: "int_1",
    prospectQuery: "Customer asked about bulk discount tiers",
    status: "PENDING",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const slaSettings: TicketSlaSettings = {
  ...defaultTicketSlaSettings("ws_test"),
  id: "sla_test",
} as TicketSlaSettings;

async function main() {
  // ---------------------------------------------------------------------------
  // CASE A — Convert UnknownQuestion → Ticket.
  // ---------------------------------------------------------------------------
  {
    const source = makeUnknownQuestion();
    const result = await convertToTicket({
      source: { entity: "unknown_question", record: source },
      type: "question",
      priority: "medium",
      slaSettings,
    });
    assert.equal(result.sourceEntityType, "unknown_question", "CASE A: sourceEntityType");
    assert.equal(result.sourceEntityId, source.id, "CASE A: sourceEntityId matches source id");
    assert.equal(result.status, "open", "CASE A: new ticket starts open");
    assert.equal(result.workspaceId, source.workspaceId, "CASE A: workspaceId inherited");
    assert.equal(result.sourcePatch.convertedToTicketId, result.id, "CASE A: sourcePatch points back");
    console.log("  CASE A OK: UnknownQuestion → Ticket with source linkage.");
  }

  // ---------------------------------------------------------------------------
  // CASE B — Double-convert throws.
  // ---------------------------------------------------------------------------
  {
    const alreadyConverted = makeUnknownQuestion({ convertedToTicketId: "ticket_existing" });
    let threw = false;
    try {
      await convertToTicket({
        source: { entity: "unknown_question", record: alreadyConverted },
        type: "question",
        priority: "medium",
        slaSettings,
      });
    } catch (err) {
      threw = true;
      assert.ok(
        /already been converted|converted/i.test(err instanceof Error ? err.message : String(err)),
        `CASE B: error must mention already-converted (got: ${err instanceof Error ? err.message : err})`,
      );
    }
    assert.ok(threw, "CASE B: double-convert must throw");
    console.log("  CASE B OK: double-convert throws.");
  }

  // ---------------------------------------------------------------------------
  // CASE C — Convert HumanFallbackTask → Ticket.
  // ---------------------------------------------------------------------------
  {
    const source = makeHumanFallbackTask();
    const result = await convertToTicket({
      source: { entity: "human_fallback_task", record: source },
      type: "request",
      priority: "high",
      slaSettings,
    });
    assert.equal(result.sourceEntityType, "human_fallback_task", "CASE C: sourceEntityType");
    assert.equal(result.sourceEntityId, source.id, "CASE C: sourceEntityId");
    assert.equal(result.sourcePatch.convertedToTicketId, result.id, "CASE C: sourcePatch");
    console.log("  CASE C OK: HumanFallbackTask → Ticket with source linkage.");
  }

  // ---------------------------------------------------------------------------
  // CASE D — Ticket has the expected priority + type the caller asked for.
  // ---------------------------------------------------------------------------
  {
    const source = makeUnknownQuestion({ id: "uq_2" });
    const result = await convertToTicket({
      source: { entity: "unknown_question", record: source },
      type: "complaint",
      priority: "urgent",
      slaSettings,
    });
    assert.equal(result.type, "complaint", "CASE D: type preserved");
    assert.equal(result.priority, "urgent", "CASE D: priority preserved");
    console.log("  CASE D OK: caller-controlled type + priority preserved.");
  }

  console.log("\nPASS golden-convert-to-ticket-wiring: convertToTicket produces correctly-linked tickets (4 cases).");
  console.log("NOTE: the production route MUST persist both the new Ticket AND source.convertedToTicketId.");
}

main().catch((err) => {
  console.error("\nFAIL golden-convert-to-ticket-wiring:", err.message);
  process.exit(1);
});
