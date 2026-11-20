import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { createJsonRepos } from './_helpers/provider';
import { changeLeadDiscoveryFact, getLeadDiscovery, listenForDiscoveryFacts } from '@/services/DiscoveryService';
import { formatLeadMemoryForPrompt, editLeadMemoryAsOwner } from '@/services/LeadMemoryService';

async function main() {
  const repos = createJsonRepos(), workspaceId = 'fact-control-company';
  const lead = await repos.lead.createLead({ workspaceId, companyName: 'Synthetic customer', status: 'replied' });
  const said = `${'Please send the catalogue. '.repeat(12)}We buy from Surat.`;
  const reply = await repos.reply.create({ workspaceId, leadId: lead.id, channel: 'whatsapp', rawText: said } as never);
  const detect = async () => [{ key: 'current_supplier', value: 'We buy from Surat.' }];
  await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect });
  let view = await getLeadDiscovery(workspaceId, lead.id, repos);
  assert.equal(view.rows.find(row => row.key === 'current_supplier')?.evidence?.replyId, reply.id);
  assert.equal(view.rows.find(row => row.key === 'current_supplier')?.evidence?.body, said);
  console.log('PASS full inbound evidence retained beyond the old 120-character limit');
  const invented = await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect: async () => [{ key: 'volume', value: '500 kg monthly' }] });
  assert.deepEqual(invented.learned, []);
  await repos.outreachActivity.create({ workspaceId, leadId: lead.id, channel: 'whatsapp', body: '500 kg monthly', activityAt: new Date().toISOString() } as never);
  assert.deepEqual((await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect: async () => [{ key: 'volume', value: '500 kg monthly' }] })).learned, []);
  console.log('PASS invented and outbound-only facts are rejected');
  await changeLeadDiscoveryFact(workspaceId, lead.id, 'current_supplier', { action: 'correct', value: 'Owner confirmed Ahmedabad supplier' }, 'owner', repos);
  await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect });
  assert.equal((await getLeadDiscovery(workspaceId, lead.id, repos)).rows.find(row => row.key === 'current_supplier')?.value, 'Owner confirmed Ahmedabad supplier');
  console.log('PASS human correction survives later listening');
  assert.match(formatLeadMemoryForPrompt(await repos.lead.getLeadById(workspaceId, lead.id)), /Owner confirmed Ahmedabad supplier.*corrected by the team/);
  await changeLeadDiscoveryFact(workspaceId, lead.id, 'current_supplier', { action: 'forget' }, 'owner', repos);
  assert.deepEqual((await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect })).learned, []);
  view = await getLeadDiscovery(workspaceId, lead.id, repos);
  assert.ok(view.rows.find(row => row.key === 'current_supplier')?.forgottenAt);
  assert.equal(view.rows.find(row => row.key === 'current_supplier')?.value, undefined);
  assert.doesNotMatch(formatLeadMemoryForPrompt(await repos.lead.getLeadById(workspaceId, lead.id)), /Owner confirmed Ahmedabad supplier|We buy from Surat/);
  assert.match(formatLeadMemoryForPrompt(await repos.lead.getLeadById(workspaceId, lead.id)), /PAUSED CHECKLIST QUESTIONS/);
  assert.ok((await repos.reply.listByLead(workspaceId, lead.id)).some(row => row.id === reply.id));
  await changeLeadDiscoveryFact(workspaceId, lead.id, 'current_supplier', { action: 'resume' }, 'owner', repos);
  assert.deepEqual((await listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect })).learned, ['current_supplier']);
  console.log('PASS removal pauses capture; original history retained; explicit resume restores listening');
  // Hold the model while the person removes the fact. Its late result must not
  // restore the answer that was deliberately cleared.
  await changeLeadDiscoveryFact(workspaceId, lead.id, 'current_supplier', { action: 'resume' }, 'owner', repos);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const delayed = listenForDiscoveryFacts(workspaceId, lead.id, repos, { detect: async () => { started(); await gate; return detect(); } });
  await ready;
  await changeLeadDiscoveryFact(workspaceId, lead.id, 'current_supplier', { action: 'forget' }, 'owner', repos);
  release(); assert.deepEqual((await delayed).learned, []);
  console.log('PASS late detector respects removal made while it was running');
  const before = await repos.lead.getLeadById(workspaceId, lead.id), createAudit = repos.auditLog.create;
  repos.auditLog.create = async () => { throw new Error('injected audit failure'); };
  try {
    await assert.rejects(() => changeLeadDiscoveryFact(workspaceId, lead.id, 'current_supplier', { action: 'correct', value: 'Must roll back' }, 'owner', repos), /injected audit/);
    await assert.rejects(() => editLeadMemoryAsOwner(workspaceId, lead.id, 'Failed prose correction', 'owner', repos), /injected audit/);
  }
  finally { repos.auditLog.create = createAudit; }
  assert.deepEqual((await repos.lead.getLeadById(workspaceId, lead.id))?.discoveryState, before?.discoveryState);
  assert.equal((await repos.lead.getLeadById(workspaceId, lead.id))?.conversationMemory, before?.conversationMemory);
  await assert.rejects(() => changeLeadDiscoveryFact('another-company', lead.id, 'current_supplier', { action: 'correct', value: 'Wrong tenant' }, 'owner', repos));
  await assert.rejects(() => changeLeadDiscoveryFact(workspaceId, lead.id, 'not_a_fact', { action: 'forget' }, 'owner', repos));
  await assert.rejects(() => changeLeadDiscoveryFact(workspaceId, lead.id, 'volume', { action: 'correct', value: 'x'.repeat(241) }, 'owner', repos));
  console.log('PASS failed audit rolls back; wrong company, unknown keys and oversized facts rejected');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
