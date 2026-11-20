import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { createJsonRepos } from './_helpers/provider';
import { gatherHistoryText } from '@/services/ConversationSummaryService';
import { rememberConversation } from '@/services/LeadMemoryService';
import { customerConversationHistory } from '@/services/CustomerConversationHistoryService';

async function main() {
  const repos = createJsonRepos(), ws = `long_history_${Date.now()}`;
  const lead = await repos.lead.createLead({ workspaceId: ws, companyName: 'Synthetic buyer', status: 'replied' });
  const lateFact = 'Our requirement is 275 kg every month.';
  await repos.reply.create({ workspaceId: ws, leadId: lead.id, channel: 'whatsapp', rawText: `${'Please share details. '.repeat(15)}${lateFact}` });
  let history = await gatherHistoryText(ws, lead.id, repos);
  assert.ok(history.text.includes(lateFact), 'fact after character 120 must reach the model');
  console.log('PASS late-message fact retained');
  for (const status of ['drafted', 'approved', 'failed', 'manual'] as const) {
    await repos.outreachActivity.create({ workspaceId: ws, leadId: lead.id, channel: 'whatsapp', direction: 'outbound', status, sentManually: false, body: `UNSENT_${status}`, activityAt: new Date().toISOString() });
  }
  history = await gatherHistoryText(ws, lead.id, repos);
  assert.doesNotMatch(history.text, /UNSENT_/, 'approval alone is not a sent message');
  assert.doesNotMatch(JSON.stringify(await customerConversationHistory(ws, lead.id, repos)), /UNSENT_/, 'staff transcript excludes unsent activities too');
  console.log('PASS unsent activities excluded');
  await repos.lead.updateLead(ws, lead.id, { conversationMemory: 'Earlier customer requested paid samples.', conversationMemorySource: 'ai', discoveryState: {
    supplier: { label: 'Supplier', value: 'Team confirmed Pune supplier', answeredAt: new Date().toISOString(), ownerEditedAt: new Date().toISOString() },
    volume: { label: 'Volume', value: '', forgottenAt: new Date().toISOString() },
  } });
  for (let index = 0; index < 85; index++) await repos.reply.create({ workspaceId: ws, leadId: lead.id, channel: 'whatsapp', rawText: `Message ${index}: ${'x'.repeat(400)} newest detail ${index}` });
  history = await gatherHistoryText(ws, lead.id, repos);
  assert.ok(history.text.length <= 24000, 'history input bounded to 24000 characters');
  assert.match(history.text, /newest detail 84/);
  assert.match(history.text, /earlier events omitted/i);
  console.log('PASS recent window bounded with explicit omission');
  let seen = '';
  await rememberConversation(ws, lead.id, repos, { summarise: async text => { seen = text; return 'Earlier customer requested paid samples. Latest requirement awaiting confirmation.'; } });
  assert.match(seen, /Earlier customer requested paid samples/);
  assert.match(seen, /Team confirmed Pune supplier/);
  assert.match(seen, /PAUSED CHECKLIST QUESTIONS/);
  assert.match(seen, /newest detail 84/);
  console.log('PASS saved note, corrections and paused-question instructions carried forward');
  await repos.reply.create({ workspaceId: ws, leadId: lead.id, channel: 'whatsapp', rawText: `START ${'z'.repeat(30000)} END IMPORTANT FACT` });
  history = await gatherHistoryText(ws, lead.id, repos);
  assert.ok(history.text.length <= 24000);
  assert.match(history.text, /START/); assert.match(history.text, /END IMPORTANT FACT/); assert.match(history.text, /middle omitted/i);
  assert.equal((await repos.reply.listByLead(ws, lead.id)).at(-1)?.rawText.length, 30025, 'original message remains complete');
  console.log('PASS oversized message shows both ends without altering stored history');
  assert.equal((await gatherHistoryText(`${ws}_other`, lead.id, repos)).text, 'No interactions yet.');
  console.log('PASS company isolation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
