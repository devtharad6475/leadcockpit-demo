import type { RepositoryBundle } from '@/repositories/interfaces';
import { NeedsActionError } from '@/lib/user-errors';
import { hasRecordedCustomerSend, hasRecordedAutomaticSend } from '@/lib/recorded-customer-send';

export type CustomerMessage = { id: string; direction: 'incoming' | 'outgoing'; channel: string; body: string; happenedAt: string; confirmation: string };

/** Staff see customer communications, never owner chat or unsent AI drafts. */
export async function customerConversationHistory(workspaceId: string, leadId: string, repos: RepositoryBundle): Promise<CustomerMessage[]> {
  if (!(await repos.lead.getLeadById(workspaceId, leadId))) throw new NeedsActionError('This customer was not found in your company.', 404);
  const [replies, activities, logs] = await Promise.all([
    repos.reply.listByLead(workspaceId, leadId), repos.outreachActivity.listByLead(workspaceId, leadId), repos.autoReplyLog.listByLead(workspaceId, leadId),
  ]);
  const messages: CustomerMessage[] = replies.map(r => ({ id: `incoming:${r.id}`, direction: 'incoming', channel: r.channel, body: r.rawText, happenedAt: r.createdAt, confirmation: 'Received from customer' }));
  for (const a of activities) if (hasRecordedCustomerSend(a)) messages.push({ id: `outgoing:${a.id}`, direction: 'outgoing', channel: a.channel, body: a.body || '', happenedAt: a.activityAt || a.createdAt, confirmation: 'Send recorded; delivery is not confirmed here' });
  for (const log of logs) if (hasRecordedAutomaticSend(log) && log.generatedReply) messages.push({ id: `automatic:${log.id}`, direction: 'outgoing', channel: log.channel, body: log.generatedReply, happenedAt: log.createdAt, confirmation: 'Send recorded; delivery is not confirmed here' });
  return messages.sort((a, b) => a.happenedAt.localeCompare(b.happenedAt) || a.id.localeCompare(b.id));
}
