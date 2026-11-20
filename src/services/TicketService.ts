/**
 * Stage 2 / 2026-07-20 — Ticket service.  Extended 2026-07-21 (Batch 1).
 *
 * The business rules for customer tickets. The WhatsApp engine calls
 * `createTicketFromInbound` when it detects a complaint/problem that needs
 * tracking. The owner/operator then works the ticket through the lifecycle.
 *
 * 2026-07-21 additions (per docs/LOGIC.md):
 *   - computeLiveBreach(ticket, now): pure live SLA breach computation.
 *     Replaces the dormant stored slaBreached flag as the authoritative
 *     source. Resolved/closed tickets are never breached.
 *   - assignTicket(input): pure function implementing the 3 assignment
 *     modes (manual / auto_rule / round_robin) per the workspace toggle.
 *   - convertToTicket(input): converts a legacy UnknownQuestion /
 *     HumanFallbackTask into a Ticket with source linkage. Blocks double-
 *     convert. Status transitions are NOT enforced (any→any allowed).
 *
 * Pure orchestration on top of the repository + the SLA helper. No LLM.
 */
import { NeedsActionError } from "@/lib/user-errors";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { computeSla, defaultTicketSlaSettings } from "@/lib/ticket-sla";
import type {
  HumanFallbackTask,
  Ticket,
  TicketAssignmentRule,
  TicketEvent,
  TicketPriority,
  TicketSlaSettings,
  TicketSourceEntityType,
  TicketStatus,
  TicketType,
  UnknownQuestion,
} from "@/lib/types";
import { uid, timestamp } from "@/lib/db";
import { oneAtATime } from "@/lib/one-at-a-time";

function responsibilityTransaction<T>(workspaceId: string, repos: RepositoryBundle, work: () => Promise<T>): Promise<T> {
  return oneAtATime(`team:${workspaceId}`, () => {
    if (repos.withWorkspaceTeamTransaction) return repos.withWorkspaceTeamTransaction(workspaceId, work);
    return repos.withTransaction ? repos.withTransaction(work) : work();
  });
}

const TICKET_PRIORITIES: readonly TicketPriority[] = ["urgent", "high", "medium", "low"];
const TICKET_TYPES: readonly TicketType[] = ["problem", "complaint", "question", "request", "refund", "return", "delivery", "quality"];
const TICKET_STATUSES: readonly TicketStatus[] = ["open", "in_progress", "waiting_customer", "resolved", "closed", "reopened"];

function validateTicketCategory(input: { type: TicketType; priority: TicketPriority }): void {
  if (!(TICKET_PRIORITIES as readonly string[]).includes(String(input.priority))) {
    throw new NeedsActionError(`Choose a priority: ${TICKET_PRIORITIES.join(", ")}.`, 400);
  }
  if (!(TICKET_TYPES as readonly string[]).includes(String(input.type))) {
    throw new NeedsActionError(`Choose a ticket type: ${TICKET_TYPES.join(", ")}.`, 400);
  }
}

/** Keep the entire support case attached to the same customer, even for internal callers. */
async function validateTicketLinks(
  input: { workspaceId: string; leadId?: string; replyId?: string; orderId?: string; quoteId?: string },
  repos: RepositoryBundle,
): Promise<string | undefined> {
  const customerIds = new Set<string>();
  if (input.leadId) {
    if (!await repos.lead.getLeadById(input.workspaceId, input.leadId)) {
      throw new NeedsActionError("The selected customer was not found in your workspace.", 404);
    }
    customerIds.add(input.leadId);
  }
  const links = [
    { id: input.orderId, label: "order", load: (id: string) => repos.order.getById(input.workspaceId, id) },
    { id: input.quoteId, label: "quote", load: (id: string) => repos.quote.getById(input.workspaceId, id) },
    { id: input.replyId, label: "customer message", load: (id: string) => repos.reply.getById(input.workspaceId, id) },
  ];
  for (const link of links) {
    if (!link.id) continue;
    const record = await link.load(link.id);
    if (!record) throw new NeedsActionError(`The selected ${link.label} was not found in your workspace.`, 404);
    if (record.leadId) customerIds.add(record.leadId);
  }
  if (customerIds.size > 1) {
    throw new NeedsActionError("Choose a customer, order, quote and message belonging to the same customer.", 400);
  }
  return customerIds.values().next().value;
}

