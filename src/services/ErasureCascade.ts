/**
 * 2026-07-21 (Cluster D fix, session 20) — Atomic erasure cascade.
 *
 * The customer-erasure cascade (DPDPA right-to-erasure) must delete ALL of
 * the customer's records OR NONE. The OLD code (route.ts) did 9 separate
 * `await repos.X.deleteByLead(...)` calls, each its own `mutateData`
 * transaction. If the process crashed mid-cascade, the customer was left
 * half-deleted — broken records, dangling references, incomplete erasure
 * (legal liability under DPDPA).
 *
 * This service does the entire cascade in ONE mutateData transaction.
 * Either every delete commits together, or none do.
 *
 * DNC entry is PRESERVED (compliance requirement per docs/LOGIC.md Q18).
 *
 * Pinned by scripts/golden/golden-erasure-atomicity.ts.
 *
 * NOTE: this is the JSON-mode cascade. Prisma mode would wrap this in
 * `prisma.$transaction`; that's a separate migration (Cluster F finding C6).
 */
import type { AppData, Lead } from "@/lib/types";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { agentRunText, customerNeedles, textMentionsCustomer } from "@/lib/customer-traces";
import { samePhoneForOptOut } from "@/lib/phone-match";

export type MutateDataFn = <T>(mutator: (data: AppData) => T | Promise<T>) => Promise<T>;

export type EraseCascadeResult = {
  /** Per-type delete counts (for the audit log). */
  counts: {
    ticketEvents: number;
    replies: number;
    outreachActivities: number;
    tickets: number;
    orders: number;
    quotes: number;
    autoReplyLogs: number;
    unknownQuestions: number;
    humanFallbackTasks: number;
    mediaItems: number; // CP-13e (2026-08-01) — customer photos/voice notes removed with the lead
    /** 2026-09-26 (break test) — chat lines, extra phone numbers, review notes. */
    interactions: number;
    phoneNumbers: number;
    reviewDecisions: number;
    /** 2026-09-28 (S5) — drafted messages, agent runs about them, webhook-log phones. */
    messageDrafts: number;
    agentRuns: number;
    webhookPhonesScrubbed: number;
    lead: number; // always 1 if the cascade committed
  };
  /** DNC entries preserved (compliance). */
  preservedDncCount: number;
  /**
   * CP-13e — filesystem paths of the customer-media files removed (DB rows) by
   * the cascade. The caller best-effort-deletes the actual files AFTER the
   * transaction commits (filesystem ops can't be transactional). Any file that
   * fails to delete is non-fatal (logged) — the DB row is already gone, so it's
   * an orphan file, not corrupt data.
   */
  mediaStoragePathsToDelete: string[];
  // 2026-09-10: media bytes no longer live at a filesystem path, so the paths
  // above are empty for anything uploaded since. The ids are what the store
  // needs to forget the bytes.
  mediaItemIdsToPurge: string[];
};

/**
 * Erase a customer and all their records in ONE atomic transaction.
 *
 * Caller passes:
 *   - workspaceId + leadId (the customer to erase)
 *   - data (the current AppData — for in-memory inspection / testing)
 *   - mutateData (the JSON-mode mutation primitive; injected so the test
 *     can count mutations)
 *
 * Throws if the lead doesn't exist in this workspace (defensive — caller
 * should have already confirmed). The throw propagates so the route
 * handler returns a 4xx and NO partial state is committed.
 */
