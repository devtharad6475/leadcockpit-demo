import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { repositories } from '@/repositories';
import { customerConversationHistory } from '@/services/CustomerConversationHistoryService';
import { canReadWorkspacePath, canViewWorkspaceTab, workspaceLandingTab } from '@/lib/workspace-ui-access';

async function main() {
  const lead = await repositories.lead.createLead({ workspaceId: 'history-company', companyName: 'History buyer' });
  const other = await repositories.lead.createLead({ workspaceId: 'other-company', companyName: 'Other buyer' });
  const body = `${'Customer detail '.repeat(20)}Important ending remains visible.`;
  await repositories.reply.create({ workspaceId: lead.workspaceId, leadId: lead.id, channel: 'WhatsApp', rawText: body });
  await repositories.reply.create({ workspaceId: other.workspaceId, leadId: other.id, channel: 'WhatsApp', rawText: 'PRIVATE NEIGHBOUR MESSAGE' });
  await repositories.autoReplyLog.create(lead.workspaceId, { workspaceId: lead.workspaceId, leadId: lead.id, channel: 'WhatsApp', incomingMessage: 'Question', generatedReply: 'UNSENT PROMISE', status: 'held_for_review', canAutoSend: false, needsHumanReview: true });
  const messages = await customerConversationHistory(lead.workspaceId, lead.id, repositories);
  assert.equal(messages.length, 1); assert.equal(messages[0].body, body);
  assert.ok(!JSON.stringify(messages).includes('UNSENT PROMISE')); assert.ok(!JSON.stringify(messages).includes('PRIVATE NEIGHBOUR'));
  await assert.rejects(() => customerConversationHistory(lead.workspaceId, other.id, repositories), /not found in your company/);
  const broken = { ...repositories, reply: { ...repositories.reply, listByLead: async () => { throw new Error('Database unavailable'); } } };
  await assert.rejects(() => customerConversationHistory(lead.workspaceId, lead.id, broken), /Database unavailable/);
  for (const role of ['viewer', 'sales_member', 'admin'] as const) {
    assert.equal(canViewWorkspaceTab(role, 'commandCenter'), false);
    assert.equal(canReadWorkspacePath(role, '/api/auto-reply-logs'), false);
    assert.equal(canReadWorkspacePath(role, '/api/leads'), true);
    assert.equal(workspaceLandingTab(role), 'tickets');
  }
  assert.equal(canViewWorkspaceTab('sales_member', 'workspace'), false);
  assert.equal(canViewWorkspaceTab('admin', 'workspace'), true);
  assert.equal(canViewWorkspaceTab('viewer', 'tickets'), true);
  assert.equal(canViewWorkspaceTab('viewer', 'unclassified-new-settings'), false);
  console.log('PASS: full customer words, unsent/foreign exclusion, foreign refusal, visible data failure, role-correct entry and protected navigation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