/**
 * Create a ticket from an inbound customer message. The caller passes the
 * type + priority (the WhatsApp engine derives these from the classifier).
 * Computes the SLA dueAt using the workspace's SLA settings.
 *
 * If a ticket already exists for the same (leadId, replyId) and is still
 * open, returns that ticket instead of creating a duplicate. Prevents
 * duplicate tickets when the customer sends multiple messages about the
 * same complaint.
 */
export async function createTicketFromInbound(input: {
  workspaceId: string;
  leadId?: string;
  replyId?: string;
  conversationId?: string;
  /** N-P1-2 (2026-08-07) — the order/quote this ticket is about, if any. */
  orderId?: string;
  quoteId?: string;
  sourceChannel: string;
  type: TicketType;
  priority: TicketPriority;
  subject: string;
  description: string;
  createdBy?: string;
}, repos: RepositoryBundle = createRepositories()): Promise<Ticket> {
  return responsibilityTransaction(input.workspaceId, repos, async () => {
    input = { ...input };
    for (const key of ["leadId", "replyId", "orderId", "quoteId"] as const) {
      const value = input[key];
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw new NeedsActionError("Choose a valid customer, order, quote or message.", 400);
      }
      input[key] = typeof value === "string" ? value.trim() || undefined : undefined;
    }
    // 2026-09-26 (break test): an unknown priority made the SLA length
    // "undefined", so the ticket was due the moment it was created (and an
    // unknown type was stored as is). Refused with plain words instead.
    validateTicketCategory(input);
    input.leadId = await validateTicketLinks(input, repos);
    // De-duplicate: if there's an open ticket on the same lead + SAME REPLY,
    // reuse it. F-UI-4 (depth-audit 2026-07-29): the old check
    // `t.replyId === input.replyId` matched when BOTH were undefined — so a
    // manual ticket (no replyId) dedup'd against ANY existing open ticket on
    // the same lead, silently returning the old one. The operator could never
    // create a second manual ticket for a lead with an open ticket. Dedup must
    // only fire when an actual replyId ties them together (the same inbound
    // message producing duplicate tickets); absence of replyId = no tie.
    if (input.leadId && input.replyId) {
      const existing = await repos.ticket.listByWorkspace(input.workspaceId, { leadId: input.leadId });
      const open = existing.find((t) => !["resolved", "closed"].includes(t.status) && t.replyId === input.replyId);
      if (open) return open;
    }

    // Load SLA settings (or create defaults).
    let slaSettings = await repos.ticketSlaSettings.getByWorkspace(input.workspaceId);
    if (!slaSettings) {
      slaSettings = await repos.ticketSlaSettings.upsertForWorkspace(input.workspaceId, defaultTicketSlaSettings(input.workspaceId) as Partial<TicketSlaSettings>);
    }

    // Compute SLA dueAt from "now".
    const startedAt = new Date();
    const sla = computeSla({
      priority: input.priority,
      startedAt,
      now: startedAt,
      settings: slaSettings,
  });

  // Allocate the next ticket number + create in one atomic transaction when
  // the repo supports it (Cluster D fix, 2026-07-21 session 20). Falls back
  // to the old nextTicketNumber + create pair for repos that don't.
  const ticketInput = {
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    replyId: input.replyId,
    conversationId: input.conversationId,
    orderId: input.orderId,
    quoteId: input.quoteId,
    sourceChannel: input.sourceChannel,
    type: input.type,
    priority: input.priority,
    status: "open" as TicketStatus,
    subject: input.subject,
    description: input.description,
    sourceEntityType: (input.sourceChannel === "manual" ? "manual" : "inbound") as TicketSourceEntityType,
    slaStartedAt: startedAt.toISOString(),
    slaDueAt: sla.dueAt.toISOString(),
    slaBreached: false,
  };
  const ticketRepo = repos.ticket as unknown as {
    createWithNextTicketNumber?: (input: typeof ticketInput) => Promise<Ticket>;
    nextTicketNumber: (ws: string) => Promise<number>;
    create: (input: typeof ticketInput & { ticketNumber: number }) => Promise<Ticket>;
  };
  let ticket: Ticket;
  if (typeof ticketRepo.createWithNextTicketNumber === "function") {
    ticket = await ticketRepo.createWithNextTicketNumber(ticketInput);
  } else {
    const ticketNumber = await ticketRepo.nextTicketNumber(input.workspaceId);
    ticket = await ticketRepo.create({ ...ticketInput, ticketNumber });
  }

  // 2026-07-21 (Cluster A fix, session 16) — ASSIGN the ticket per the
  // workspace's policy (manual / auto_rule / round_robin). Previously the
  // assignTicket helper existed + was golden-tested but NEVER called from
  // production, so the assignment toggle silently did nothing.
  //
  // The helper is pure; we apply its result here and persist two things:
  //   1. ticket.assignedTo (when assigned)
  //   2. settings.roundRobinPointer (only advances in round_robin mode)
  //
  // Round-robin + ticket-update + settings-update are NOT in one mutateData
  // block today (JSON repos are single-process, so the small race window is
  // acceptable; Cluster D of the audit will tighten this when atomicity work
  // lands). A failed assignment does NOT abort ticket creation — the ticket
  // exists unassigned, matching CASE D/E of golden-ticket-wiring.
  let assignedTicket = ticket;
  try {
    // A viewer can read the case but cannot work it. Never route work to them.
    const activeStaff = (await repos.workspace.listActiveStaffForWorkspace(input.workspaceId))
      .filter((member) => member.role !== "viewer");
    const decision = assignTicket({
      ticket: {
        sourceChannel: ticket.sourceChannel,
        priority: ticket.priority,
        type: ticket.type,
        assignedTo: ticket.assignedTo,
      },
      settings: {
        assignmentMode: slaSettings.assignmentMode,
        assignmentRules: slaSettings.assignmentRules,
        roundRobinPointer: slaSettings.roundRobinPointer ?? 0,
      },
      // N-DATA-18: WorkspaceMember.userId is null until the invite is
      // accepted. A pending invitee is not staff and must never have a
      // ticket routed to them, so they are dropped here rather than
      // reaching the round-robin pointer as an empty id.
      activeStaffIds: activeStaff.map((m) => m.userId).filter((id): id is string => Boolean(id)),
    });
    // 2026-09-26 (break test): an assignment rule keeps pointing at a person
    // after they leave the team. Handing them the ticket means nobody works
    // it; per the auto_rule contract it stays unassigned instead.
    const activeIds = new Set(activeStaff.map((m) => m.userId).filter(Boolean));
    if (decision.assignedTo && !activeIds.has(decision.assignedTo)) {
      decision.assignedTo = undefined;
    }
    if (decision.assignedTo) {
      assignedTicket = await repos.ticket.update(input.workspaceId, ticket.id, {
        assignedTo: decision.assignedTo,
      });
      await repos.ticketEvent.create({
        workspaceId: input.workspaceId,
        ticketId: ticket.id,
        eventType: "assigned",
        actorType: "agent",
        actorUserId: input.createdBy,
        // Plain words: this note is shown in the ticket's history.
        note: slaSettings.assignmentMode === "round_robin" ? "Assigned automatically, taking turns across the team."
          : slaSettings.assignmentMode === "auto_rule" ? "Assigned automatically by your assignment rule."
          : "Assigned automatically.",
      });
    }
    // Advance the round-robin pointer ONLY when mode=round_robin AND a
    // ticket was actually assigned (no-op for manual / auto_rule / no-staff).
    if (slaSettings.assignmentMode === "round_robin" && decision.assignedTo && decision.pointer !== slaSettings.roundRobinPointer) {
      await repos.ticketSlaSettings.upsertForWorkspace(input.workspaceId, {
        roundRobinPointer: decision.pointer,
      } as Partial<TicketSlaSettings>);
    }
  } catch (assignmentError) {
    // Assignment failure must NOT mask ticket creation. The ticket exists;
    // it is simply unassigned. The operator can assign manually. We log so
    // the failure is visible (no silent catch per build-right Phase 4).
    console.error(
      `[TicketService] auto-assignment failed for ticket ${ticket.id} in workspace ${input.workspaceId}:`,
      assignmentError instanceof Error ? assignmentError.message : assignmentError,
    );
  }

  // Audit event.
  await repos.ticketEvent.create({
    workspaceId: input.workspaceId,
    ticketId: assignedTicket.id,
    eventType: "created",
    actorType: input.sourceChannel === "manual" ? "owner" : "agent",
    actorUserId: input.createdBy,
    toStatus: "open",
    // Plain words (break test 2026-09-26: "from whatsapp inbound" was shown as is).
    note: input.sourceChannel === "manual" ? "Created manually."
      : `Created automatically from ${input.sourceChannel === "whatsapp" ? "a WhatsApp message" : input.sourceChannel === "email" ? "an email" : "an incoming message"}.`,
  });

  return assignedTicket;
  });
}