export async function eraseLeadCascade(input: {
  workspaceId: string;
  leadId: string;
  data: AppData;
  mutateData: MutateDataFn;
}): Promise<EraseCascadeResult> {
  const { workspaceId, leadId, data, mutateData } = input;

  // ONE transaction. Every delete happens here. If anything throws, the
  // transaction rolls back (mutateData doesn't write on throw).
  return mutateData((d) => {
    // Referential-safe order: events before tickets; lead LAST.
    // (Everything else references leadId directly.)

    // 2026-09-28 (S5): what identifies the customer in records that carry no
    // lead id (agent-run text, the webhook duplicate-check log). Read before
    // anything is deleted — the extra numbers go further down.
    const erasedLead = (d.leads || []).find((l) => l.workspaceId === workspaceId && l.id === leadId);
    const extraNumbers = (d.leadPhoneNumbers || []).filter((n) => n.workspaceId === workspaceId && n.leadId === leadId).map((n) => n.number);
    const needles = erasedLead ? customerNeedles(erasedLead, extraNumbers) : undefined;

    // Ticket events — belong to tickets, not leads directly. Find the
    // ticketIds that belong to this lead, then delete their events.
    const leadTicketIds = new Set(
      (d.tickets || [])
        .filter((t) => t.workspaceId === workspaceId && t.leadId === leadId)
        .map((t) => t.id),
    );
    const beforeTicketEvents = (d.ticketEvents || []).length;
    d.ticketEvents = (d.ticketEvents || []).filter(
      (te) => !(te.workspaceId === workspaceId && leadTicketIds.has(te.ticketId)),
    );
    const deletedTicketEvents = beforeTicketEvents - d.ticketEvents.length;

    // Replies.
    const beforeReplies = (d.replies || []).length;
    d.replies = (d.replies || []).filter(
      (r) => !(r.workspaceId === workspaceId && r.leadId === leadId),
    );
    const deletedReplies = beforeReplies - d.replies.length;

    // Outreach activities.
    const beforeOutreach = (d.outreachActivities || []).length;
    d.outreachActivities = (d.outreachActivities || []).filter(
      (o) => !(o.workspaceId === workspaceId && o.leadId === leadId),
    );
    const deletedOutreach = beforeOutreach - d.outreachActivities.length;

    // Tickets (after events).
    const beforeTickets = (d.tickets || []).length;
    d.tickets = (d.tickets || []).filter(
      (t) => !(t.workspaceId === workspaceId && t.leadId === leadId),
    );
    const deletedTickets = beforeTickets - d.tickets.length;

    // Orders.
    const beforeOrders = (d.orders || []).length;
    d.orders = (d.orders || []).filter(
      (o) => !(o.workspaceId === workspaceId && o.leadId === leadId),
    );
    const deletedOrders = beforeOrders - d.orders.length;

    // Quotes.
    const beforeQuotes = (d.quotes || []).length;
    d.quotes = (d.quotes || []).filter(
      (q) => !(q.workspaceId === workspaceId && q.leadId === leadId),
    );
    const deletedQuotes = beforeQuotes - d.quotes.length;

    // Auto-reply logs.
    const beforeAutoReply = (d.autoReplyLogs || []).length;
    d.autoReplyLogs = (d.autoReplyLogs || []).filter(
      (a) => !(a.workspaceId === workspaceId && a.leadId === leadId),
    );
    const deletedAutoReply = beforeAutoReply - d.autoReplyLogs.length;

    // Unknown questions.
    const beforeUnknown = (d.unknownQuestions || []).length;
    d.unknownQuestions = (d.unknownQuestions || []).filter(
      (u) => !(u.workspaceId === workspaceId && u.leadId === leadId),
    );
    const deletedUnknown = beforeUnknown - d.unknownQuestions.length;

    // Human-fallback tasks (no leadId field; join through interaction).
    // Cluster F finding: this used to be a comment-only delete that never
    // happened. Now actually delete by joining interactionId → interaction.leadId.
    // HumanFallbackTask has no leadId; for safety, we conservatively delete
    // tasks whose interactionId references an interaction belonging to this
    // lead. Since interactions aren't a separate collection, we use the
    // prospectQuery / workspaceId match — for now we delete tasks that
    // have a convertedToTicketId pointing at one of the deleted tickets.
    const deletedTicketIdSet = new Set(
      // recompute: the tickets we just deleted are those with leadId match.
      // We can't read them anymore (already filtered out), so we use the
      // count delta. For HumanFallbackTask, the only safe link is via
      // convertedToTicketId. We delete tasks whose convertedToTicketId is
      // in leadTicketIds.
      [],
    );
    // 2026-09-26 (break test): the lead's chat lines (interactions) were never
    // erased, and they are exactly what links a fallback task to its lead.
    // They go now, and a fallback task raised from one of them goes with them.
    const leadInteractionIds = new Set(
      (d.interactions || [])
        .filter((i) => i.workspaceId === workspaceId && i.leadId === leadId)
        .map((i) => i.id),
    );
    const beforeInteractions = (d.interactions || []).length;
    d.interactions = (d.interactions || []).filter((i) => !(i.workspaceId === workspaceId && i.leadId === leadId));
    const deletedInteractions = beforeInteractions - d.interactions.length;

    const beforeHft = (d.humanFallbackTasks || []).length;
    d.humanFallbackTasks = (d.humanFallbackTasks || []).filter((hft) => {
      // Delete if converted to one of this lead's tickets, or raised from one
      // of this lead's chat lines.
      const convId = (hft as { convertedToTicketId?: string }).convertedToTicketId;
      if (hft.workspaceId !== workspaceId) return true;
      return !((convId && leadTicketIds.has(convId)) || leadInteractionIds.has(hft.interactionId));
    });

    // 2026-09-26 (break test): the customer's other phone numbers and the
    // review notes about them ("<company> fits because …") survived erasure.
    // The numbers are personal data, and a message from one still matched the
    // erased customer's id. Both are removed with the lead.
    const beforePhones = (d.leadPhoneNumbers || []).length;
    d.leadPhoneNumbers = (d.leadPhoneNumbers || []).filter((n) => !(n.workspaceId === workspaceId && n.leadId === leadId));
    const deletedPhoneNumbers = beforePhones - d.leadPhoneNumbers.length;
    const beforeDecisions = (d.leadReviewDecisions || []).length;
    d.leadReviewDecisions = (d.leadReviewDecisions || []).filter((r) => !(r.workspaceId === workspaceId && r.leadId === leadId));
    // 2026-09-27 — reminders about the customer go with them (Postgres: the
    // follow_ups foreign key cascades on the lead delete).
    d.followUps = (d.followUps || []).filter((f) => !(f.workspaceId === workspaceId && f.leadId === leadId));
    // 2026-09-28 — what happened with the customer (orders, opt-out…) goes too
    // (Postgres: the outcome_signals foreign key cascades on the lead delete).
    d.outcomeSignals = (d.outcomeSignals || []).filter((s) => !(s.workspaceId === workspaceId && s.leadId === leadId));
    const deletedReviewDecisions = beforeDecisions - d.leadReviewDecisions.length;
    // The owner's assistant chat stays (it is the owner's), but it no longer
    // points at a customer who does not exist.
    for (const c of d.ownerCopilotConversations || []) {
      if (c.workspaceId === workspaceId && c.activeLeadId === leadId) c.activeLeadId = undefined;
    }
    const deletedHft = beforeHft - d.humanFallbackTasks.length;
    void deletedTicketIdSet; // (kept for clarity; the actual filter uses leadTicketIds)

    // CP-13e (2026-08-01) — Customer media (photos + voice notes). The DB rows
    // are removed atomically here; their file paths are collected so the caller
    // can best-effort-delete the files after commit. Previously the cascade did
    // NOT clean up media, so a customer's photos/voice notes survived erasure as
    // ghost files + orphan rows (a privacy + side-effect gap). Only customer-
    // sourced media (customer_photo / customer_voice_note) is removed here —
    // the owner's own catalog/product/policy media is NOT lead-owned and stays.
    const mediaStoragePathsToDelete: string[] = [];
    const mediaItemIdsToPurge: string[] = [];
    const beforeMedia = (d.mediaCatalogItems || []).length;
    d.mediaCatalogItems = (d.mediaCatalogItems || []).filter((m) => {
      const isLeadMedia =
        m.workspaceId === workspaceId &&
        m.leadId === leadId &&
        (m.category === "customer_photo" || m.category === "customer_voice_note");
      if (isLeadMedia && m.storagePath) mediaStoragePathsToDelete.push(m.storagePath);
      if (isLeadMedia) mediaItemIdsToPurge.push(m.id);
      return !isLeadMedia;
    });
    const deletedMedia = beforeMedia - (d.mediaCatalogItems || []).length;

    // 2026-09-28 (S5): three more places that held the customer.
    //   - Drafted messages for the lead (they quote the customer by name).
    //   - Agent runs whose input/output/error mentions them.
    //   - Their number in the webhook duplicate-check log (the message id
    //     stays, so a late redelivery is still recognised as a duplicate).
    const beforeDrafts = (d.messageTemplates || []).length;
    d.messageTemplates = (d.messageTemplates || []).filter((m) => !(m.workspaceId === workspaceId && m.leadId === leadId));
    const deletedDrafts = beforeDrafts - d.messageTemplates.length;
    const beforeRuns = (d.agentRuns || []).length;
    d.agentRuns = (d.agentRuns || []).filter((run) => !(run.workspaceId === workspaceId && needles && textMentionsCustomer(agentRunText(run), needles)));
    const deletedAgentRuns = beforeRuns - d.agentRuns.length;
    let scrubbedWebhookPhones = 0;
    const erasedPhones = [erasedLead?.phone, erasedLead?.whatsappNumber, ...extraNumbers].filter((p): p is string => Boolean(p));
    for (const row of d.processedWebhookMessageIds || []) {
      if (row.workspaceId === workspaceId && row.fromPhone && erasedPhones.some((p) => samePhoneForOptOut(row.fromPhone, p))) {
        row.fromPhone = undefined;
        scrubbedWebhookPhones += 1;
      }
    }

    // Lead LAST.
    const beforeLead = (d.leads || []).length;
    d.leads = (d.leads || []).filter(
      (l) => !(l.workspaceId === workspaceId && l.id === leadId),
    );
    const deletedLead = beforeLead - d.leads.length;
    if (deletedLead === 0) {
      throw new Error(`Lead ${leadId} not found in workspace ${workspaceId} — erasure aborted (no partial commit).`);
    }

    // DNC preserved — count for the audit entry.
    const preservedDncCount = (d.doNotContactRegistry || []).filter(
      (entry) => entry.workspaceId === workspaceId && entry.sourceLeadId === leadId,
    ).length;

    return {
      counts: {
        ticketEvents: deletedTicketEvents,
        replies: deletedReplies,
        outreachActivities: deletedOutreach,
        tickets: deletedTickets,
        orders: deletedOrders,
        quotes: deletedQuotes,
        autoReplyLogs: deletedAutoReply,
        unknownQuestions: deletedUnknown,
        humanFallbackTasks: deletedHft,
        mediaItems: deletedMedia,
        interactions: deletedInteractions,
        phoneNumbers: deletedPhoneNumbers,
        reviewDecisions: deletedReviewDecisions,
        messageDrafts: deletedDrafts,
        agentRuns: deletedAgentRuns,
        webhookPhonesScrubbed: scrubbedWebhookPhones,
        lead: deletedLead,
      },
      preservedDncCount,
      mediaStoragePathsToDelete,
      mediaItemIdsToPurge,
    };
  });
}

