import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { E2E_DATA_DIR, assertE2EDataDirIsIsolated } from '../e2e/helpers/data-dir';
async function main() {
  const dir = path.resolve(process.env.LEADGEN_DATA_DIR || '');
  assertE2EDataDirIsIsolated(dir);
  assert.equal(dir, E2E_DATA_DIR, 'Only the configured isolated browser-test data may be used');
  assert.equal(process.env.PERSISTENCE_PROVIDER, 'json');
  const [workspaceId, leadId] = process.argv.slice(2);
  assert.ok(workspaceId && leadId);
  for (const name of Object.keys(process.env)) if (/API_KEY|DATABASE_URL|ACCESS_TOKEN|WHATSAPP_TOKEN|META_SYSTEM_TOKEN/.test(name)) process.env[name] = '';
  Object.assign(process.env, { LEADGEN_LEAD_MEMORY: '0', LEADGEN_DISCOVERY_LISTEN: '0', LEADGEN_AGENTIC_RETRIEVAL: '0' });
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'app-data.json'), 'utf8'));
  assert.equal(before.workspaces.find((w: {id:string}) => w.id === workspaceId)?.name, 'Harbour Packaging');
  const { createRepositories } = await import('../src/repositories');
  const { handleIncomingWhatsAppMessage } = await import('../src/services/WhatsAppConversationEngine');
  const result = await handleIncomingWhatsAppMessage({ workspaceId, leadId, phone: '+910000000111', rawText: 'The H20 carton samples arrived damaged. Please resolve this complaint.', providerMessageId: `synthetic-playtest-${Date.now()}`, metadata: { source: 'synthetic_customer_playtest' } }, createRepositories('json'), { dryRun: false, allowRealSend: false });
  assert.ok(result.replyId); assert.ok(result.needsHumanReview);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'app-data.json'), 'utf8'));
  const ticket = after.tickets.find((t: {workspaceId:string;leadId:string}) => t.workspaceId === workspaceId && t.leadId === leadId);
  assert.ok(ticket, 'Actual complaint engine must create the ticket');
  assert.ok(ticket.assignedTo, 'Configured assignment must name a real accepted employee');
  assert.equal(after.autoReplyLogs.find((l: {id:string}) => l.id === result.autoReplyLogId)?.sendStatus === 'sent', false);
  console.log(JSON.stringify({ replyId: result.replyId, ticketId: ticket.id, assignedTo: ticket.assignedTo, mode: result.llm?.mode, noCustomerSend: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
