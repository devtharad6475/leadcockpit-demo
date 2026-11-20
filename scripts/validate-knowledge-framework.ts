import { KNOWLEDGE_QUESTION_FRAMEWORK, getAllKnowledgeQuestions } from "../src/knowledge/knowledge-question-framework";

function fail(message: string): never {
  throw new Error(message);
}

const questions = getAllKnowledgeQuestions();
if (questions.length < 400) fail(`Expected at least 400 questions, found ${questions.length}`);
if (!KNOWLEDGE_QUESTION_FRAMEWORK.length) fail("Knowledge framework has no domains");

const seen = new Set<string>();
for (const domain of KNOWLEDGE_QUESTION_FRAMEWORK) {
  if (!domain.questions.length) fail(`${domain.domainKey} has no questions`);
  for (const question of domain.questions) {
    const key = `${domain.domainKey}:${question.questionKey}`;
    if (seen.has(key)) fail(`Duplicate question key: ${key}`);
    seen.add(key);
    if (!question.questionKey || !question.question?.trim()) fail(`${key} is missing question text`);
    if (!question.answerType) fail(`${key} is missing answerType`);
    if (!question.priority) fail(`${key} is missing priority`);
    if (!Array.isArray(question.usedByAgents) || !question.usedByAgents.length) fail(`${key} is missing usedByAgents`);
    if (!Array.isArray(question.mapsTo) || !question.mapsTo.length) fail(`${key} is missing mapsTo`);
    const combined = `${question.questionKey} ${question.question}`.toLowerCase();
    if (combined.includes("todo") || combined.includes("placeholder")) fail(`${key} looks like a TODO/placeholder question`);
  }
}

const counts = KNOWLEDGE_QUESTION_FRAMEWORK.map((domain) => domain.questions.length);
console.log(JSON.stringify({
  status: "ok",
  domains: KNOWLEDGE_QUESTION_FRAMEWORK.length,
  totalQuestions: questions.length,
  minQuestionsPerDomain: Math.min(...counts),
  maxQuestionsPerDomain: Math.max(...counts),
  uniqueQuestionDepths: Array.from(new Set(counts)).sort((a, b) => a - b),
}, null, 2));
