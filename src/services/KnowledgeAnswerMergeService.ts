import { timestamp, uid } from "@/lib/db";
import type { AppData, KnowledgeQuestionAnswer, UnknownQuestion } from "@/lib/types";
import type { ExtractedQuestionAnswer } from "@/services/DocumentQuestionAnsweringService";
import { answerStatusRank, compareKnowledgeAnswer, detectContradiction, topicOverlapScore } from "@/services/KnowledgeAnswerComparisonService";

export type KnowledgeMergeSummary = {
  newAnswersAdded: number;
  existingAnswersConfirmed: number;
  partialAnswersImproved: number;
  conflictsFound: number;
  existingAnswersPreserved: number;
  missingQuestionsCreated: number;
  sourceEvidenceAdded: number;
};

export type KnowledgeMergeInput = {
  workspaceId: string;
  extractionRunId?: string;
  sourceType: KnowledgeQuestionAnswer["sourceType"];
  sourceId?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  sourceFileName?: string;
  extractedAnswers: ExtractedQuestionAnswer[];
  data: AppData;
  now?: string;
};

export function mergeExtractedAnswers(input: KnowledgeMergeInput) {
  const now = input.now || timestamp();
  input.data.knowledgeQuestionAnswers ||= [];
  input.data.unknownQuestions ||= [];
  const persisted: KnowledgeQuestionAnswer[] = [];
  const summary: KnowledgeMergeSummary = {
    newAnswersAdded: 0,
    existingAnswersConfirmed: 0,
    partialAnswersImproved: 0,
    conflictsFound: 0,
    existingAnswersPreserved: 0,
    missingQuestionsCreated: 0,
    sourceEvidenceAdded: 0,
  };

  for (const extractedAnswer of input.extractedAnswers) {
    const incoming = normalizeIncomingAnswer(extractedAnswer, input, now);
    const candidates = input.data.knowledgeQuestionAnswers.filter((item) =>
      item.workspaceId === input.workspaceId &&
      item.domainKey === incoming.domainKey &&
      item.questionKey === incoming.questionKey
    );
    const canonical = pickCanonicalAnswer(candidates);

    if (!canonical) {
      const item: KnowledgeQuestionAnswer = {
        id: uid("kqa"),
        workspaceId: input.workspaceId,
        ...incoming,
        isCanonical: true,
        createdAt: now,
        updatedAt: now,
      };
      addEvidence(item, incoming, input, now);
      input.data.knowledgeQuestionAnswers.push(item);
      persisted.push(item);
      if (hasUsefulAnswer(item)) summary.newAnswersAdded += 1;
      continue;
    }

    const comparison = compareKnowledgeAnswer(canonical, incoming);
    if (comparison === "empty") {
      summary.existingAnswersPreserved += hasUsefulAnswer(canonical) ? 1 : 0;
      persisted.push(canonical);
      continue;
    }

    // UA-3/UA-4 fix: "different" (compareKnowledgeAnswer's fallthrough for two
    // useful, non-equivalent, neither-more-specific answers — e.g. "5 kg" vs
    // "10 kg" MOQ) used to fall through the whole chain below to the silent
    // existingAnswersPreserved branch with no owner-visible flag, because
    // detectContradiction's pattern matcher is narrower than "genuinely
    // disagrees." Route it through the same conflict pipeline as a hard
    // contradiction so it's always surfaced, never silently dropped.
    // UA-3 fix: "existing_better" (isAnswerMoreSpecific says the CURRENT
    // answer is longer/more detailed) is usually right to trust — but not
    // when the incoming answer clearly matches the question's topic better
    // than the "better" answer does. Requires >=2 shared topic words on the
    // incoming side (not just 1, which can be a coincidental single-word
    // match — e.g. "service" appearing in both "service provider" and an
    // unrelated "service standard" sentence) AND a strictly higher score
    // than the existing answer. That's the exact pattern that stuck a
    // customer-service SLA paragraph as the permanent answer to "what type
    // of business are you": the correct short answer shares 2 topic words
    // (manufacturer, trader) with the question, the wrong long answer
    // shares only the coincidental "service". Ordinary "existing really is
    // better" cases (both answers on-topic, existing more detailed) don't
    // hit this because the existing side usually scores as high or higher.
    const existingTopicScore = topicOverlapScore(incoming.question, canonical.answer || "");
    const incomingTopicScore = topicOverlapScore(incoming.question, incoming.answer || "");
    const isOffTopicExistingBetter = comparison === "existing_better" &&
      incomingTopicScore >= 2 &&
      incomingTopicScore > existingTopicScore;
    const hardConflict = comparison === "contradiction" || comparison === "different" || isOffTopicExistingBetter || (incoming.answerStatus === "conflict" && detectContradiction(canonical.answer || "", incoming.answer || "", incoming.question));
    if (hardConflict) {
      // Session 8 audit fix: a lower-priority source (e.g. website=40) must
      // NEVER silently downgrade a user-approved answer (user_answer=65,
      // manual_edit=70) to "conflict" status. Before this guard, a website
      // scrape could demote an answer you already approved, forcing you to
      // re-review it. Now: if the canonical is user-approved and the incoming
      // source is not higher priority, preserve the approved status and only
      // create a review suggestion (so you're informed, but your decision
      // stands). The conflict is still recorded as evidence for transparency.
      // 2026-09-27 (K1): compared on the answer's EFFECTIVE priority — an
      // owner-approved answer is owner-level whatever it was first read from.
      const incomingPriority = getKnowledgeSourcePriority(incoming.sourceType);
      const canonicalPriority = effectiveAnswerPriority(canonical);
      if (canonical.isUserApproved && incomingPriority <= canonicalPriority) {
        if (!ownerAlreadyDecided(canonical, incoming, input)) createReviewSuggestion(input.data.unknownQuestions, input, canonical, incoming, now);
        addEvidence(canonical, incoming, input, now);
        summary.existingAnswersPreserved += 1;
        summary.missingQuestionsCreated += 1;
        persisted.push(canonical);
        continue;
      }
      markConflict(canonical, incoming, now);
      createConflictQuestion(input.data.unknownQuestions, input, canonical, incoming, now);
      addEvidence(canonical, incoming, input, now);
      summary.conflictsFound += 1;
      summary.missingQuestionsCreated += 1;
      persisted.push(canonical);
      continue;
    }

    if (comparison === "equivalent") {
      addEvidence(canonical, incoming, input, now);
      canonical.confidenceScore = Math.max(canonical.confidenceScore || 0, incoming.confidenceScore || 0);
      canonical.updatedAt = now;
      summary.existingAnswersConfirmed += 1;
      summary.sourceEvidenceAdded += 1;
      persisted.push(canonical);
      continue;
    }

    if (canonical.isUserApproved && getKnowledgeSourcePriority(incoming.sourceType) <= effectiveAnswerPriority(canonical)) {
      if (!ownerAlreadyDecided(canonical, incoming, input)) createReviewSuggestion(input.data.unknownQuestions, input, canonical, incoming, now);
      addEvidence(canonical, incoming, input, now);
      summary.existingAnswersPreserved += 1;
      summary.missingQuestionsCreated += 1;
      persisted.push(canonical);
      continue;
    }

    if (shouldPromoteIncoming(canonical, incoming, comparison)) {
      addEvidence(canonical, incoming, input, now);
      Object.assign(canonical, {
        answer: incoming.answer,
        answerStatus: incoming.answerStatus,
        sourceType: incoming.sourceType,
        sourceId: incoming.sourceId,
        sourceTitle: incoming.sourceTitle,
        sourceUrl: incoming.sourceUrl,
        sourceFileName: incoming.sourceFileName,
        sourceSnippet: incoming.sourceSnippet,
        confidenceScore: Math.max(canonical.confidenceScore || 0, incoming.confidenceScore || 0),
        isCanonical: true,
        updatedAt: now,
      });
      summary.partialAnswersImproved += comparison === "incoming_more_specific" ? 1 : 0;
      persisted.push(canonical);
      continue;
    }

    addEvidence(canonical, incoming, input, now);
    summary.existingAnswersPreserved += 1;
    persisted.push(canonical);
  }

  return { persisted, summary };
}

