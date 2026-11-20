/**
 * smoke-stage5-platform-ticket.ts — Stage 5 / WP3 acceptance test (lifecycle).
 *
 * WHAT THIS PROVES
 *   The platform-ticket lifecycle works as ONE continuous round-trip through
 *   the real service functions (create → list → detail → operator comment →
 *   close → user reopen within 7d → event thread → spam flag → user block).
 *   This is COMPLEMENTARY to `golden:platform-ticket` — the golden pins each
 *   individual LOGIC rule with hand-computed values; this smoke proves the
 *   sequence holds together as a real operator↔user conversation, including
 *   cross-call state continuity (events accumulate, firstResponse persists,
 *   ticketNumber is globally unique, isolation holds).
 *
 *   Why service-layer (not HTTP): 10 of 17 repo smokes are service-layer
 *   integration tests that run without a dev server (CI-reliable). The HTTP
 *   wiring itself is pinned by the Playwright Golden Thread test in Step 9 +
 *   the route's role gates are pinned by smoke-rbac-unit. This smoke focuses
 *   on the lifecycle orchestration the routes wrap.
 *
 * SACRED no-auto-outreach: every step is a logged-in human action. No send
 * path is exercised here (verified statically in golden:platform-ticket CASE J
 * + the repo-wide golden:no-auto-outreach).
 *
 * Run: npx tsx scripts/smoke-stage5-platform-ticket.ts
 * (No DATABASE_URL needed — uses the local JSON demo store. Each run uses a
 *  unique timestamp namespace so state never leaks between runs.)
 */
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import {
  addPlatformTicketComment,
  blockPlatformUser,
  changePlatformTicketStatus,
  createPlatformTicket,
  flagPlatformTicketAsSpam,
} from "@/services/PlatformTicketService";
import assert from "node:assert";

