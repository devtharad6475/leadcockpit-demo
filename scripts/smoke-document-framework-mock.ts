import "./smoke-offline-preload";
import nodeAssert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readData, writeData } from "../src/lib/db";
import { getAllKnowledgeQuestions, KNOWLEDGE_QUESTION_FRAMEWORK } from "../src/knowledge/knowledge-question-framework";
import { answerDocumentQuestions } from "../src/services/DocumentQuestionAnsweringService";
import { mapDocumentExtraction, processManualAnswer } from "../src/services/DocumentExtractionMappingService";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const originalData = await readData();
  try {
    const serviceSource = readFileSync("src/services/DocumentExtractionMappingService.ts", "utf8");
    assert(!serviceSource.includes("MasterKnowledgeQuestionnaire"), "Document mapping service must not use the legacy questionnaire");

    const questions = getAllKnowledgeQuestions();
    // N13 retired template padding; prove the complete canonical pool, not an obsolete quota.
    assert(questions.length > 0, "Canonical question pool must not be empty");
    assert(questions.length === KNOWLEDGE_QUESTION_FRAMEWORK.reduce((n, domain) => n + domain.questions.length, 0), "Every canonical domain question must be loaded");
    assert(KNOWLEDGE_QUESTION_FRAMEWORK.every(domain => questions.some(q => q.domainKey === domain.domainKey)), "Every canonical domain must contribute");
    const productQuestion = questions.find((question) => question.domainKey === "product_knowledge") || questions[0];
    const productQuestionId = `${productQuestion.domainKey}/${productQuestion.questionKey}`;
    const documentText = [
      "Company: Example B2B Supplier",
      "Products: modular sample kits, catalogue packs, and custom trade displays.",
      "Payment: advance payment is required for custom trade displays.",
      "Shipping: ready stock dispatch is usually 3 business days after confirmation.",
      "Q: Do you share catalogue?",
      "A: Yes, catalogue can be shared after the buyer shares product interest.",
    ].join("\n");

    const preview = await mapDocumentExtraction({
      workspaceId: "workspace_demo",
      title: "Framework smoke document",
      documentType: "faq",
      contentText: documentText,
    });
    assert(preview.missingQuestions.length > 0, "Document preview should return framework missing questions");
    assert(preview.missingQuestions.every((item) => item.id.includes("/")), "Preview missing questions should use domain/question framework ids");
    assert(preview.missingQuestions.some((item) => item.section.includes("product") || item.section.includes("payment")), "Preview should include business framework sections");

    // The generic mock has no extracted answers. It must fail closed rather than manufacture company facts.
    const beforeAnswers = (await readData()).knowledgeQuestionAnswers || [];
    await nodeAssert.rejects(answerDocumentQuestions({
      workspaceId: "workspace_demo",
      documentText,
      documentMetadata: { title: "Framework smoke document", sourceType: "manual_text" },
    }), /Extraction did not produce usable LLM answers/);
    const afterBlocked = await readData();
    assert((afterBlocked.knowledgeExtractionRuns || []).some(run => run.status === "failed"), "Unusable mock extraction must persist failure evidence");
    assert((afterBlocked.knowledgeQuestionAnswers || []).filter(answer => answer.answerStatus === "answered").length === beforeAnswers.filter(answer => answer.answerStatus === "answered").length, "Unusable mock must not invent answered company knowledge");

    const manual = await processManualAnswer({
      workspaceId: "workspace_demo",
      originalQuestionId: productQuestionId,
      answerText: "The owner confirms the main products are modular sample kits and custom trade displays.",
    });
    assert(manual.answeredCount > 0, "Manual answer mapping should map to framework question ids");
  } finally {
    await writeData(originalData);
  }
}

main().then(() => {
  console.log("Document framework and mock extraction smoke passed.");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
