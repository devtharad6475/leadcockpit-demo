import type { RepositoryBundle } from '@/repositories/interfaces';

/** Read-only, bounded operational state. It supplements, never rewrites, the transcript. */
export async function getCustomerTicketReplyContext(workspaceId: string, leadId: string | undefined, repos: RepositoryBundle) {
  if (!leadId) return { availability: 'no_linked_customer' as const, tickets: [] };
  try {
    const tickets = (await repos.ticket.listByWorkspace(workspaceId, { leadId }))
      // Defence in depth: repository scope/filter implementations must not leak other buyers.
      .filter(ticket => ticket.workspaceId === workspaceId && ticket.leadId === leadId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 6);
    const snapshot = await Promise.all(tickets.map(async ticket => {
      const events = (await repos.ticketEvent.listByTicket(workspaceId, ticket.id))
        .filter(event => event.workspaceId === workspaceId && event.ticketId === ticket.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const completion = events.find(event =>
        (event.toStatus === 'resolved' || event.toStatus === 'closed' || event.eventType === 'resolved')
        && event.note?.trim());
      return {
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject.slice(0, 160),
        status: ticket.status,
        updatedAt: ticket.updatedAt,
        // This is a staff record, not proof that the customer received a reply or goods.
        lastRecordedOutcome: completion ? {
          note: completion.note!.trim().slice(0, 600),
          recordedAt: completion.createdAt,
          actorType: completion.actorType,
        } : undefined,
      };
    }));
    return { availability: 'available' as const, tickets: snapshot };
  } catch (error) {
    console.warn('[WhatsAppEngine] current ticket context unavailable:', error instanceof Error ? error.message : 'ticket lookup failed');
    // An unavailable snapshot is not evidence that an old complaint is still open or solved.
    return { availability: 'unavailable' as const, tickets: [] };
  }
}
