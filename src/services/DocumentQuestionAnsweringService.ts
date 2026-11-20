import { NeedsActionError } from "@/lib/user-errors";
import { readableCharCount, stripPdfPageMarkers } from "@/lib/pdf-text";
import { isAnswerServable } from "@/lib/knowledge-readiness";
import { chunkByStructure, STRUCTURED_CHUNK_MAX_CHARS } from "@/rag/document-structure";
import { embedChunks } from "@/rag/embed-chunks";
import { timestamp, uid } from "@/lib/db";
import type { AppData, KnowledgeExtractionBatch, KnowledgeExtractionRun, KnowledgeQuestionAnswer, KnowledgeQuestionAnswerStatus } from "@/lib/types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { BUSINESS_KINDS, getAllKnowledgeQuestions, KNOWLEDGE_QUESTION_FRAMEWORK, type KnowledgeDomain, type KnowledgeQuestion, type KnowledgeQuestionWithDomain } from "@/knowledge/knowledge-question-framework";
import { checklistChoiceFor, checklistFactsFrom, checklistFramework, checklistQuestions, type ChecklistChoice } from "@/knowledge/knowledge-sheets";
import { detectKnowledgeConflicts } from "@/services/ConflictDetectionService";
import { LLMService } from "@/llm/LLMService";
import { classifyProviderFailure, ownerFacingFailureText, type ProviderFailure } from "@/llm/provider-failure";
import type { LLMTaskResult } from "@/llm/types";
import { buildDocumentQuestionAnsweringPrompt } from "@/llm/prompts/documentQuestionAnsweringPrompt";
import { createExtractionPlan, DOCUMENT_QA_BATCH_SIZE, type KnowledgeQuestionBatch } from "@/services/KnowledgeQuestionBatcher";
import { TRUNCATED_OUTPUT_MARKER } from "@/llm/providers/OpenAICompatibleProvider";
import { retrieveRelevantDocumentContext } from "@/services/DocumentContextRetrievalService";
import { loadAgentInstructions } from "@/agents/AgentInstructionLoader";
import { mergeExtractedAnswers } from "@/services/KnowledgeAnswerMergeService";
import { detectFactGroupConflicts } from "@/services/KnowledgeFactConflictService";
import { answerStatusRank as compareAnswerStatusRank } from "@/services/KnowledgeAnswerComparisonService";
import { calculateExtractionQuality } from "@/services/ExtractionQualityService";
import { displayLabel } from "@/lib/display-labels";

export type DocumentQuestionAnsweringInput = {
  workspaceId: string;
  documentId?: string;
  documentText: string;
  documentMetadata?: {
    title?: string;
    sourceType?: "document" | "website" | "manual_text";
  };
};

export type ExtractedQuestionAnswer = Omit<KnowledgeQuestionAnswer, "id" | "workspaceId" | "createdAt" | "updatedAt"> & {
  domainTitle: string;
};

export type KnowledgeQuestionAnsweringSummary = {
  run: KnowledgeExtractionRun;
  totalQuestions: number;
  answeredCount: number;
  unansweredCount: number;
  partialCount: number;
  conflictCount: number;
  additionalMissingQuestionsCount: number;
  modelUsed: {
    provider: string;
    modelName?: string;
    slotId?: string;
    mode: "real" | "mock" | "fallback" | "deterministic" | "unknown";
    fallbackUsed?: boolean;
    runId?: string;
    warning?: string;
  };
  domains: Array<{
    domainKey: string;
    domainTitle: string;
    totalQuestions: number;
    answeredCount: number;
    unansweredCount: number;
    conflictCount: number;
  }>;
  answers: KnowledgeQuestionAnswer[];
};

type LLMQuestionAnswer = {
  domainKey?: string;
  questionKey?: string;
  question?: string;
  answer?: string;
  answerStatus?: KnowledgeQuestionAnswerStatus;
  confidenceScore?: number;
  sourceSnippet?: string;
  conflictWithExisting?: boolean;
  conflictReason?: string;
};

type LLMAdditionalMissingQuestion = {
  domainKey?: string;
  questionText?: string;
  reason?: string;
  priority?: "high" | "medium" | "low";
  usedByAgents?: string[];
};

type LLMQuestionAnsweringOutput = {
  answers?: LLMQuestionAnswer[];
  additionalMissingQuestions?: LLMAdditionalMissingQuestion[];
};

type BatchRunResult = Pick<LLMTaskResult<LLMQuestionAnsweringOutput>, "provider" | "modelName" | "slotId" | "mode" | "fallbackUsed" | "warning" | "runId"> & {
  output: LLMQuestionAnsweringOutput;
};
type BatchFailureResult = {
  provider: string;
  modelName?: string;
  slotId?: "daily_workhorse";
  mode: "fallback";
  fallbackUsed: true;
  warning: string;
  output: LLMQuestionAnsweringOutput;
};

const STOPWORDS = new Set([
  "what", "does", "do", "the", "company", "is", "are", "for", "and", "or", "to", "of", "in", "a", "an", "which", "how", "should", "be", "with", "from", "this", "that",
]);

const DOCUMENT_QA_LLM_TIMEOUT_MS = Number(process.env.DOCUMENT_QA_LLM_TIMEOUT_MS || 420000);
const DOCUMENT_QA_MAX_ATTEMPTS = Number(process.env.DOCUMENT_QA_MAX_ATTEMPTS || 2);
/**
 * 2026-09-17 (session 56) — whole-document extraction.
 *
 * Each batch used to see only the five chunks that shared the most keywords
 * with its questions (~6,000 characters). A fact worded differently from the
 * question's keywords never reached the model, however plainly the document
 * stated it. A company's own documents are usually small enough to send whole:
 * the five Om Jari test PDFs are ~52,000 characters (~13,000 tokens), well
 * inside the model's window with room for the questions and instructions.
 *
 * So below this size every batch reads the complete structured document —
 * tables serialised, every chunk labelled with its file and section. Above it,
 * keyword retrieval (with the contradiction sweep) is still used. The prompt
 * puts the document before the per-batch questions so a prefix-caching
 * provider bills it at the cached rate after the first batch.
 *
 * Set DOCUMENT_QA_WHOLE_DOCUMENT_MAX_CHARS=0 to always use retrieval.
 */
const DOCUMENT_QA_WHOLE_DOCUMENT_MAX_CHARS = Number(process.env.DOCUMENT_QA_WHOLE_DOCUMENT_MAX_CHARS ?? 60000);

export type BatchContext = ReturnType<typeof retrieveRelevantDocumentContext> & { mode: "whole_document" | "retrieval" };

/** The structured form of the whole document, or null when it is too big to send whole. */
export function wholeDocumentContext(documentText: string, maxChars = DOCUMENT_QA_WHOLE_DOCUMENT_MAX_CHARS): string | null {
  if (!maxChars || maxChars <= 0) return null;
  const structured = chunkByStructure(documentText).join("\n\n");
  if (!structured || structured.length > maxChars) return null;
  return structured;
}

export function contextForBatch(documentText: string, batch: KnowledgeQuestionBatch, whole: string | null): BatchContext {
  if (whole !== null) {
    return {
      contextText: whole,
      chunksUsed: whole.split("\n\n").length,
      hadRelevantContext: true,
      keywords: [],
      contradictionChunksUsed: 0,
      mode: "whole_document",
    };
  }
  return { ...retrieveRelevantDocumentContext(documentText, batch), mode: "retrieval" };
}

export function extractQuestionAnswersFromText(documentText: string, existingAnswers: KnowledgeQuestionAnswer[] = [], questions: KnowledgeQuestionWithDomain[] = getAllKnowledgeQuestions()): ExtractedQuestionAnswer[] {
  const paragraphs = splitIntoEvidence(documentText);
  const existingByQuestion = new Map(existingAnswers.map((answer) => [`${answer.domainKey}:${answer.questionKey}`, answer]));

  return questions.map((question) => {
    const evidence = findBestEvidence(question.domainKey, question.domainTitle, question.question, paragraphs);
    const existing = existingByQuestion.get(`${question.domainKey}:${question.questionKey}`);
    let answerStatus: KnowledgeQuestionAnswerStatus = "unanswered";
    let answer = "";
    let confidenceScore = 0;
    let conflictWithExisting = false;
    let conflictReason = "";

    if (evidence.score >= 3) {
      answerStatus = question.humanReviewRequired ? "needs_review" : "answered";
      answer = evidence.text;
      confidenceScore = Math.min(0.9, 0.52 + evidence.score * 0.06);
    } else if (evidence.score === 2) {
      answerStatus = "partial";
      answer = evidence.text;
      confidenceScore = 0.46;
    }

    if (existing?.answer && answer) {
      const conflicts = detectKnowledgeConflicts([existing.answer, answer]);
      if (conflicts.length) {
        answerStatus = "conflict";
        conflictWithExisting = true;
        conflictReason = conflicts[0].suggestedQuestion;
        confidenceScore = Math.min(confidenceScore, 0.4);
      }
    }

    return {
      domainKey: question.domainKey,
      domainTitle: question.domainTitle,
      questionKey: question.questionKey,
      question: question.question,
      answer,
      answerStatus,
      sourceType: "document",
      sourceId: undefined,
      confidenceScore,
      usedByAgentsJson: { values: question.usedByAgents },
      mapsToJson: { values: question.mapsTo },
      humanReviewRequired: question.humanReviewRequired,
      sourceSnippet: answer ? answer.slice(0, 420) : undefined,
      conflictWithExisting,
      conflictReason,
    };
  });
}

/**
 * `probe.questionList` — MEASUREMENT ONLY (N13 test 4: the old 424 questions
 * against the checklist on the same documents). No route passes a third
 * argument; the product always asks the workspace's own checklist.
 */
