/**
 * golden-mock-answers-need-review.ts — N-AI-6 pin (2026-08-18, CEO-loop
 * session 4).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * `enableMockFallback: true` means that when the AI budget cap is hit, or the
 * provider fails part-way through an extraction, the REMAINING batches are
 * answered by the mock provider — a stub that invents plausible business
 * sentences. A run that dies half way (batches 1-9 real, batches 10-20 mock)
 * produces plenty of useful answers, so the zero-useful-answers guard that
 * N-AI-5 fixed never fires. The run completes and the answers land in the
 * review list.
 *
 * WHAT WAS ALREADY CORRECT (checked before writing this, and re-pinned below so
 * a future change cannot quietly remove it):
 *
 *   - mock answers are capped at 0.45 confidence, under the 0.75 bulk-approve
 *     bar (M2.2 / R5 audit fix), and that cap is computed PER BATCH, so the
 *     real batches of a mixed run keep their real confidence;
 *   - mock answers are written sourceType "agent_inference", isUserApproved
 *     false, so nothing invented reaches a customer without a human approving.
 *
 * WHAT WAS WRONG. The human doing that approving was never told the answer was
 * invented. The review card shows the status, "45% confidence", the source
 * count and an Approve button. "45%" reads as "the model was unsure" — not as
 * "your budget ran out on batch 10 and a stub wrote this". Confidence cannot
 * carry that meaning, because a genuine model may report 0.45 by itself.
 *
 * THE FIX. A mock batch's answers are demoted to `needs_review` — the same move
 * already made for questions flagged humanReviewRequired. That both TELLS the
 * reviewer (the status badge is already rendered) and adds a second, independent
 * lock: `syncKnowledgeQuestionAnswers` only turns answers with status exactly
 * "answered" into servable knowledge chunks, so an invented answer stays out of
 * customer-facing use even if it is approved by accident.
 *
 * HAND-COMPUTED CONTRACT (written BEFORE running the implementation):
 *
 *   CASE A — a mock batch's answered answer comes back `needs_review`. The defect.
 *   CASE B — the SAME input on a real batch stays `answered`. Without this, CASE A
 *            could pass because the fixture was broken rather than because the
 *            mock flag did anything. B is what makes A mean something.
 *   CASE C — the answer TEXT survives the demotion. A reviewer cannot judge an
 *            answer that has been blanked.
 *   CASE D — the 0.45 mock confidence cap is still applied (M2.2 regression guard).
 *   CASE E — a humanReviewRequired question on a REAL run is still `needs_review`.
 *   CASE F — an unanswered answer is not promoted INTO `needs_review` by a mock run.
 *   CASE G — the serving boundary: a mock answer fails the exact predicate
 *            `syncKnowledgeQuestionAnswers` uses, even when marked approved.
 *   CASE H — the run summary is not zeroed: `answeredCount` counts "answered" OR
 *            "needs_review", so this fix does not make a mock run look empty.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { normalizeLLMQuestionAnswers } from "@/services/DocumentQuestionAnsweringService";
import { getAllKnowledgeQuestions } from "@/knowledge/knowledge-question-framework";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

const ALL = getAllKnowledgeQuestions();
/** A normal question — nothing about it demands review on its own. */
const PLAIN = ALL.find((item) => item.questionKey === "company_overview" && !item.humanReviewRequired);
/** A question that already demands review regardless of provider. */
const HUMAN_REVIEW = ALL.find((item) => item.humanReviewRequired);

if (!PLAIN || !HUMAN_REVIEW) {
  console.error("FAIL golden-mock-answers-need-review: fixture questions missing from the framework.");
  process.exit(1);
}

/**
 * A believable answer to "What does the company do in simple business language?".
 * It deliberately echoes the question's own subject words so that the
 * boilerplate / wrong-topic demotions in normalizeLLMQuestionAnswers do not fire
 * and quietly turn this into "unanswered" — CASE B is the tripwire for that.
 * N-SAFETY-1: no phone numbers, no routable domains, nothing contactable.
 */
const ANSWER_TEXT =
  "The company manufactures and supplies embroidery trims — zari thread, laces, borders, sequins and beads — to garment manufacturers and wholesale buyers across India, selling in bulk on a per-shade minimum.";

function llmOutput(answerStatus: "answered" | "unanswered", answer = ANSWER_TEXT) {
  return {
    answers: [
      {
        domainKey: PLAIN!.domainKey,
        questionKey: PLAIN!.questionKey,
        question: PLAIN!.question,
        answer: answerStatus === "unanswered" ? "" : answer,
        answerStatus,
        confidenceScore: 0.91,
        sourceSnippet: answer,
      },
      {
        domainKey: HUMAN_REVIEW!.domainKey,
        questionKey: HUMAN_REVIEW!.questionKey,
        question: HUMAN_REVIEW!.question,
        answer: "Do not promise delivery dates or discounts without written approval from the owner.",
        answerStatus: "answered" as const,
        confidenceScore: 0.88,
        sourceSnippet: "Do not promise delivery dates or discounts without written approval from the owner.",
      },
    ],
  };
}

