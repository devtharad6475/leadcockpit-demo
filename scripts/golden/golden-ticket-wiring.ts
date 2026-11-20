/**
 * Golden test — Ticket assignment WIRING (Cluster A fix, session 16).
 *
 * PROVES the production path actually calls `assignTicket`. The existing
 * `golden:ticket-lifecycle` pins the pure helper in isolation; this test
 * pins that the helper is REACHED when a ticket is created.
 *
 * Without this test, the dead-chokepoint bug returns silently: a future
 * change can keep `assignTicket` green (helper still works) while the
 * product ships tickets unassigned (helper not called).
 *
 * Operator-confirmed rule (docs/LOGIC.md 2026-07-21 Batch 1 Q3):
 *   "Ticket assignment is a per-workspace toggle: manual | auto_rule |
 *    round_robin."
 *
 * Hand-computed expected values (BEFORE looking at the wiring code):
 *
 *   CASE A — round_robin mode, 3 active staff [userA, userB, userC],
 *     pointer starts at 0. Creating 3 tickets in sequence must assign:
 *       ticket 1 → userA   (pointer becomes 1)
 *       ticket 2 → userB   (pointer becomes 2)
 *       ticket 3 → userC   (pointer wraps to 0)
 *     Each ticket's assignedTo MUST match. The settings.roundRobinPointer
 *     MUST end at 0 (wrapped).
 *
 *   CASE B — auto_rule mode, 2 rules:
 *     rule1 { sourceChannel: "whatsapp" → userA }
 *     rule2 { priority: "urgent"        → userB }
 *     Creating a whatsapp+medium ticket → assignedTo = userA (first match).
 *     Creating an email+urgent ticket   → assignedTo = userB (second rule).
 *     Creating an email+low ticket      → assignedTo = undefined (no match).
 *
 *   CASE C — manual mode: ticket stays unassigned (assignedTo = undefined).
 *
 *   CASE D — round_robin with NO active staff: ticket stays unassigned,
 *     no crash, pointer unchanged.
 *
 *   CASE E — settings absent (workspace has no TicketSlaSettings row yet):
 *     createTicketFromInbound must still succeed; assignment defaults to
 *     manual (unassigned). No crash from a missing settings row.
 *
 * Run: npx tsx scripts/golden/golden-ticket-wiring.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createTicketFromInbound } from "@/services/TicketService";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type {
  Ticket,
  TicketSlaSettings,
  Workspace,
  WorkspaceMember,
} from "@/lib/types";

// =============================================================================
// In-memory repository bundle — deterministic, no JSON file dependency.
// =============================================================================

/** Build a fresh in-memory repo bundle for one test case. */
function makeRepos(initial: {
  workspace?: Partial<Workspace>;
  slaSettings?: Partial<TicketSlaSettings>;
  members?: Array<{ userId: string; role?: WorkspaceMember["role"]; status?: WorkspaceMember["status"] }>;
}): RepositoryBundle {
  const workspaceId = "ws_test";
  const workspace: Workspace = {
    id: workspaceId,
    name: initial.workspace?.name || "Test",
    ownerUserId: initial.workspace?.ownerUserId,
    businessName: initial.workspace?.businessName,
    industry: initial.workspace?.industry,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const slaSettings: TicketSlaSettings | undefined = initial.slaSettings
    ? {
        id: "sla_test",
        workspaceId,
        businessHoursStart: initial.slaSettings.businessHoursStart || "09:00",
        businessHoursEnd: initial.slaSettings.businessHoursEnd || "18:00",
        businessDays: initial.slaSettings.businessDays || [1, 2, 3, 4, 5],
        clockMode: (initial.slaSettings as { clockMode?: string }).clockMode || "business_hours",
        urgentSlaMinutes: 60,
        highSlaMinutes: 240,
        mediumSlaMinutes: 1440,
        lowSlaMinutes: 10080,
        assignmentMode: initial.slaSettings.assignmentMode || "manual",
        assignmentRules: initial.slaSettings.assignmentRules || [],
        roundRobinPointer: initial.slaSettings.roundRobinPointer ?? 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as TicketSlaSettings
    : undefined;

  const members: WorkspaceMember[] = (initial.members || []).map((m, i) => ({
    id: `member_${i}`,
    workspaceId,
    userId: m.userId,
    email: `${m.userId}@example.com`,
    name: m.userId,
    role: m.role || "sales_member",
    status: m.status || "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));

  // In-memory tables.
  const tickets: Ticket[] = [];
  const ticketEvents: Array<Record<string, unknown>> = [];
  let slaRow: TicketSlaSettings | undefined = slaSettings;
  let ticketCounter = 0;

  // Minimal repo bundle — only the methods the service touches.
  // (Plus listActiveStaffForWorkspace, which the fix adds.)
  const repos = {
    workspace: {
      getById: async () => workspace,
      getDefault: async () => workspace,
      create: async (input: Partial<Workspace>) => ({ ...workspace, ...input }) as Workspace,
      update: async (_id: string, data: Partial<Workspace>) => ({ ...workspace, ...data }),
      // 2026-07-21 (Cluster A fix) — the new method the wiring needs.
      listActiveStaffForWorkspace: async (): Promise<WorkspaceMember[]> =>
        members.filter((m) => m.status === "active"),
    },
    ticket: {
      listByWorkspace: async () => tickets,
      nextTicketNumber: async () => ++ticketCounter,
      create: async (input: Partial<Ticket>) => {
        const t = {
          id: `t_${ticketCounter}`,
          ticketNumber: ticketCounter,
          workspaceId,
          status: "open",
          priority: "medium",
          ...input,
        } as Ticket;
        tickets.push(t);
        return t;
      },
      getById: async (_ws: string, id: string) => tickets.find((t) => t.id === id),
      update: async (_ws: string, id: string, patch: Partial<Ticket>) => {
        const idx = tickets.findIndex((t) => t.id === id);
        if (idx === -1) throw new Error("Ticket not found");
        tickets[idx] = { ...tickets[idx], ...patch };
        return tickets[idx];
      },
    },
    ticketEvent: {
      create: async (input: Record<string, unknown>) => {
        ticketEvents.push(input);
        return input;
      },
    },
    ticketSlaSettings: {
      getByWorkspace: async () => slaRow,
      upsertForWorkspace: async (_ws: string, input: Partial<TicketSlaSettings>) => {
        slaRow = { ...(slaRow || ({} as TicketSlaSettings)), ...input, workspaceId } as TicketSlaSettings;
        return slaRow;
      },
    },
  } as unknown as RepositoryBundle;

  // Expose internals for assertions.
  (repos as unknown as { __slaRow: typeof slaRow }).__slaRow = slaRow;
  (repos as unknown as { __getSlaRow: () => typeof slaRow }).__getSlaRow = () => slaRow;
  return repos;
}

// =============================================================================
// Tests.
// =============================================================================

async function main() {
  // ---------------------------------------------------------------------------
  // CASE A — round_robin rotates across 3 staff.
  // ---------------------------------------------------------------------------
  {
    const repos = makeRepos({
      slaSettings: { assignmentMode: "round_robin", roundRobinPointer: 0 },
      members: [{ userId: "userA" }, { userId: "userB" }, { userId: "userC" }],
    });
    const t1 = await createTicketFromInbound({
      workspaceId: "ws_test", sourceChannel: "whatsapp",
      type: "question", priority: "medium",
      subject: "t1", description: "",
    }, repos);
    const t2 = await createTicketFromInbound({
      workspaceId: "ws_test", sourceChannel: "whatsapp",
      type: "question", priority: "medium",
      subject: "t2", description: "",
    }, repos);
    const t3 = await createTicketFromInbound({
      workspaceId: "ws_test", sourceChannel: "whatsapp",
      type: "question", priority: "medium",
      subject: "t3", description: "",
    }, repos);
    assert.equal(t1.assignedTo, "userA", `CASE A: ticket 1 → userA (got ${t1.assignedTo})`);
    assert.equal(t2.assignedTo, "userB", `CASE A: ticket 2 → userB (got ${t2.assignedTo})`);
    assert.equal(t3.assignedTo, "userC", `CASE A: ticket 3 → userC (got ${t3.assignedTo})`);
    const finalPointer = ((repos as unknown as { __getSlaRow: () => TicketSlaSettings }).__getSlaRow()).roundRobinPointer;
    assert.equal(finalPointer, 0, `CASE A: pointer wraps to 0 after 3 (got ${finalPointer})`);
    console.log("  CASE A OK: round_robin A → B → C, pointer wraps to 0.");
  }

  // ---------------------------------------------------------------------------
  // CASE B — auto_rule first-match-wins; no match → undefined.
  // ---------------------------------------------------------------------------
  {
    const repos = makeRepos({
      slaSettings: {
        assignmentMode: "auto_rule",
        assignmentRules: [
          { match: { sourceChannel: "whatsapp" }, assignToUserId: "userA" },
          { match: { priority: "urgent" }, assignToUserId: "userB" },
        ],
      },
      // 2026-09-26 (break test): a rule only assigns to an ACTIVE member.
      members: [{ userId: "userA" }, { userId: "userB" }],
    });
    const t1 = await createTicketFromInbound({
      workspaceId: "ws_test", sourceChannel: "whatsapp",
      type: "question", priority: "medium",
      subject: "t1", description: "",
    }, repos);
    const t2 = await createTicketFromInbound({
      workspaceId: "ws_test", sourceChannel: "email",
      type: "question", priority: "urgent",
      subject: "t2", description: "",
    }, repos);
    const t3 = await createTicketFromInbound({
      workspaceId: "ws_test", sourceChannel: "email",
      type: "question", priority: "low",
      subject: "t3", description: "",
    }, repos);
    assert.equal(t1.assignedTo, "userA", `CASE B: rule1 match → userA (got ${t1.assignedTo})`);
    assert.equal(t2.assignedTo, "userB", `CASE B: rule2 match → userB (got ${t2.assignedTo})`);
    assert.equal(t3.assignedTo, undefined, `CASE B: no match → undefined (got ${t3.assignedTo})`);
    console.log("  CASE B OK: auto_rule first-match-wins + no-match undefined.");
  }

  // ---------------------------------------------------------------------------
  // CASE C — manual mode leaves ticket unassigned.
  // ---------------------------------------------------------------------------
  {
    const repos = makeRepos({
      slaSettings: { assignmentMode: "manual" },
      members: [{ userId: "userA" }],
    });
    const t = await createTicketFromInbound({
      workspaceId: "ws_test", sourceChannel: "whatsapp",
      type: "question", priority: "medium",
      subject: "t", description: "",
    }, repos);
    assert.equal(t.assignedTo, undefined, `CASE C: manual → unassigned (got ${t.assignedTo})`);
    console.log("  CASE C OK: manual mode → unassigned.");
  }

  // ---------------------------------------------------------------------------
  // CASE D — round_robin with no active staff → unassigned, no crash.
  // ---------------------------------------------------------------------------
  {
    const repos = makeRepos({
      slaSettings: { assignmentMode: "round_robin", roundRobinPointer: 0 },
      members: [], // nobody active
    });
    const t = await createTicketFromInbound({
      workspaceId: "ws_test", sourceChannel: "whatsapp",
      type: "question", priority: "medium",
      subject: "t", description: "",
    }, repos);
    assert.equal(t.assignedTo, undefined, `CASE D: no staff → unassigned (got ${t.assignedTo})`);
    const pointer = ((repos as unknown as { __getSlaRow: () => TicketSlaSettings }).__getSlaRow()).roundRobinPointer;
    assert.equal(pointer, 0, `CASE D: pointer unchanged (got ${pointer})`);
    console.log("  CASE D OK: round_robin with no staff → unassigned, no crash.");
  }

  // ---------------------------------------------------------------------------
  // CASE E — no settings row → defaults to manual, no crash.
  // ---------------------------------------------------------------------------
  {
    const repos = makeRepos({}); // no slaSettings passed
    const t = await createTicketFromInbound({
      workspaceId: "ws_test", sourceChannel: "whatsapp",
      type: "question", priority: "medium",
      subject: "t", description: "",
    }, repos);
    assert.equal(t.assignedTo, undefined, `CASE E: no settings → unassigned (got ${t.assignedTo})`);
    assert.ok(t.id, "CASE E: ticket was created despite missing settings");
    console.log("  CASE E OK: missing settings row → defaults to manual, no crash.");
  }

  console.log("\nPASS golden-ticket-wiring: assignTicket is reached on every createTicketFromInbound path (5 cases).");
}

main().catch((err) => {
  console.error("\nFAIL golden-ticket-wiring:", err.message);
  process.exit(1);
});