export async function answerDocumentQuestions(
  input: DocumentQuestionAnsweringInput,
  repos: RepositoryBundle = createRepositories(),
  probe?: { questionList: Pick<WorkspaceChecklist, "framework" | "questions"> },
): Promise<KnowledgeQuestionAnsweringSummary> {
  const runSourceType = input.documentMetadata?.sourceType || "document";
  const answerSourceType: KnowledgeQuestionAnswer["sourceType"] = runSourceType === "website" ? "website" : "document";
  const sourceId = input.documentId || uid("doc_source");
  const title = input.documentMetadata?.title || "Uploaded document";
  // K4 (2026-09-27): text that is only PDF page markers ("-- 1 of 3 --") or a
  // file-name header is a scanned or empty document. Say so before anything is
  // recorded, and spend no AI call reading nothing.
  const readable = stripPdfPageMarkers(input.documentText || "").replace(/^[ \t]*(?:Source file:.*|\[Source:.*\])[ \t]*$/gim, "");
  if (readableCharCount(readable) === 0) {
    throw new NeedsActionError("No readable text was found. If this is a scanned PDF (a photo of pages), upload the original document instead.", 400);
  }
  const { existing, checklist } = await repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    return {
      existing: data.knowledgeQuestionAnswers.filter((item) => item.workspaceId === input.workspaceId),
      checklist: workspaceChecklist(input.workspaceId, data),
    };
  });
  const asked = probe?.questionList ?? checklist;
  const deterministic = extractQuestionAnswersFromText(input.documentText, existing, asked.questions).map((item) => ({ ...item, sourceType: answerSourceType, sourceId }));
  const tracking = await createExtractionTracking(input.workspaceId, sourceId, runSourceType, deterministic.length, repos, asked.framework);
  let llmAttempt: Awaited<ReturnType<typeof answerQuestionsWithLLM>>;
  try {
    llmAttempt = await answerQuestionsWithLLM(input, existing, deterministic, tracking.runId, repos, asked);
  } catch (error) {
    const message = error instanceof Error ? error.message : "LLM extraction failed.";
    await markExtractionRunBlocked(input.workspaceId, tracking.runId, sourceId, runSourceType, tracking.totalBatches, "llm", message, repos);
    // K3 (2026-09-27): a key/credit problem is the owner's to fix, already in
    // plain words — pass it on as it is (a 4xx), not wrapped as our failure.
    if (error instanceof NeedsActionError) throw error;
    throw new Error(`Company knowledge extraction stopped because the configured LLM did not complete. ${message}`);
  }
  const extracted = llmAttempt.extracted.map((item) => ({ ...item, sourceType: answerSourceType, sourceId }));
  const additionalMissingQuestions = llmAttempt.additionalMissingQuestions;
  const usefulExtractedCount = extracted.filter((item) => Boolean(item.answer?.trim()) && item.answerStatus !== "unanswered").length;
  if ((llmAttempt.modelUsed.provider === "mock" || llmAttempt.modelUsed.fallbackUsed) && usefulExtractedCount === 0) {
    const blockedMessage = buildBlockedExtractionMessage(llmAttempt.modelUsed.provider, llmAttempt.modelUsed.warning);
    await markExtractionRunBlocked(input.workspaceId, tracking.runId, sourceId, runSourceType, tracking.totalBatches, llmAttempt.modelUsed.provider, blockedMessage, repos);
    throw new NeedsActionError(blockedMessage, 400);
  }

  return repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.knowledgeExtractionRuns ||= [];
    data.unknownQuestions ||= [];
    data.knowledgeBaseDocuments ||= [];
    data.knowledgeBaseChunks ||= [];
    data.auditLogs ||= [];
    data.eventLogs ||= [];

    const now = timestamp();
    const { persisted, summary: mergeSummary } = mergeExtractedAnswers({
      workspaceId: input.workspaceId,
      extractionRunId: tracking.runId,
      sourceType: answerSourceType,
      sourceId,
      sourceTitle: title,
      sourceUrl: runSourceType === "website" ? title.replace(/^Website scan:\s*/i, "") : undefined,
      sourceFileName: runSourceType === "document" ? title : undefined,
      extractedAnswers: extracted,
      data,
      now,
    });

    // N-AI-3 (2026-08-18): mergeExtractedAnswers only compares answers filed
    // under the SAME question key, so two documents that state one real-world
    // fact under two different questions both stay live and unflagged — the
    // measured 5 kg vs 10 kg MOQ defect. This second pass compares canonical
    // answers ACROSS the question keys that describe one fact. It runs here,
    // inside the same mutation, so the flags it sets are visible to the
    // conflictCount below and to the QA document written just after.
    // Deterministic string logic, no LLM call — safe to run on every merge.
    detectFactGroupConflicts({ workspaceId: input.workspaceId, data, now });

    createClarificationQuestions(input.workspaceId, persisted, data.unknownQuestions, workspaceChecklist(input.workspaceId, data).gapKeys);
    createDynamicMissingQuestions(input.workspaceId, sourceId, additionalMissingQuestions, data.unknownQuestions);
    upsertQuestionAnswerDocument(input.workspaceId, sourceId, title, persisted, data);

    const answeredCount = persisted.filter((item) => item.answerStatus === "answered" || item.answerStatus === "needs_review").length;
    const partialCount = persisted.filter((item) => item.answerStatus === "partial").length;
    const conflictCount = persisted.filter((item) => item.answerStatus === "conflict").length;
    const unansweredCount = persisted.filter((item) => item.answerStatus === "unanswered").length;
    const run = data.knowledgeExtractionRuns.find((item) => item.id === tracking.runId) || {
      id: tracking.runId,
      workspaceId: input.workspaceId,
      sourceType: runSourceType,
      sourceId,
      status: "running",
      totalQuestions: persisted.length,
      processedQuestions: 0,
      answeredCount,
      unansweredCount,
      partialCount,
      conflictCount,
      failedBatchCount: 0,
      totalBatches: tracking.totalBatches,
      completedBatches: 0,
      startedAt: tracking.startedAt,
      outputJson: {
        title,
        domains: domainSummaries(persisted),
        modelUsed: llmAttempt.modelUsed,
        additionalMissingQuestionsCount: additionalMissingQuestions.length,
      },
      createdAt: now,
      updatedAt: now,
    } satisfies KnowledgeExtractionRun;
    const batchStats = summarizeBatches(data.knowledgeExtractionBatches || [], tracking.runId);
    Object.assign(run, {
      status: batchStats.failedBatchCount ? "partial" : "completed",
      totalQuestions: persisted.length,
      processedQuestions: persisted.length,
      answeredCount,
      unansweredCount,
      partialCount,
      conflictCount,
      failedBatchCount: batchStats.failedBatchCount,
      totalBatches: tracking.totalBatches,
      completedBatches: batchStats.completedBatches,
      currentDomain: undefined,
      currentBatchIndex: undefined,
      modelProvider: llmAttempt.modelUsed.provider,
      modelName: "modelName" in llmAttempt.modelUsed ? llmAttempt.modelUsed.modelName : undefined,
      fallbackUsed: llmAttempt.modelUsed.fallbackUsed,
      completedAt: now,
      updatedAt: now,
      outputJson: { title, domains: domainSummaries(persisted), modelUsed: llmAttempt.modelUsed, additionalMissingQuestionsCount: additionalMissingQuestions.length, mergeSummary },
    });
    if (!data.knowledgeExtractionRuns.some((item) => item.id === run.id)) data.knowledgeExtractionRuns.push(run);
    data.auditLogs.push({
      id: uid("audit"),
      workspaceId: input.workspaceId,
      actorUserId: "user_owner",
      eventType: "knowledge.extraction.questions_answered",
      entityType: "knowledge_extraction_run",
      entityId: run.id,
      payload: { sourceType: runSourceType, sourceId, answeredCount, unansweredCount, partialCount, conflictCount, modelUsed: llmAttempt.modelUsed, additionalMissingQuestionsCount: additionalMissingQuestions.length, mergeSummary },
      createdAt: now,
      updatedAt: now,
    });
    data.eventLogs.push({
      id: uid("event"),
      workspaceId: input.workspaceId,
      eventType: "knowledge.questions_extracted",
      entityType: "knowledge_extraction_run",
      entityId: run.id,
      payload: { answeredCount, unansweredCount, partialCount, conflictCount, modelUsed: llmAttempt.modelUsed, additionalMissingQuestionsCount: additionalMissingQuestions.length, mergeSummary },
      metadata: {},
      status: "completed",
      createdAt: now,
    });

    return {
      run,
      totalQuestions: persisted.length,
      answeredCount,
      unansweredCount,
      partialCount,
      conflictCount,
      additionalMissingQuestionsCount: additionalMissingQuestions.length,
      modelUsed: llmAttempt.modelUsed,
      domains: domainSummaries(persisted),
      answers: persisted,
    };
  });
}

async function answerQuestionsWithLLM(input: DocumentQuestionAnsweringInput, existingAnswers: KnowledgeQuestionAnswer[], fallbackAnswers: ExtractedQuestionAnswer[], extractionRunId: string, repos: RepositoryBundle, checklist: Pick<WorkspaceChecklist, "framework" | "questions">) {
  // N13: only the checklist's questions are sent to the AI — fewer batches,
  // and none spent on questions that cannot apply to this business.
  const batches = createExtractionPlan(checklist.framework, { batchSize: DOCUMENT_QA_BATCH_SIZE });
  const batchResults: Array<{ result: BatchRunResult | BatchFailureResult; output: { answers: ExtractedQuestionAnswer[] }; batch: KnowledgeQuestionBatch; batchQuestions: KnowledgeQuestionBatch["questions"] }> = [];
  const agentInstructions = await loadAgentInstructions("document_extraction");
  // Built once: identical for every batch, which is also what lets the
  // provider cache it.
  const whole = wholeDocumentContext(input.documentText);
  for (const batch of batches) {
    await assertExtractionNotCanceled(input.workspaceId, extractionRunId, repos);
    const batchQuestions = batch.questions;
    await markBatchRunning(input.workspaceId, extractionRunId, batch, repos);
    const context = contextForBatch(input.documentText, batch, whole);
    // Built per batch rather than once, because a batch that does not fit is
    // SPLIT and each half needs a prompt naming only its own questions.
    const buildPrompt = (forBatch: KnowledgeQuestionBatch) => buildDocumentQuestionAnsweringPrompt({
      documentText: context.contextText,
      questionFramework: [{ domainKey: forBatch.domainKey, domainTitle: forBatch.domainTitle, description: forBatch.domainTitle, questions: forBatch.questions }],
      existingKnowledgeSummary: summarizeExistingAnswers(existingAnswers),
      agentInstructions,
    });
    const result = await runBatchSplitting(input, buildPrompt, batch, context.contextText);
    if (result.ok) {
      const isMockRun = result.result.fallbackUsed || result.result.provider === "mock";
      const output = normalizeLLMQuestionAnswers(result.result.output, existingAnswers, fallbackAnswers, batchQuestions, { isMockRun });
      if (output.valid) {
        if (result.result.fallbackUsed || result.result.provider === "mock") {
          const warning = `Demo/mock extraction used ${result.result.provider}; answers are usable for preview and review, but retry with a real model before production use.`;
          await markBatchCompleted(input.workspaceId, extractionRunId, batch, output.answers, { provider: result.result.provider, modelName: result.result.modelName, status: "fallback", warning }, repos);
          batchResults.push({
            result: {
              ...result.result,
              fallbackUsed: true,
              warning,
              mode: "fallback",
            },
            output,
            batch,
            batchQuestions,
          });
          continue;
        }
        await markBatchCompleted(input.workspaceId, extractionRunId, batch, output.answers, { provider: result.result.provider, modelName: result.result.modelName, status: "completed" }, repos);
        batchResults.push({ result: result.result, output, batch, batchQuestions });
        continue;
      }
      const warning = output.warning || "LLM output validation failed. Retry this batch after the model returns the required JSON schema.";
      await markBatchFailed(input.workspaceId, extractionRunId, batch, { provider: result.result.provider, modelName: result.result.modelName, warning }, repos);
      batchResults.push({ result: failedBatchResult(result.result.provider, result.result.modelName, warning), output: { answers: [] }, batch, batchQuestions });
      continue;
    }
    const accountProblem = extractionStoppingFailure(result.error);
    const warning = accountProblem ? plainExtractionStopMessage(accountProblem) : result.error;
    await markBatchFailed(input.workspaceId, extractionRunId, batch, { provider: "llm", modelName: "configured-model", warning }, repos);
    // K3 (2026-09-27, break test): a rejected key used to be sent again for
    // every question group — 23 groups, each retried — and the run then ended
    // with the provider's raw error JSON as its message and a 500 "our fault".
    // The key will be just as rejected on the next group, so stop at the first
    // one and tell the owner, in the words the health lamp already uses, what
    // to fix.
    if (accountProblem) throw new NeedsActionError(warning, 409);
    batchResults.push({ result: failedBatchResult("llm", "configured-model", warning), output: { answers: [] }, batch, batchQuestions });
  }
  const llmAnswers = batchResults.flatMap((item) => item.output.answers);
  const llmByKey = new Map(llmAnswers.map((answer) => [`${answer.domainKey}:${answer.questionKey}`, answer]));
  const extracted = checklist.questions.map((question) => llmByKey.get(`${question.domainKey}:${question.questionKey}`) || unansweredForQuestion(question)).filter(Boolean) as ExtractedQuestionAnswer[];
  const firstResult = batchResults[0].result;
  const fallbackUsed = batchResults.some((item) => item.result.fallbackUsed);
  return {
    extracted,
    additionalMissingQuestions: normalizeAdditionalMissingQuestions(batchResults.flatMap((item) => item.result.output?.additionalMissingQuestions || [])),
    modelUsed: {
      provider: firstResult.provider,
      modelName: firstResult.modelName,
      slotId: firstResult.slotId,
      mode: (fallbackUsed ? "fallback" : (firstResult.mode || "unknown")) as "real" | "mock" | "fallback" | "deterministic" | "unknown",
      fallbackUsed,
      runId: "runId" in firstResult ? firstResult.runId : undefined,
      warning: summarizeWarnings(batchResults.map((item) => item.result.warning).filter(Boolean) as string[]),
    },
  };
}

/**
 * N-AI-5 (2026-08-18). Build the message an operator sees when an extraction is
 * blocked and nothing usable came back.
 *
 * WHAT WAS WRONG. The message was one hard-coded sentence: *"Extraction did not
 * produce usable LLM answers. Knowledge Base was not changed. Configure and test
 * a real Daily Workhorse model before running company knowledge extraction."*
 * It was emitted whenever `provider === "mock" || fallbackUsed` and zero useful
 * answers came back — but `fallbackUsed` is set for EVERY batch failure, so a
 * run stopped by the AI budget cap reported itself as a broken model
 * configuration. Measured: the Daily Workhorse model was configured, real, and
 * had worked 90 seconds earlier. An operator following that sentence goes and
 * re-checks an API key that was never broken, and never looks at the budget,
 * which is the actual cause.
 *
 * WHY THE FIX IS THIS SMALL. I first recorded this as "the guard cannot tell
 * 'no key' from 'no budget'". That was wrong, and the correction is the whole
 * reason this is four lines rather than a refactor. The real reason is carried
 * faithfully the entire way and then dropped at the last step:
 *   1. `LLMService.runTask` throws the usage reason at LLMService.ts:38 —
 *      BEFORE its try block, so a budget block never reaches the mock-fallback
 *      path. (Which is why the obvious place to look was the wrong one.)
 *   2. `answerQuestionsWithLLM` catches it per batch and stores the real text as
 *      that batch's warning, then `failedBatchResult` sets `fallbackUsed: true`.
 *   3. `summarizeWarnings` deduplicates with a batch count, so twenty blocked
 *      batches collapse to one line ending "(20 batches)".
 *   4. The result is sitting in `modelUsed.warning` — and the old code ignored it.
 *
 * RULES ENCODED HERE
 *  - Name the real blocker first when it is known. That is the sentence the
 *    operator can act on.
 *  - Keep the "configure a real model" advice ONLY when it is actually apt:
 *    the provider really is mock, or we have no reason at all (which preserves
 *    the previous behaviour exactly). Telling someone to fix a model that is
 *    working is how the original bug misdirected them; repeating it alongside
 *    the true reason would soften the true reason for no gain.
 *  - Never invent a cause. No warning means no "Reason:" clause.
 */
export function buildBlockedExtractionMessage(provider: string, warning?: string) {
  const base = "Extraction did not produce usable LLM answers. Knowledge Base was not changed.";
  const advice = "Configure and test a real Daily Workhorse model before running company knowledge extraction.";
  const cause = warning?.trim();
  const parts = [base];
  // K3 (2026-09-27): a provider's own error text is JSON and jargon
  // ({"error":{"type":"authentication_error"...}}), and this message is shown
  // on the extraction panel. A cause the classifier recognises is told in its
  // plain words instead; anything else keeps its text with the JSON removed.
  // A reason with no raw provider reply in it is kept word for word.
  if (cause) parts.push(`Reason: ${ownerFacingFailureText(cause)}`);
  if (provider === "mock" || !cause) parts.push(advice);
  return parts.join(" ");
}

