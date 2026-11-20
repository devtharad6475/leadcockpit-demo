import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { createJsonRepos } from './_helpers/provider';
import { ensureWorkspace } from './_helpers/fixtures';
import { answerDocumentQuestions, approveKnowledgeQuestionAnswer, getWorkspaceChecklist, listKnowledgeQuestionAnswers, plainExtractionStopMessage } from '@/services/DocumentQuestionAnsweringService';
import { searchKnowledge } from '@/services/KnowledgeBaseService';

async function main() {
  const repos = createJsonRepos();
  const workspaceId = 'week1_extraction_contract';
  await ensureWorkspace(repos, workspaceId);
  const checklist = await getWorkspaceChecklist(workspaceId, repos);
  const keys = ['legal_company_name', 'industry'];
  const questions = checklist.questions.filter(q => keys.includes(q.questionKey));
  assert.equal(questions.length, 2);
  const framework = checklist.framework.filter(d => d.domainKey === 'factual_company_profile').map(d => ({ ...d, questions: d.questions.filter(q => keys.includes(q.questionKey)) }));
  const source = 'Pilot Loom Supplies makes cotton yarn for textile manufacturers.';
  const realFetch = globalThis.fetch;
  const previousKey = process.env.PLATFORM_DEEPSEEK_API_KEY;
  process.env.PLATFORM_DEEPSEEK_API_KEY = 'synthetic-offline-provider-key';
  let requests = 0;
  globalThis.fetch = (async (_url, init) => {
    requests++;
    const payload = JSON.parse(String(init?.body));
    assert.ok(JSON.stringify(payload).includes(source), 'source evidence must reach the actual provider request');
    return new Response(JSON.stringify({ choices:[{message:{content:JSON.stringify({ answers:questions.map(q => ({ domainKey:q.domainKey, questionKey:q.questionKey, answer:q.questionKey === 'legal_company_name' ? 'Pilot Loom Supplies' : 'Cotton yarn manufacturing', answerStatus:'answered', confidenceScore:0.9, sourceSnippet:source })), additionalMissingQuestions:[] })}}], usage:{prompt_tokens:200,completion_tokens:100,total_tokens:300} }), {status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  try {
    const result = await answerDocumentQuestions({workspaceId,documentText:source,documentId:'synthetic-uploaded-txt',documentMetadata:{title:'pilot-company.txt',sourceType:'document'}}, repos, {questionList:{framework,questions}});
    assert.equal(requests, 1, 'two related questions use one actual routed provider request');
    assert.equal(result.answeredCount, 2);
    const saved = (await listKnowledgeQuestionAnswers(workspaceId, repos)).find(q => q.questionKey === 'legal_company_name')!;
    assert.equal(saved.answer, 'Pilot Loom Supplies');
    assert.equal(Boolean(saved.isUserApproved), false, 'AI extraction never implies owner approval');
    assert.equal(saved.sourceId, 'synthetic-uploaded-txt');
    await approveKnowledgeQuestionAnswer(workspaceId, saved.id, repos);
    const search = await searchKnowledge(workspaceId, 'Pilot Loom Supplies', repos);
    assert.ok(search.chunks.some(c => c.chunkText.includes('Pilot Loom Supplies')), 'approval reaches real searchable knowledge');
    assert.equal((await listKnowledgeQuestionAnswers(workspaceId, repos)).find(q => q.id === saved.id)?.isUserApproved, true);
    const stopped = plainExtractionStopMessage({reason:'no_key'} as Parameters<typeof plainExtractionStopMessage>[0]);
    assert.ok(stopped.includes('completed batches may already be saved'));
    assert.ok(!stopped.includes('Nothing was read'));
    console.log('PASS: offline routed extraction -> source-linked unapproved answers -> owner approval -> searchable knowledge; 1 intercepted provider request, zero paid calls.');
  } finally {
    globalThis.fetch = realFetch;
    if (previousKey === undefined) delete process.env.PLATFORM_DEEPSEEK_API_KEY;
    else process.env.PLATFORM_DEEPSEEK_API_KEY = previousKey;
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