/**
 * Change a ticket's status. Emits a status_changed event. If the new status
 * is "resolved" or "closed", records the resolvedAt/closedAt timestamp.
 */
export async function changeTicketStatus(
  workspaceId: string,
  ticketId: string,
  toStatus: TicketStatus,
  actor: { userId?: string; actorType: TicketEvent["actorType"]; note?: string },
  repos: RepositoryBundle = createRepositories(),
): Promise<Ticket> {
  return responsibilityTransaction(workspaceId, repos, async () => {
    if (!(TICKET_STATUSES as readonly string[]).includes(String(toStatus))) {
      throw new NeedsActionError("Choose a valid ticket status.", 400);
    }
    const ticket = await repos.ticket.getById(workspaceId, ticketId);
    if (!ticket) throw new NeedsActionError("This ticket was not found. It may have been removed.", 404);
    if (actor.note !== undefined && (typeof actor.note !== "string" || actor.note.length > 5_000)) {
      throw new NeedsActionError("Keep the ticket note within 5,000 characters.", 400);
    }
    if (!["resolved", "closed"].includes(toStatus) && ticket.assignedTo) {
      const handler = (await repos.workspace.listActiveStaffForWorkspace(workspaceId))
        .find((member) => member.userId === ticket.assignedTo && member.role !== "viewer");
      if (!handler) throw new NeedsActionError("Reassign this ticket to an active team member before reopening or continuing the work.", 409);
    }
    const fromStatus = ticket.status;
    // Completion must carry the same useful explanation required by the
    // employee screen. Keep the documented flexible status transitions;
    // repeated same-status requests do not create another history entry.
    const outcomeNote = actor.note?.trim();
    if (fromStatus !== toStatus && ["resolved", "closed"].includes(toStatus) && !outcomeNote) {
      throw new NeedsActionError("Please explain the outcome so your team can follow what happened.", 400);
    }
    const now = new Date().toISOString();
    const patch: Partial<Ticket> = { status: toStatus };
    if (toStatus === "resolved" && !ticket.resolvedAt) patch.resolvedAt = now;
    if (toStatus === "closed" && !ticket.closedAt) patch.closedAt = now;
    if (toStatus === "reopened") patch.resolvedAt = undefined;
    // 2026-09-26 (break test): a ticket brought back from resolved/closed kept
    // its old deadline (long past), so it showed as late the moment it
    // reopened, and it kept saying when it was closed. Leaving a finished state
    // now clears those dates and starts a fresh SLA clock from now.
    const FINISHED: TicketStatus[] = ["resolved", "closed"];
    if (FINISHED.includes(fromStatus) && !FINISHED.includes(toStatus)) {
      patch.resolvedAt = undefined;
      patch.closedAt = undefined;
      const settings = (await repos.ticketSlaSettings.getByWorkspace(workspaceId))
        ?? ({ ...defaultTicketSlaSettings(workspaceId) } as TicketSlaSettings);
      const restartedAt = new Date(now);
      patch.slaStartedAt = restartedAt.toISOString();
      patch.slaDueAt = computeSla({ priority: ticket.priority, startedAt: restartedAt, now: restartedAt, settings }).dueAt.toISOString();
    }
    if (fromStatus !== toStatus && (toStatus === "in_progress" || toStatus === "waiting_customer") && !ticket.firstRespondedAt) {
      patch.firstRespondedAt = now;
    }
    const updated = await repos.ticket.update(workspaceId, ticketId, patch);
    if (fromStatus !== toStatus) {
      await repos.ticketEvent.create({
        workspaceId,
        ticketId,
        eventType: toStatus === "resolved" ? "resolved" : toStatus === "reopened" ? "reopened" : "status_changed",
        fromStatus,
        toStatus,
        actorType: actor.actorType,
        actorUserId: actor.userId,
        note: outcomeNote,
      });
    }
    return updated;
  });
}