/**
 * K3 (2026-09-27): failures that will fail identically on every remaining
 * question group — the key is missing or rejected, or the account is out of
 * credit. Anything else (a slow reply, a busy provider, a reply too long)
 * may well succeed on the next group, so those still carry on.
 */
export function extractionStoppingFailure(error: string | undefined): ProviderFailure | undefined {
  if (!error) return undefined;
  const failure = classifyProviderFailure(new Error(error));
  return ["invalid_key", "no_key", "out_of_balance"].includes(failure.reason) ? failure : undefined;
}

/** The sentence the owner sees when extraction stopped on a key/credit problem. */
export function plainExtractionStopMessage(failure: ProviderFailure) {
  const lead = failure.reason === "invalid_key"
    ? "Your AI key was rejected — check it in AI Settings."
    : failure.reason === "no_key"
      ? "No AI key is set up yet — add one in AI Settings."
      : "Your AI account has no credit left — top it up with your AI provider.";
  return `${lead} AI analysis stopped before finishing. Uploaded source text and any completed batches may already be saved. Check the extraction status and saved answers before retrying; your existing approved answers are kept.`;
}

function failedBatchResult(provider: string, modelName: string | undefined, warning: string): BatchFailureResult {
  return {
    provider,
    modelName,
    slotId: "daily_workhorse",
    mode: "fallback",
    fallbackUsed: true,
    warning,
    output: { additionalMissingQuestions: [] },
  };
}

function unansweredForQuestion(question: KnowledgeQuestion & { domainKey: string; domainTitle: string }): ExtractedQuestionAnswer {
  return {
    domainKey: question.domainKey,
    domainTitle: question.domainTitle,
    questionKey: question.questionKey,
    question: question.question,
    answer: "",
    answerStatus: "unanswered",
    sourceType: "agent_inference",
    confidenceScore: 0,
    usedByAgentsJson: { values: question.usedByAgents },
    mapsToJson: { values: question.mapsTo },
    humanReviewRequired: question.humanReviewRequired,
  };
}

function summarizeWarnings(warnings: string[]) {
  const unique = Array.from(new Set(warnings.map((warning) => warning.trim()).filter(Boolean)));
  if (!unique.length) return undefined;
  return unique
    .map((warning) => {
      const count = warnings.filter((item) => item.trim() === warning).length;
      return count > 1 ? `${warning} (${count} batches)` : warning;
    })
    .join(" | ");
}

export function normalizeLLMQuestionAnswers(output: LLMQuestionAnsweringOutput | undefined, existingAnswers: KnowledgeQuestionAnswer[], fallbackAnswers: ExtractedQuestionAnswer[], questions = getAllKnowledgeQuestions(), options: { isMockRun?: boolean } = {}) {
  const answers = Array.isArray(output?.answers) ? output.answers : [];
  if (!answers.length) return { valid: false, answers: fallbackAnswers, warning: "LLM returned no answers." };
  // M2.2 / R5 audit fix: when the run was mock mode, every answer's confidence
  // must be honest about being a guess. The previous floor of 0.72 let mock
  // answers sneak past the 0.75 bulk-approve bar with a single nudge. Now mock
  // answers are capped at 0.45; real answers use the LLM's number (clamped
  // via clampConfidence) with a 0.6 floor when the LLM omitted one.
  const isMockRun = options.isMockRun === true;
  const llmByKey = new Map(answers.map((answer) => [`${answer.domainKey}:${answer.questionKey}`, answer]));
  const fallbackByKey = new Map(fallbackAnswers.map((answer) => [`${answer.domainKey}:${answer.questionKey}`, answer]));
  const normalized = questions.map((question) => {
    const key = `${question.domainKey}:${question.questionKey}`;
    const llm = llmByKey.get(key);
    const fallback = fallbackByKey.get(key);
    const answer = cleanKnowledgeAnswerText(String(llm?.answer || "").trim());
    const allowedStatuses: KnowledgeQuestionAnswerStatus[] = ["answered", "unanswered", "partial", "conflict", "needs_review"];
    let answerStatus: KnowledgeQuestionAnswerStatus = allowedStatuses.includes(llm?.answerStatus as KnowledgeQuestionAnswerStatus) ? llm?.answerStatus as KnowledgeQuestionAnswerStatus : "unanswered";
    if (!answer && answerStatus !== "conflict") answerStatus = "unanswered";
    if (answer && question.humanReviewRequired && answerStatus === "answered") answerStatus = "needs_review";
    // N-AI-6 (2026-08-18). A mock/fallback batch's answers are INVENTED, and the
    // person deciding whether to keep them was never told so.
    //
    // WHAT THE REVIEWER SAW BEFORE THIS LINE. The review card shows the status,
    // "45% confidence", the source count, and an Approve button
    // (KnowledgeBaseSection.tsx:352-357). "45%" reads as "the model was unsure",
    // not as "your budget ran out on batch 10 and a stub wrote this sentence".
    // Confidence alone cannot separate those two: the 0.45 cap above is real and
    // works, but a genuine model is free to report 0.45 of its own accord, so the
    // number is not proof of provenance. The truth was recorded per batch
    // (markBatchCompleted(..., status: "fallback", warning) at :334) and simply
    // never reached the human doing the approving.
    //
    // WHY DEMOTING THE STATUS IS THE WHOLE FIX. `needs_review` is not a new
    // concept — the line directly above already uses it for questions flagged
    // humanReviewRequired, and every consumer is already built for it:
    //   - the UI renders the status badge already, so the reviewer is now told;
    //   - `syncKnowledgeQuestionAnswers` (:970-975) turns answers into servable
    //     knowledge chunks only when the status is exactly "answered", so an
    //     invented answer is locked out of customer-facing use EVEN IF someone
    //     approves it by accident — a second, independent lock behind approval;
    //   - `approveKnowledgeQuestionAnswer` (:737-744) sets "answered" explicitly,
    //     so a reviewer who reads it and genuinely wants it can still approve it.
    //     Not a dead end: the good batches of a half-failed run are not thrown
    //     away to punish the bad ones.
    //
    // MEASURED, NOT ASSUMED: `answeredCount` (:223, and :1340/:1353/:1504) counts
    // "answered" OR "needs_review", so this does not zero the run summary or
    // break smoke-document-framework-mock.ts:48. And `usefulExtractedCount`
    // (:179) counts anything that is not "unanswered", so the N-AI-5 blocked-run
    // guard still behaves identically — the two fixes do not interact.
    //
    // Deliberately placed BEFORE the boilerplate/weak-negative checks below: a
    // mock answer that is also boilerplate should end up "unanswered", not
    // "needs_review". Demoting a real answer is never correct here, which is why
    // this is gated on isMockRun and not on confidence.
    if (isMockRun && answer && answerStatus === "answered") answerStatus = "needs_review";
    const sourceSnippet = String(llm?.sourceSnippet || answer || fallback?.sourceSnippet || "").trim();
    if (answer && isBoilerplateOrWrongTopicAnswer(question.question, answer, sourceSnippet)) {
      answerStatus = "unanswered";
    }
    if (answer && shouldDemoteWeakNegativeAnswer(question.question, answer)) {
      answerStatus = "unanswered";
    }
    const finalAnswer = answerStatus === "unanswered" ? "" : answer;
    const conflictWithExisting = Boolean(llm?.conflictWithExisting);
    const conflictReason = String(llm?.conflictReason || "");
    return {
      domainKey: question.domainKey,
      domainTitle: question.domainTitle,
      questionKey: question.questionKey,
      question: question.question,
      answer: finalAnswer,
      answerStatus,
      // Phase 2.6 audit fix: LLM answers are AGENT INFERENCE (priority 20),
      // NOT "document" (priority 50). The LLM interprets the document — it
      // doesn't extract verbatim. Labeling these as "document" let inferred
      // answers override user-approved answers (priority 65) and approved
      // extractions (priority 50). Keeping them at "agent_inference" ensures
      // they can never silently overwrite a higher-priority source.
      sourceType: "agent_inference" as const,
      isUserApproved: false,
      sourceId: undefined,
      confidenceScore: isMockRun
        ? (finalAnswer ? 0.45 : 0)
        : clampConfidence(llm?.confidenceScore, finalAnswer ? 0.6 : 0),
      usedByAgentsJson: { values: question.usedByAgents },
      mapsToJson: { values: question.mapsTo },
      humanReviewRequired: question.humanReviewRequired,
      sourceSnippet: finalAnswer ? sourceSnippet.slice(0, 420) || undefined : undefined,
      conflictWithExisting,
      conflictReason,
    };
  });
  return { valid: normalized.length === questions.length, answers: normalized };
}

function shouldDemoteWeakNegativeAnswer(question: string, answer: string) {
  const lowerQuestion = question.toLowerCase();
  const lowerAnswer = answer.toLowerCase();
  const asksForGap = /(missing|unanswered|not known|not available|gap|still needed|required .* missing|what .* remain)/.test(lowerQuestion);
  if (asksForGap) return false;
  const onlySaysMissing = [
    "not mentioned",
    "not specified",
    "not provided",
    "not stated",
    "no information",
    "does not include",
    "does not specify",
    "does not mention",
    "unclear",
  ].some((phrase) => lowerAnswer.includes(phrase));
  if (!onlySaysMissing) return false;
  const hasPositiveBusinessFact = /(yes|no|allowed|required|available|accepted|manufactures|supplies|located|established|payment|credit|delivery|return|replacement|product|customer|lead|whatsapp|quotation|sample|moq|gst|iec|address|phone|email|website)/.test(lowerAnswer);
  return !hasPositiveBusinessFact || lowerAnswer.length < 140;
}

function normalizeAdditionalMissingQuestions(items: LLMAdditionalMissingQuestion[] | undefined) {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  return items
    .map((item) => ({
      domainKey: String(item.domainKey || "extra_unmapped_information"),
      questionText: String(item.questionText || "").trim(),
      reason: String(item.reason || "The document suggests this information is needed but does not provide it."),
      priority: item.priority || "medium",
      usedByAgents: Array.isArray(item.usedByAgents) ? item.usedByAgents.map(String).filter(Boolean) : ["knowledge_base_agent"],
    }))
    .filter((item) => item.questionText && !seen.has(item.questionText.toLowerCase()) && seen.add(item.questionText.toLowerCase()))
    .slice(0, 80);
}

function isBoilerplateOrWrongTopicAnswer(question: string, answer: string, sourceSnippet: string) {
  const combined = `${answer}\n${sourceSnippet}`.toLowerCase();
  const normalizedQuestion = question.toLowerCase();
  const boilerplatePatterns = [
    /source file:/,
    /master company information document/,
    /internal working draft/,
    /document control note/,
    /this master document should be updated/,
    /compiled from business answers/,
  ];
  if (boilerplatePatterns.some((pattern) => pattern.test(combined))) {
    const asksAboutDocument = /document|file|source|unmapped|extra/.test(normalizedQuestion);
    if (!asksAboutDocument) return true;
  }
  if (/founder|leadership|story/.test(normalizedQuestion) && /credit|payment|dispatch|whatsapp|promotional/.test(combined)) return true;
  if (/support hours|business hours|working hours/.test(normalizedQuestion) && !/(hour|am|pm|morning|evening|monday|sunday|daily|open|closed)/.test(combined)) return true;
  if (/abusive|unsafe|escalation|tone|message length|unknown answer/.test(normalizedQuestion) && /promotional whatsapp\/email messages are currently on hold/.test(combined)) return true;
  if (/certification|award|membership|recognition/.test(normalizedQuestion) && /document control note|updated whenever/.test(combined)) return true;
  return false;
}

function cleanKnowledgeAnswerText(answer: string) {
  if (!answer) return "";
  return answer
    .replace(/\b(according to|as per|based on)\s+(the\s+)?(uploaded\s+)?(file|document|pdf|source)(,|\s+)?/gi, "")
    .replace(/\b(the\s+)?(uploaded\s+)?(file|document|pdf|source)\s+(says|states|mentions|shows|indicates|lists|provides|contains)\s+(that\s+)?/gi, "")
    .replace(/\b(in|from)\s+(the\s+)?(uploaded\s+)?(file|document|pdf|source)(,|\s+)?/gi, "")
    .replace(/\bthis\s+(file|document|pdf|source)\s+(says|states|mentions|shows|indicates)\s+(that\s+)?/gi, "")
    .replace(/\bthe\s+uploaded\s+content\s+(says|states|mentions|shows|indicates|lists|provides|contains)\s+(that\s+)?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,;:\-\s]+/, "")
    .replace(/^that\s+/i, "");
}

// Fixed-choice UI (2026-08-14): the framework knows each question's
// answerType/options; the DB row (KnowledgeQuestionAnswer) doesn't carry
// them. Look them up once per call and stamp them onto each answer so the
// Knowledge Base screen can render a dropdown/Yes-No control instead of a
// free-text box for questions where that matters (see UA-3).
const questionDefinitionByKey = new Map(getAllKnowledgeQuestions().map((question) => [`${question.domainKey}/${question.questionKey}`, question]));

