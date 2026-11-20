/**
 * Stage 5 / WP3 (2026-07-28) — Platform ticket lifecycle service.
 *
 * Pure-ish functions for the platform-ticket model (a workspace user reporting
 * a problem to the SaaS operator). Deliberately a SEPARATE model from the
 * workspace-scoped customer `Ticket` (Stage 2): different audience, different
 * SLA owner (the operator), different inbox.
 *
 * Rules in docs/LOGIC.md 2026-07-28 (Stage 5 WP3). Pinned by
 * `golden:platform-ticket` (10 hand-computed cases) +
 * `golden:platform-admin-auth` (RBAC gate on create).
 *
 * Reuses the proven Stage 2 SLA engine (`src/lib/ticket-sla.ts`) via a thin
 * adapter — no second SLA implementation. The platform SLA uses the OPERATOR's
 * support hours (`PlatformSupportHours`), NOT the customer workspace's hours.
 *
 * SACRED no-auto-outreach: this service introduces ZERO automatic outbound
 * messages. Every status change + comment is written by a logged-in human.
 */
import { NeedsActionError } from "@/lib/user-errors";
import { computeSla } from "@/lib/ticket-sla";
import type { TicketSlaSettings } from "@/lib/types";
import type {
  PlatformTicket,
  PlatformTicketActorType,
  PlatformTicketCategory,
  PlatformTicketEvent,
  PlatformTicketSlaSettings,
  PlatformTicketStatus,
  PlatformSupportHours,
} from "@/lib/types";
import { repositories } from "@/repositories";

/** The 7-day window during which a resolved/closed ticket can be reopened. */
export const REOPEN_WINDOW_DAYS = 7;

export const PLATFORM_TICKET_CATEGORIES: readonly PlatformTicketCategory[] = [
  "bug",
  "account",
  "billing",
  "how_to",
  "data_request",
  "other",
] as const;

export function isValidPlatformTicketCategory(value: string): value is PlatformTicketCategory {
  return (PLATFORM_TICKET_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Adapter: convert the platform SLA settings + support hours into the
 * TicketSlaSettings shape the proven `computeSla` engine expects. This keeps
 * a single SLA implementation (build-right Phase 3d chokepoint rule: no
 * second copy of cross-cutting math).
 *
 * We only map the SLA-relevant fields; the Stage 2 assignment-mode fields are
 * irrelevant for platform tickets (the operator assigns manually).
 */
function toSlaSettingsAdapter(
  sla: PlatformTicketSlaSettings,
  hours: PlatformSupportHours,
): TicketSlaSettings {
  return {
    id: "platform_adapter",
    workspaceId: "platform",
    clockMode: sla.clockMode,
    businessHoursStart: hours.hoursStart,
    businessHoursEnd: hours.hoursEnd,
    businessDays: hours.businessDays,
    urgentSlaMinutes: sla.urgentSlaMinutes,
    highSlaMinutes: sla.highSlaMinutes,
    mediumSlaMinutes: sla.mediumSlaMinutes,
    lowSlaMinutes: sla.lowSlaMinutes,
    assignmentMode: "manual",
    assignmentRules: [],
    roundRobinPointer: 0,
    createdAt: "",
    updatedAt: "",
  } as TicketSlaSettings;
}

/**
 * Compute the SLA dueAt for a new platform ticket, using the operator's
 * support hours + the operator's internal SLA targets. Pure (no I/O).
 */
export function computePlatformSlaDueAt(input: {
  priority: PlatformTicket["priority"];
  startedAt: Date;
  now?: Date;
  slaSettings: PlatformTicketSlaSettings;
  supportHours: PlatformSupportHours;
}): Date {
  const settings = toSlaSettingsAdapter(input.slaSettings, input.supportHours);
  const result = computeSla({
    priority: input.priority,
    startedAt: input.startedAt,
    now: input.now ?? input.startedAt,
    settings,
  });
  return result.dueAt;
}

/**
 * Compute whether a platform ticket is currently breached (LIVE on read,
 * mirroring the Stage 2 rule LOGIC.md 2026-07-21: resolved/closed are NEVER
 * breached). Pure (no I/O).
 */
// Stage 5 re-audit F-P2-6 (2026-07-28): the breach rule lives in ONE client-
// safe chokepoint (`src/lib/platform-ticket-breach.ts`) so the admin UI
// (a "use client" component that can't import this server service) imports
// the SAME function instead of re-implementing it inline. Re-exported here
// for back-compat (existing goldens import from this service path).
// Pinned by golden:platform-ticket-user-view CASE 3.
export { computeLivePlatformBreach } from "@/lib/platform-ticket-breach";

/**
 * Stage 5 re-audit fix (F-P2-5, 2026-07-28) — User-side projection.
 *
 * The user-side GET /platform-tickets routes MUST NOT leak operator-internal
 * fields (assignedAdminId, isSpamFlagged, spamReason, flaggedByAdminId,
 * slaStartedAt, slaDueAt, firstResponseAt). The type doc explicitly says
 * these are "user never sees these." Pre-fix, the routes returned the full
 * PlatformTicket verbatim — the user could see whether their ticket was
 * flagged as spam + the reason, the internal id of the assigned admin, and
 * the operator's internal SLA dueAt. This projection strips those fields.
 *
 * Pinned by golden:platform-ticket-user-view CASE 1.
 */
export type PlatformTicketUserView = Omit<
  PlatformTicket,
  | "assignedAdminId"
  | "isSpamFlagged"
  | "spamReason"
  | "flaggedByAdminId"
  | "slaStartedAt"
  | "slaDueAt"
  | "firstResponseAt"
>;

export function toUserView(ticket: PlatformTicket): PlatformTicketUserView {
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    assignedAdminId: _assignedAdminId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    isSpamFlagged: _isSpamFlagged,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    spamReason: _spamReason,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    flaggedByAdminId: _flaggedByAdminId,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    slaStartedAt: _slaStartedAt,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    slaDueAt: _slaDueAt,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    firstResponseAt: _firstResponseAt,
    ...userView
  } = ticket;
  return userView;
}

/**
 * Stage 5 re-audit fix (F-P2-5, 2026-07-28) — User-side event projection.
 * Strips `actorAdminId` (the operator's internal admin id) from events shown
 * to the workspace user.
 */
export type PlatformTicketEventUserView = Omit<PlatformTicketEvent, "actorAdminId">;

export function toUserEventView(event: PlatformTicketEvent): PlatformTicketEventUserView {
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    actorAdminId: _actorAdminId,
    ...userView
  } = event;
  return userView;
}