function assert2(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  console.log("smoke-stage5-platform-ticket: lifecycle round-trip...\n");

  const repos: RepositoryBundle = createRepositories();
  // Unique-per-run namespace (Ironclad Gate #8: clean slate, no cross-run leak).
  const runId = `smoke5_${Date.now()}`;
  const ws = `ws_${runId}`;
  const user = `user_${runId}_owner`;
  const user2 = `user_${runId}_owner2`; // second owner in the same workspace
  const adminId = `admin_${runId}_op`;
  // Fixed clock keeps SLA assertions deterministic. Mon 2026-07-13 10:00 IST.
  const startedAt = new Date("2026-07-13T04:30:00.000Z");

  // Clear any leftover data in this workspace (defensive; should be empty).
  const { mutateData } = await import("@/lib/db");
  await mutateData((data) => {
    const ticketIds = (data.platformTickets || []).filter((t) => t.workspaceId === ws).map((t) => t.id);
    data.platformTickets = (data.platformTickets || []).filter((t) => t.workspaceId !== ws);
    data.platformTicketEvents = (data.platformTicketEvents || []).filter((e) => !ticketIds.includes(e.ticketId));
    data.platformUserBlocks = (data.platformUserBlocks || []).filter((b) => b.workspaceId !== ws);
    return undefined as never;
  });

  // --- [1] Owner opens a ticket ---------------------------------------------
  console.log("  [1] Owner opens an urgent bug ticket...");
  const ticket = await createPlatformTicket({
    workspaceId: ws,
    raisedByUserId: user,
    creatorRole: "owner",
    subject: "Cannot export leads CSV",
    description: "Clicking Export gives a white screen.",
    category: "bug",
    priority: "urgent",
    now: startedAt,
  });
  assert2(typeof ticket.ticketNumber === "number" && ticket.ticketNumber > 0, "ticketNumber must be a positive integer");
  assert2(ticket.status === "open", `status must be open, got ${ticket.status}`);
  assert2(ticket.category === "bug", "category must be bug");
  assert2(ticket.workspaceId === ws, "workspaceId must match");
  assert2(ticket.raisedByUserId === user, "raisedByUserId must match");
  assert2(ticket.firstResponseAt === undefined, "no first response yet");
  console.log(`    OK ticket #${ticket.ticketNumber} created (${ticket.id}), status=open`);

  // --- [2] listForUser shows it (workspace-scoped) --------------------------
  console.log("  [2] listForUser(ws) returns the ticket (workspace-scoped)...");
  const mine = await repos.platformTicket.listForUser(ws);
  assert2(mine.some((t) => t.id === ticket.id), "owner must see their own ticket");
  assert2(mine.every((t) => t.workspaceId === ws), "no leak from other workspaces");
  console.log(`    OK owner sees ${mine.length} ticket(s) in their workspace`);

  // --- [3] getForUser detail -------------------------------------------------
  console.log("  [3] getForUser detail fetch...");
  const detail = await repos.platformTicket.getForUser(ws, ticket.id);
  assert2(detail && detail.id === ticket.id, "getForUser must return the ticket");
  // Cross-workspace read must be blocked.
  const crossRead = await repos.platformTicket.getForUser("ws_does_not_exist_xyz", ticket.id);
  assert2(crossRead === undefined, "another workspace must NOT read this ticket by id");
  console.log("    OK detail returned; cross-workspace read blocked");

  // --- [4] Operator replies → firstResponseAt set ---------------------------
  console.log("  [4] Operator replies (first response)...");
  const opReplyAt = new Date("2026-07-13T05:30:00.000Z"); // +1h
  const r1 = await addPlatformTicketComment({
    ticketId: ticket.id,
    actorType: "operator",
    actorAdminId: adminId,
    note: "Thanks for reporting. We're looking into the export.",
    now: opReplyAt,
  });
  assert2(typeof r1.ticket.firstResponseAt === "string", "firstResponseAt must be set after first operator comment");
  assert2(r1.event.eventType === "commented", "a commented event is appended");
  console.log("    OK firstResponseAt set; commented event appended");

  // --- [5] Operator closes the ticket ---------------------------------------
  console.log("  [5] Operator closes the ticket...");
  const closedAt = new Date("2026-07-13T07:00:00.000Z"); // +2.5h
  const closed = await changePlatformTicketStatus({
    ticketId: ticket.id,
    toStatus: "closed",
    actorType: "operator",
    actorAdminId: adminId,
    note: "Fixed in deploy abc123.",
    now: closedAt,
  });
  assert2(closed.status === "closed", `status must be closed, got ${closed.status}`);
  assert2(typeof closed.closedAt === "string", "closedAt must be stamped");
  assert2(typeof closed.resolvedAt === "string", "closing also stamps resolvedAt if missing");
  console.log("    OK ticket closed; closedAt + resolvedAt stamped");

  // --- [6] User reopens within 7-day window via comment ---------------------
  console.log("  [6] User comments within 7-day window → reopen...");
  const reopenAt = new Date("2026-07-15T07:00:00.000Z"); // +2 days (within 7d)
  const r2 = await addPlatformTicketComment({
    ticketId: ticket.id,
    actorType: "user",
    actorUserId: user,
    note: "It happened again on a different list.",
    now: reopenAt,
  });
  assert2(r2.reopened === true, "user comment within 7d must reopen the ticket");
  assert2(r2.ticket.status === "reopened", `status must be reopened, got ${r2.ticket.status}`);
  assert2(r2.ticket.closedAt === undefined && r2.ticket.resolvedAt === undefined, "terminal timestamps cleared on reopen");
  console.log("    OK ticket reopened; terminal timestamps cleared");

  // --- [7] Event thread shows the full conversation -------------------------
  console.log("  [7] Event thread shows the full conversation...");
  const events = await repos.platformTicketEvent.listByTicket(ticket.id);
  const types = events.map((e) => e.eventType);
  assert2(types.includes("created"), "thread must include a created event");
  assert2(types.filter((t) => t === "commented").length >= 2, "thread must include both comments");
  assert2(types.includes("reopened"), "thread must include a reopened event");
  assert2(types.includes("closed"), "thread must include a closed event");
  // Every event is workspace-scoped to this ticket's workspace.
  assert2(events.every((e) => e.workspaceId === ws), "all events must be workspace-scoped");
  console.log(`    OK thread has ${events.length} events: ${[...new Set(types)].join(", ")}`);

  // --- [8] listForOperator (default) shows the ticket; spam flag hides it ---
  console.log("  [8] Operator inbox shows ticket; spam flag hides from default list...");
  const inboxBefore = await repos.platformTicket.listForOperator();
  assert2(inboxBefore.some((t) => t.id === ticket.id), "operator inbox includes the ticket by default");
  const flagged = await flagPlatformTicketAsSpam({ ticketId: ticket.id, adminId, reason: "smoke test spam flag" });
  assert2(flagged.isSpamFlagged === true, "ticket must be flagged");
  const inboxDefault = await repos.platformTicket.listForOperator();
  assert2(!inboxDefault.some((t) => t.id === ticket.id), "default operator inbox must HIDE spam-flagged tickets");
  // But the record persists (getForOperator still returns it).
  const stillThere = await repos.platformTicket.getForOperator(ticket.id);
  assert2(stillThere && stillThere.isSpamFlagged === true, "flagged ticket must persist (not deleted)");
  console.log("    OK spam-flagged ticket hidden from default inbox; record persists");

  // --- [9] Block user → new ticket by that user rejected --------------------
  console.log("  [9] Block user2 → their new ticket is rejected...");
  // Stage 5 re-audit F-P1-10 ripple (2026-07-29): blockPlatformUser now
  // verifies the user EXISTS + is a member of the workspace before upserting
  // the block. Seed user2 first (the golden-platform-ticket helper seedUser
  // uses the same pattern). Without this, the block throws "user not found".
  await repos.user.create({
    id: user2, workspaceId: ws, name: "Smoke Owner 2",
    email: `smoke5_${runId}_owner2@test.example`, role: "owner",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await blockPlatformUser({ userId: user2, workspaceId: ws, adminId, isBlockedFromSupport: true, reason: "smoke block" });
  assert2(await repos.platformUserBlock.isBlocked(user2), "isBlocked must report true");
  await assert.rejects(
    () => createPlatformTicket({
      workspaceId: ws,
      raisedByUserId: user2,
      creatorRole: "owner",
      subject: "blocked attempt",
      description: "should be rejected",
      category: "how_to",
      priority: "medium",
    }),
    (err: unknown) => err instanceof Error && /restricted from opening support tickets/i.test(err.message),
    "a blocked user must NOT open a new ticket",
  );
  // The audit log captured the block + the spam flag.
  const audit = await repos.platformAuditLog.list({ adminId });
  const auditActions = audit.map((a) => a.action);
  assert2(auditActions.includes("user_blocked"), "audit log must record the user block");
  assert2(auditActions.includes("ticket_flagged_spam"), "audit log must record the spam flag");
  console.log(`    OK blocked user rejected; audit log captured ${auditActions.length} admin actions`);

  console.log("\nsmoke-stage5-platform-ticket: ALL CHECKS PASSED");
}

main().catch((error) => {
  console.error("\nsmoke-stage5-platform-ticket FAILED:", error.message);
  console.error(error.stack);
  process.exit(1);
});