/**
 * Hand a ticket to a team member (or unassign it with an empty value).
 *
 * 2026-09-26 (break test): the assign route wrote whatever id it was sent.
 * A ticket could be given to someone removed from the team, to a pending
 * invite, or to an id that is nobody — and then nobody worked it. The history
 * line also showed the raw id ("Assigned to user_ab12."). Only ACTIVE members
 * of this workspace can be assigned now, and the history names them.
 */
export async function assignTicketToMember(
  workspaceId: string,
  ticketId: string,
  assignedTo: string | undefined | null,
  actorUserId: string | undefined,
  repos: RepositoryBundle = createRepositories(),
): Promise<Ticket> {
  return responsibilityTransaction(workspaceId, repos, async () => {
    const ticket = await repos.ticket.getById(workspaceId, ticketId);
    if (!ticket) throw new NeedsActionError("This ticket was not found. It may have been removed.", 404);
    const previousAssignee = ticket.assignedTo;
    if (assignedTo === undefined || assignedTo === null || assignedTo === "") {
      const updated = await repos.ticket.update(workspaceId, ticketId, { assignedTo: undefined });
      if (previousAssignee) {
        await repos.ticketEvent.create({
          workspaceId, ticketId, eventType: "commented", actorType: "owner", actorUserId,
          note: "Assignment removed.",
        });
      }
      return updated;
    }
    const members = (await repos.workspace.listActiveStaffForWorkspace(workspaceId))
      .filter((member) => member.role !== "viewer");
    const member = typeof assignedTo === "string" ? members.find((m) => m.userId === assignedTo) : undefined;
    if (!member) {
      throw new NeedsActionError("That person must be an active team member with permission to work tickets. Pick someone from the list.", 400);
    }
    const updated = await repos.ticket.update(workspaceId, ticketId, { assignedTo: member.userId! });
    if (previousAssignee !== member.userId) {
      await repos.ticketEvent.create({
        workspaceId, ticketId, eventType: "assigned",
        actorType: "owner", actorUserId,
        note: `Assigned to ${member.name || member.email}.`,
      });
    }
    return updated;
  });
}