const FIXTURE_QUESTIONS = [PLAIN, HUMAN_REVIEW];

function normalize(isMockRun: boolean, output = llmOutput("answered")) {
  return normalizeLLMQuestionAnswers(output, [], [], FIXTURE_QUESTIONS, { isMockRun });
}

function pick(result: ReturnType<typeof normalize>, questionKey: string) {
  const found = result.answers.find((item) => item.questionKey === questionKey);
  assert.ok(found, `fixture answer for ${questionKey} missing from the normalized result`);
  return found;
}

function main() {
  console.log("golden-mock-answers-need-review — N-AI-6 (invented answers must not look merely 'low confidence')\n");

  // --- CASE B FIRST: it is the control that makes CASE A meaningful ---------
  check("CASE B — the same answer on a REAL batch stays 'answered' (control)", () => {
    const real = pick(normalize(false), PLAIN!.questionKey);
    assert.strictEqual(
      real.answerStatus,
      "answered",
      `the fixture must be a genuinely answerable answer on a real run, otherwise CASE A proves nothing. Got "${real.answerStatus}" with answer "${real.answer}"`,
    );
  });

  // --- CASE A: the measured defect -----------------------------------------
  check("CASE A — a mock batch's answer comes back 'needs_review', not 'answered'", () => {
    const mock = pick(normalize(true), PLAIN!.questionKey);
    assert.strictEqual(
      mock.answerStatus,
      "needs_review",
      `an invented answer must announce itself to the reviewer. Got "${mock.answerStatus}"`,
    );
  });

  // --- CASE C: the reviewer can still read it -------------------------------
  check("CASE C — the answer text survives the demotion", () => {
    const mock = pick(normalize(true), PLAIN!.questionKey);
    assert.strictEqual(mock.answer, ANSWER_TEXT, "a blanked answer cannot be reviewed, only deleted");
  });

  // --- CASE D: the older defence is still in place --------------------------
  check("CASE D — the 0.45 mock confidence cap is still applied (M2.2 regression guard)", () => {
    const mock = pick(normalize(true), PLAIN!.questionKey);
    const real = pick(normalize(false), PLAIN!.questionKey);
    assert.strictEqual(mock.confidenceScore, 0.45, `mock answers must stay under the 0.75 bulk-approve bar, got ${mock.confidenceScore}`);
    assert.ok(real.confidenceScore > 0.45, `a real answer must keep its own confidence, got ${real.confidenceScore}`);
  });

  // --- CASE E: pre-existing needs_review behaviour untouched ----------------
  check("CASE E — a humanReviewRequired question is still 'needs_review' on a real run", () => {
    const real = pick(normalize(false), HUMAN_REVIEW!.questionKey);
    assert.strictEqual(real.answerStatus, "needs_review", "this fix must not disturb the humanReviewRequired path");
  });

  // --- CASE F: nothing is promoted -----------------------------------------
  check("CASE F — an unanswered answer is not promoted into 'needs_review' by a mock run", () => {
    const mock = pick(normalize(true, llmOutput("unanswered")), PLAIN!.questionKey);
    assert.strictEqual(mock.answerStatus, "unanswered", `a mock run must not invent coverage it does not have, got "${mock.answerStatus}"`);
  });

  // --- CASE G: the serving boundary, stated as the product requirement ------
  check("CASE G — a mock answer fails the serving filter even if it is marked approved", () => {
    const mock = pick(normalize(true), PLAIN!.questionKey);
    // The exact predicate syncKnowledgeQuestionAnswers uses to decide what
    // becomes a servable knowledge chunk (DocumentQuestionAnsweringService.ts
    // :970-975). Approval is forced true here to prove the SECOND lock holds on
    // its own — this is the "approved by accident" case.
    const servable = (item: { answerStatus: string; answer?: string; isUserApproved?: boolean; sourceType?: string }) =>
      item.answerStatus === "answered" &&
      Boolean(item.answer?.trim()) &&
      Boolean(item.isUserApproved || item.sourceType === "user_answer" || item.sourceType === "manual_edit");

    assert.strictEqual(servable({ ...mock, isUserApproved: true }), false, "an invented answer must not become a servable chunk on approval alone");
    const real = pick(normalize(false), PLAIN!.questionKey);
    assert.strictEqual(servable({ ...real, isUserApproved: true }), true, "a real approved answer must still be servable — the lock must not be indiscriminate");
  });

  // --- CASE H: the run summary is not zeroed --------------------------------
  check("CASE H — a mock run still reports its answers in answeredCount", () => {
    const mock = normalize(true);
    // The exact counting rule at DocumentQuestionAnsweringService.ts:223.
    const answeredCount = mock.answers.filter((item) => item.answerStatus === "answered" || item.answerStatus === "needs_review").length;
    assert.ok(answeredCount > 0, "demoting the status must not make a completed mock run look empty to the owner");
  });

  console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
  if (failed) {
    console.error("\nFAIL golden-mock-answers-need-review");
    process.exit(1);
  }
  console.log("PASS golden-mock-answers-need-review: answers invented by a mock fallback now announce themselves as needing review, and cannot be served even if approved.");
}

main();
