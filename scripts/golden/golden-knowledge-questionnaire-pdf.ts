import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { buildKnowledgeQuestionnairePdf } from '@/services/KnowledgeQuestionnairePdfService';
import { KNOWLEDGE_QUESTION_FRAMEWORK } from '@/knowledge/knowledge-question-framework';
import { inspectPdf } from './_helpers/pdf-inspection';
async function main() {
  const pdf = await buildKnowledgeQuestionnairePdf();
  const inspected = await inspectPdf(pdf);
  assert(pdf.subarray(0,8).toString().startsWith('%PDF-1.4'));
  assert(inspected.pages.length >= 1);
  console.log('PASS A: questionnaire is an actual readable PDF');
  for(const domain of KNOWLEDGE_QUESTION_FRAMEWORK) {
    assert(inspected.text.includes(domain.domainTitle),`Missing domain: ${domain.domainTitle}`);
    for(const question of domain.questions) assert(inspected.text.includes(question.question.replace(/\s+/g,' ').trim()),`Missing question: ${question.question}`);
  }
  console.log('PASS B: every complete domain and question survives pagination');
  assert(inspected.text.includes(`Total domains: ${KNOWLEDGE_QUESTION_FRAMEWORK.length}`));
  assert(inspected.text.includes(`Total questions: ${KNOWLEDGE_QUESTION_FRAMEWORK.reduce((sum,domain)=>sum+domain.questions.length,0)}`));
  console.log('PASS C: header totals match actual framework');
  assert(inspected.pages.length >= 2);
  for(const page of inspected.pages) for(const item of page.items.filter(item=>item.text.trim())) assert(item.x >=47.8 && item.x+item.width<=547.6 && item.y>=47.8 && item.y+item.height<=794.3,`Text outside margin: ${JSON.stringify(item)}`);
  console.log('PASS D: large questionnaire paginates inside margins');
  console.log('knowledge-questionnaire-pdf: 4 passed, 0 failed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