/**
 * Map a customer-message classifier category to a (TicketType, TicketPriority).
 * Used by the WhatsApp engine when escalating a complaint.
 */
export function classifyForTicket(category: string): { type: TicketType; priority: TicketPriority } {
  switch (category) {
    case "complaint":
    case "return_question":
      return { type: "complaint", priority: "high" };
    case "abusive_message":
      return { type: "complaint", priority: "urgent" };
    case "delivery_question":
      return { type: "delivery", priority: "medium" };
    case "payment_question":
      return { type: "request", priority: "medium" };
    case "hot_lead":
    case "bulk_order_interest":
      return { type: "request", priority: "medium" };
    default:
      return { type: "question", priority: "low" };
  }
}

// =============================================================================
// 2026-07-21 additions (Batch 1 — Ticket lifecycle extensions).
// Per docs/LOGIC.md 2026-07-21.
// =============================================================================

/**
 * The statuses where the SLA clock is still running. Tickets in any other
 * status (resolved, closed) have stopped the clock and cannot be breached.
 */
const SLA_ACTIVE_STATUSES: ReadonlySet<TicketStatus> = new Set([
  "open",
  "in_progress",
  "waiting_customer",
  "reopened",
]);

/**
 * 2026-07-21 — Pure live-SLA computation.
 *
 * A ticket is "breached" iff (now > slaDueAt) AND its status is one where
 * the SLA clock is still ticking. Resolved/closed tickets are NEVER breached
 * (the clock stopped). The stored `slaBreached` field is ignored — this is
 * the authoritative source.
 *
 * Returns: { breached, remainingMinutes }.
 *   remainingMinutes = how long until dueAt (positive) or how long overdue
 *   (negative). Rounded to the nearest minute.
 */
