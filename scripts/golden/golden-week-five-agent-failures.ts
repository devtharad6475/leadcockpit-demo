import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { createJsonRepos } from './_helpers/provider';
import { LLMService } from '@/llm/LLMService';
import { confirmCopilotBigJob, handleOwnerCopilotTurn } from '@/services/OwnerCopilotService';

// Synthetic records + intercepted model calls only. Never contacts a provider.
async function main() {
  const repos = createJsonRepos();
  const original = LLMService.prototype.runTask;
  let calls = 0;
  let captured: unknown;
  let task = '';
  let response: unknown = {};
  let outage = false;
  LLMService.prototype.runTask = (async (name: string, input: unknown) => {
    calls += 1; task = name; captured = input;
    if (outage) throw new Error('Synthetic provider outage');
    return { output: response, mode: 'real', fallbackUsed: false, provider: 'synthetic' };
  }) as unknown as typeof original;
  const makeCompany = async (suffix: string) => {
    const workspaceId = `ws_week_five_agent_${suffix}`;
    await repos.workspace.create({ id: workspaceId, name: `Synthetic supplier ${suffix}`, status: 'active' });
    const profile = await repos.businessProfile.create({ workspaceId, companyName: `Synthetic supplier ${suffix}`, industry: 'industrial supplies', products: ['Replacement filters'] });
    const initial = await repos.icp.replaceForBusinessProfile(workspaceId, profile.id, [{ name: 'Existing approved buyer profile', buyerType: 'distributor' }]);
    return { workspaceId, profile, initial };
  };
  const askAndConfirm = async (workspaceId: string, intent: 'icp_generation' | 'campaign_planning' | 'lead_review_decision') => {
    const conversation = await repos.ownerCopilotConversation.create({ workspaceId, ownerUserId: 'synthetic_owner' });
    const proposal = await handleOwnerCopilotTurn({ workspaceId, ownerUserId: 'synthetic_owner', conversationId: conversation.id,
      ownerText: intent === 'icp_generation' ? 'build my customer profile' : intent === 'campaign_planning' ? 'plan a campaign' : 'review my pending leads', repos, conversationBrain: false });
    assert.equal(proposal.kind, 'copilot_confirm');
    assert.ok(proposal.pendingAction?.entityId);
    return confirmCopilotBigJob({ workspaceId, ownerUserId: 'synthetic_owner', conversationId: conversation.id,
      pendingActionId: proposal.pendingAction.entityId, intent, repos });
  };
  let passed = 0;
  const pass = (description: string) => { passed += 1; console.log(`PASS ${description}`); };
  try {
    for (const [suffix, value, failed] of [
      ['outage', {}, true], ['missing', {}, false], ['empty', { icps: [] }, false],
      ['malformed', { icps: [null] }, false], ['nameless', { icps: [{}] }, false],
    ] as const) {
      const company = await makeCompany(suffix);
      response = value; outage = failed;
      const result = await askAndConfirm(company.workspaceId, 'icp_generation');
      assert.notEqual(result.kind, 'copilot_action_done', `${suffix}: failure must not claim completion`);
      assert.deepEqual(await repos.icp.listByWorkspace(company.workspaceId), company.initial, `${suffix}: previous profiles must survive exactly`);
      assert.equal((await repos.campaign.listByWorkspace(company.workspaceId)).length, 0);
      pass(`ICP ${suffix} preserves existing profiles`);
    }
    {
      const company = await makeCompany('valid');
      outage = false;
      response = { icps: [{ name: 'Regional filter distributors', buyerType: 'distributor', description: 'Replacement filter wholesalers',
        industries: ['industrial supplies'], geography: ['Pune'], likelyNeeds: ['Replacement filters'], buyingTriggers: ['Maintenance demand'],
        painPoints: ['Supply continuity'], preferredChannels: ['email'], messagingAngles: ['Product fit'], qualificationRules: ['Business buyer'], confidenceScore: 0.8, companySizeBucket: 'small company' }] };
      const result = await askAndConfirm(company.workspaceId, 'icp_generation');
      assert.equal(result.kind, 'copilot_action_done');
      const rows = await repos.icp.listByWorkspace(company.workspaceId);
      assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Regional filter distributors');
      assert.equal(result.aiStatus, 'real');
      pass('schema-conforming icps output creates actual generated profile');
    }
    for (const [suffix, value, failed] of [
      ['outage', {}, true], ['empty', {}, false], ['malformed', { searchQueries: [] }, false],
    ] as const) {
      const company = await makeCompany(`campaign_${suffix}`);
      const existing = await repos.campaign.create({ workspaceId: company.workspaceId, name: 'Existing reviewed campaign', status: 'draft', icpId: company.initial[0].id });
      response = value; outage = failed;
      const result = await askAndConfirm(company.workspaceId, 'campaign_planning');
      assert.notEqual(result.kind, 'copilot_action_done');
      assert.deepEqual(await repos.campaign.listByWorkspace(company.workspaceId), [existing], 'Failed generation must not create a fake campaign');
      pass(`campaign ${suffix} leaves existing campaign unchanged`);
    }
    {
      const company = await makeCompany('campaign_valid');
      outage = false; response = { icpSummary: 'Industrial filter distributors', prospectSources: ['Trade directories'],
        searchQueries: ['industrial filter distributor Pune', 'industrial filter distributor Nashik', 'filter cartridge wholesaler Pune', 'maintenance filter supplier Maharashtra', 'industrial cartridge reseller Pune'], messageStrategy: 'Review product fit before contact', outreachSequence: ['Find buyers', 'Review fit', 'Draft introduction', 'Owner reviews'],
        qualificationCriteria: ['Buys filters'], expectedLeadStatuses: ['needs_review'], manualExecutionSteps: ['Owner reviews drafts'] };
      const result = await askAndConfirm(company.workspaceId, 'campaign_planning');
      assert.equal(result.kind, 'copilot_action_done');
      const rows = await repos.campaign.listByWorkspace(company.workspaceId);
      assert.equal(rows.length, 1); assert.deepEqual(rows[0].plan, response);
      assert.equal(rows[0].status, 'draft');
      pass('valid campaign plan persists draft with actual generated plan');
    }
    const company = await makeCompany('analysis');
    const foreign = await makeCompany('analysis_foreign');
    const lead = await repos.lead.createLead({ workspaceId: company.workspaceId, companyName: 'Scoped buyer', source: 'manual', status: 'approved' });
    const other = await repos.lead.createLead({ workspaceId: foreign.workspaceId, companyName: 'Foreign buyer', source: 'manual', status: 'approved' });
    const customerWords = 'Please send your catalogue for filter cartridges.';
    await repos.reply.create({ workspaceId: company.workspaceId, leadId: lead.id, channel: 'whatsapp', rawText: customerWords });
    await repos.reply.create({ workspaceId: foreign.workspaceId, leadId: other.id, channel: 'whatsapp', rawText: 'FOREIGN_PRIVATE_REPLY' });
    const conversation = await repos.ownerCopilotConversation.create({ workspaceId: company.workspaceId, ownerUserId: 'synthetic_owner', activeLeadId: lead.id });
    const turn = (ownerText: string, leadId?: string) => handleOwnerCopilotTurn({ workspaceId: company.workspaceId, ownerUserId: 'synthetic_owner', conversationId: conversation.id, ownerText, leadId, repos, conversationBrain: false });
    outage = false; response = { classification: 'ask_catalogue', confidenceScore: 0.9, leadStatus: 'mql', summary: 'Buyer requests filter catalogue.', suggestedNextAction: 'Review and share catalogue.', suggestedResponse: 'Thank you for your catalogue request.' };
    const analysis = await turn('classify this reply', lead.id);
    assert.equal(task, 'reply_classification');
    assert.ok(JSON.stringify(captured).includes(customerWords), 'Classify must read the actual scoped buyer message');
    assert.ok(!JSON.stringify(captured).includes('FOREIGN_PRIVATE_REPLY'));
    assert.match(analysis.text, /Buyer requests filter catalogue/);
    assert.ok(!analysis.text.includes('"classification"'), 'Summary must be business text, not serialized JSON');
    pass('classification reads exact scoped customer reply and renders plain summary');
    {
      const before = calls;
      const missing = await turn('classify this reply');
      assert.equal(calls, before, 'Missing target must ask before any model call');
      assert.match(missing.text, /which|pick|select|customer|lead/i);
      const foreignTarget = await turn('classify this reply', other.id);
      assert.equal(calls, before, 'Foreign target must never be analyzed');
      assert.notEqual(foreignTarget.kind, 'copilot_action_done');
      pass('missing and foreign customer targets ask safely without model');
    }
    {
      const draftBody = 'Thank you. Which filter cartridge size do you need?';
      await repos.messageTemplate.create({ workspaceId: company.workspaceId, campaignId: 'copilot', leadId: lead.id, channel: 'whatsapp', body: draftBody, tone: 'professional', language: 'en', status: 'draft' });
      response = { overallScore: 0.8, issues: [{ issue: 'Ask quantity as well.', severity: 'low', field: 'body' }], recommendations: ['Ask the required quantity.'], passes: true };
      const review = await turn('review this draft', lead.id);
      assert.equal(task, 'quality_review');
      assert.ok(JSON.stringify(captured).includes(draftBody), 'Quality review must read saved scoped draft');
      assert.match(review.text, /Ask quantity|Ask the required quantity/);
      assert.ok(!review.text.includes('"overallScore"'));
      assert.equal((await repos.messageTemplate.listByWorkspace(company.workspaceId))[0].status, 'draft', 'Read-only review never sends or approves');
      pass('quality review reads saved draft and returns plain issues');
    }
    {
      response = {};
      const malformedAnalysis = await turn('classify this reply', lead.id);
      assert.notEqual(malformedAnalysis.kind, 'copilot_action_done');
      assert.ok(!malformedAnalysis.text.includes('{}'), 'Unusable analysis must say unavailable rather than display an empty object');
      assert.match(malformedAnalysis.text, /not|unable|could|unavailable|usable/i);
      const withoutDraft = await repos.lead.createLead({ workspaceId: company.workspaceId, companyName: 'Buyer without draft', source: 'manual', status: 'approved' });
      const before = calls;
      const missingDraft = await turn('review this draft', withoutDraft.id);
      assert.equal(calls, before, 'Missing draft must not ask a model to judge nonexistent text');
      assert.match(missingDraft.text, /draft|message/i);
      pass('unusable analysis and absent draft never claim a successful review');
    }
    {
      const reviewCompany = await makeCompany('lead_review');
      const pending = await repos.lead.createLead({ workspaceId: reviewCompany.workspaceId, companyName: 'Only pending buyer', source: 'manual', status: 'needs_review', reviewStatus: 'pending', icpId: reviewCompany.initial[0].id });
      const storedPending = await repos.lead.getLeadById(reviewCompany.workspaceId, pending.id);
      const recommendation = { decision: 'needs_review', reason: 'The product need is recorded, but contact details need confirmation.', signals: ['Filter distributor'], confidenceScore: 0.7 };
      outage = false; response = recommendation;
      const valid = await askAndConfirm(reviewCompany.workspaceId, 'lead_review_decision');
      assert.equal(task, 'lead_review_decision');
      assert.ok(JSON.stringify(captured).includes(pending.id));
      assert.ok(!JSON.stringify(captured).includes(other.id), 'Single buyer recommendation excludes foreign company records');
      assert.match(valid.text, /Only pending buyer/);
      assert.match(valid.text, /contact details need confirmation/);
      assert.match(valid.text, /chat suggestion only/);
      assert.ok(!valid.text.includes('See suggestions on the review screen'));
      assert.deepEqual(await repos.lead.getLeadById(reviewCompany.workspaceId, pending.id), storedPending, 'Suggestion must not change the buyer');
      pass('single scoped lead review renders actual recommendation without changing status');
      for (const [name, output, failed] of [
        ['outage', {}, true], ['malformed', {}, false], ['foreign attribution', { ...recommendation, leadId: other.id }, false],
      ] as const) {
        outage = failed; response = output;
        const failure = await askAndConfirm(reviewCompany.workspaceId, 'lead_review_decision');
        assert.notEqual(failure.kind, 'copilot_action_done');
        assert.match(failure.text, /could not produce|manually/i);
        assert.ok(!failure.text.includes('analyzed'));
        assert.deepEqual(await repos.lead.getLeadById(reviewCompany.workspaceId, pending.id), storedPending);
        pass(`lead review ${name} refuses false success and preserves buyer`);
      }
      await repos.lead.createLead({ workspaceId: reviewCompany.workspaceId, companyName: 'Second pending buyer', source: 'manual', status: 'needs_review', reviewStatus: 'pending' });
      const before = calls; outage = false; response = recommendation;
      const batch = await askAndConfirm(reviewCompany.workspaceId, 'lead_review_decision');
      assert.equal(calls, before, 'Single-output contract must not be used for unsupported batch');
      assert.match(batch.text, /2 buyers/);
      assert.match(batch.text, /batch recommendations are not available/);
      assert.notEqual(batch.kind, 'copilot_action_done');
      pass('unsupported multi-buyer batch reports manual review with zero model calls');
    }
    console.log(`week-five-agent-failures: ${passed} passed, 0 failed`);
  } finally { LLMService.prototype.runTask = original; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
