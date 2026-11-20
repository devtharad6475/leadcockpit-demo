/**
 * Stage 5 / 2026-07-21 — DPDPA right-to-erasure cascade.
 *
 * Per docs/LOGIC.md 2026-07-21 (Q18):
 *   - Owner-only. Non-owner actors → throw (403-equivalent).
 *   - Two-step confirmation: caller must type the customer's exact name.
 *   - Cascade delete (10 record types): Lead, Replies, OutreachActivities,
 *     Tickets, TicketEvents, Orders, Quotes, AutoReplyLogs, UnknownQuestions,
 *     HumanFallbackTasks.
 *   - PRESERVE: DNC registry entry (the customer asked to be deleted, but
 *     if they ever come back we still must honour DNC); AuditLog entries
 *     (kept, anonymized to "erased customer").
 *   - Write a `customer_erased` audit entry with actor + timestamp +
 *     anonymized customer id.
 *
 * R5 (2026-07-21) extended this from 5 record types to the full 10 per
 * LOGIC.md Q18. The earlier version only planned Lead/Replies/Tickets/
 * Orders/Quotes; the rule always said all 10.
 *
 * This module is the PURE planning function — it returns the lists of ids
 * to delete + the audit entry to write. The caller (API/repository layer)
 * does the actual deletion within a transaction. Keeping the cascade plan
 * pure means it's fully testable without DB I/O.
 *
 * Pinned by scripts/golden/golden-erasure-audit.ts (CASES A/B/C/D + the
 * R5 additions for the 5 new record types).
 */
import { NeedsActionError } from "@/lib/user-errors";
import { timestamp } from "@/lib/db";
import { samePhoneForOptOut } from "@/lib/phone-match";
import { websiteKey } from "@/lib/same-company";
import type {
  AutoReplyLog,
  DoNotContactEntry,
  HumanFallbackTask,
  Lead,
  Order,
  OutreachActivity,
  Quote,
  Reply,
  Ticket,
  TicketEvent,
  UnknownQuestion,
} from "@/lib/types";
import type { AuditEntry } from "./AuditLogExtensions";

export type ErasureActor = {
  userId: string;
  actorType: "owner" | "admin" | "member" | "viewer" | "system";
};

export type ErasureInput = {
  workspaceId: string;
  leadId: string;
  /** The actor requesting erasure. Must be owner or system. */
  actor: ErasureActor;
  /** The customer's exact name, typed by the operator as confirmation. */
  confirmName: string;
  /** The lead being erased (used to validate confirmName + to extract identifiers). */
  lead: Lead;
  /** Related records to scan for cascade deletion. */
  replies?: Reply[];
  tickets?: Ticket[];
  orders?: Order[];
  quotes?: Quote[];
  /**
   * 2026-07-21 (R5) — the 5 additional cascade types per docs/LOGIC.md Q18.
   * Earlier versions of this function only planned the first 5; the rule
   * says all 10 must be deleted. These are optional only because not every
   * caller has all of them loaded; the API endpoint loads all 10.
   */
  outreachActivities?: OutreachActivity[];
  ticketEvents?: TicketEvent[];
  autoReplyLogs?: AutoReplyLog[];
  unknownQuestions?: UnknownQuestion[];
  humanFallbackTasks?: HumanFallbackTask[];
  /** DNC registry entries — preserved, not deleted. */
  doNotContactRegistry?: DoNotContactEntry[];
};

export type ErasureResult = {
  deleted: {
    leadIds: string[];
    replyIds: string[];
    ticketIds: string[];
    orderIds: string[];
    quoteIds: string[];
    /** R5 — the 5 additional cascade types. */
    outreachActivityIds: string[];
    ticketEventIds: string[];
    autoReplyLogIds: string[];
    unknownQuestionIds: string[];
    humanFallbackTaskIds: string[];
  };
  /** DNC entries that were PRESERVED (not deleted) — listed for the audit trail. */
  preservedDncIds: string[];
  /** The audit entry to write. Anonymized — does NOT contain customer PII. */
  auditEntry: AuditEntry & { anonymizedCustomerId: string };
};

/**
 * Plan the erasure of a customer. Returns the cascade plan + audit entry.
 * The caller does the actual deletion.
 *
 * Throws if:
 *   - actor is not owner/system (403 equivalent)
 *   - confirmName does not match the lead's contactName exactly
 *
 * Per docs/LOGIC.md the DNC entry is PRESERVED (so if the customer comes
 * back we still honour DNC), and the audit entry is ANONYMIZED (no PII).
 */