export function computeLiveBreach(ticket: Pick<Ticket, "slaDueAt" | "status">, now: Date): {
  breached: boolean;
  remainingMinutes: number;
} {
  // If the SLA clock isn't running for this status, the ticket is never
  // breached — even if dueAt is in the past. The clock stopped.
  if (!SLA_ACTIVE_STATUSES.has(ticket.status)) {
    return { breached: false, remainingMinutes: Number.POSITIVE_INFINITY };
  }
  const dueMs = new Date(ticket.slaDueAt).getTime();
  const nowMs = now.getTime();
  const remainingMinutes = Math.round((dueMs - nowMs) / 60000);
  return {
    breached: nowMs > dueMs,
    remainingMinutes,
  };
}

/**
 * 2026-07-21 — Assign a ticket per the workspace's assignment policy.
 *
 * Pure function — does NOT write to the repository. The caller is responsible
 * for persisting `assignedTo` on the ticket and updating the roundRobinPointer
 * on the settings (when mode=round_robin).
 *
 * Behaviour per mode:
 *   - manual: returns the ticket unchanged (assignedTo stays undefined).
 *   - auto_rule: walks assignmentRules in order; first rule whose `match`
 *     object fully matches the ticket wins. If no rule matches, the ticket
 *     is left unassigned (never silently routed to the wrong person).
 *   - round_robin: picks the next active staff id, advances the pointer
 *     (wraps around). If activeStaffIds is empty, ticket stays unassigned.
 *
 * Returns: { assignedTo, pointer }. `pointer` is the new value to persist
 * for round-robin mode (unchanged for manual / auto_rule).
 */
export function assignTicket(input: {
  ticket: Pick<Ticket, "sourceChannel" | "priority" | "type" | "assignedTo">;
  settings: Pick<TicketSlaSettings, "assignmentMode" | "assignmentRules" | "roundRobinPointer">;
  activeStaffIds: string[];
}): { assignedTo: string | undefined; pointer: number } {
  const { ticket, settings, activeStaffIds } = input;

  if (settings.assignmentMode === "manual") {
    return { assignedTo: ticket.assignedTo, pointer: settings.roundRobinPointer };
  }

  if (settings.assignmentMode === "auto_rule") {
    for (const rule of settings.assignmentRules as TicketAssignmentRule[]) {
      if (ruleMatchesTicket(rule, ticket)) {
        return { assignedTo: rule.assignToUserId, pointer: settings.roundRobinPointer };
      }
    }
    // No rule matched — leave unassigned.
    return { assignedTo: undefined, pointer: settings.roundRobinPointer };
  }

  if (settings.assignmentMode === "round_robin") {
    if (activeStaffIds.length === 0) {
      return { assignedTo: undefined, pointer: settings.roundRobinPointer };
    }
    const safePointer = settings.roundRobinPointer % activeStaffIds.length;
    const assignedTo = activeStaffIds[safePointer];
    const nextPointer = (safePointer + 1) % activeStaffIds.length;
    return { assignedTo, pointer: nextPointer };
  }

  // Unknown mode — fall back to manual.
  return { assignedTo: ticket.assignedTo, pointer: settings.roundRobinPointer };
}