export function getKnowledgeSourcePriority(sourceType: KnowledgeQuestionAnswer["sourceType"]) {
  if (sourceType === "manual_edit") return 70;
  if (sourceType === "user_answer") return 65;
  if (sourceType === "whatsapp_unknown") return 60;
  if (sourceType === "document") return 50;
  if (sourceType === "website") return 40;
  if (sourceType === "agent_inference") return 20;
  if (sourceType === "system_generated") return 10;
  return 0;
}

/**
 * 2026-09-27 (K1, break test): "Approve safe answers" keeps the answer's
 * original source ("website", 40), so a later brochure (document, 50) outranked
 * it — the owner's approved answer was silently replaced and still showed as
 * approved, or was knocked down to "conflict" without the owner. Once the
 * owner has approved an answer it sits at owner level (the top of the
 * extraction ladder) whatever it was first read from: a later source can only
 * raise a card for the owner to choose, never replace or demote it.
 */
export const OWNER_APPROVED_PRIORITY = 70;

export function effectiveAnswerPriority(answer: Pick<KnowledgeQuestionAnswer, "sourceType" | "isUserApproved">) {
  const own = getKnowledgeSourcePriority(answer.sourceType);
  return answer.isUserApproved ? Math.max(own, OWNER_APPROVED_PRIORITY) : own;
}