/**
 * N13 (2026-09-25) — the workspace's checklist: the questions its kind of
 * business is asked. Everything that decides what to LOOK FOR (extraction),
 * what is MISSING (stubs, counts) and what to ASK (clarification questions)
 * reads this, never the whole pool. Answers to questions off the checklist are
 * kept and still served; they just stop counting as gaps.
 *
 * Needs `businessProfiles` loaded in the snapshot; the restricted collection
 * lists below include it for that reason.
 */
export type WorkspaceChecklist = {
  choice: ChecklistChoice;
  questions: KnowledgeQuestionWithDomain[];
  framework: KnowledgeDomain[];
  /** "domainKey/questionKey" of every question on the checklist. */
  keys: Set<string>;
  /** The subset that counts as missing when empty (catch-all buckets do not). */
  gapKeys: Set<string>;
};

export function workspaceChecklist(workspaceId: string, data: Pick<AppData, "businessProfiles" | "knowledgeQuestionAnswers">): WorkspaceChecklist {
  const profile = (data.businessProfiles || []).find((item) => item.workspaceId === workspaceId);
  const choice = checklistChoiceFor(checklistFactsFrom(profile, data.knowledgeQuestionAnswers || [], workspaceId));
  const questions = checklistQuestions(choice);
  return {
    choice,
    questions,
    framework: checklistFramework(choice),
    keys: new Set(questions.map((question) => `${question.domainKey}/${question.questionKey}`)),
    gapKeys: new Set(questions.filter((question) => question.countsAsMissing).map((question) => `${question.domainKey}/${question.questionKey}`)),
  };
}

export async function listKnowledgeQuestionAnswers(workspaceId: string, repos: RepositoryBundle = createRepositories()) {
  const read = () => repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    const checklist = workspaceChecklist(workspaceId, data);
    ensureFrameworkAnswerStubs(workspaceId, data.knowledgeQuestionAnswers, checklist.keys);
    compactKnowledgeQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers);
    return { answers: [...canonicalQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers), ...retiredQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers)], keys: checklist.keys };
  });
  // Two reads at once (the Knowledge Base screen loads the answers and the
  // guided blocks together) can both add the same blank row for a question
  // that just joined the checklist; the second then breaks the database's
  // one-row-per-question rule (seen 2026-09-26 after changing the kind of
  // business). By then the other read has added the row, so one retry finds
  // it and adds nothing.
  const { answers, keys } = await read().catch((error: unknown) => {
    if ((error as { code?: string })?.code === "P2002") return read();
    throw error;
  });
  return answers.map((answer) => {
    const definition = questionDefinitionByKey.get(`${answer.domainKey}/${answer.questionKey}`);
    const onChecklist = keys.has(`${answer.domainKey}/${answer.questionKey}`);
    // 2026-09-25 — the screen used to re-implement "safe to approve" with two
    // rules missing (sensitive topics, snippet evidence), so it offered
    // "Approve 13 safe answers" that the server then skipped, forever. The
    // server's own rule is now stamped on each answer and the screen reads it.
    // countsAsMissing: whether a blank answer here counts as "not known yet".
    // The Knowledge Base and the assistant's setup card both count by it, so
    // they show the same numbers (they did not: "59 of 204" vs "57 of 190").
    return { ...answer, answerType: definition?.answerType, options: definition?.options, onChecklist, countsAsMissing: definition ? definition.countsAsMissing !== false : false, safeToBulkApprove: onChecklist && !answer.isUserApproved && isSafeForBulkApproval(answer) };
  });
}

export async function syncMissingKnowledgeQuestions(workspaceId: string, repos: RepositoryBundle = createRepositories()) {
  return repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.unknownQuestions ||= [];
    ensureFrameworkAnswerStubs(workspaceId, data.knowledgeQuestionAnswers, workspaceChecklist(workspaceId, data).keys);
    compactKnowledgeQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers);
    const answers = canonicalQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers);
    const checklist = workspaceChecklist(workspaceId, data);
    createClarificationQuestions(workspaceId, answers, data.unknownQuestions, checklist.gapKeys);
    // N13: open knowledge questions raised under the old 424 for a question
    // this business is no longer asked are kept on file but not shown.
    return data.unknownQuestions
      .filter((item) => item.workspaceId === workspaceId)
      .filter((item) => item.channel !== "knowledge" || !item.relatedDomain || !item.relatedQuestionKey || item.status !== "open" || checklist.keys.has(`${item.relatedDomain}/${item.relatedQuestionKey}`))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export async function answerKnowledgeQuestionFromUnknown(
  workspaceId: string,
  questionText: string,
  finalAnswer: string,
  frameworkMarker?: string,
  relatedDomain?: string,
  relatedQuestionKey?: string,
  repos: RepositoryBundle = createRepositories(),
  /** 2026-09-26 — where the answer came from, shown as its evidence (the
   * owner's own words when the assistant rewrote them into clean wording). */
  evidence?: { snippet: string; title: string },
  /** Wording revisions may replace only the answer the owner reviewed. */
  expectedAnswer?: string,
) {
  if (!finalAnswer.trim()) return undefined;
  return repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    ensureFrameworkAnswerStubs(workspaceId, data.knowledgeQuestionAnswers, workspaceChecklist(workspaceId, data).keys);
    const markerParts = frameworkMarker?.split("/");
    const markerDomain = markerParts?.[0];
    const markerQuestionKey = markerParts?.[1];
    const item = data.knowledgeQuestionAnswers.find((answer) =>
      answer.workspaceId === workspaceId &&
      (
        Boolean(relatedDomain && relatedQuestionKey && answer.domainKey === relatedDomain && answer.questionKey === relatedQuestionKey) ||
        Boolean(markerDomain && markerQuestionKey && answer.domainKey === markerDomain && answer.questionKey === markerQuestionKey) ||
        Boolean(frameworkMarker && knowledgeQuestionMarker(answer) === frameworkMarker) ||
        answer.question.trim().toLowerCase() === questionText.trim().toLowerCase()
      )
    );
    if (!item) return undefined;
    if (expectedAnswer !== undefined && item.answer !== expectedAnswer) return undefined;
    Object.assign(item, {
      answer: finalAnswer.trim(),
      answerStatus: "answered" as KnowledgeQuestionAnswerStatus,
      sourceType: "user_answer" as const,
      confidenceScore: 1,
      isUserApproved: true,
      reviewedByUser: "user_owner",
      reviewedAt: timestamp(),
      isCanonical: true,
      updatedAt: timestamp(),
      // The quote shown under an answer must support THIS answer: a document
      // snippet left from the answer being replaced would read as its proof.
      sourceSnippet: evidence ? evidence.snippet.slice(0, 1000) : undefined,
      ...(evidence ? { sourceTitle: evidence.title } : {}),
    });
    compactKnowledgeQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers);
    resolveMatchingUnknownQuestions(workspaceId, item, data.unknownQuestions ||= [], "user_answer");
    return item;
  });
  // 2026-09-27 (K2): no rebuild of the searchable copy here, on purpose — the
  // callers run this inside a snapshot session, which must not span the
  // embedding call a rebuild makes. Every caller rebuilds once its session has
  // closed: recordSetupAnswer (SetupInterviewService), answerUnknownQuestion and
  // answerUnknownQuestionGroup (AISettingsService).
}

/**
 * N13: answers to questions that are no longer in the pool at all (the retired
 * template questions of the old banks). Kept, best row per question, so the
 * owner can still see and correct what was found. Blank rows are not returned:
 * a question nobody asks any more has no gap to show.
 */
function retiredQuestionAnswers(workspaceId: string, answers: KnowledgeQuestionAnswer[]) {
  const best = new Map<string, KnowledgeQuestionAnswer>();
  for (const item of answers) {
    if (item.workspaceId !== workspaceId || !item.answer?.trim()) continue;
    const key = `${item.domainKey}/${item.questionKey}`;
    if (questionDefinitionByKey.has(key)) continue;
    const held = best.get(key);
    if (!held || answerRank(item) > answerRank(held) || (answerRank(item) === answerRank(held) && item.updatedAt > held.updatedAt)) best.set(key, item);
  }
  return [...best.values()];
}

/** N13: canonical answers to the checklist only — what extraction status counts. */
function checklistAnswers(workspaceId: string, data: AppData) {
  const { keys } = workspaceChecklist(workspaceId, data);
  return canonicalQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers || []).filter((answer) => keys.has(knowledgeQuestionMarker(answer)));
}

/** N13: the workspace's checklist, for callers outside a snapshot mutation. */
export async function getWorkspaceChecklist(workspaceId: string, repos: RepositoryBundle = createRepositories()): Promise<WorkspaceChecklist> {
  return repos.mutateAll!((data) => workspaceChecklist(workspaceId, data), { collections: ["knowledgeQuestionAnswers", "businessProfiles"] });
}

/**
 * The owner confirms or changes which kind of business this is (N13). From
 * then on the checklist follows the owner's choice, never a guess. Answers to
 * questions that drop off the checklist are kept — they just stop counting as
 * missing. Returns a plain problem sentence instead of saving when the choice
 * is invalid.
 */
export async function setWorkspaceChecklist(
  workspaceId: string,
  input: { kinds?: unknown; exports?: unknown },
  repos: RepositoryBundle = createRepositories(),
): Promise<{ problem?: string; checklist?: WorkspaceChecklist }> {
  const raw = Array.isArray(input.kinds) ? input.kinds.map(String) : [];
  const kinds = BUSINESS_KINDS.filter((kind) => raw.includes(kind));
  if (!raw.length) return { problem: "Pick at least one kind of business." };
  if (kinds.length !== new Set(raw).size) return { problem: "One of the kinds of business is not one we know." };
  if (input.exports !== undefined && typeof input.exports !== "boolean") return { problem: "Say yes or no to exports." };
  const fields = { checklistKinds: kinds, checklistExports: input.exports === true, checklistConfirmedAt: new Date().toISOString() };
  const profile = await repos.businessProfile.getByWorkspace(workspaceId);
  // Profile fields are saved through the profile repository: the bulk
  // snapshot writer does not write business profiles.
  if (profile?.id) await repos.businessProfile.update(workspaceId, profile.id, fields);
  else await repos.businessProfile.create({ workspaceId, ...fields });
  return { checklist: await getWorkspaceChecklist(workspaceId, repos) };
}