// ─── Create ──────────────────────────────────────────────────────────────────

export type CreatePlatformTicketInput = {
  workspaceId: string;
  raisedByUserId: string;
  /** Creator's workspace role — the service RE-checks this (defense in depth). */
  creatorRole: "owner" | "admin" | "sales_member" | "viewer";
  subject: string;
  description: string;
  category: PlatformTicketCategory;
  priority: PlatformTicket["priority"];
  /** Override for tests (fixed clock). Defaults to now. */
  now?: Date;
};

/**
 * Create a platform ticket. Enforces every LOGIC.md 2026-07-28 rule:
 *   - creator role must be owner/admin (else AuthorizationError).
 *   - creator must not be blocked from support (else AuthorizationError).
 *   - category must be in the closed list (else Error).
 *   - subject + description non-empty.
 *   - slaDueAt computed from the operator's support hours + SLA targets.
 *   - a "created" event is appended atomically with the ticket.
 *
 * Throws on any rule violation (the route layer maps to HTTP 4xx).
 */
export async function createPlatformTicket(input: CreatePlatformTicketInput): Promise<PlatformTicket> {
  // Defense-in-depth role re-check (the route layer already enforces RBAC).
  if (input.creatorRole !== "owner" && input.creatorRole !== "admin") {
    const { AuthorizationError } = await import("@/lib/auth-service");
    throw new AuthorizationError("Only workspace owners and admins can open support tickets.", 403);
  }
  if (await repositories.platformUserBlock.isBlocked(input.raisedByUserId)) {
    const { AuthorizationError } = await import("@/lib/auth-service");
    throw new AuthorizationError("Your account is restricted from opening support tickets. Email support@leadcockpit.app.", 403);
  }
  if (!isValidPlatformTicketCategory(input.category)) {
    throw new NeedsActionError(`Unknown platform-ticket category: ${input.category}`, 400);
  }
  const subject = input.subject.trim();
  const description = input.description.trim();
  if (!subject || !description) {
    throw new NeedsActionError("Subject and description are required.", 400);
  }

  const now = input.now ?? new Date();
  const slaSettings = await repositories.platformTicketSlaSettings.get();
  const supportHours = await repositories.platformSupportHours.get();
  const slaDueAt = computePlatformSlaDueAt({
    priority: input.priority,
    startedAt: now,
    now,
    slaSettings,
    supportHours,
  });

  // Atomic create (allocates the global ticketNumber inside one tx).
  const ticket = await repositories.platformTicket.createWithNextNumber({
    workspaceId: input.workspaceId,
    raisedByUserId: input.raisedByUserId,
    subject,
    description,
    category: input.category,
    priority: input.priority,
    slaStartedAt: now.toISOString(),
    slaDueAt: slaDueAt.toISOString(),
  });
  await repositories.platformTicketEvent.create({
    ticketId: ticket.id,
    workspaceId: ticket.workspaceId,
    eventType: "created",
    actorType: "user",
    actorUserId: input.raisedByUserId,
    toStatus: "open",
    note: subject,
  });
  return ticket;
}

