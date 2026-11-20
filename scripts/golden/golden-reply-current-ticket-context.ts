import './_helpers/force-json-provider';
import assert from 'node:assert/strict';
import { whatsappReplyPrompt } from '@/llm/prompts/whatsappReplyPrompt';
import { getCustomerTicketReplyContext } from '@/services/CustomerTicketReplyContext';
import type { Ticket, TicketEvent } from '@/lib/types';
import type { RepositoryBundle } from '@/repositories/interfaces';
import { createJsonRepos } from './_helpers/provider';
import { LLMService } from '@/llm/LLMService';
import { handleIncomingWhatsAppMessage } from '@/services/WhatsAppConversationEngine';
import type { LLMTaskName, LLMTaskOptions, LLMTaskResult } from '@/llm/types';

assert.match(whatsappReplyPrompt, /currentTicketContext/, 'reply task must explain the current ticket snapshot alongside older customer history');
assert.match(whatsappReplyPrompt, /unrelated.*(?:complaint|ticket)|(?:complaint|ticket).*unrelated/i, 'historical complaints must not be repeated in unrelated answers');
console.log('PASS current question and truthful ticket state take precedence over old complaint history');

async function main() {
  const calls: unknown[] = [];
  const tickets = [
    { id: 'same-closed', workspaceId: 'company', leadId: 'buyer', ticketNumber: 1, subject: 'Damaged samples', status: 'closed', updatedAt: '2026-10-04' },
    { id: 'same-reopened', workspaceId: 'company', leadId: 'buyer', ticketNumber: 2, subject: 'Raised again', status: 'reopened', updatedAt: '2026-10-05' },
    { id: 'other-company', workspaceId: 'other', leadId: 'buyer', subject: 'Private company issue', updatedAt: '2026-10-06' },
    { id: 'other-buyer', workspaceId: 'company', leadId: 'other', subject: 'Private buyer issue', updatedAt: '2026-10-06' },
  ] as Ticket[];
  const repos = {
    ticket: { listByWorkspace: async (workspace: string, filters: unknown) => { calls.push([workspace, filters]); return tickets; } },
    ticketEvent: { listByTicket: async (workspace: string, id: string) => {
      calls.push([workspace, id]);
      return [
        { workspaceId: workspace, ticketId: id, toStatus: 'resolved', note: '  Sample inspected; no promised dispatch.  ', actorType: 'owner', createdAt: '2026-10-03' },
        { workspaceId: 'other', ticketId: id, toStatus: 'closed', note: 'Private outcome', createdAt: '2026-10-04' },
        { workspaceId: workspace, ticketId: 'other-ticket', toStatus: 'closed', note: 'Private outcome', createdAt: '2026-10-04' },
      ] as TicketEvent[];
    } },
  } as unknown as RepositoryBundle;
  const result = await getCustomerTicketReplyContext('company', 'buyer', repos);
  assert.equal(result.availability, 'available');
  assert.deepEqual(calls[0], ['company', { leadId: 'buyer' }]);
  assert.equal(result.tickets.length, 2);
  assert.equal(result.tickets[0].status, 'reopened');
  assert.equal(result.tickets[1].status, 'closed');
  assert.equal(result.tickets[0].lastRecordedOutcome?.note, 'Sample inspected; no promised dispatch.');
  assert.doesNotMatch(JSON.stringify(result), /Private/);
  assert.equal(tickets[0].subject, 'Damaged samples', 'context gathering never rewrites original data');
  console.log('PASS current closed/reopened states and attributed outcomes are scoped to the right company, buyer and ticket');

  const before = calls.length;
  assert.equal((await getCustomerTicketReplyContext('company', undefined, repos)).availability, 'no_linked_customer');
  assert.equal(calls.length, before, 'first contact cannot read arbitrary company tickets');
  tickets.splice(0);
  assert.deepEqual(await getCustomerTicketReplyContext('company', 'buyer', repos), { availability: 'available', tickets: [] });
  console.log('PASS first contact and no cases remain honest empty context');

  for (let i = 0; i < 12; i++) tickets.push({ id: `case-${i}`, workspaceId: 'company', leadId: 'buyer', status: 'open', subject: 's'.repeat(1000), updatedAt: `2026-10-${String(i + 1).padStart(2, '0')}` } as Ticket);
  const bounded = await getCustomerTicketReplyContext('company', 'buyer', repos);
  assert.equal(bounded.tickets.length, 6);
  assert.ok(bounded.tickets.every(ticket => ticket.subject.length <= 160));
  console.log('PASS only six recent cases enter bounded model context');

  repos.ticket.listByWorkspace = async () => { throw new Error('isolated expected lookup failure'); };
  assert.deepEqual(await getCustomerTicketReplyContext('company', 'buyer', repos), { availability: 'unavailable', tickets: [] });
  console.log('PASS lookup failure remains unavailable rather than invented completion');

  const realRepos = createJsonRepos();
  const workspaceId = 'reply-focus-isolated';
  await realRepos.workspace.create({ id: workspaceId, name: 'Reply focus fixture', status: 'active' });
  const buyer = await realRepos.lead.createLead({ workspaceId, companyName: 'Fixture buyer', status: 'contacted', reviewStatus: 'approved' });
  await realRepos.reply.create({ workspaceId, leadId: buyer.id, rawText: 'The samples arrived damaged.', channel: 'whatsapp' });
  const caseRow = await realRepos.ticket.create({ workspaceId, leadId: buyer.id, type: 'complaint', priority: 'medium', subject: 'Damaged samples', description: 'The samples arrived damaged.', sourceChannel: 'whatsapp', status: 'closed' });
  await realRepos.ticketEvent.create({ workspaceId, ticketId: caseRow.id, eventType: 'status_changed', toStatus: 'closed', actorType: 'owner', note: 'Customer confirmed the inspection outcome.' });
  let captured: Record<string, unknown> | undefined;
  const original = LLMService.prototype.runTask;
  LLMService.prototype.runTask = async function<T>(_task: LLMTaskName, input: unknown, _options: LLMTaskOptions): Promise<LLMTaskResult<T>> {
    captured = input as Record<string, unknown>;
    return { output: { classification: 'moq_request', riskLevel: 'medium', suggestedReply: 'Our team can confirm the minimum order.', confidenceScore: 0.8, needsHumanReview: true, canAutoSend: false, missingKnowledge: true, missingQuestion: 'Minimum order?', mediaAttachmentId: '', leadStatusSuggestion: 'needs_review', reason: 'Synthetic offline contract' } as T, provider: 'mock', modelTier: 'balanced', mode: 'mock', fallbackUsed: false };
  };
  try {
    const result = await handleIncomingWhatsAppMessage({ workspaceId, leadId: buyer.id, rawText: 'What is the minimum order?' }, realRepos, { dryRun: true, allowRealSend: false });
    assert.match(String(captured?.conversationHistory), /samples arrived damaged/i, 'original transcript must remain present');
    const snapshot = captured?.currentTicketContext as { availability: string; tickets: Array<{ status: string }> };
    assert.equal(snapshot.availability, 'available');
    assert.equal(snapshot.tickets[0].status, 'closed', 'actual reply model receives newer completion evidence');
    assert.equal(captured?.customerMessage, 'What is the minimum order?');
    assert.equal(result.send.attempted, false);
    assert.equal(result.needsHumanReview, true);
    assert.equal((await realRepos.reply.listByLead(workspaceId, buyer.id)).length, 1, 'dry-run must not replace or add to original history');
    console.log('PASS actual engine passes original complaint plus current closed case and current question, retaining review and no-send');
  } finally { LLMService.prototype.runTask = original; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