function canonicalQuestionAnswers(workspaceId: string, answers: KnowledgeQuestionAnswer[]) {
  return getAllKnowledgeQuestions().map((question) => {
    const candidates = answers.filter((item) => item.workspaceId === workspaceId && item.domainKey === question.domainKey && item.questionKey === question.questionKey);
    const ranked = candidates.sort((a, b) =>
      Number(Boolean(b.isCanonical)) - Number(Boolean(a.isCanonical)) ||
      answerRank(b) - answerRank(a) ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    return ranked[0];
  }).filter(Boolean) as KnowledgeQuestionAnswer[];
}

/**
 * N-PERF-3 / audit A-13 (2026-08-25) - one pass instead of 424.
 *
 * ensureFrameworkAnswerStubs and compactKnowledgeQuestionAnswers both walked the
 * 424-question framework and, for EVERY question, scanned the whole
 * knowledgeQuestionAnswers array looking for that question's rows. The array
 * holds every tenant, so at 39 workspaces that is 424 x 13,820 = 5.9 million
 * comparisons per call - and answering a seven-question setup card called them
 * seven times each. Measured: about 0.9 seconds of pure in-memory work per
 * question, on top of the database time.
 *
 * Indexing the array once by (domainKey, questionKey) makes it 13,820 + 424.
 * Nothing about the result changes: buckets are filled in array order, so
 * bucket[0] is exactly what answers.find() returned and the bucket is exactly
 * what answers.filter() returned.
 */
function indexWorkspaceAnswersByQuestion(workspaceId: string, answers: KnowledgeQuestionAnswer[]) {
  const index = new Map<string, KnowledgeQuestionAnswer[]>();
  for (const item of answers) {
    if (item.workspaceId !== workspaceId) continue;
    const key = `${item.domainKey}::${item.questionKey}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(item);
    else index.set(key, [item]);
  }
  return index;
}

function compactKnowledgeQuestionAnswers(workspaceId: string, answers: KnowledgeQuestionAnswer[]) {
  const index = indexWorkspaceAnswersByQuestion(workspaceId, answers);
  for (const question of getAllKnowledgeQuestions()) {
    const candidates = index.get(`${question.domainKey}::${question.questionKey}`) || [];
    const ranked = [...candidates].sort((a, b) => answerRank(b) - answerRank(a) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const best = ranked[0];
    for (const item of candidates) item.isCanonical = item.id === best?.id;
  }
}

function answerRank(answer: KnowledgeQuestionAnswer) {
  return compareAnswerStatusRank(answer.answerStatus, Boolean(answer.answer?.trim()));
}

/**
 * The collections an answer edit actually touches (N16, 2026-09-18).
 *
 * Without this the edit loaded about SIXTY tables to change one row — the
 * behaviour that consumed a month of the hosting plan's data allowance in
 * eighteen days.
 *
 * `auditLogs` is deliberately ABSENT although the mutator appends to it. The
 * snapshot writer upserts, so a row pushed onto an unloaded collection is
 * written and the rows never loaded are left alone. Loading them would mean
 * reading an append-only table that grows forever, to add one line to the end
 * of it. Anything that READS a collection must name it here.
 */
const ANSWER_EDIT_COLLECTIONS = { collections: ["knowledgeQuestionAnswers", "unknownQuestions", "businessProfiles"] } as const;

/** The rebuild reads every servable answer and writes the one searchable document. */
const ANSWER_SYNC_COLLECTIONS = { collections: ["knowledgeQuestionAnswers", "knowledgeBaseDocuments"] } as const;

/**
 * Is this answer one the AI is allowed to serve?
 *
 * Named and shared on purpose. The rebuild below filters on it, and the callers
 * that decide WHETHER to rebuild ask the same question — two copies of this
 * condition would drift, and the day they disagreed an owner would approve an
 * answer that the index quietly refused to include.
 */
function isServableAnswer(item: KnowledgeQuestionAnswer): boolean {
  // K7 (2026-09-27): the rule lives in src/lib/knowledge-readiness.ts so the
  // Knowledge Base screen's "Ready for the AI" count reads the same one.
  return isAnswerServable(item);
}

/**
 * N1 (2026-09-18, session 57) — rebuild the searchable copy after a correction.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * An owner correcting a price changed the ANSWER, and nothing else. The copy
 * the AI actually searches is a separate document rebuilt by
 * `syncKnowledgeQuestionAnswers`, and the only thing that called it was the
 * "Sync Knowledge" button. So between the correction and someone remembering to
 * press that button, the AI went on quoting the old price to customers — and
 * the owner had no way to know, because the screen showed the new one.
 *
 * A correction the product accepts but does not act on is worse than a
 * correction it refuses: the owner believes the problem is fixed.
 *
 * ── WHY IT CANNOT THROW ─────────────────────────────────────────────────────
 * The owner's edit is already saved by the time this runs. Letting a failure
 * here surface as an error would tell them their correction did not save, and
 * the correction is the thing that matters most. It is reported and swallowed;
 * the Sync button remains as the manual rebuild for exactly this case.
 *
 * ── WHY IT IS AFFORDABLE ────────────────────────────────────────────────────
 * The rebuild re-embeds only chunks whose text actually changed (session 56's
 * vector reuse), so one corrected price costs one chunk — a fraction of a
 * paisa — not a re-embedding of the whole knowledge base.
 */
export async function rebuildAnswerSearchIndex(workspaceId: string, repos: RepositoryBundle = createRepositories()): Promise<void> {
  try {
    await syncKnowledgeQuestionAnswers(workspaceId, repos);
  } catch (error) {
    console.error(
      `[knowledge] answer saved, but rebuilding the searchable copy failed for ${workspaceId}: ` +
        `${error instanceof Error ? error.message : String(error)} — press Sync Knowledge to rebuild it.`,
    );
  }
}

export async function updateKnowledgeQuestionAnswer(workspaceId: string, answerId: string, input: Partial<KnowledgeQuestionAnswer>, repos: RepositoryBundle = createRepositories()) {
  // Set inside the mutation, acted on after it: a rebuild has to see the
  // committed row, and it must not run inside a transaction that is still open.
  let searchAffected = false;
  const updated = await repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.auditLogs ||= [];
    const item = data.knowledgeQuestionAnswers.find((answer) => answer.workspaceId === workspaceId && answer.id === answerId);
    if (!item) throw new Error("Knowledge question answer not found");
    // 2026-09-26 (break test): approving a blank answer marked the question
    // answered with nothing in it. Say so instead.
    if (input.answer === undefined && input.isUserApproved && !item.answer?.trim()) {
      throw new NeedsActionError("There is no answer to approve yet. Write the answer first.", 400);
    }
    const previous = { answer: item.answer, answerStatus: item.answerStatus };
    // Taken BEFORE the change, because withdrawing an answer moves the index
    // just as much as adding one: the retracted text has to leave the copy the
    // AI searches, or the correction only half happened.
    const wasServable = isServableAnswer(item);
    // An owner replacing the text has overruled whatever was quoted to justify
    // the old one. Keeping that snippet attached leaves the record claiming a
    // source for a sentence the source never said — and it is what the
    // Knowledge Base screen shows as "where this came from". The evidence
    // trail in evidenceJson is left intact; only the headline snippet, which
    // reads as support for the CURRENT answer, is dropped.
    const answerReplaced = typeof input.answer === "string" && input.answer.trim() !== (item.answer || "").trim();
    if (answerReplaced) item.sourceSnippet = undefined;
    Object.assign(item, {
      answer: input.answer ?? item.answer,
      // Blanking an answer makes it unanswered again (it used to stay "answered").
      answerStatus: input.answerStatus || (input.answer?.trim() ? "answered" : typeof input.answer === "string" ? "unanswered" : item.answerStatus),
      sourceType: input.sourceType || "manual_edit",
      confidenceScore: input.confidenceScore ?? (input.answer ? 1 : item.confidenceScore),
      isUserApproved: input.isUserApproved ?? (typeof input.answer === "string" && !input.answer.trim() ? false : Boolean(input.answer) || item.isUserApproved),
      reviewedByUser: input.reviewedByUser || (input.answer || input.isUserApproved ? "user_owner" : item.reviewedByUser),
      reviewedAt: input.reviewedAt || (input.answer || input.isUserApproved ? timestamp() : item.reviewedAt),
      updatedAt: timestamp(),
    });
    // 2026-09-26 (break test): an answer that says nothing is not an answer.
    // {answer:"", answerStatus:"answered", isUserApproved:true} used to store a
    // blank "approved" answer, and its Information Needed card vanished though
    // nothing was known. "Not applicable" may stay blank — that is a decision.
    if (!item.answer?.trim() && item.answerStatus !== "not_applicable") {
      item.answer = "";
      item.answerStatus = "unanswered";
      item.isUserApproved = false;
    }
    data.auditLogs.push({
      id: uid("audit"),
      workspaceId,
      actorUserId: "user_owner",
      eventType: "knowledge.question_answer.edited",
      entityType: "knowledge_question_answer",
      entityId: item.id,
      payload: { previous, next: { answer: item.answer, answerStatus: item.answerStatus } },
      createdAt: timestamp(),
      updatedAt: timestamp(),
    });
    if (item.answerStatus === "answered" && item.answer?.trim()) {
      resolveMatchingUnknownQuestions(workspaceId, item, data.unknownQuestions ||= [], "manual_edit");
    }
    // Either side being true is a change the AI's searches must see. Both being
    // false is a stub nobody can be answered from, and rebuilding for it would
    // spend an embedding call to produce the identical document.
    searchAffected = wasServable || isServableAnswer(item);
    return item;
  }, ANSWER_EDIT_COLLECTIONS);

  if (searchAffected) await rebuildAnswerSearchIndex(workspaceId, repos);
  return updated;
}

export async function approveKnowledgeQuestionAnswer(workspaceId: string, answerId: string, repos: RepositoryBundle = createRepositories()) {
  return updateKnowledgeQuestionAnswer(workspaceId, answerId, {
    answerStatus: "answered",
    isUserApproved: true,
    reviewedByUser: "user_owner",
    reviewedAt: timestamp(),
  }, repos);
}

export async function approveAllSafeKnowledgeAnswers(workspaceId: string, repos: RepositoryBundle = createRepositories()) {
  const result = await repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.auditLogs ||= [];
    ensureFrameworkAnswerStubs(workspaceId, data.knowledgeQuestionAnswers, workspaceChecklist(workspaceId, data).keys);
    compactKnowledgeQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers);
    const now = timestamp();
    const canonical = canonicalQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers);
    const approved: KnowledgeQuestionAnswer[] = [];
    const skipped: KnowledgeQuestionAnswer[] = [];
    for (const item of canonical) {
      // Already approved: nothing to do, and not counted as "approved" again
      // (the message used to report every approved answer as newly approved).
      if (item.isUserApproved) continue;
      if (isSafeForBulkApproval(item)) {
        item.answerStatus = "answered";
        item.isUserApproved = true;
        item.reviewedByUser = "user_owner";
        item.reviewedAt = now;
        item.updatedAt = now;
        approved.push(item);
        resolveMatchingUnknownQuestions(workspaceId, item, data.unknownQuestions ||= [], "bulk_approval");
      } else {
        skipped.push(item);
      }
    }
    data.auditLogs.push({
      id: uid("audit"),
      workspaceId,
      actorUserId: "user_owner",
      eventType: "knowledge.safe_answers.bulk_approved",
      entityType: "knowledge_question_answer",
      entityId: workspaceId,
      payload: {
        approvedCount: approved.length,
        // 2026-09-27 (K1): which answers the owner approved in this press, so
        // the trail shows each one as owner-approved just as a single approve
        // does. The approval itself (isUserApproved + reviewedAt) is what lifts
        // the answer to owner level — see effectiveAnswerPriority — so a later
        // document can no longer replace it.
        approvedAnswerIds: approved.map((item) => item.id),
        skippedCount: skipped.length,
        skippedSensitiveOrUnsafe: skipped.filter((item) => item.humanReviewRequired || isSensitiveQuestion(item)).length,
      },
      createdAt: now,
      updatedAt: now,
    });
    createClarificationQuestions(workspaceId, canonicalQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers), data.unknownQuestions ||= [], workspaceChecklist(workspaceId, data).gapKeys);
    return {
      status: "completed",
      approvedCount: approved.length,
      skippedCount: skipped.length,
      message: `Approved ${approved.length} safe answers. Skipped ${skipped.length} sensitive, partial, conflict, or unanswered answers.`,
    };
  });

  // ONCE for the whole batch, not once per answer. The rebuild reads every
  // servable answer and writes one document, so doing it per answer would
  // repeat the same whole-knowledge-base write two hundred times to arrive at
  // the identical result — with an embedding call attached to each pass.
  if (result.approvedCount > 0) await rebuildAnswerSearchIndex(workspaceId, repos);
  return result;
}

function isSafeForBulkApproval(item: KnowledgeQuestionAnswer) {
  if (!item.answer?.trim()) return false;
  if (!["answered"].includes(item.answerStatus)) return false;
  if (item.conflictWithExisting || item.answerStatus === "conflict") return false;
  if ((item.confidenceScore || 0) < 0.75) return false;
  if (!item.sourceSnippet && !(item.evidenceJson?.sources || []).some((source) => source.sourceSnippet)) return false;
  if (item.humanReviewRequired || isSensitiveQuestion(item)) return false;
  return true;
}

export function isSensitiveQuestion(item: Pick<KnowledgeQuestionAnswer, "domainKey" | "question" | "questionKey">) {
  const text = `${item.domainKey} ${item.questionKey} ${item.question}`.toLowerCase();
  // 2026-09-27 (K6, break test): a bare `custom` also matched "customer", so
  // 16 plain questions such as "What email address should customers use?"
  // could never be bulk-approved. Custom work (custom, customs, customise /
  // customize and their forms) is matched as a whole word now — letters on
  // either side break the match, underscores in question keys do not.
  return /(price|pricing|payment|credit|refund|return|replacement|delivery|shipping|legal|privacy|warranty|guarantee|claim|gst|iec|license|quotation|sample|discount)/.test(text) ||
    /(?<![a-z])custom(?:s|i[sz](?:e|es|ed|ing|ation|ations))?(?![a-z])/.test(text);
}

function resolveMatchingUnknownQuestions(workspaceId: string, answer: KnowledgeQuestionAnswer, unknownQuestions: NonNullable<AppData["unknownQuestions"]>, resolvedBy: string) {
  const marker = knowledgeQuestionMarker(answer);
  for (const question of unknownQuestions) {
    if (question.workspaceId !== workspaceId || question.status !== "open" || question.channel !== "knowledge") continue;
    const sameRelated = question.relatedDomain === answer.domainKey && question.relatedQuestionKey === answer.questionKey;
    const sameMarker = Boolean(question.suggestedAnswer?.includes(`Framework question: ${marker}.`));
    const sameText = question.questionText.trim().toLowerCase() === answer.question.trim().toLowerCase();
    if (sameRelated || sameMarker || sameText) {
      question.status = "added_to_knowledge";
      question.finalAnswer = answer.answer || "";
      question.suggestedAnswer = `${question.suggestedAnswer || ""}\nResolved by: ${resolvedBy}.`.trim();
      question.updatedAt = timestamp();
    }
  }
}

export async function getKnowledgeExtractionRun(workspaceId: string, runId: string, repos: RepositoryBundle = createRepositories()) {
  return repos.mutateAll!((data) => {
    data.knowledgeExtractionRuns ||= [];
    const run = data.knowledgeExtractionRuns.find((item) => item.workspaceId === workspaceId && item.id === runId) || null;
    if (!run) return null;
    const batches = (data.knowledgeExtractionBatches || []).filter((item) => item.workspaceId === workspaceId && item.extractionRunId === run.id);
    const answers = checklistAnswers(workspaceId, data);
    return enrichExtractionRun(run, batches, answers);
  });
}

export async function listKnowledgeExtractionBatches(workspaceId: string, runId: string, repos: RepositoryBundle = createRepositories()) {
  return repos.mutateAll!((data) => {
    data.knowledgeExtractionBatches ||= [];
    return data.knowledgeExtractionBatches.filter((item) => item.workspaceId === workspaceId && item.extractionRunId === runId);
  });
}

export async function getActiveKnowledgeExtractionStatus(workspaceId: string, repos: RepositoryBundle = createRepositories()) {
  const data = await repos.readAll!();
  const runs = (data.knowledgeExtractionRuns || []).filter((item) => item.workspaceId === workspaceId);
  const activeRun = runs.find((item) => ["pending", "running"].includes(item.status));
  const run = activeRun || runs.at(-1) || null;
  if (!run) {
    return { active: false, run: null, batchSummary: null };
  }
  const batches = (data.knowledgeExtractionBatches || []).filter((item) => item.workspaceId === workspaceId && item.extractionRunId === run.id);
  const completed = batches.filter((item) => ["completed", "fallback", "failed", "canceled"].includes(item.status));
  const completedWithTimes = completed.filter((item) => item.startedAt && item.completedAt);
  const averageBatchMs = completedWithTimes.length
    ? Math.round(completedWithTimes.reduce((sum, item) => sum + (Date.parse(item.completedAt || "") - Date.parse(item.startedAt || "")), 0) / completedWithTimes.length)
    : 0;
  return {
    active: ["pending", "running"].includes(run.status),
    run: enrichExtractionRun(run, batches, checklistAnswers(workspaceId, data)),
    batchSummary: {
      totalBatches: run.totalBatches || batches.length,
      completedBatches: completed.filter((item) => item.status === "completed" || item.status === "fallback").length,
      failedBatches: batches.filter((item) => item.status === "failed").length,
      canceledBatches: batches.filter((item) => item.status === "canceled").length,
      runningBatches: batches.filter((item) => item.status === "running").length,
      realLlmBatches: batches.filter((item) => item.status === "completed" && item.modelProvider && item.modelProvider !== "mock").length,
      fallbackBatches: batches.filter((item) => item.status === "fallback").length + (run.fallbackUsed ? 1 : 0),
      averageBatchMs,
    },
  };
}

function enrichExtractionRun(run: KnowledgeExtractionRun, batches: KnowledgeExtractionBatch[], answers: KnowledgeQuestionAnswer[]) {
  const quality = calculateExtractionQuality({ run, batches, answers });
  const batchSummary = summarizeExtractionBatchDetails(batches);
  return {
    ...run,
    quality,
    batchSummary,
    nextAction: quality.nextAction,
  };
}

function summarizeExtractionBatchDetails(batches: KnowledgeExtractionBatch[]) {
  return {
    totalBatches: batches.length,
    completedBatches: batches.filter((item) => item.status === "completed").length,
    fallbackBatches: batches.filter((item) => item.status === "fallback").length,
    failedBatches: batches.filter((item) => item.status === "failed").length,
    runningBatches: batches.filter((item) => item.status === "running").length,
    batches: batches.map((item) => ({
      id: item.id,
      domainKey: item.domainKey,
      batchIndex: item.batchIndex,
      questionCount: ((item.questionKeysJson?.values as unknown[] | undefined) || []).length,
      status: item.status,
      provider: item.modelProvider,
      modelName: item.modelName,
      latencyMs: item.startedAt && item.completedAt ? Date.parse(item.completedAt) - Date.parse(item.startedAt) : undefined,
      attemptCount: item.attemptCount,
      answeredCount: Number(item.resultJson?.answeredCount || 0),
      partialCount: Number(item.resultJson?.partialCount || 0),
      unansweredCount: Number(item.resultJson?.unansweredCount || 0),
      conflictCount: Number(item.resultJson?.conflictCount || 0),
      errorMessage: item.errorMessage,
    })),
  };
}

export async function retryFailedKnowledgeExtractionBatches(workspaceId: string, runId: string, repos: RepositoryBundle = createRepositories()) {
  return repos.mutateAll!((data) => {
    data.knowledgeExtractionBatches ||= [];
    data.knowledgeExtractionRuns ||= [];
    const now = timestamp();
    const batches = data.knowledgeExtractionBatches.filter((item) => item.workspaceId === workspaceId && item.extractionRunId === runId && item.status === "failed");
    for (const batch of batches) {
      Object.assign(batch, { status: "pending", errorMessage: undefined, updatedAt: now });
    }
    const run = data.knowledgeExtractionRuns.find((item) => item.workspaceId === workspaceId && item.id === runId);
    if (run) Object.assign(run, { status: "partial", failedBatchCount: 0, errorMessage: undefined, updatedAt: now });
    return { status: "queued", retriedBatchCount: batches.length, message: batches.length ? "Failed batches were queued for retry. Run extraction again to process them." : "No failed batches were found." };
  });
}

export async function cancelActiveKnowledgeExtraction(workspaceId: string, repos: RepositoryBundle = createRepositories()) {
  return repos.mutateAll!((data) => {
    data.knowledgeExtractionRuns ||= [];
    data.knowledgeExtractionBatches ||= [];
    data.knowledgeExtractionSourceBundles ||= [];
    const now = timestamp();
    const activeRuns = data.knowledgeExtractionRuns.filter((run) => run.workspaceId === workspaceId && ["pending", "running"].includes(run.status));
    for (const run of activeRuns) {
      Object.assign(run, {
        status: "canceled",
        errorMessage: "Canceled by user.",
        completedAt: now,
        updatedAt: now,
      });
      for (const batch of data.knowledgeExtractionBatches.filter((item) => item.workspaceId === workspaceId && item.extractionRunId === run.id && ["pending", "running"].includes(item.status))) {
        Object.assign(batch, {
          status: "canceled",
          errorMessage: "Canceled by user.",
          completedAt: now,
          updatedAt: now,
        });
      }
      for (const bundle of data.knowledgeExtractionSourceBundles.filter((item) => item.workspaceId === workspaceId && item.extractionRunId === run.id && item.status === "running_extraction")) {
        Object.assign(bundle, {
          status: "canceled",
          errorMessage: "Canceled by user.",
          updatedAt: now,
        });
      }
    }
    return {
      canceled: activeRuns.length > 0,
      canceledRunCount: activeRuns.length,
      message: activeRuns.length ? "Active extraction was canceled. The current provider call may finish first, but no new batches will start." : "No active extraction was running.",
    };
  });
}

export async function syncKnowledgeQuestionAnswers(workspaceId: string, repos: RepositoryBundle = createRepositories()) {
  const prepared = await repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.knowledgeBaseDocuments ||= [];
    data.knowledgeBaseChunks ||= [];
    data.auditLogs ||= [];
    data.eventLogs ||= [];
    const syncedAnswers = data.knowledgeQuestionAnswers.filter((item) => item.workspaceId === workspaceId && isServableAnswer(item));
    const contentText = buildKnowledgeDocumentText(syncedAnswers);
    const now = timestamp();
    let document = data.knowledgeBaseDocuments.find((item) => item.workspaceId === workspaceId && item.documentType === "question_answers" && item.source === "knowledge_question_answers");
    if (!document) {
      document = {
        id: uid("kbd"),
        workspaceId,
        title: "Question-driven company knowledge",
        documentType: "question_answers",
        source: "knowledge_question_answers",
        status: "active",
        contentText,
        metadata: { syncedFrom: "knowledge_question_answers", answerCount: syncedAnswers.length },
        createdAt: now,
        updatedAt: now,
      };
      data.knowledgeBaseDocuments.push(document);
    } else {
      document.contentText = contentText;
      document.metadata = { ...document.metadata, syncedFrom: "knowledge_question_answers", answerCount: syncedAnswers.length };
      document.updatedAt = now;
    }
    data.auditLogs.push({
      id: uid("audit"),
      workspaceId,
      actorUserId: "user_owner",
      eventType: "knowledge.synced",
      entityType: "knowledge_base_document",
      entityId: document.id,
      payload: {
        sectionsSynced: domainSummaries(syncedAnswers).length,
        blocksSynced: syncedAnswers.length,
        skippedConflicts: data.knowledgeQuestionAnswers.filter((item) => item.workspaceId === workspaceId && item.answerStatus === "conflict").length,
        skippedUnapproved: data.knowledgeQuestionAnswers.filter((item) => item.workspaceId === workspaceId && item.answerStatus === "answered" && item.answer?.trim() && !item.isUserApproved).length,
      },
      createdAt: now,
      updatedAt: now,
    });
    data.eventLogs.push({
      id: uid("event"),
      workspaceId,
      eventType: "knowledge.synced",
      entityType: "knowledge_base_document",
      entityId: document.id,
      payload: { blocksSynced: syncedAnswers.length },
      metadata: {},
      status: "completed",
      createdAt: now,
    });
    return {
      status: "synced",
      document,
      contentText,
      syncedAt: now,
      sectionsSynced: domainSummaries(syncedAnswers).length,
      blocksSynced: syncedAnswers.length,
      warnings: data.knowledgeQuestionAnswers.filter((item) => item.workspaceId === workspaceId && ["unanswered", "conflict"].includes(item.answerStatus)).length,
      skippedUnapproved: data.knowledgeQuestionAnswers.filter((item) => item.workspaceId === workspaceId && item.answerStatus === "answered" && item.answer?.trim() && !item.isUserApproved).length,
      agentsAffected: ["knowledge-base-agent", "whatsapp-conversation-agent", "lead-review-agent", "message-generation-agent", "campaign-planning-agent"],
    };
  }, ANSWER_SYNC_COLLECTIONS);

  // N-BUG-3 (2026-09-05). The chunks used to be replaced inside the mutateAll
  // above: filter the document's old ones out of the snapshot, push the new
  // ones. The filter deletes on the JSON substrate and is silently discarded on
  // Postgres, where the snapshot writer is upsert-only — so in production every
  // sync ADDED a complete second copy of the company's knowledge to the index
  // the AI answers out of, and never removed the first. An owner who corrected
  // an answer could still be quoted the old one, and the table grew by a full
  // copy per sync forever. `replaceForDocument` is the repository method that
  // knows how to remove on either substrate.
  //
  // It runs AFTER the mutateAll rather than inside it because a chunk has a
  // foreign key to its document, and on a workspace's FIRST sync that document
  // is created by the block above — it has to be committed before a chunk can
  // point at it.
  //
  // 2026-09-17 (session 56): the chunks are embedded (batched, model-labelled)
  // so approved answers are found by meaning, not only by shared words. This
  // document is rebuilt on every approval, so unchanged chunks keep their old
  // vectors — only the edited text is paid for again.
  const previousChunks = await repos.knowledgeBaseChunk.listByDocument(workspaceId, prepared.document.id);
  const newChunks = await embedChunks(
    workspaceId,
    splitText(prepared.contentText).map((chunkText, index) => ({
      chunkIndex: index,
      chunkText,
      metadata: { source: "knowledge_question_answers", syncedAt: prepared.syncedAt } as Record<string, unknown>,
    })),
    repos,
    previousChunks,
  );
  const chunks = await repos.knowledgeBaseChunk.replaceForDocument(workspaceId, prepared.document.id, newChunks);

  return { ...prepared, chunks };
}

function ensureFrameworkAnswerStubs(workspaceId: string, answers: KnowledgeQuestionAnswer[], checklistKeys?: Set<string>) {
  const now = timestamp();
  const index = indexWorkspaceAnswersByQuestion(workspaceId, answers);
  for (const domainItem of KNOWLEDGE_QUESTION_FRAMEWORK) {
    for (const question of domainItem.questions) {
      const existing = index.get(`${domainItem.domainKey}::${question.questionKey}`)?.[0];
      if (existing) {
        existing.question = question.question;
        existing.usedByAgentsJson = { values: question.usedByAgents };
        existing.mapsToJson = { values: question.mapsTo };
        existing.humanReviewRequired = question.humanReviewRequired;
        existing.isCanonical ??= true;
        if (!existing.evidenceJson && existing.answer?.trim()) {
          existing.evidenceJson = {
            sources: [{
              sourceType: existing.sourceType,
              sourceId: existing.sourceId,
              sourceTitle: existing.sourceTitle,
              sourceUrl: existing.sourceUrl,
              sourceFileName: existing.sourceFileName,
              sourceSnippet: existing.sourceSnippet,
              confidenceScore: existing.confidenceScore,
              answer: existing.answer,
              createdAt: existing.createdAt || now,
            }],
          };
        }
        existing.updatedAt ||= now;
      } else if (!checklistKeys || checklistKeys.has(`${domainItem.domainKey}/${question.questionKey}`)) {
        // N13: a blank row is only created for a question on this business's
        // checklist. A blank row IS a gap, and a gap off the checklist is not one.
        answers.push({
          id: uid("kqa"),
          workspaceId,
          domainKey: domainItem.domainKey,
          questionKey: question.questionKey,
          question: question.question,
          answer: "",
          answerStatus: "unanswered",
          sourceType: "agent_inference",
          confidenceScore: 0,
          usedByAgentsJson: { values: question.usedByAgents },
          mapsToJson: { values: question.mapsTo },
          humanReviewRequired: question.humanReviewRequired,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
}

function createClarificationQuestions(workspaceId: string, answers: KnowledgeQuestionAnswer[], unknownQuestions: NonNullable<import("@/lib/types").AppData["unknownQuestions"]>, gapKeys?: Set<string>) {
  const now = timestamp();
  const resolvedQuestions = new Map(
    answers
      .filter((item) => ["answered", "needs_review"].includes(item.answerStatus) && item.answer)
      .map((item) => [knowledgeQuestionMarker(item), item.answer || "Answered from extracted company knowledge."])
  );
  for (const question of unknownQuestions) {
    const marker = question.suggestedAnswer?.match(/Framework question: ([^.\n]+)/)?.[1];
    const fallbackMarker = `${question.missingTopic?.replaceAll(" ", "_") || ""}/${question.questionText}`;
    const resolvedAnswer = marker ? resolvedQuestions.get(marker) : resolvedQuestions.get(fallbackMarker);
    if (question.workspaceId === workspaceId && question.channel === "knowledge" && question.status === "open" && resolvedAnswer) {
      question.status = "added_to_knowledge";
      question.finalAnswer = resolvedAnswer;
      question.updatedAt = now;
    }
  }
  // N13: a question off the checklist is never asked. A CONFLICT is asked
  // wherever it is — two sources disagreeing is a problem even on a question
  // the business is no longer asked, because the AI can still quote either.
  const needed = answers.filter((item) =>
    item.answerStatus === "conflict" ||
    (["unanswered", "partial"].includes(item.answerStatus) && (!gapKeys || gapKeys.has(knowledgeQuestionMarker(item)))));
  for (const item of needed) {
    const missingTopic = item.domainKey.replaceAll("_", " ");
    const marker = knowledgeQuestionMarker(item);
    const matchingQuestions = unknownQuestions.filter((question) =>
      question.workspaceId === workspaceId &&
      question.channel === "knowledge" &&
      question.questionText === item.question &&
      (question.suggestedAnswer?.includes("Framework question:")
        ? question.suggestedAnswer.includes(`Framework question: ${marker}.`)
        : question.missingTopic === missingTopic)
    );
    const resolvedExisting = matchingQuestions.find((question) => question.status !== "open");
    if (resolvedExisting) {
      for (const question of matchingQuestions) {
        if (question.status !== "open") continue;
        question.status = resolvedExisting.status;
        question.finalAnswer = resolvedExisting.finalAnswer || question.finalAnswer;
        question.updatedAt = now;
      }
      continue;
    }
    const existing = matchingQuestions.find((question) => question.status === "open");
    if (existing) {
      if (!existing.suggestedAnswer?.includes("Framework question:")) {
        // 2026-09-26 — a draft the owner already wrote here is kept; the sync
        // used to overwrite it with its own text on every run. The link to
        // the question lives in relatedDomain / relatedQuestionKey below.
        if (!existing.suggestedAnswer?.trim()) existing.suggestedAnswer = buildClarificationSuggestedAnswer(item, marker);
        existing.generatedBy = item.answerStatus === "conflict" ? "conflict_detection" : "framework";
        existing.relatedDomain = item.domainKey;
        existing.relatedQuestionKey = item.questionKey;
        existing.priority = item.answerStatus === "conflict" || item.humanReviewRequired ? "high" : "medium";
        existing.updatedAt = now;
      }
    } else {
      unknownQuestions.push({
        id: uid("unknown"),
        workspaceId,
        channel: "knowledge",
        questionText: item.question,
        missingTopic,
        status: "open",
        suggestedAnswer: buildClarificationSuggestedAnswer(item, marker),
        generatedBy: item.answerStatus === "conflict" ? "conflict_detection" : "framework",
        relatedDomain: item.domainKey,
        relatedQuestionKey: item.questionKey,
        priority: item.answerStatus === "conflict" || item.humanReviewRequired ? "high" : "medium",
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

function buildClarificationSuggestedAnswer(item: KnowledgeQuestionAnswer, marker: string) {
  if (item.answerStatus === "conflict") {
    return `Framework question: ${marker}. Conflict: ${item.conflictReason || "Conflicting information found."}`;
  }
  if (item.answerStatus === "partial" && item.answer?.trim()) {
    return `Framework question: ${marker}. Partial source answer found, but owner clarification is still needed: ${item.answer.slice(0, 320)}`;
  }
  return `Framework question: ${marker}.`;
}

function knowledgeQuestionMarker(item: Pick<KnowledgeQuestionAnswer, "domainKey" | "questionKey">) {
  return `${item.domainKey}/${item.questionKey}`;
}

function createDynamicMissingQuestions(workspaceId: string, sourceId: string, questions: LLMAdditionalMissingQuestion[], unknownQuestions: NonNullable<import("@/lib/types").AppData["unknownQuestions"]>) {
  const now = timestamp();
  for (const item of normalizeAdditionalMissingQuestions(questions)) {
    const exists = unknownQuestions.some((question) =>
      question.workspaceId === workspaceId &&
      question.status === "open" &&
      question.questionText.toLowerCase() === item.questionText.toLowerCase()
    );
    if (!exists) {
      unknownQuestions.push({
        id: uid("unknown"),
        workspaceId,
        channel: "knowledge",
        questionText: item.questionText,
        missingTopic: `${item.domainKey.replaceAll("_", " ")} / dynamic from document`,
        status: "open",
        suggestedAnswer: `Needed because: ${item.reason} Source: ${sourceId}. Priority: ${item.priority}. Used by: ${item.usedByAgents.join(", ")}`,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

async function createExtractionTracking(workspaceId: string, sourceId: string, sourceType: KnowledgeExtractionRun["sourceType"], totalQuestions: number, repos: RepositoryBundle, framework: KnowledgeDomain[] = KNOWLEDGE_QUESTION_FRAMEWORK) {
  const now = timestamp();
  const runId = uid("kex");
  const plan = createExtractionPlan(framework, { batchSize: DOCUMENT_QA_BATCH_SIZE });
  await repos.mutateAll!((data) => {
    data.knowledgeExtractionRuns ||= [];
    data.knowledgeExtractionBatches ||= [];
    data.knowledgeExtractionRuns.push({
      id: runId,
      workspaceId,
      sourceType,
      sourceId,
      status: "running",
      totalQuestions,
      processedQuestions: 0,
      answeredCount: 0,
      unansweredCount: 0,
      partialCount: 0,
      conflictCount: 0,
      failedBatchCount: 0,
      totalBatches: plan.length,
      completedBatches: 0,
      outputJson: {},
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    for (const batch of plan) {
      data.knowledgeExtractionBatches.push({
        id: uid("keb"),
        workspaceId,
        extractionRunId: runId,
        documentId: sourceId,
        domainKey: batch.domainKey,
        batchIndex: batch.batchIndex,
        questionKeysJson: { values: batch.questionKeys },
        status: "pending",
        attemptCount: 0,
        maxAttempts: DOCUMENT_QA_MAX_ATTEMPTS,
        timeoutMs: DOCUMENT_QA_LLM_TIMEOUT_MS,
        resultJson: {},
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  return { runId, totalBatches: plan.length, completedBatches: 0, failedBatchCount: 0, startedAt: now };
}

async function markExtractionRunBlocked(
  workspaceId: string,
  extractionRunId: string,
  sourceId: string,
  sourceType: KnowledgeExtractionRun["sourceType"],
  totalBatches: number,
  provider: string | undefined,
  errorMessage: string,
  repos: RepositoryBundle
) {
  await repos.mutateAll!((data) => {
    const now = timestamp();
    data.knowledgeExtractionRuns ||= [];
    data.knowledgeExtractionBatches ||= [];
    const run = data.knowledgeExtractionRuns.find((item) => item.id === extractionRunId && item.workspaceId === workspaceId);
    if (run) {
      Object.assign(run, {
        status: "failed",
        sourceType,
        sourceId,
        processedQuestions: 0,
        answeredCount: 0,
        partialCount: 0,
        unansweredCount: 0,
        conflictCount: 0,
        failedBatchCount: totalBatches,
        totalBatches,
        completedBatches: 0,
        modelProvider: provider || "unknown",
        fallbackUsed: true,
        errorMessage,
        completedAt: now,
        updatedAt: now,
        outputJson: { blocked: true, reason: errorMessage },
      });
    }
    for (const batch of data.knowledgeExtractionBatches.filter((item) => item.workspaceId === workspaceId && item.extractionRunId === extractionRunId)) {
      if (batch.status === "pending" || batch.status === "running") {
        Object.assign(batch, {
          status: "failed",
          modelProvider: provider || "unknown",
          errorMessage,
          completedAt: now,
          updatedAt: now,
        });
      }
    }
  });
}

async function assertExtractionNotCanceled(workspaceId: string, extractionRunId: string, repos: RepositoryBundle) {
  const data = await repos.readAll!();
  const run = (data.knowledgeExtractionRuns || []).find((item) => item.workspaceId === workspaceId && item.id === extractionRunId);
  if (run?.status === "canceled") {
    throw new NeedsActionError("Company knowledge extraction was canceled by the user.");
  }
}

async function markBatchRunning(workspaceId: string, extractionRunId: string, batch: KnowledgeQuestionBatch, repos: RepositoryBundle) {
  await repos.mutateAll!((data) => {
    const now = timestamp();
    const item = findBatch(data, workspaceId, extractionRunId, batch);
    if (item) Object.assign(item, { status: "running", startedAt: item.startedAt || now, attemptCount: item.attemptCount + 1, updatedAt: now });
    const run = data.knowledgeExtractionRuns?.find((runItem) => runItem.id === extractionRunId && runItem.workspaceId === workspaceId);
    if (run) Object.assign(run, { currentDomain: batch.domainKey, currentBatchIndex: batch.batchIndex, updatedAt: now });
  });
}

async function markBatchCompleted(workspaceId: string, extractionRunId: string, batch: KnowledgeQuestionBatch, answers: ExtractedQuestionAnswer[], meta: { provider?: string; modelName?: string; status: KnowledgeExtractionBatch["status"]; warning?: string }, repos: RepositoryBundle) {
  await repos.mutateAll!((data) => {
    const now = timestamp();
    data.knowledgeQuestionAnswers ||= [];
    data.unknownQuestions ||= [];
    data.knowledgeBaseDocuments ||= [];
    data.knowledgeBaseChunks ||= [];
    const item = findBatch(data, workspaceId, extractionRunId, batch);
    const run = data.knowledgeExtractionRuns?.find((runItem) => runItem.id === extractionRunId && runItem.workspaceId === workspaceId);
    const sourceId = run?.sourceId || item?.documentId || extractionRunId;
    const sourceType: KnowledgeQuestionAnswer["sourceType"] = run?.sourceType === "website" ? "website" : "document";
    const persisted = persistQuestionAnswersForBatch(workspaceId, sourceId, sourceType, answers, data, now);
    if (item) Object.assign(item, {
      status: meta.status,
      modelProvider: meta.provider,
      modelName: meta.modelName,
      errorMessage: meta.warning,
      resultJson: {
        answeredCount: answers.filter((answer) => ["answered", "needs_review"].includes(answer.answerStatus)).length,
        partialCount: answers.filter((answer) => answer.answerStatus === "partial").length,
        unansweredCount: answers.filter((answer) => answer.answerStatus === "unanswered").length,
        conflictCount: answers.filter((answer) => answer.answerStatus === "conflict").length,
      },
      completedAt: now,
      updatedAt: now,
    });
    const stats = summarizeBatches(data.knowledgeExtractionBatches || [], extractionRunId);
    if (run) Object.assign(run, {
      processedQuestions: stats.processedQuestions,
      completedBatches: stats.completedBatches,
      failedBatchCount: stats.failedBatchCount,
      answeredCount: (run.answeredCount || 0) + persisted.filter((answer) => ["answered", "needs_review"].includes(answer.answerStatus)).length,
      partialCount: (run.partialCount || 0) + persisted.filter((answer) => answer.answerStatus === "partial").length,
      unansweredCount: (run.unansweredCount || 0) + persisted.filter((answer) => answer.answerStatus === "unanswered").length,
      conflictCount: (run.conflictCount || 0) + persisted.filter((answer) => answer.answerStatus === "conflict").length,
      modelProvider: meta.provider || run.modelProvider,
      modelName: meta.modelName || run.modelName,
      fallbackUsed: run.fallbackUsed || meta.status === "fallback",
      updatedAt: now,
    });
    // N-AI-3 (2026-08-18): the batched path persists one batch at a time, so
    // the two answers that state one fact under two different questions land in
    // two different batches. Running the cross-question check per batch would
    // compare half-populated state and could flag a pair that a later batch
    // goes on to correct, leaving a stale flag nobody clears. So it runs ONCE,
    // when the last batch lands — `completedBatches` already counts failed
    // batches, so a run that ends with failures still gets checked instead of
    // silently skipping the check.
    if (run && stats.completedBatches >= (run.totalBatches || 0)) {
      detectFactGroupConflicts({ workspaceId, data, now });
    }

    createClarificationQuestions(workspaceId, persisted, data.unknownQuestions, workspaceChecklist(workspaceId, data).gapKeys);
    // 2026-09-01 (N-UX-12) — was `` `${run.sourceType} question answers` ``,
    // which produced the Knowledge Base document title
    // "manual_text question answers question answers": a raw backend code, and
    // the suffix twice, because upsertQuestionAnswerDocument() appends
    // " question answers" itself. The other caller (line ~221) correctly passes
    // a bare human title, which is the contract this one now follows too.
    if (run) upsertQuestionAnswerDocument(workspaceId, sourceId, displayLabel(run.sourceType), canonicalQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers), data);
  });
}

function persistQuestionAnswersForBatch(workspaceId: string, sourceId: string, sourceType: KnowledgeQuestionAnswer["sourceType"], answers: ExtractedQuestionAnswer[], data: AppData, now = timestamp()) {
  ensureFrameworkAnswerStubs(workspaceId, data.knowledgeQuestionAnswers ||= [], workspaceChecklist(workspaceId, data).keys);
  const { persisted } = mergeExtractedAnswers({
    workspaceId,
    sourceType,
    sourceId,
    extractedAnswers: answers,
    data,
    now,
  });
  compactKnowledgeQuestionAnswers(workspaceId, data.knowledgeQuestionAnswers);
  return persisted;
}

async function markBatchFailed(workspaceId: string, extractionRunId: string, batch: KnowledgeQuestionBatch, meta: { provider?: string; modelName?: string; warning?: string }, repos: RepositoryBundle) {
  await repos.mutateAll!((data) => {
    const now = timestamp();
    const item = findBatch(data, workspaceId, extractionRunId, batch);
    if (item) Object.assign(item, {
      status: "failed",
      modelProvider: meta.provider,
      modelName: meta.modelName,
      errorMessage: meta.warning || "LLM batch failed and was kept for retry.",
      resultJson: {
        answeredCount: 0,
        partialCount: 0,
        unansweredCount: batch.questionKeys.length,
        conflictCount: 0,
      },
      completedAt: now,
      updatedAt: now,
    });
    const run = data.knowledgeExtractionRuns?.find((runItem) => runItem.id === extractionRunId && runItem.workspaceId === workspaceId);
    const stats = summarizeBatches(data.knowledgeExtractionBatches || [], extractionRunId);
    if (run) Object.assign(run, {
      processedQuestions: stats.processedQuestions,
      completedBatches: stats.completedBatches,
      failedBatchCount: stats.failedBatchCount,
      modelProvider: meta.provider || run.modelProvider,
      modelName: meta.modelName || run.modelName,
      errorMessage: meta.warning || run.errorMessage,
      updatedAt: now,
    });
  });
}

function findBatch(data: AppData, workspaceId: string, extractionRunId: string, batch: KnowledgeQuestionBatch) {
  return data.knowledgeExtractionBatches?.find((item) =>
    item.workspaceId === workspaceId &&
    item.extractionRunId === extractionRunId &&
    item.domainKey === batch.domainKey &&
    item.batchIndex === batch.batchIndex
  );
}

function summarizeBatches(batches: KnowledgeExtractionBatch[], extractionRunId: string) {
  const items = batches.filter((item) => item.extractionRunId === extractionRunId);
  const completed = items.filter((item) => ["completed", "fallback", "failed"].includes(item.status));
  return {
    completedBatches: completed.length,
    failedBatchCount: items.filter((item) => item.status === "failed").length,
    processedQuestions: completed.reduce((sum, item) => sum + ((item.questionKeysJson?.values as unknown[] | undefined)?.length || 0), 0),
  };
}

function upsertQuestionAnswerDocument(workspaceId: string, sourceId: string, title: string, answers: KnowledgeQuestionAnswer[], data: AppData) {
  const answered = answers.filter((item) => item.answer && item.answerStatus !== "unanswered");
  if (!answered.length) return;
  const now = timestamp();
  const contentText = buildKnowledgeDocumentText(answered);
  const existing = data.knowledgeBaseDocuments?.find((item) => item.workspaceId === workspaceId && item.source === `question_answering:${sourceId}`);
  if (existing) {
    existing.contentText = contentText;
    existing.updatedAt = now;
    // 2026-09-01 (N-UX-12) — the update path used to leave the title alone, so
    // documents already named "manual_text question answers question answers"
    // would have kept that name forever no matter how many times they were
    // rewritten. Refreshing the title here means the naming fix heals the
    // existing rows on their next update instead of needing a data migration.
    existing.title = `${title} question answers`;
    existing.metadata = { ...existing.metadata, sourceId, questionAnswerCount: answered.length };
  } else {
    data.knowledgeBaseDocuments?.push({
      id: uid("kbd"),
      workspaceId,
      title: `${title} question answers`,
      documentType: "question_answer_extraction",
      source: `question_answering:${sourceId}`,
      status: "active",
      contentText,
      metadata: { sourceId, questionAnswerCount: answered.length },
      createdAt: now,
      updatedAt: now,
    });
  }
}

function findBestEvidence(domainKey: string, domainTitle: string, question: string, paragraphs: string[]) {
  const keywords = keywordSet(`${domainTitle} ${domainKey.replaceAll("_", " ")} ${question}`);
  let best = { text: "", score: 0 };
  for (const paragraph of paragraphs) {
    const normalized = normalize(paragraph);
    let score = 0;
    for (const keyword of keywords) {
      if (normalized.includes(keyword)) score += 1;
    }
    if (score > best.score) best = { text: paragraph, score };
  }
  return best;
}

function keywordSet(text: string) {
  return Array.from(new Set(normalize(text).split(/\s+/).filter((word) => word.length > 3 && !STOPWORDS.has(word)))).slice(0, 14);
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}%:+./\s-]/gu, " ").replace(/\s+/g, " ").trim();
}

function splitIntoEvidence(text: string) {
  const chunks = text.split(/\n{2,}|(?<=[.!?])\s+/).map((item) => item.trim()).filter((item) => item.length > 20);
  return chunks.length ? chunks : [text.trim()].filter(Boolean);
}

function domainSummaries(answers: KnowledgeQuestionAnswer[]) {
  return KNOWLEDGE_QUESTION_FRAMEWORK.map((domainItem) => {
    const items = answers.filter((answer) => answer.domainKey === domainItem.domainKey);
    return {
      domainKey: domainItem.domainKey,
      domainTitle: domainItem.domainTitle,
      totalQuestions: items.length,
      answeredCount: items.filter((item) => ["answered", "needs_review"].includes(item.answerStatus)).length,
      unansweredCount: items.filter((item) => item.answerStatus === "unanswered").length,
      conflictCount: items.filter((item) => item.answerStatus === "conflict").length,
    };
  }).filter((item) => item.totalQuestions > 0);
}

function buildKnowledgeDocumentText(answers: KnowledgeQuestionAnswer[]) {
  return domainSummaries(answers).map((domainItem) => {
    const lines = answers
      .filter((answer) => answer.domainKey === domainItem.domainKey && answer.answer)
      // The source snippet is PROVENANCE — the raw sentence a model read to
      // propose this answer. It is shown on the Knowledge Base screen so an
      // owner can check where an answer came from, and it is deliberately NOT
      // indexed here.
      //
      // It used to be. Every chunk carried "Source snippet: <raw text>", so
      // retrieval matched on text nobody approved, and the agent could quote it
      // back to a customer. On the live demo the owner corrected thirteen
      // answers away from a previous tenant's software catalogue and the
      // snippets stayed: a search for the company's products still returned
      // "Cloud ERP System: A comprehensive enterprise resource planning
      // system", filed under a zari thread manufacturer, from evidence the
      // owner had already overruled. An answer is what the company stands
      // behind; the snippet is only how it was guessed.
      .map((answer) => `Q: ${answer.question}\nA: ${answer.answer}\nStatus: ${answer.answerStatus}\nSource: ${answer.sourceType}`);
    return [`## ${domainItem.domainTitle}`, ...lines].join("\n\n");
  }).join("\n\n");
}