// ─── Add comment (the thread) ────────────────────────────────────────────────

export type AddCommentInput = {
  ticketId: string;
  actorType: PlatformTicketActorType;
  actorUserId?: string;
  actorAdminId?: string;
  note: string;
  /** Override for tests. */
  now?: Date;
};

/**
 * Append a comment to a platform ticket's thread.
 *
 * Side effects (per LOGIC.md):
 *   - If the actor is an operator and this is the first operator response,
 *     set `firstResponseAt`.
 *   - If the actor is a USER and the ticket is resolved/closed, the comment
 *     REOPENS the ticket IF within REOPEN_WINDOW_DAYS (7) of resolution;
 *     otherwise the comment is rejected (must open a new ticket).
 *   - A "commented" event is always appended; a "reopened" event is appended
 *     on reopen.
 */
export async function addPlatformTicketComment(input: AddCommentInput): Promise<{ ticket: PlatformTicket; event: PlatformTicketEvent; reopened: boolean }> {
  const note = input.note.trim();
  if (!note) {
    throw new Error("Comment cannot be empty.");
  }
  const ticket = await repositories.platformTicket.getForOperator(input.ticketId);
  if (!ticket) {
    throw new Error(`Platform ticket ${input.ticketId} not found.`);
  }
  const now = input.now ?? new Date();
  let reopened = false;
  const updates: Partial<PlatformTicket> = {};

  if (input.actorType === "operator" && !ticket.firstResponseAt) {
    updates.firstResponseAt = now.toISOString();
  }

  // User commenting on a resolved/closed ticket → reopen-window logic.
  if (input.actorType === "user" && (ticket.status === "resolved" || ticket.status === "closed")) {
    const resolvedAnchor = ticket.resolvedAt || ticket.closedAt;
    if (resolvedAnchor) {
      const daysSince = (now.getTime() - new Date(resolvedAnchor).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince <= REOPEN_WINDOW_DAYS) {
        reopened = true;
        updates.status = "reopened";
        updates.resolvedAt = undefined;
        updates.closedAt = undefined;
      } else {
        throw new NeedsActionError(`This ticket can no longer be reopened (${Math.ceil(daysSince)} days since resolution). Please open a new ticket.`, 409);
      }
    }
  }

  let updated = ticket;
  if (Object.keys(updates).length > 0) {
    updated = await repositories.platformTicket.updateForOperator(ticket.id, updates);
  }

  const event = await repositories.platformTicketEvent.create({
    ticketId: ticket.id,
    workspaceId: ticket.workspaceId,
    eventType: "commented",
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    actorAdminId: input.actorAdminId,
    note,
  });

  if (reopened) {
    await repositories.platformTicketEvent.create({
      ticketId: ticket.id,
      workspaceId: ticket.workspaceId,
      eventType: "reopened",
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      actorAdminId: input.actorAdminId,
      fromStatus: ticket.status,
      toStatus: "reopened",
      note: "Reopened by user comment.",
    });
  }

  return { ticket: updated, event, reopened };
}

// ─── Status change ───────────────────────────────────────────────────────────

export type ChangeStatusInput = {
  ticketId: string;
  toStatus: PlatformTicketStatus;
  actorType: PlatformTicketActorType;
  actorUserId?: string;
  actorAdminId?: string;
  note?: string;
  /** Override for tests. */
  now?: Date;
};

/**
 * Change a platform ticket's status. Per LOGIC.md 2026-07-28, transitions are
 * NOT hard-enforced (any → any allowed + audit-logged — same rule as Stage 2).
 * Terminal statuses set resolvedAt/closedAt. Appends a status_changed event
 * (and a resolved/closed event for terminal transitions).
 */