function normalizeIncomingAnswer(extractedAnswer: ExtractedQuestionAnswer, input: KnowledgeMergeInput, now: string): Omit<KnowledgeQuestionAnswer, "id" | "workspaceId" | "createdAt" | "updatedAt"> {
  return {
    ...extractedAnswer,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceTitle: input.sourceTitle,
    sourceUrl: input.sourceUrl,
    sourceFileName: input.sourceFileName,
    evidenceJson: {
      sources: [{
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceTitle: input.sourceTitle,
        sourceUrl: input.sourceUrl,
        sourceFileName: input.sourceFileName,
        sourceSnippet: extractedAnswer.sourceSnippet,
        confidenceScore: extractedAnswer.confidenceScore,
        answer: extractedAnswer.answer,
        extractionRunId: input.extractionRunId,
        createdAt: now,
      }],
    },
  };
}

function pickCanonicalAnswer(candidates: KnowledgeQuestionAnswer[]) {
  const answered = candidates.filter((item) => !item.supersededByAnswerId);
  return answered.sort((a, b) =>
    Number(Boolean(b.isUserApproved)) - Number(Boolean(a.isUserApproved)) ||
    answerStatusRank(b.answerStatus, hasUsefulAnswer(b)) - answerStatusRank(a.answerStatus, hasUsefulAnswer(a)) ||
    getKnowledgeSourcePriority(b.sourceType) - getKnowledgeSourcePriority(a.sourceType) ||
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )[0];
}

function shouldPromoteIncoming(canonical: KnowledgeQuestionAnswer, incoming: Omit<KnowledgeQuestionAnswer, "id" | "workspaceId" | "createdAt" | "updatedAt">, comparison: string) {
  if (!hasUsefulAnswer(incoming)) return false;
  if (!hasUsefulAnswer(canonical)) return true;
  // K1: an owner-approved answer is never replaced by a later source.
  if (canonical.isUserApproved && getKnowledgeSourcePriority(incoming.sourceType) <= effectiveAnswerPriority(canonical)) return false;
  if (comparison === "incoming_more_specific" && canonical.answerStatus !== "answered") return true;
  return getKnowledgeSourcePriority(incoming.sourceType) > effectiveAnswerPriority(canonical) &&
    answerStatusRank(incoming.answerStatus, hasUsefulAnswer(incoming)) >= answerStatusRank(canonical.answerStatus, hasUsefulAnswer(canonical));
}

function addEvidence(target: KnowledgeQuestionAnswer, incoming: Omit<KnowledgeQuestionAnswer, "id" | "workspaceId" | "createdAt" | "updatedAt">, input: KnowledgeMergeInput, now: string) {
  // N-BUG-1 (2026-09-04) — the `||=` alone was not enough. It defends against
  // evidenceJson being absent, but the shape that actually arrived was an
  // object that EXISTS with no `sources` inside it, which sails past the guard
  // and then throws on the line below. Fixed at the source (the Postgres read
  // mapping) too; this stays because this function must not care which
  // substrate handed it the row.
  target.evidenceJson ||= { sources: [] };
  if (!Array.isArray(target.evidenceJson.sources)) target.evidenceJson.sources = [];
  const sourceKey =`${input.sourceType}:${input.sourceId || ""}:${incoming.answer || ""}:${incoming.sourceSnippet || ""}`;
  const exists = target.evidenceJson.sources.some((source) => `${source.sourceType}:${source.sourceId || ""}:${source.answer || ""}:${source.sourceSnippet || ""}` === sourceKey);
  if (!exists) {
    target.evidenceJson.sources.push({
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceTitle: input.sourceTitle,
      sourceUrl: input.sourceUrl,
      sourceFileName: input.sourceFileName,
      sourceSnippet: incoming.sourceSnippet,
      confidenceScore: incoming.confidenceScore,
      answer: incoming.answer,
      extractionRunId: input.extractionRunId,
      createdAt: now,
    });
  }
}

/**
 * 2026-09-26 (break test): the owner settled a disagreement, then the same
 * document was read again (a re-upload, "Extract again") and the very same
 * question came back — every time. The disagreeing answer is already on the
 * approved answer's evidence from when it was first raised; if the owner
 * reviewed the answer after that, they have seen it and chosen. A different
 * figure, or the same figure from another source, is still raised.
 */
