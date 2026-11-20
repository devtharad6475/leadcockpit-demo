/**
 * Golden test — answering a conflict files the customer's question, and the
 * owner's chosen answer, not the prompt and not both sides.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo while clearing a real 59-item review queue, not by a
 * test.
 *
 * When two sources disagree, the merge service raises an item whose
 * questionText is a PROMPT addressed to the owner — "A new source has more
 * detail for: <question>. Should this update the approved answer?" — and whose
 * suggestedAnswer is a COMPARISON of the two candidates, "Approved answer: ...
 * New document answer: ...".
 *
 * Two things then went wrong, and they compounded:
 *
 *   1. The screen prefilled the answer box with that comparison. "Save and let
 *      the AI use it" is the button an owner presses, so the default action
 *      wrote the comparison itself into the knowledge base as the company's
 *      position — keeping the wrong half of a conflict the product had just
 *      correctly detected. On the demo this happened to six payment and credit
 *      answers, which then read "Approved answer: The credit period is Net-30
 *      for approved enterprise clients. New document answer: Credit of 30 days
 *      is available only to buyers with six months of clean payment history."
 *      in a workspace that sells zari thread and offers no Net-30.
 *
 *   2. answerUnknownQuestion filed the resulting FAQ document under
 *      question.questionText — the prompt. The knowledge base filled with
 *      documents titled "Answer: A new source has more detail for: ...", every
 *      one of them retrieved at reply time, none of them a question a customer
 *      would ask. The real question was on the record the whole time.
 *
 *   CASE A — the raised item carries the two answers apart, and the customer's
 *     question, so the screen can offer a choice instead of a paragraph.
 *
 *   CASE B — behavioural, and the one that matters: answering files the FAQ
 *     document under the CUSTOMER's question, not the owner-facing prompt.
 *
 *   CASE C — behavioural: the stored answer is exactly what the owner chose.
 *     Nothing re-attaches the side they rejected.
 *
 *   CASE D — static: the screen no longer prefills a conflict with the
 *     comparison, and offers the sides as choices.
 *
 * Substrate: runs on whichever provider the suite selects. No network, no AI.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createRepositories } from "@/repositories";
import { defaultWorkspaceId } from "@/lib/db";
import type { AppData, KnowledgeQuestionAnswer } from "@/lib/types";
import { mergeExtractedAnswers } from "@/services/KnowledgeAnswerMergeService";
import type { ExtractedQuestionAnswer } from "@/services/DocumentQuestionAnsweringService";
import { answerUnknownQuestion } from "@/services/AISettingsService";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const WS = defaultWorkspaceId;
const SCREEN = "src/app/sections/NeedsYou.tsx";

const CUSTOMER_QUESTION = "Is credit allowed?";
const APPROVED = "Credit is allowed to every buyer on Net-30 terms.";
const INCOMING = "Credit is not allowed. Every order is prepaid before dispatch.";

const NOW = "2026-09-09T00:00:00.000Z";

/** Raises a review item the way the extraction pipeline does, and returns it. */
function raiseCard(existingSourceType: string, isUserApproved: boolean, incomingSourceType: string) {
  const stored = {
    id: "kqa_golden_credit",
    workspaceId: WS,
    domainKey: "payment_credit_terms",
    questionKey: "credit_allowed",
    question: CUSTOMER_QUESTION,
    answer: APPROVED,
    answerStatus: "answered",
    sourceType: existingSourceType,
    confidenceScore: 0.9,
    humanReviewRequired: false,
    isUserApproved,
    isCanonical: true,
    conflictWithExisting: false,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as KnowledgeQuestionAnswer;

  const data = { knowledgeQuestionAnswers: [stored], unknownQuestions: [] } as unknown as AppData;
  mergeExtractedAnswers({
    workspaceId: WS,
    sourceType: incomingSourceType as never,
    sourceId: "ksb_golden_conflict",
    sourceTitle: "Om Jari payment and credit policy",
    extractedAnswers: [{
      domainTitle: "Payment and credit terms",
      domainKey: "payment_credit_terms",
      questionKey: "credit_allowed",
      question: CUSTOMER_QUESTION,
      answer: INCOMING,
      answerStatus: "answered",
      sourceType: incomingSourceType,
      confidenceScore: 0.95,
      humanReviewRequired: false,
      isUserApproved: false,
      isCanonical: true,
      conflictWithExisting: false,
      sourceSnippet: INCOMING,
    } as unknown as ExtractedQuestionAnswer],
    data,
    now: NOW,
  });

  const raised = (data.unknownQuestions || [])
    .filter((entry) => entry.relatedQuestionKey === "credit_allowed" && entry.generatedBy === "conflict_detection");
  assert(raised.length === 1, `setup: expected one raised item, got ${raised.length}`);
  return raised[0];
}

async function main() {
  console.log("=== GOLDEN: a conflict is answered by choosing, and filed under the real question ===\n");
  const repos = createRepositories();

  // knowledgeQuestionAnswers have no repository of their own — the merge is a
  // pure function over the workspace snapshot, so the card is raised the same
  // way the extraction pipeline raises it.
  const conflictCard = raiseCard("document", false, "document");
  const reviewCard = raiseCard("manual_edit", true, "website");

  // Persist it the way the pipeline does, so the answer path reads a real record.
  const item = await repos.unknownQuestion.create(WS, {
    ...conflictCard,
    id: undefined,
    workspaceId: WS,
  } as never);

  // ---------------------------------------------------------------- CASE A
  {
    const sources = item.conflictSourcesJson as
      | { question?: string; existing?: { answer?: string; label?: string }; incoming?: { answer?: string; label?: string } }
      | undefined;
    assert(sources, "CASE A: the raised item must carry conflictSourcesJson, or the screen has nothing to offer as a choice");
    assert(
      sources.question === CUSTOMER_QUESTION,
      `CASE A: the customer's question must be carried, got ${JSON.stringify(sources.question)}`,
    );
    assert(sources.existing?.answer === APPROVED, "CASE A: the approved answer must be carried on its own");
    assert(sources.incoming?.answer === INCOMING, "CASE A: the incoming answer must be carried on its own");
    assert(
      Boolean(sources.existing?.label?.trim()) && Boolean(sources.incoming?.label?.trim()),
      "CASE A: each side needs a label, or the owner cannot tell which one they are picking",
    );
    assert(
      item.questionText !== CUSTOMER_QUESTION,
      "CASE A: this test is meaningless unless questionText really is the owner-facing prompt",
    );

    // The softer path — a new source disagreeing with an answer the owner
    // approved — is the one that raised most of the demo's queue, so it has to
    // carry the same thing. It did not: it shipped with no conflictSourcesJson
    // at all, which is why that screen had nothing to offer but the paragraph.
    const review = reviewCard.conflictSourcesJson as
      | { question?: string; existing?: { answer?: string }; incoming?: { answer?: string } }
      | undefined;
    assert(review, "CASE A: a review suggestion must carry its two sides too");
    assert(review.question === CUSTOMER_QUESTION, "CASE A: the review suggestion must carry the customer's question");
    assert(review.existing?.answer === APPROVED && review.incoming?.answer === INCOMING, "CASE A: both sides of a review suggestion must be readable on their own");
    console.log("✅ CASE A — the two answers, and the real question, are on the record separately");
  }

  // ------------------------------------------------------------ CASE B + C
  {
    await answerUnknownQuestion(WS, item.id, INCOMING, true, repos);

    const docs = await repos.knowledgeBaseDocument.listByWorkspace(WS);
    const faq = docs.filter((doc) => doc.source === "unknown_question");
    assert(faq.length === 1, `CASE B: expected one FAQ document, found ${faq.length}`);
    const [document] = faq;

    assert(
      !/Should this update the approved answer|A new source has more detail|Conflicting information found/i.test(document.title),
      `CASE B: the document must not be filed under the owner-facing prompt, got title ${JSON.stringify(document.title)}`,
    );
    assert(
      document.title.includes(CUSTOMER_QUESTION),
      `CASE B: the document must be filed under the customer's question, got title ${JSON.stringify(document.title)}`,
    );
    assert(
      (document.contentText || "").includes(`Question: ${CUSTOMER_QUESTION}`),
      "CASE B: the indexed text must carry the customer's question — it is what retrieval matches against",
    );
    console.log("✅ CASE B — the FAQ document is filed under the question a customer would actually ask");

    assert(
      (document.contentText || "").includes(INCOMING),
      "CASE C: the chosen answer must be what is stored",
    );
    assert(
      !(document.contentText || "").includes(APPROVED),
      "CASE C: the rejected side must NOT be stored — keeping both is how the wrong half survives a conflict " +
      "the product had already detected correctly",
    );
    assert(
      !/Approved answer:|New document answer:/i.test(document.contentText || ""),
      "CASE C: the comparison scaffolding must not reach the knowledge base as the company's answer",
    );
    console.log("✅ CASE C — only the side the owner chose is stored");
  }

  // ---------------------------------------------------------------- CASE D
  {
    const screen = readSource(SCREEN);
    assert(
      /conflictChoices\(question\)/.test(screen),
      `CASE D: ${SCREEN} must read the sides off the item to offer them as a choice`,
    );
    assert(
      /choices\.length \? "" : (question\.suggestedAnswer|draft\.answer)/.test(screen),
      `CASE D: ${SCREEN} must NOT prefill a conflict with the side-by-side comparison — a choice has no safe default`,
    );
    assert(
      /Use this one/.test(screen),
      `CASE D: ${SCREEN} must give the owner a control that picks one side`,
    );
    console.log("✅ CASE D — the screen offers the sides, and defaults to neither");
  }

  console.log("\n=== GOLDEN PASSED (A-D) ===");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
