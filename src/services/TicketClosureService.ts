import { isContactBlocked } from "@/lib/dnc-registry";
import { oneAtATime } from "@/lib/one-at-a-time";
import { NeedsActionError } from "@/lib/user-errors";
import type { AutoReplyLog, Ticket } from "@/lib/types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";

export type TicketClosureDraftReceipt = {
  id: string; ticketId: string; leadId: string; body: string;
  status: AutoReplyLog["status"]; sendStatus: AutoReplyLog["sendStatus"]; createdAt: string;
};

function receipt(ticket: Ticket, log: AutoReplyLog): TicketClosureDraftReceipt {
  return { id: log.id, ticketId: ticket.id, leadId: log.leadId!, body: log.generatedReply || "",
    status: log.status, sendStatus: log.sendStatus, createdAt: log.createdAt };
}

async function linkedDrafts(ticket: Ticket, repos: RepositoryBundle) {
  if (!ticket.leadId) return [];
  return (await repos.autoReplyLog.listByLead(ticket.workspaceId, ticket.leadId))
    .filter(log => log.retrievedContext?.ticketId === ticket.id && log.retrievedContext?.source === "ticket_closure")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Staff see only the receipt belonging to this case, never the owner's general review queue. */
export async function getTicketClosureDraft(workspaceId: string, ticketId: string, repos = createRepositories()) {
  const ticket = await repos.ticket.getById(workspaceId, ticketId);
  if (!ticket) throw new NeedsActionError("This ticket was not found.", 404);
  const drafts = await linkedDrafts(ticket, repos);
  const draft = drafts.find(log => log.status !== "rejected") || drafts[0];
  return { draft: draft ? receipt(ticket, draft) : null };
}

/** Human-written outcome only. Saving never approves, contacts a customer or runs an AI model. */
export async function saveTicketClosureDraft(
  workspaceId: string, ticketId: string,
  input: { body: unknown; replaceExisting?: unknown; actorUserId?: string },
  repos: RepositoryBundle = createRepositories(),
) {
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 4000) {
    throw new NeedsActionError("Write a customer reply of between 1 and 4,000 characters.", 400);
  }
  if (input.replaceExisting !== undefined && typeof input.replaceExisting !== "boolean") {
    throw new NeedsActionError("Confirm whether the previous draft should be replaced.", 400);
  }
  const body = input.body.trim();
  return oneAtATime(`team:${workspaceId}`, () => {
    const work = async () => {
      const ticket = await repos.ticket.getById(workspaceId, ticketId);
      if (!ticket) throw new NeedsActionError("This ticket was not found.", 404);
      if (!["resolved", "closed"].includes(ticket.status)) throw new NeedsActionError("Record the resolution before preparing the customer's reply.", 409);
      if (!ticket.leadId) throw new NeedsActionError("Attach a customer before preparing their reply.", 400);
      const lead = await repos.lead.getLeadById(workspaceId, ticket.leadId);
      if (!lead) throw new NeedsActionError("This customer was not found in your workspace.", 404);
      const contact = await isContactBlocked(workspaceId, lead, repos);
      if (contact.blocked) throw new NeedsActionError("This customer has asked not to be contacted. Keep the resolution as an internal note.", 409);
      const replyId = ticket.replyId || ticket.conversationId;
      const reply = replyId ? await repos.reply.getById(workspaceId, replyId) : undefined;
      if (replyId && (!reply || reply.leadId !== lead.id)) throw new NeedsActionError("This ticket's customer message does not belong to the selected customer.", 409);
      const drafts = await linkedDrafts(ticket, repos);
      const existing = drafts.find(log => !["rejected"].includes(log.status));
      if (existing) {
        const pending = ["held_for_review", "drafted"].includes(existing.status);
        if ((existing.generatedReply || "").trim() === body) {
          return { draft: receipt(ticket, existing), reused: true };
        }
        if (!pending) throw new NeedsActionError("This case already has an approved reply. Review its delivery before creating another reply.", 409);
        if (!input.replaceExisting) throw new NeedsActionError("A reply is already waiting for the owner. Confirm replacement before saving a different draft.", 409);
        await repos.autoReplyLog.reject(workspaceId, existing.id);
      }
      const draft = await repos.autoReplyLog.create(workspaceId, {
        leadId: lead.id, replyId: reply?.id,
        channel: ["whatsapp", "email"].includes(ticket.sourceChannel) ? ticket.sourceChannel : "whatsapp",
        incomingMessage: reply?.rawText || ticket.description || ticket.subject,
        generatedReply: body, retrievedContext: { source: "ticket_closure", ticketId, writtenByUserId: input.actorUserId || null },
        classification: "ticket_resolution", canAutoSend: false, needsHumanReview: true,
        reason: "A team member recorded the resolution. The owner must review this reply before sending.",
        status: "held_for_review", modelMode: "unknown", validationStatus: "not_run", sendAttempted: false, sendStatus: "not_attempted",
      });
      await repos.ticketEvent.create({ workspaceId, ticketId, eventType: "commented", actorType: "owner",
        actorUserId: input.actorUserId, note: `Customer reply saved for owner review. Draft reference: ${draft.id}. Nothing was sent.` });
      return { draft: receipt(ticket, draft), reused: false };
    };
    if (repos.withWorkspaceTeamTransaction) return repos.withWorkspaceTeamTransaction(workspaceId, work);
    return repos.withTransaction ? repos.withTransaction(work) : work();
  });
}
