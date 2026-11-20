import './_helpers/isolate-standalone';
import './_helpers/no-platform-ai-keys';
import assert from 'node:assert/strict';
import { createJsonRepos } from './_helpers/provider';
import { classifyCopilotIntent, handleOwnerCopilotTurn } from '@/services/OwnerCopilotService';
import { setupProgress } from '@/services/SetupInterviewService';
import { listKnowledgeQuestionAnswers } from '@/services/DocumentQuestionAnsweringService';

async function main() {
  const setupPhrases = ["Let's fill in my business details.", "Let's continue setting up my business details.", 'Set up my business details', 'Continue setup', 'Start business setup'];
  for (const phrase of setupPhrases) assert.equal(classifyCopilotIntent(phrase).intent, 'setup_question');
  for (const phrase of ['Enrich this lead', 'Fill in this lead', 'Find their company details', 'Look up the lead']) assert.equal(classifyCopilotIntent(phrase).intent, 'enrich_lead');
  for (const [phrase, tier] of [
    ["Fill in my business details and delete all leads", 'T5'],
    ["Continue setup and send this to every customer", 'T5'],
    ["Fill in my business details and send the quote", 'T4'],
    ["Continue setup and run a paid search", 'T4'],
    ["Fill in my business details and plan a campaign", 'T3'],
  ] as const) assert.equal(classifyCopilotIntent(phrase).tier, tier);
  console.log('PASS explicit setup phrases; customer enrichment and higher-risk priority unchanged');

  const repos = createJsonRepos();
  const workspaceId = `assistant_setup_starter_${Date.now()}`;
  await repos.workspace.create({ id: workspaceId, name: 'Synthetic owner setup company', status: 'active' });
  const conversation = await repos.ownerCopilotConversation.create({ workspaceId, ownerUserId: 'synthetic-owner' });
  const next = (await setupProgress(workspaceId, repos)).next;
  assert.ok(next, 'fresh business has a real unanswered setup question');
  const turn = () => handleOwnerCopilotTurn({ workspaceId, conversationId: conversation.id, ownerUserId: 'synthetic-owner', ownerText: setupPhrases[0], repos, conversationBrain: false });
  const response = await turn();
  assert.equal(response.intent, 'setup_question');
  assert.equal(response.pendingAction?.entityType, 'knowledge_question');
  assert.equal(response.pendingAction?.entityId, `${next.domainKey}/${next.questionKey}`);
  assert.ok(response.text.includes(next.question), 'actual checklist wording is displayed');
  assert.equal(response.aiStatus, 'none');
  assert.equal((await listKnowledgeQuestionAnswers(workspaceId, repos)).filter(answer => answer.answer?.trim()).length, 0);
  const again = await turn();
  assert.equal(again.pendingAction?.entityId, response.pendingAction?.entityId, 'restarting does not drop the pending question');
  assert.equal((await repos.ownerCopilotMessage.listByConversation(workspaceId, conversation.id)).at(-1)?.pendingAction?.entityId, response.pendingAction?.entityId);
  console.log('PASS actual setup question persisted; restart retains it; no business answer invented');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