/**
 * 2026-09-17 (session 56): section- and table-aware. This used to pack
 * paragraphs up to 900 characters with no idea what a table or a heading was,
 * so a stored price row could lose the column names that say which quantity
 * band each price is for. See src/rag/document-structure.ts.
 */
function splitText(text: string) {
  const chunks = chunkByStructure(text, STRUCTURED_CHUNK_MAX_CHARS);
  return chunks.length ? chunks : [String(text || "").slice(0, STRUCTURED_CHUNK_MAX_CHARS)];
}

function summarizeExistingAnswers(existingAnswers: KnowledgeQuestionAnswer[]) {
  const answered = existingAnswers.filter((item) => item.answer && ["answered", "needs_review"].includes(item.answerStatus)).slice(0, 80);
  if (!answered.length) return "No existing verified question answers yet.";
  return answered.map((item) => `[${item.domainKey}.${item.questionKey}] ${item.answer}`).join("\n");
}

/**
 * Did this batch fail because the model ran out of room to answer?
 *
 * Matched on the marker the provider throws, which is exported rather than
 * copied — see TRUNCATED_OUTPUT_MARKER.
 */
export function isTruncatedOutputFailure(message: string): boolean {
  return message.includes(TRUNCATED_OUTPUT_MARKER);
}

/**
 * N-EXTRACT (2026-09-18, session 57) — a batch too big to answer is SPLIT,
 * not retried.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * One domain fails on every single extraction run:
 * `extra_unmapped_information`, the catch-all that collects everything the 424
 * questions do not cover. Its seventeen questions are open-ended, the answers
 * are long, and the reply runs past the model's output ceiling. The JSON comes
 * back cut in half and the whole batch is lost.
 *
 * `runBatchWithRetry` then retried the IDENTICAL request twice more. A request
 * that was too long to answer is still too long to answer the second and third
 * time, so all three attempts failed the same way and the workspace was billed
 * for each of them. Seventeen questions were lost on the live system today and
 * on every previous run.
 *
 * ── WHY SPLITTING, AND NOT A BIGGER CEILING ─────────────────────────────────
 * Raising LLM_MAX_OUTPUT_TOKENS moves the wall without removing it, and it
 * cannot go past what the model itself allows. Splitting adapts to whatever the
 * ceiling happens to be.
 *
 * ── WHY IT COSTS NOTHING WHEN IT IS NOT NEEDED ──────────────────────────────
 * The split happens ONLY after a truncation failure. A batch that fits is one
 * request, exactly as before. Cost is a standing constraint here, so recovery
 * that charges every run for a problem that affects one domain would be the
 * wrong trade.
 */
