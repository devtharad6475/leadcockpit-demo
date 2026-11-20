import './_helpers/isolate-standalone';
import './_helpers/no-platform-ai-keys';
import assert from 'node:assert/strict';
import { createJsonRepos } from './_helpers/provider';
import { getAllKnowledgeQuestions, getKnowledgeQuestion } from '@/knowledge/knowledge-question-framework';
import { setupProgress, setupCandidates, setupQuestionWording } from '@/services/SetupInterviewService';

async function main() {
  const repos = createJsonRepos();
  const workspaceId = `plain_setup_${Date.now()}`;
  await repos.workspace.create({ id: workspaceId, name: 'Synthetic setup wording company', status: 'active' });
  const marker = 'company_knowledge/value_proposition';
  const original = JSON.stringify(getAllKnowledgeQuestions());
  const all = await setupCandidates(workspaceId, repos, marker, new Set());
  const value = all.find(item => item.marker === marker);
  assert.equal(value?.question, 'What is the main benefit customers get from buying from your company?');
  const excluded = new Set(all.filter(item => item.marker !== marker).map(item => item.marker));
  const progress = await setupProgress(workspaceId, repos, excluded);
  assert.equal(`${progress.next?.domainKey}/${progress.next?.questionKey}`, marker);
  assert.equal(progress.next?.question, value?.question);
  assert.equal(all[0].marker, marker, 'pending question stays first');
  assert.equal(value?.answered, false, 'wording cannot invent an answer');
  assert.equal(JSON.stringify(getAllKnowledgeQuestions()), original, 'canonical questions, depth, flags and keys are unchanged');
  assert.equal(getKnowledgeQuestion('company_knowledge', 'value_proposition')?.question, 'What is the company primary value proposition for buyers?');
  assert.equal(setupQuestionWording('company_knowledge', 'value_proposition', 'A changed question must receive a new copy review?'), 'A changed question must receive a new copy review?');
  assert.equal(setupQuestionWording('unknown', 'unknown', 'What legal conditions apply?'), 'What legal conditions apply?');
  for (const [domainKey, questionKey, expected] of [
    ['lead_qualification', 'mql_rules', 'What tells you a potential customer is suitable for your marketing efforts?'],
    ['lead_qualification', 'sql_rules', 'What tells you a potential customer is ready for your sales team to contact?'],
    ['objection_handling', 'moq_objection', 'What should the AI say when a buyer wants less than your minimum order?'],
  ]) {
    const question = getKnowledgeQuestion(domainKey, questionKey);
    assert.ok(question);
    assert.equal(setupQuestionWording(domainKey, questionKey, question.question), expected);
  }
  const safety = getKnowledgeQuestion('whatsapp_communication', 'auto_reply_boundaries');
  assert.ok(safety?.humanReviewRequired, 'sensitive review rules stay in the canonical definition');
  assert.equal(setupQuestionWording('whatsapp_communication', 'auto_reply_boundaries', safety.question), safety.question);
  console.log('PASS understandable actual interview wording; pending identity and canonical knowledge unchanged');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