export async function changePlatformTicketStatus(input: ChangeStatusInput): Promise<PlatformTicket> {
  const ticket = await repositories.platformTicket.getForOperator(input.ticketId);
  if (!ticket) {
    throw new Error(`Platform ticket ${input.ticketId} not found.`);
  }
  if (ticket.status === input.toStatus) {
    // No-op; don't churn events for same-status writes.
    return ticket;
  }
  const now = input.now ?? new Date();
  const fromStatus = ticket.status;
  const updates: Partial<PlatformTicket> = { status: input.toStatus };
  if (input.toStatus === "resolved") updates.resolvedAt = now.toISOString();
  if (input.toStatus === "closed") {
    updates.closedAt = now.toISOString();
    // Closing also stamps resolvedAt if it was never resolved (defensive).
    if (!ticket.resolvedAt) updates.resolvedAt = now.toISOString();
  }
  // Stage 5 re-audit fix (F-P2-4, 2026-07-28): clear resolvedAt/closedAt when
  // moving AWAY from a terminal state. Pre-fix, a `closed→open` move left the
  // stale resolvedAt/closedAt in place — inconsistent state that broke the
  // 7-day reopen window (resolvedAnchor computed from a stale timestamp).
  // Mirrors the comment-reopen branch's behavior. Pinned by
  // golden:stage5-batch4-chokepoints CASE 8.
  const TERMINAL_STATUSES: PlatformTicket["status"][] = ["resolved", "closed"];
  const wasTerminal = TERMINAL_STATUSES.includes(fromStatus);
  const isTerminal = TERMINAL_STATUSES.includes(input.toStatus);
  if (wasTerminal && !isTerminal) {
    updates.resolvedAt = undefined;
    updates.closedAt = undefined;
  }

  const updated = await repositories.platformTicket.updateForOperator(ticket.id, updates);

  await repositories.platformTicketEvent.create({
    ticketId: ticket.id,
    workspaceId: ticket.workspaceId,
    eventType: "status_changed",
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    actorAdminId: input.actorAdminId,
    fromStatus,
    toStatus: input.toStatus,
    note: input.note,
  });

  // Terminal-transition events (cleaner thread for the operator inbox).
  if (input.toStatus === "resolved") {
    await repositories.platformTicketEvent.create({
      ticketId: ticket.id,
      workspaceId: ticket.workspaceId,
      eventType: "resolved",
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      actorAdminId: input.actorAdminId,
    });
  } else if (input.toStatus === "closed") {
    await repositories.platformTicketEvent.create({
      ticketId: ticket.id,
      workspaceId: ticket.workspaceId,
      eventType: "closed",
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      actorAdminId: input.actorAdminId,
    });
  }

  return updated;
}

// ─── Operator-side: spam flag + user block ───────────────────────────────────

export async function flagPlatformTicketAsSpam(input: {
  ticketId: string;
  adminId: string;
  reason: string;
}): Promise<PlatformTicket> {
  if (!input.reason.trim()) {
    throw new NeedsActionError("A reason is required to flag a ticket as spam.", 400);
  }
  const updated = await repositories.platformTicket.updateForOperator(input.ticketId, {
    isSpamFlagged: true,
    spamReason: input.reason.trim(),
    flaggedByAdminId: input.adminId,
  });
  await repositories.platformAuditLog.create({
    adminId: input.adminId,
    action: "ticket_flagged_spam",
    metadata: { ticketId: input.ticketId, reason: input.reason.trim() },
  });
  return updated;
}

export async function blockPlatformUser(input: {
  userId: string;
  workspaceId: string;
  adminId: string;
  isBlockedFromSupport: boolean;
  reason?: string;
}): Promise<void> {
  // Stage 5 re-audit fix (F-P1-10, 2026-07-28): verify the (userId,
  // workspaceId) pair is a real membership BEFORE upserting the block row.
  // Pre-fix the service trusted body.userId + body.workspaceId verbatim, so
  // an operator could create orphan block rows with mismatched workspaceIds
  // by passing arbitrary combinations. Mirrors the membership check
  // issuePasswordReset already does. Pinned by golden:stage5-batch4-
  // chokepoints CASE 4.
  const user = await repositories.user.findById(input.userId);
  if (!user) {
    throw new Error(`Cannot block: user ${input.userId} not found.`);
  }
  if (user.workspaceId !== input.workspaceId) {
    throw new Error(
      `Cannot block: user ${input.userId} does not belong to workspace ${input.workspaceId} (actually belongs to ${user.workspaceId}).`,
    );
  }

  await repositories.platformUserBlock.upsert({
    userId: input.userId,
    workspaceId: input.workspaceId,
    isBlockedFromSupport: input.isBlockedFromSupport,
    reason: input.reason,
    blockedByAdminId: input.adminId,
  });
  await repositories.platformAuditLog.create({
    adminId: input.adminId,
    action: input.isBlockedFromSupport ? "user_blocked" : "user_unblocked",
    metadata: { userId: input.userId, workspaceId: input.workspaceId, reason: input.reason },
  });
}