export async function runBatchSplitting(
  input: DocumentQuestionAnsweringInput,
  buildPrompt: (batch: KnowledgeQuestionBatch) => string,
  batch: KnowledgeQuestionBatch,
  contextText: string,
  /**
   * Test seam: the single attempt. Exported with this parameter so a golden can
   * drive the REAL recursion — the splitting, the stopping rule, the merge —
   * without a provider. A test of a hand-written copy of this function would
   * pass while this one was broken.
   */
  runOne: typeof runBatchWithRetry = runBatchWithRetry,
): Promise<{ ok: true; result: BatchRunResult } | { ok: false; error: string }> {
  const attempt = await runOne(input, buildPrompt(batch), batch, contextText);
  if (attempt.ok) return attempt;
  // A single question that still will not fit cannot be split further. Report
  // it rather than recursing forever on the same one.
  if (!isTruncatedOutputFailure(attempt.error) || batch.questions.length < 2) return attempt;

  const middle = Math.ceil(batch.questions.length / 2);
  const halves: KnowledgeQuestionBatch[] = [
    { ...batch, questions: batch.questions.slice(0, middle), questionKeys: batch.questionKeys.slice(0, middle) },
    { ...batch, questions: batch.questions.slice(middle), questionKeys: batch.questionKeys.slice(middle) },
  ];
  console.warn(
    `[extraction] ${batch.domainKey} answer did not fit; splitting ${batch.questions.length} questions into ${halves[0].questions.length} + ${halves[1].questions.length}.`,
  );

  const results: BatchRunResult[] = [];
  for (const half of halves) {
    const outcome = await runBatchSplitting(input, buildPrompt, half, contextText, runOne);
    // One half failing must not discard the other. Half the answers of a domain
    // that previously produced none is the improvement.
    if (outcome.ok) results.push(outcome.result);
    else console.warn(`[extraction] ${batch.domainKey} half failed after splitting: ${outcome.error}`);
  }
  if (!results.length) return attempt;
  return { ok: true, result: mergeBatchResults(results) };
}

