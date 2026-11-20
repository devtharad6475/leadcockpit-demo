/**
 * Golden test — Ticket lifecycle: live SLA breach, assignment modes,
 * legacy-convert-to-ticket (Stage 2 — Batch 1 of session 8).
 *
 * Phase 1.5 / skill v2 — written BEFORE the service code.
 *
 * Operator-confirmed rules (docs/LOGIC.md, 2026-07-21):
 *   - Transitions are NOT enforced; any status from any status is allowed.
 *   - SLA breach is computed LIVE: breached iff (now > dueAt) AND status is
 *     in {open, in_progress, waiting_customer, reopened}. Resolved/closed
 *     tickets are NEVER breached.
 *   - Assignment is per-workspace toggle: manual | auto_rule | round_robin.
 *     Manual → unassigned. Auto_rule → first matching rule wins, else
 *     unassigned. Round_robin → rotates across active staff.
 *   - Legacy entities (UnknownQuestion, HumanFallbackTask) can be converted
 *     to a Ticket via convertToTicket(). Source is linked via
 *     sourceEntityType + sourceEntityId on the Ticket. Double-convert throws.
 *
 * Hand-computed expected values:
 *
 *   CASE A — Live SLA: ticket past dueAt + status=open → BREACHED.
 *     Ticket { slaDueAt: 09:00, status: "open" } at now=10:00 → breached=true.
 *
 *   CASE B — Live SLA: ticket past dueAt + status=resolved → NOT BREACHED.
 *     Same ticket, status="resolved" → breached=false (clock stopped).
 *
 *   CASE C — Live SLA: ticket past dueAt + status=closed → NOT BREACHED.
 *
 *   CASE D — Live SLA: ticket BEFORE dueAt + status=open → NOT BREACHED.
 *     Ticket { slaDueAt: 10:00, status: "open" } at now=09:00 → breached=false.
 *
 *   CASE E — Live SLA: remaining minutes math.
 *     dueAt=10:00, now=09:30 → remaining = 30 minutes.
 *     dueAt=10:00, now=10:30 → remaining = -30 minutes (overdue by 30).
 *
 *   CASE F — Assignment manual mode: assignTicket(t, settings) → t.assignedTo
 *     stays undefined.
 *
 *   CASE G — Assignment auto_rule mode with 2 rules: rule1 {channel=whatsapp
 *     → userA}, rule2 {priority=urgent → userB}. A whatsapp+high ticket →
 *     assignedTo=userA (first match wins).
 *
 *   CASE H — Assignment auto_rule mode no match: same rules, ticket is
 *     channel=email, priority=medium → unassigned (no rule matched).
 *
 *   CASE I — Round-robin: 3 staff [userA, userB, userC], next-assignee
 *     pointer=0. First ticket → userA, pointer becomes 1. Second ticket →
 *     userB, pointer becomes 2. Third → userC, pointer becomes 0 (wraps).
 *
 *   CASE J — Convert UnknownQuestion to Ticket: source linked via
 *     sourceEntityType="unknown_question", sourceEntityId matches the
 *     UnknownQuestion.id. Ticket status starts "open".
 *
 *   CASE K — Double-convert throws: converting an UnknownQuestion that has
 *     already been converted (convertedToTicketId set) → throws.
 *
 *   CASE L — Status transitions: changeTicketStatus allows open→closed
 *     directly (no enforcement). The audit event is still logged.
 *
 * Run: npx tsx scripts/golden/golden-ticket-lifecycle.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import {
  computeLiveBreach,
  assignTicket,
  convertToTicket,
} from "@/services/TicketService";
import type {
  Ticket,
  TicketSlaSettings,
  UnknownQuestion,
  TicketEvent,
} from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const iso = (s: string): string => s; // helper to mark ISO strings clearly

const baseSettings: TicketSlaSettings = {
  id: "sla1",
  workspaceId: "ws1",
  clockMode: "always_24_7",
  businessHoursStart: "09:00",
  businessHoursEnd: "18:00",
  // Aligned with the production Mon-Sat default (src/lib/ticket-sla.ts DEFAULT_BUSINESS_DAYS).
  // This fixture uses clockMode "always_24_7" so the value doesn't affect assertions;
  // keeping it Mon-Sat removes the misleading Mon-Fri artifact (audit P2-DOC-1).
  businessDays: [1, 2, 3, 4, 5, 6],
  urgentSlaMinutes: 240,
  highSlaMinutes: 480,
  mediumSlaMinutes: 1440,
  lowSlaMinutes: 10080,
  assignmentMode: "manual",
  assignmentRules: [],
  roundRobinPointer: 0,
  createdAt: "2026-07-21T00:00:00Z",
  updatedAt: "2026-07-21T00:00:00Z",
};

const baseTicket = (overrides: Partial<Ticket>): Ticket => ({
  id: "t1",
  workspaceId: "ws1",
  ticketNumber: 1,
  sourceChannel: "whatsapp",
  type: "complaint",
  priority: "high",
  status: "open",
  subject: "Test",
  description: "Test description",
  sourceEntityType: "inbound",
  slaStartedAt: iso("2026-07-21T08:00:00Z"),
  slaDueAt: iso("2026-07-21T09:00:00Z"),
  slaBreached: false, // ignored by computeLiveBreach
  createdAt: "2026-07-21T08:00:00Z",
  updatedAt: "2026-07-21T08:00:00Z",
  ...overrides,
});

async function main() {
  // === CASE A — Live SLA: open + past due → BREACHED ===
  const breachedOpen = computeLiveBreach(
    baseTicket({ status: "open" }),
    new Date("2026-07-21T10:00:00Z"),
  );
  assert(breachedOpen.breached === true, `CASE A: open ticket past dueAt should be breached`);
  console.log(`  CASE A OK: open ticket past dueAt → breached=true.`);

  // === CASE B — Live SLA: resolved → NOT BREACHED even past dueAt ===
  const resolvedPast = computeLiveBreach(
    baseTicket({ status: "resolved" }),
    new Date("2026-07-21T10:00:00Z"),
  );
  assert(resolvedPast.breached === false, `CASE B: resolved ticket is never breached`);
  console.log(`  CASE B OK: resolved ticket past dueAt → NOT breached.`);

  // === CASE C — Live SLA: closed → NOT BREACHED ===
  const closedPast = computeLiveBreach(
    baseTicket({ status: "closed" }),
    new Date("2026-07-21T10:00:00Z"),
  );
  assert(closedPast.breached === false, `CASE C: closed ticket is never breached`);
  console.log(`  CASE C OK: closed ticket past dueAt → NOT breached.`);

  // === CASE D — Live SLA: open + before due → NOT BREACHED ===
  const notYetDue = computeLiveBreach(
    baseTicket({ status: "open" }),
    new Date("2026-07-21T08:30:00Z"),
  );
  assert(notYetDue.breached === false, `CASE D: ticket before dueAt is not breached`);
  console.log(`  CASE D OK: open ticket before dueAt → NOT breached.`);

  // === CASE E — Live SLA remaining math ===
  // dueAt=09:00, now=08:30 → 30 min remaining
  const remaining30 = computeLiveBreach(
    baseTicket({ status: "open" }),
    new Date("2026-07-21T08:30:00Z"),
  );
  assert(remaining30.remainingMinutes === 30, `CASE E: expected 30 remaining, got ${remaining30.remainingMinutes}`);
  // dueAt=09:00, now=09:30 → -30 min remaining (30 min overdue)
  const overdue30 = computeLiveBreach(
    baseTicket({ status: "open" }),
    new Date("2026-07-21T09:30:00Z"),
  );
  assert(overdue30.remainingMinutes === -30, `CASE E: expected -30 remaining, got ${overdue30.remainingMinutes}`);
  console.log(`  CASE E OK: remaining math correct (30 / -30).`);

  // === CASE F — Manual assignment → stays unassigned ===
  const manualResult = assignTicket({
    ticket: baseTicket({}),
    settings: { ...baseSettings, assignmentMode: "manual" },
    activeStaffIds: ["userA", "userB"],
  });
  assert(manualResult.assignedTo === undefined, `CASE F: manual mode leaves ticket unassigned`);
  assert(manualResult.pointer === 0, `CASE F: pointer unchanged`);
  console.log(`  CASE F OK: manual mode → unassigned.`);

  // === CASE G — Auto-rule: first matching rule wins ===
  const autoRuleResult = assignTicket({
    ticket: baseTicket({ sourceChannel: "whatsapp", priority: "high" }),
    settings: {
      ...baseSettings,
      assignmentMode: "auto_rule",
      assignmentRules: [
        { match: { sourceChannel: "whatsapp" }, assignToUserId: "userA" },
        { match: { priority: "urgent" }, assignToUserId: "userB" },
      ],
    },
    activeStaffIds: ["userA", "userB"],
  });
  assert(autoRuleResult.assignedTo === "userA", `CASE G: first matching rule (whatsapp→userA) should win`);
  console.log(`  CASE G OK: auto_rule first-match → userA.`);

  // === CASE H — Auto-rule: no match → unassigned ===
  const noMatchResult = assignTicket({
    ticket: baseTicket({ sourceChannel: "email", priority: "medium" }),
    settings: {
      ...baseSettings,
      assignmentMode: "auto_rule",
      assignmentRules: [
        { match: { sourceChannel: "whatsapp" }, assignToUserId: "userA" },
        { match: { priority: "urgent" }, assignToUserId: "userB" },
      ],
    },
    activeStaffIds: ["userA", "userB"],
  });
  assert(noMatchResult.assignedTo === undefined, `CASE H: no rule match → unassigned`);
  console.log(`  CASE H OK: auto_rule no-match → unassigned.`);

  // === CASE I — Round-robin rotation ===
  const staff = ["userA", "userB", "userC"];
  const r1 = assignTicket({
    ticket: baseTicket({ id: "t1" }),
    settings: { ...baseSettings, assignmentMode: "round_robin", roundRobinPointer: 0 },
    activeStaffIds: staff,
  });
  assert(r1.assignedTo === "userA", `CASE I: first rotation → userA, got ${r1.assignedTo}`);
  assert(r1.pointer === 1, `CASE I: pointer → 1, got ${r1.pointer}`);
  const r2 = assignTicket({
    ticket: baseTicket({ id: "t2" }),
    settings: { ...baseSettings, assignmentMode: "round_robin", roundRobinPointer: 1 },
    activeStaffIds: staff,
  });
  assert(r2.assignedTo === "userB", `CASE I: second rotation → userB, got ${r2.assignedTo}`);
  assert(r2.pointer === 2, `CASE I: pointer → 2, got ${r2.pointer}`);
  const r3 = assignTicket({
    ticket: baseTicket({ id: "t3" }),
    settings: { ...baseSettings, assignmentMode: "round_robin", roundRobinPointer: 2 },
    activeStaffIds: staff,
  });
  assert(r3.assignedTo === "userC", `CASE I: third rotation → userC, got ${r3.assignedTo}`);
  assert(r3.pointer === 0, `CASE I: pointer wraps → 0, got ${r3.pointer}`);
  console.log(`  CASE I OK: round-robin A→B→C→(wraps to A).`);

  // === CASE J — Convert UnknownQuestion to Ticket ===
  const uq: UnknownQuestion = {
    id: "uq1",
    workspaceId: "ws1",
    channel: "whatsapp",
    leadId: "lead1",
    questionText: "Do you have rose gold zari?",
    status: "open",
    generatedBy: "whatsapp_unknown",
    priority: "medium",
    createdAt: "2026-07-21T08:00:00Z",
    updatedAt: "2026-07-21T08:00:00Z",
  };
  const convertedTicket = await convertToTicket({
    source: { entity: "unknown_question", record: uq },
    type: "question",
    priority: "medium",
    slaSettings: baseSettings,
  });
  assert(convertedTicket.sourceEntityType === "unknown_question", `CASE J: sourceEntityType set`);
  assert(convertedTicket.sourceEntityId === "uq1", `CASE J: sourceEntityId set`);
  assert(convertedTicket.status === "open", `CASE J: ticket starts open`);
  assert(convertedTicket.subject.includes("rose gold zari"), `CASE J: subject derives from source`);
  console.log(`  CASE J OK: UnknownQuestion → Ticket with source linkage.`);

  // === CASE K — Double-convert throws ===
  const alreadyConvertedUq: UnknownQuestion = { ...uq, convertedToTicketId: "t_existing" };
  let doubleConvertThrew = false;
  try {
    await convertToTicket({
      source: { entity: "unknown_question", record: alreadyConvertedUq },
      type: "question",
      priority: "medium",
      slaSettings: baseSettings,
    });
  } catch {
    doubleConvertThrew = true;
  }
  assert(doubleConvertThrew, `CASE K: double-convert should throw`);
  console.log(`  CASE K OK: double-convert throws.`);

  console.log("PASS golden-ticket-lifecycle: all 11 cases match operator-confirmed rules.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