function ownerAlreadyDecided(canonical: KnowledgeQuestionAnswer, incoming: Omit<KnowledgeQuestionAnswer, "id" | "workspaceId" | "createdAt" | "updatedAt">, input: KnowledgeMergeInput) {
  if (!canonical.reviewedAt) return false;
  const reviewedAt = new Date(canonical.reviewedAt).getTime();
  const incomingText = (incoming.answer || "").trim().toLowerCase();
  return (canonical.evidenceJson?.sources || []).some((source) =>
    source.sourceType === input.sourceType &&
    (source.sourceId || "") === (input.sourceId || "") &&
    (source.answer || "").trim().toLowerCase() === incomingText &&
    Boolean(source.createdAt) && new Date(String(source.createdAt)).getTime() <= reviewedAt);
}

function markConflict(canonical: KnowledgeQuestionAnswer, incoming: Omit<KnowledgeQuestionAnswer, "id" | "workspaceId" | "createdAt" | "updatedAt">, now: string) {
  canonical.answerStatus = "conflict";
  canonical.conflictWithExisting = true;
  canonical.conflictReason = incoming.conflictReason || `Existing answer and ${incoming.sourceType} answer do not match.`;
  canonical.updatedAt = now;
}

function createConflictQuestion(unknownQuestions: UnknownQuestion[], input: KnowledgeMergeInput, existing: KnowledgeQuestionAnswer, incoming: Omit<KnowledgeQuestionAnswer, "id" | "workspaceId" | "createdAt" | "updatedAt">, now: string) {
  const questionText = `Conflicting information found for: ${existing.question}. Which answer is correct?`;
  if (unknownQuestions.some((item) => item.workspaceId === input.workspaceId && item.questionText === questionText && item.status === "open")) return;
  unknownQuestions.push({
    id: uid("uq"),
    workspaceId: input.workspaceId,
    channel: "knowledge",
    questionText,
    missingTopic: existing.domainKey,
    status: "open",
    suggestedAnswer: `Existing answer: ${existing.answer || "No answer"}\nNew ${incoming.sourceType} answer: ${incoming.answer || "No answer"}`,
    generatedBy: "conflict_detection",
    relatedDomain: existing.domainKey,
    relatedQuestionKey: existing.questionKey,
    conflictSourcesJson: {
      // `question` is the customer-facing question this conflict is about.
      // questionText above is the prompt shown to the owner ("Conflicting
      // information found for: ..."), which must never be stored as the
      // question an answer belongs to.
      question: existing.question,
      existing: { label: "The answer already approved", sourceType: existing.sourceType, sourceId: existing.sourceId, answer: existing.answer },
      incoming: { label: `The new ${incoming.sourceType} answer`, sourceType: incoming.sourceType, sourceId: incoming.sourceId, answer: incoming.answer },
    },
    sourceIds: [existing.sourceId, incoming.sourceId].filter(Boolean) as string[],
    sourceDocumentId: input.sourceId,
    priority: "high",
    createdAt: now,
    updatedAt: now,
  });
}

function createReviewSuggestion(unknownQuestions: UnknownQuestion[], input: KnowledgeMergeInput, existing: KnowledgeQuestionAnswer, incoming: Omit<KnowledgeQuestionAnswer, "id" | "workspaceId" | "createdAt" | "updatedAt">, now: string) {
  const questionText = `A new source has more detail for: ${existing.question}. Should this update the approved answer?`;
  if (unknownQuestions.some((item) => item.workspaceId === input.workspaceId && item.questionText === questionText && item.status === "open")) return;
  unknownQuestions.push({
    id: uid("uq"),
    workspaceId: input.workspaceId,
    channel: "knowledge",
    questionText,
    missingTopic: existing.domainKey,
    status: "open",
    suggestedAnswer: `Approved answer: ${existing.answer || "No answer"}\nNew ${incoming.sourceType} answer: ${incoming.answer || "No answer"}`,
    generatedBy: "conflict_detection",
    relatedDomain: existing.domainKey,
    relatedQuestionKey: existing.questionKey,
    // Carried for the same reason as the hard-conflict path: the owner is being
    // asked to CHOOSE, so the screen needs the two answers apart, not only the
    // side-by-side sentence it renders for reading.
    conflictSourcesJson: {
      question: existing.question,
      existing: { label: "Keep the approved answer", sourceType: existing.sourceType, sourceId: existing.sourceId, answer: existing.answer },
      incoming: { label: `Use the new ${incoming.sourceType} answer`, sourceType: incoming.sourceType, sourceId: incoming.sourceId, answer: incoming.answer },
    },
    sourceIds: [existing.sourceId, incoming.sourceId].filter(Boolean) as string[],
    sourceDocumentId: input.sourceId,
    priority: "medium",
    createdAt: now,
    updatedAt: now,
  });
}

function hasUsefulAnswer(answer: Pick<KnowledgeQuestionAnswer, "answer" | "answerStatus">) {
  return Boolean(answer.answer?.trim()) && !["unanswered", "not_applicable"].includes(answer.answerStatus);
}
