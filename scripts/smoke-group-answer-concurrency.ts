import { getAllKnowledgeQuestions } from "../src/knowledge/knowledge-question-framework";
import { defaultWorkspaceId, mutateData, readData } from "../src/lib/db";
import type { AppData } from "../src/lib/types";
import { answerUnknownQuestionGroup } from "../src/services/AISettingsService";
import { listKnowledgeQuestionAnswers, syncMissingKnowledgeQuestions } from "../src/services/DocumentQuestionAnsweringService";
import { draftStructuredSettingsFromAnswer } from "../src/services/StructuredSettingsDraftService";
import { updatePolicySettings, updateSalesSettings } from "../src/services/SettingsService";
import { syncWorkspaceKnowledge } from "../src/services/SyncKnowledgeService";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function cloneData(data: AppData): AppData {
  return JSON.parse(JSON.stringify(data)) as AppData;
}

async function main() {
  const originalData = cloneData(await readData());
  const workspaceId = defaultWorkspaceId;
  const smokeRunId = `smoke_group_${Date.now()}`;
  const requiredPaymentQuestionKeys = new Set(["payment_methods", "credit_allowed", "credit_period", "advance_payment_rule"]);
  const selectedQuestions = getAllKnowledgeQuestions()
    .filter((question) => question.domainKey === "payment_credit_terms" && requiredPaymentQuestionKeys.has(question.questionKey));

  assert(selectedQuestions.length >= 3, "Smoke needs at least three payment/credit framework questions");

  const syntheticQuestionIds = selectedQuestions.map((_question, index) => `${smokeRunId}_${index + 1}`);

  try {
    await mutateData((data) => {
      data.salesSettings = [];
      data.policySettings = [];
      data.communicationSettings = [];
      data.settingsConflicts = [];
    });

    const answer = [
      "Standard payment is 50% advance and 50% before dispatch.",
      "Catalogue can be shared on WhatsApp before quotation.",
      "Formal quotations are valid for 7 days unless raw material rates change.",
      "Credit terms require owner approval and should not be promised automatically.",
    ].join(" ");

    const result = await answerUnknownQuestionGroup(
      workspaceId,
      syntheticQuestionIds,
      answer,
      true,
      undefined,
      {
        domainKey: "payment_credit_terms",
        relatedQuestionKeys: selectedQuestions.map((question) => question.questionKey),
      },
    );

    assert(result.answeredQuestions === syntheticQuestionIds.length, "Every generated grouped information item should be marked answered");
    assert(result.mappedAnswers === syntheticQuestionIds.length, "Every generated grouped information item should map to an internal question answer");

    await Promise.all([
      ...Array.from({ length: 8 }, () => syncMissingKnowledgeQuestions(workspaceId)),
      ...Array.from({ length: 8 }, () => listKnowledgeQuestionAnswers(workspaceId)),
    ]);

    const answers = await listKnowledgeQuestionAnswers(workspaceId);
    const selectedKeys = new Set(selectedQuestions.map((question) => `${question.domainKey}:${question.questionKey}`));
    const mappedAnswers = answers.filter((item) => selectedKeys.has(`${item.domainKey}:${item.questionKey}`));

    assert(mappedAnswers.length === selectedQuestions.length, "All selected internal question answers should still exist after concurrent reads");
    for (const item of mappedAnswers) {
      assert(item.answerStatus === "answered", `${item.domainKey}/${item.questionKey} should remain answered`);
      assert(item.isUserApproved === true, `${item.domainKey}/${item.questionKey} should remain user-approved`);
      assert(item.sourceType === "user_answer", `${item.domainKey}/${item.questionKey} should keep user-answer source priority`);
      assert(item.answer?.includes("50% advance"), `${item.domainKey}/${item.questionKey} should keep the grouped business answer`);
    }

    const latestUnknowns = await syncMissingKnowledgeQuestions(workspaceId);
    const selectedQuestionKeys = new Set(selectedQuestions.map((question) => `${question.domainKey}:${question.questionKey}`));
    const stillOpen = latestUnknowns.filter((item) =>
      item.status === "open" &&
      item.relatedDomain &&
      item.relatedQuestionKey &&
      selectedQuestionKeys.has(`${item.relatedDomain}:${item.relatedQuestionKey}`)
    );
    assert(stillOpen.length === 0, "Resolved generated grouped information items should not reopen after sync");

    const duplicateGuardQuestion = getAllKnowledgeQuestions()
      .find((question) => question.domainKey === "shipping_delivery" && !selectedQuestionKeys.has(`${question.domainKey}:${question.questionKey}`));
    if (!duplicateGuardQuestion) {
      throw new Error("Smoke needs a shipping/delivery framework question for duplicate reopen guard");
    }
    const duplicateGuard = duplicateGuardQuestion;

    await mutateData((data) => {
      data.unknownQuestions ||= [];
      data.unknownQuestions.push({
        id: `${smokeRunId}_resolved_duplicate_guard`,
        workspaceId,
        channel: "knowledge",
        questionText: duplicateGuard.question,
        missingTopic: duplicateGuard.domainKey.replaceAll("_", " "),
        status: "added_to_knowledge",
        finalAnswer: "Previously resolved through Information Needed.",
        suggestedAnswer: `Framework question: ${duplicateGuard.domainKey}/${duplicateGuard.questionKey}.`,
        generatedBy: "framework",
        relatedDomain: duplicateGuard.domainKey,
        relatedQuestionKey: duplicateGuard.questionKey,
        priority: "high",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    const afterDuplicateGuardSync = await syncMissingKnowledgeQuestions(workspaceId);
    const reopenedDuplicate = afterDuplicateGuardSync.filter((item) =>
      item.status === "open" &&
      item.relatedDomain === duplicateGuard.domainKey &&
      item.relatedQuestionKey === duplicateGuard.questionKey
    );
    assert(reopenedDuplicate.length === 0, "Resolved framework markers should not spawn a new open Information Needed duplicate");

    const preReviewSync = await syncWorkspaceKnowledge(workspaceId);
    assert(preReviewSync.status === "synced" || preReviewSync.status === "partial", "Sync Knowledge should return a usable sync summary");
    assert(preReviewSync.settings.sales.status === "not_configured", "Information Needed answers should not silently become Sales settings before owner review");
    assert(preReviewSync.settings.policy.status === "not_configured", "Information Needed answers should not silently become Policy settings before owner review");
    const knowledgeBaseSync = preReviewSync.knowledgeBase;
    if (!knowledgeBaseSync.synced) {
      throw new Error("Sync Knowledge should create the question-answer knowledge document");
    }
    assert(knowledgeBaseSync.blocksSynced !== undefined && knowledgeBaseSync.blocksSynced >= mappedAnswers.length, "Synced knowledge should include the grouped Information Needed answers");

    const settingsDraft = draftStructuredSettingsFromAnswer({
      domainKey: "payment_credit_terms",
      relatedQuestionKeys: selectedQuestions.map((question) => question.questionKey),
      answer,
    });
    assert(settingsDraft.fields.some((field) => field.area === "sales" && field.fieldKey === "standardCreditPeriod"), "Payment answer should draft a reviewed Sales settings field");
    assert(settingsDraft.fields.some((field) => field.area === "policy" && field.fieldKey === "paymentPolicy"), "Payment answer should draft a reviewed Policy settings field");
    await updateSalesSettings(workspaceId, { workspaceId, ...settingsDraft.sales });
    await updatePolicySettings(workspaceId, { workspaceId, ...settingsDraft.policy });

    const reviewedSync = await syncWorkspaceKnowledge(workspaceId);
    assert(reviewedSync.settings.sales.status === "synced", "Reviewed Sales settings should sync after owner save");
    assert(reviewedSync.settings.policy.status === "synced", "Reviewed Policy settings should sync after owner save");

    const syncedData = await readData();
    const syncedDocument = syncedData.knowledgeBaseDocuments?.find((document) =>
      document.workspaceId === workspaceId &&
      document.documentType === "question_answers" &&
      document.source === "knowledge_question_answers"
    );
    assert(syncedData.salesSettings?.some((settings) => settings.workspaceId === workspaceId && settings.standardCreditPeriod?.includes("50% advance")), "Reviewed Information Needed draft should save Sales settings fields");
    assert(syncedData.policySettings?.some((settings) => settings.workspaceId === workspaceId && settings.paymentPolicy?.includes("50% advance")), "Reviewed Information Needed draft should save Policy settings fields");
    assert(syncedDocument?.contentText.includes("50% advance"), "Synced agent-ready knowledge document should contain the grouped answer");

    console.log(`Grouped Information Needed concurrency and sync smoke passed: ${mappedAnswers.length} internal answers preserved and synced.`);
  } finally {
    await mutateData((data) => {
      Object.assign(data, originalData);
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
