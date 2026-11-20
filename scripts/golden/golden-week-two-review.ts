import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { createJsonRepos } from './_helpers/provider';
import { ensureWorkspace } from './_helpers/fixtures';
import { registerDoNotContact } from '@/lib/dnc-registry';
import { approveLead, bulkReviewLeads } from '@/services/LeadReviewDecisionService';

async function main() {
  const repos = createJsonRepos();
  const ws = `week_two_review_${Date.now()}`;
  await ensureWorkspace(repos, ws);
  const safe = await repos.lead.createLead({ workspaceId: ws, companyName: 'Eligible buyer', phone: '+919876540001', status: 'needs_review', reviewStatus: 'pending', doNotContact: false });
  const blocked = await repos.lead.createLead({ workspaceId: ws, companyName: 'Restored opted-out buyer', whatsappNumber: '+919876540002', phone: '+919876540003', status: 'needs_review', reviewStatus: 'pending', doNotContact: false });
  await registerDoNotContact(ws, { phone: blocked.phone, reason: 'Permanent opt-out' }, repos);
  await assert.rejects(() => approveLead(ws, blocked.id, repos), /do-not-contact/);
  assert.equal((await repos.lead.getLeadById(ws, blocked.id))!.reviewStatus, 'pending');
  console.log('PASS permanent alternate-phone block prevents approval with clear display flags');
  const result = await bulkReviewLeads(ws, [blocked.id, safe.id, 'deleted_buyer'], 'approve', repos);
  assert.deepEqual(result.leads.map(l => l.id), [safe.id]);
  assert.deepEqual(result.skipped.map(l => l.leadId), [blocked.id, 'deleted_buyer']);
  assert.equal((await repos.lead.getLeadById(ws, safe.id))!.reviewStatus, 'approved');
  console.log('PASS mixed batch keeps eligible result and precise skipped reasons');
  const waiting = await repos.lead.createLead({ workspaceId: ws, companyName: 'Waiting buyer', phone: '+919876540004', status: 'needs_review', reviewStatus: 'pending', doNotContact: false });
  const unavailable = { ...repos, doNotContact: { ...repos.doNotContact, findMatch: async () => { throw new Error('Registry unavailable'); } } };
  await assert.rejects(() => approveLead(ws, waiting.id, unavailable), /Registry unavailable/);
  assert.equal((await repos.lead.getLeadById(ws, waiting.id))!.reviewStatus, 'pending');
  console.log('PASS registry outage cannot authorize a buyer');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
