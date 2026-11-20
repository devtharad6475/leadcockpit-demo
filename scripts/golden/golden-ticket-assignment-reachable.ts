/**
 * Golden test — a ticket can actually be handed to a person.
 *
 * WHY THIS EXISTS (2026-09-08, session 54)
 * ----------------------------------------
 * Found by working a ticket in the live demo, not by a test.
 *
 * The Tickets screen tells the operator it shows "Problems raised by customers,
 * WHO IS HANDLING EACH ONE, and how long it has been waiting". The server has
 * had `POST /api/tickets/:id/assign` since M6 — the Tickets.tsx header comment
 * lists it among the endpoints the screen uses — and `TicketService` implements
 * three assignment modes (manual, auto_rule, round_robin) with a round-robin
 * pointer persisted on the SLA settings row.
 *
 * None of it could be reached. The detail pane rendered a bare "Assigned" badge
 * and there was no control anywhere in the product that set `assignedTo`, so
 * the badge could never appear, no ticket could ever be handed to anybody, and
 * the sentence at the top of the screen was false on every deployment. Same
 * shape as the product price: the read side shipped, the write side never
 * existed.
 *
 *   CASE A — behavioural: POST assign persists `assignedTo` and records an
 *     "assigned" ticket event, so the history shows who was given the work.
 *
 *   CASE B — behavioural: assigning with no value clears the assignee and does
 *     NOT record an assignment event. Unassigning is a real operator action
 *     (the person left, the ticket was mis-routed) and it must not read as an
 *     assignment in the audit trail.
 *
 *   CASE C — static: the Tickets screen contains a control that calls the
 *     assign endpoint. Without this the endpoint can keep working perfectly
 *     while the operator has no way to reach it, which is the exact state this
 *     golden was written for.
 *
 * Substrate: runs on whichever provider the suite selects. No network, no AI.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createRepositories } from "@/repositories";
import { defaultWorkspaceId } from "@/lib/db";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const WS = defaultWorkspaceId;
const SCREEN = "src/app/sections/Tickets.tsx";

async function postAssign(ticketId: string, assignedTo?: string) {
  const { POST } = await import("@/app/api/[[...path]]/route");
  const request = new Request(`http://localhost/api/tickets/${ticketId}/assign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignedTo }),
  });
  const response = await POST(
    request as never,
    { params: Promise.resolve({ path: ["tickets", ticketId, "assign"] }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function main() {
  console.log("=== GOLDEN: ticket assignment is reachable ===\n");
  const repos = createRepositories();

  const ticket = await repos.ticket.create({
    workspaceId: WS,
    subject: "Shade variation on lot ZK-4417 against the confirmed card",
    description: "Buyer reports the Kasab Zari in this lot runs darker than the shade card they approved.",
    status: "open",
    priority: "high",
    sourceChannel: "manual",
  } as never);
  assert(ticket?.id, "setup: the ticket was not created");
  // 2026-09-26 (break test): only an ACTIVE team member can be assigned now,
  // so the person this golden hands the ticket to must be on the team.
  if (!(await repos.workspace.listActiveStaffForWorkspace(WS)).some((m) => m.userId === "user_demo_owner")) {
    const now = new Date().toISOString();
    await repos.workspaceMember.create({ id: "member_demo_owner_golden", workspaceId: WS, userId: "user_demo_owner", email: "owner@example.test", name: "Demo Owner", role: "owner", status: "active", createdAt: now, updatedAt: now });
  }

  // ---------------------------------------------------------------- CASE A
  {
    const { status, body } = await postAssign(ticket.id, "user_demo_owner");
    assert(status === 200, `CASE A: assign returned HTTP ${status}: ${JSON.stringify(body)}`);

    const reloaded = await repos.ticket.getById(WS, ticket.id);
    assert(
      reloaded?.assignedTo === "user_demo_owner",
      `CASE A: the ticket must remember who is handling it, got ${JSON.stringify(reloaded?.assignedTo)}`,
    );

    const events = await repos.ticketEvent.listByTicket(WS, ticket.id);
    assert(
      events.some((event) => event.eventType === "assigned"),
      `CASE A: handing a ticket to somebody must appear in its history. Events: ${JSON.stringify(events.map((e) => e.eventType))}`,
    );
    console.log("✅ CASE A — assigning persists the assignee and records it in the ticket history");
  }

  // ---------------------------------------------------------------- CASE B
  {
    const before = (await repos.ticketEvent.listByTicket(WS, ticket.id)).filter((e) => e.eventType === "assigned").length;
    const { status } = await postAssign(ticket.id, undefined);
    assert(status === 200, `CASE B: unassign returned HTTP ${status}`);

    const reloaded = await repos.ticket.getById(WS, ticket.id);
    assert(
      !reloaded?.assignedTo,
      `CASE B: clearing the assignee must leave nobody holding the ticket, got ${JSON.stringify(reloaded?.assignedTo)}`,
    );

    const after = (await repos.ticketEvent.listByTicket(WS, ticket.id)).filter((e) => e.eventType === "assigned").length;
    assert(
      after === before,
      `CASE B: unassigning must not be recorded as an assignment — the history would say the ticket was given to ` +
      `nobody. assigned events before=${before} after=${after}`,
    );
    console.log("✅ CASE B — unassigning clears the holder without faking an assignment in the history");
  }

  // ---------------------------------------------------------------- CASE C
  {
    const source = readSource(SCREEN);
    assert(
      source.includes("/assign"),
      `CASE C: ${SCREEN} must call the assign endpoint. The screen says it shows "who is handling each one"; ` +
      "for two months it had no control that could set that.",
    );
    assert(
      /workspace-members/.test(source),
      `CASE C: ${SCREEN} must load the workspace members, otherwise the operator is asked to type a user id.`,
    );
    console.log("✅ CASE C — the Tickets screen still has a control that reaches the assign endpoint");
  }

  console.log("\n✅✅✅ All ticket-assignment golden cases PASSED (A–C). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