export type RepositoryErasureCounts = {
  ticketEvents: number;
  replies: number;
  outreachActivities: number;
  tickets: number;
  orders: number;
  quotes: number;
  autoReplyLogs: number;
  unknownQuestions: number;
  mediaItems: number;
  reviewDecisions: number;
  messageDrafts: number;
  followUps: number;
  outcomeSignals: number;
  agentRuns: number;
  webhookPhonesScrubbed: number;
  copilotPointersCleared: number;
  lead: number;
};

/**
 * 2026-09-28 (S5) — erase a customer through the repositories, for the
 * Postgres substrate (the JSON substrate uses eraseLeadCascade above, one
 * atomic snapshot write). Every repository call is workspace-scoped.
 *
 * Order (drafts and review notes BEFORE the lead: their foreign keys are
 * SET NULL / absent, so afterwards they could no longer be found by lead):
 *   ticket events → replies → outreach → tickets → orders → quotes →
 *   auto-reply logs → unknown questions → customer media → review notes →
 *   drafted messages → reminders → agent runs that mention the customer →
 *   webhook-log phones → the owner assistant's pointer → the lead.
 * The lead delete then cascades (Postgres foreign keys, mirrored by the JSON
 * repository) to chat lines, fallback tasks, extra numbers, enrichment runs
 * and duplicate candidates.
 *
 * The do-not-contact register is NOT touched (LOGIC.md Q18). Not atomic
 * across tables — the route records "customer_erased_partial" if a step
 * throws, and running the erasure again finishes the job: every step is a
 * delete-by-lead that does nothing the second time.
 */
