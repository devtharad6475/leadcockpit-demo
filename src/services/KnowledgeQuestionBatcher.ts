import type { KnowledgeDomain, KnowledgeQuestion } from "@/knowledge/knowledge-question-framework";
import { KNOWLEDGE_QUESTION_FRAMEWORK } from "@/knowledge/knowledge-question-framework";

export const DOCUMENT_QA_BATCH_SIZE = Number(process.env.DOCUMENT_QA_BATCH_SIZE || 999);

export type KnowledgeQuestionWithDomain = KnowledgeQuestion & {
  domainKey: string;
  domainTitle: string;
};

export type KnowledgeQuestionBatch = {
  domainKey: string;
  domainTitle: string;
  batchIndex: number;
  questions: KnowledgeQuestionWithDomain[];
  questionKeys: string[];
};

export function groupQuestionsByDomain(framework: KnowledgeDomain[] = KNOWLEDGE_QUESTION_FRAMEWORK) {
  return framework.map((domain) => ({
    domainKey: domain.domainKey,
    domainTitle: domain.domainTitle,
    questions: domain.questions.map((question) => ({ ...question, domainKey: domain.domainKey, domainTitle: domain.domainTitle })),
  }));
}

export function createQuestionBatches(domain: ReturnType<typeof groupQuestionsByDomain>[number], batchSize = DOCUMENT_QA_BATCH_SIZE): KnowledgeQuestionBatch[] {
  const safeBatchSize = Math.max(1, batchSize || DOCUMENT_QA_BATCH_SIZE);
  const batches: KnowledgeQuestionBatch[] = [];
  for (let index = 0; index < domain.questions.length; index += safeBatchSize) {
    const questions = domain.questions.slice(index, index + safeBatchSize);
    batches.push({
      domainKey: domain.domainKey,
      domainTitle: domain.domainTitle,
      batchIndex: batches.length,
      questions,
      questionKeys: questions.map((question) => question.questionKey),
    });
  }
  return batches;
}

export function createExtractionPlan(framework: KnowledgeDomain[] = KNOWLEDGE_QUESTION_FRAMEWORK, options: { batchSize?: number } = {}) {
  const domains = groupQuestionsByDomain(framework);
  return domains.flatMap((domain) => createQuestionBatches(domain, options.batchSize));
}
