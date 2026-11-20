import { KNOWLEDGE_QUESTION_FRAMEWORK } from "@/knowledge/knowledge-question-framework";
import { buildPdfFromLines } from "@/lib/pdf-writer";

/** Pass the workspace's checklist; the whole-pool default is for tests. */
export async function buildKnowledgeQuestionnairePdf(framework: typeof KNOWLEDGE_QUESTION_FRAMEWORK = KNOWLEDGE_QUESTION_FRAMEWORK) {
  const lines = [
    "# LeadCockpit Knowledge Base Questionnaire",
    `Total domains: ${framework.length}`,
    `Total questions: ${framework.reduce((sum, domain) => sum + domain.questions.length, 0)}`,
    "Use this before onboarding to prepare brochures, policy notes, product details, and business answers.",
    "",
  ];
  for (const domain of framework) {
    lines.push(`## ${domain.domainTitle} (${domain.questions.length} questions)`);
    domain.questions.forEach((question, index) => lines.push(`${index + 1}. ${question.question}`));
    lines.push("");
  }
  return buildPdfFromLines(lines);
}