function ruleMatchesTicket(
  rule: TicketAssignmentRule,
  ticket: Pick<Ticket, "sourceChannel" | "priority" | "type">,
): boolean {
  const m = rule.match;
  if (m.sourceChannel !== undefined && m.sourceChannel !== ticket.sourceChannel) return false;
  if (m.priority !== undefined && m.priority !== ticket.priority) return false;
  if (m.type !== undefined && m.type !== ticket.type) return false;
  return true;
}

/**
 * 2026-07-21 — Convert a legacy entity (UnknownQuestion / HumanFallbackTask)
 * into a Ticket, with source linkage.
 *
 * Throws if the source has already been converted (convertedToTicketId set).
 * The caller is responsible for persisting both the new Ticket AND the
 * updated source record (with convertedToTicketId set to the new ticket's id).
 *
 * Pure constructor — does NOT write to the repository. Returns the new
 * Ticket object + the patch to apply to the source.
 */
export async function convertToTicket(input: {
  source:
    | { entity: "unknown_question"; record: UnknownQuestion }
    | { entity: "human_fallback_task"; record: HumanFallbackTask };
  type: TicketType;
  priority: TicketPriority;
  slaSettings: TicketSlaSettings;
}): Promise<Ticket & { sourcePatch: { convertedToTicketId: string } }> {
  validateTicketCategory(input);
  const { source } = input;
  if (source.record.convertedToTicketId) {
    throw new NeedsActionError(
      "This has already been converted to a ticket — open it from Tickets.",
    );
  }

  const startedAt = new Date();
  const sla = computeSla({
    priority: input.priority,
    startedAt,
    now: startedAt,
    settings: input.slaSettings,
  });

  const subject = deriveSubjectFromSource(source);
  const description = deriveDescriptionFromSource(source);

  const ticketId = uid("ticket");
  const now = timestamp();

  const ticket: Ticket = {
    id: ticketId,
    workspaceId: source.record.workspaceId,
    ticketNumber: 0, // caller assigns via repos.ticket.nextTicketNumber
    leadId: "leadId" in source.record ? source.record.leadId : undefined,
    conversationId: "conversationId" in source.record ? source.record.conversationId : undefined,
    sourceChannel: "channel" in source.record ? source.record.channel : "manual",
    type: input.type,
    priority: input.priority,
    status: "open",
    subject,
    description,
    sourceEntityType: (source.entity === "unknown_question"
      ? "unknown_question"
      : "human_fallback_task") as TicketSourceEntityType,
    sourceEntityId: source.record.id,
    slaStartedAt: startedAt.toISOString(),
    slaDueAt: sla.dueAt.toISOString(),
    slaBreached: false,
    createdAt: now,
    updatedAt: now,
  };

  return { ...ticket, sourcePatch: { convertedToTicketId: ticketId } };
}

function deriveSubjectFromSource(
  source:
    | { entity: "unknown_question"; record: UnknownQuestion }
    | { entity: "human_fallback_task"; record: HumanFallbackTask },
): string {
  if (source.entity === "unknown_question") {
    const text = source.record.questionText.trim();
    return text.length > 80 ? text.slice(0, 77) + "..." : text;
  }
  return `Follow-up: ${source.record.prospectQuery}`;
}

function deriveDescriptionFromSource(
  source:
    | { entity: "unknown_question"; record: UnknownQuestion }
    | { entity: "human_fallback_task"; record: HumanFallbackTask },
): string {
  if (source.entity === "unknown_question") {
    return `Converted from UnknownQuestion: ${source.record.questionText}`;
  }
  return `Converted from HumanFallbackTask: ${source.record.prospectQuery}`;
}