/**
 * Joins split halves back into one batch result.
 *
 * Only the answers are merged. Spend needs no adding up here: every half is a
 * separate `LLMService.runTask`, and that is the one place the product meters
 * cost — so each call is already counted against the workspace's cap on its own.
 */
function mergeBatchResults(results: BatchRunResult[]): BatchRunResult {
  const merged = results[0];
  const answers = results.flatMap((item) => item.output?.answers || []);
  return { ...merged, output: { ...merged.output, answers } };
}

async function runBatchWithRetry(input: DocumentQuestionAnsweringInput, prompt: string, batch: KnowledgeQuestionBatch, contextText: string): Promise<{ ok: true; result: BatchRunResult } | { ok: false; error: string }> {
  let lastError = "";
  for (let attempt = 1; attempt <= DOCUMENT_QA_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await withTimeout(
        new LLMService().runTask<LLMQuestionAnsweringOutput>(
          "document_extraction_mapping",
          {
            documentTitle: input.documentMetadata?.title || "Uploaded document",
            documentText: contextText,
            questionCount: batch.questions.length,
            domainKeys: [batch.domainKey],
            batchIndex: batch.batchIndex,
          },
          { workspaceId: input.workspaceId, overridePrompt: prompt, disableFallback: true }
        ),
        DOCUMENT_QA_LLM_TIMEOUT_MS
      );
      return { ok: true, result: { ...result, output: result.output as LLMQuestionAnsweringOutput } };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "LLM batch failed.";
      // Retrying an answer that did not fit produces an answer that does not
      // fit, and bills for it. Hand it straight back so the caller can split it.
      if (isTruncatedOutputFailure(lastError)) break;
      // K3: a rejected key or an empty account will not heal on a retry.
      if (extractionStoppingFailure(lastError)) break;
    }
  }
  return { ok: false, error: lastError || "LLM batch failed after retries." };
}

function clampConfidence(value: unknown, fallback: number) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.min(1, numberValue));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LLM question-answering timed out after ${timeoutMs}ms.`)), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