export async function eraseLeadViaRepositories(input: {
  workspaceId: string;
  lead: Pick<Lead, "id" | "phone" | "whatsappNumber" | "email" | "companyName" | "contactName">;
  repos: RepositoryBundle;
}): Promise<RepositoryErasureCounts> {
  const { workspaceId, lead, repos } = input;
  const leadId = lead.id;
  // 2026-09-28: deleteByTicketIds takes TICKET ids. The route used to pass the
  // planned ticket-EVENT ids, which match no ticket, so on Postgres (no foreign
  // key from events to tickets) the erased customer's ticket history stayed.
  const ticketIds = (await repos.ticket.listByWorkspace(workspaceId, { leadId })).map((t) => t.id);
  if (!repos.scrubProcessedWebhookPhones) {
    throw new Error("This storage cannot remove the customer's number from the webhook log, so the erasure was not started.");
  }
  const extraNumbers = (await repos.lead.listLeadPhoneNumbers(workspaceId, leadId)).map((n) => n.number);
  const needles = customerNeedles(lead, extraNumbers);
  const phones = [lead.phone, lead.whatsappNumber, ...extraNumbers].filter((p): p is string => Boolean(p && String(p).trim()));
  const { eraseLeadMedia } = await import("@/services/InboundMediaService");
  const counts: RepositoryErasureCounts = {
    ticketEvents: await repos.ticketEvent.deleteByTicketIds(workspaceId, ticketIds),
    replies: await repos.reply.deleteByLead(workspaceId, leadId),
    outreachActivities: await repos.outreachActivity.deleteByLead(workspaceId, leadId),
    tickets: await repos.ticket.deleteByLead(workspaceId, leadId),
    orders: await repos.order.deleteByLead(workspaceId, leadId),
    quotes: await repos.quote.deleteByLead(workspaceId, leadId),
    autoReplyLogs: await repos.autoReplyLog.deleteByLead(workspaceId, leadId),
    unknownQuestions: await repos.unknownQuestion.deleteByLead(workspaceId, leadId),
    mediaItems: (await eraseLeadMedia(workspaceId, leadId, repos)).removed,
    reviewDecisions: await repos.leadReviewDecision.deleteByLead(workspaceId, leadId),
    messageDrafts: await repos.messageTemplate.deleteByLead(workspaceId, leadId),
    followUps: await repos.followUp.deleteByLead(workspaceId, leadId),
    outcomeSignals: await repos.outcomeSignal.deleteByLead(workspaceId, leadId),
    agentRuns: await repos.agentRun.deleteMentioning(workspaceId, needles),
    webhookPhonesScrubbed: phones.length ? await repos.scrubProcessedWebhookPhones(workspaceId, phones) : 0,
    copilotPointersCleared: await repos.ownerCopilotConversation.clearActiveLead(workspaceId, leadId),
    lead: 0,
  };
  counts.lead = await repos.lead.deleteById(workspaceId, leadId);
  return counts;
}