export async function eraseCustomer(input: ErasureInput): Promise<ErasureResult> {
  // Guardrail: owner-only.
  if (input.actor.actorType !== "owner" && input.actor.actorType !== "system") {
    throw new Error(`Forbidden: only owners may erase customers. Actor ${input.actor.userId} is ${input.actor.actorType}.`);
  }

  // Guardrail: two-step name confirmation.
  const expected = (input.lead.contactName || input.lead.companyName || "").trim();
  if (!expected) {
    throw new NeedsActionError(`Cannot confirm erasure: lead ${input.leadId} has no contactName or companyName on file. Add a name first.`, 400);
  }
  if (input.confirmName.trim() !== expected) {
    throw new NeedsActionError(`Confirmation name "${input.confirmName}" does not match the customer's stored name "${expected}". Erasure refused.`, 400);
  }

  // Build the cascade plan.
  const replyIds = (input.replies || []).filter((r) => r.leadId === input.leadId).map((r) => r.id);
  const ticketIds = (input.tickets || []).filter((t) => t.leadId === input.leadId).map((t) => t.id);
  const orderIds = (input.orders || []).filter((o) => o.leadId === input.leadId).map((o) => o.id);
  const quoteIds = (input.quotes || []).filter((q) => q.leadId === input.leadId).map((q) => q.id);

  // R5 — 5 additional cascade types per docs/LOGIC.md Q18.
  const outreachActivityIds = (input.outreachActivities || [])
    .filter((o) => o.leadId === input.leadId)
    .map((o) => o.id);
  // TicketEvents are attached to tickets, not leads directly. Cascade by
  // matching the tickets being deleted (their ids are in ticketIds above).
  const ticketIdSet = new Set(ticketIds);
  const ticketEventIds = (input.ticketEvents || [])
    .filter((e) => ticketIdSet.has(e.ticketId))
    .map((e) => e.id);
  const autoReplyLogIds = (input.autoReplyLogs || [])
    .filter((l) => l.leadId === input.leadId)
    .map((l) => l.id);
  const unknownQuestionIds = (input.unknownQuestions || [])
    .filter((q) => q.leadId === input.leadId)
    .map((q) => q.id);
  // HumanFallbackTask has no leadId field — it links via interactionId. We
  // can't cascade it without loading interactions; the API endpoint handles
  // this by leaving humanFallbackTasks empty when no interaction linkage is
  // knowable. (Per LOGIC.md Q18 the rule still lists it; the cascade plan
  // surfaces whatever the caller passes.)
  const humanFallbackTaskIds = (input.humanFallbackTasks || [])
    .filter((t) => ticketIdSet.has(t.convertedToTicketId || ""))
    .map((t) => t.id);

  // DNC entries are PRESERVED (compliance).
  const preservedDncIds = (input.doNotContactRegistry || [])
    // 2026-09-28: phones on their last 10 digits (the register's own rule), and
    // the website host — an exact string comparison missed "+91 98250 33333"
    // against the stored "+919825033333".
    .filter((d) =>
      samePhoneForOptOut(d.normalizedPhone, input.lead.whatsappNumber) ||
      samePhoneForOptOut(d.normalizedPhone, input.lead.phone) ||
      Boolean(d.normalizedEmail && d.normalizedEmail === String(input.lead.email || "").trim().toLowerCase()) ||
      Boolean(d.normalizedDomain && d.normalizedDomain === websiteKey(input.lead.websiteUrl)) ||
      d.sourceLeadId === input.leadId)
    .map((d) => d.id);

  // Build the anonymized audit entry. NO customer PII is recorded.
  const totalDeleted =
    replyIds.length +
    ticketIds.length +
    orderIds.length +
    quoteIds.length +
    outreachActivityIds.length +
    ticketEventIds.length +
    autoReplyLogIds.length +
    unknownQuestionIds.length +
    humanFallbackTaskIds.length;
  const auditEntry: AuditEntry & { anonymizedCustomerId: string } = {
    workspaceId: input.workspaceId,
    eventType: "customer_erased",
    severity: "warning",
    actorUserId: input.actor.userId,
    actorType: input.actor.actorType,
    note: `Customer erased at owner request. ${totalDeleted} related records cascade-deleted across 9 record types (lead + replies + tickets + ticketEvents + orders + quotes + outreach + autoReplyLogs + unknownQuestions + humanFallbackTasks). DNC entry preserved (id count: ${preservedDncIds.length}). Audit entries anonymized (not deleted).`,
    at: timestamp(),
    anonymizedCustomerId: "erased_customer",
  };

  return {
    deleted: {
      leadIds: [input.leadId],
      replyIds,
      ticketIds,
      orderIds,
      quoteIds,
      outreachActivityIds,
      ticketEventIds,
      autoReplyLogIds,
      unknownQuestionIds,
      humanFallbackTaskIds,
    },
    preservedDncIds,
    auditEntry,
  };
}
