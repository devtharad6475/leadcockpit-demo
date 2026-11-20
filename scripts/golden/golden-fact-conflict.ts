/**
 * golden-fact-conflict.ts — N-AI-3 pin (2026-08-18, CEO-loop session 4,
 * decision D6 "if any document is contradicting always ask").
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * Two earlier fixes attacked the 5 kg vs 10 kg MOQ contradiction and neither
 * closed it, so this golden pins the layer that was actually missing.
 *
 *   UA-4 (session 3) fixed RETRIEVAL: the "10 kg" note used to lose chunk
 *   ranking to the "5 kg" policy table, so no LLM call ever saw both figures.
 *   Pinned by golden-contradiction-retrieval.
 *
 *   UA-3/UA-4 (session 3) fixed MERGE: two answers that disagree under the SAME
 *   question key now always raise a conflict.
 *
 * Session 4 loaded the real 18 fixture documents through the real pipeline on
 * live DeepSeek and measured that the contradiction STILL survives both:
 *   product_varieties/minimum_quantities_by_variety -> "...minimum of 5 kg per shade..."
 *   pricing_policy/moq_policy                       -> "...minimum order of 10 kg per shade..."
 * Both live, both unflagged. The reason is structural: the merge check is keyed
 * on QUESTION IDENTITY, and these two answers are filed under different
 * questions in different domains, so neither is ever the other's "incoming" and
 * no comparison is ever attempted. Retrieval putting both figures in front of
 * the model does not help once the model has legitimately answered two
 * different questions.
 *
 * The missing layer is a FACT-level pass: KnowledgeFactConflictService, which
 * compares canonical answers ACROSS question keys that describe one real-world
 * fact (knowledge-fact-groups.ts).
 *
 * HAND-COMPUTED CONTRACT (written BEFORE running the implementation):
 *
 *   CASE A — the exact measured defect. Two answers, different domains,
 *   different question keys, 5 kg vs 10 kg. Expect exactly 1 fact conflict
 *   naming both keys, 1 review item, and BOTH answers flagged `conflict`.
 *
 *   CASE B — not indiscriminate. The same two keys with AGREEING answers
 *   (both 5 kg) must produce 0 conflicts and leave both answers untouched. A
 *   "fix" that flags every cross-key pair would pass CASE A and fail here.
 *
 *   CASE C — the group is real, not a test hook. getFactGroups() must contain
 *   sales.defaultMOQ with BOTH members, derived from the shipped settings
 *   mapping plus the declared extras — not hand-fed by this test.
 *
 *   CASE D — unrelated facts are not compared. Two disagreeing answers under
 *   keys that belong to NO shared fact group must produce 0 conflicts. This is
 *   what stops the pass degenerating into "compare everything with everything".
 *
 *   CASE E — idempotent. Running twice must not create a second review item
 *   and must not re-flag already-flagged answers.
 *
 *   CASE F — an owner decision is never overruled. If one side is
 *   `isUserApproved`, the review item is still raised (the owner is informed)
 *   but that answer's status must NOT be downgraded to `conflict`.
 *
 *   CASE G — the second instance of the same bug class, found while fixing the
 *   first: sales.quotationValidity must group the samples/quotation domain's
 *   `quotation_validity` with payment_credit_terms' `gst_quotation_validity`.
 *
 * CASES H/I/J were added AFTER the first implementation passed A-G green and
 * then found 0 conflicts against the live store. The lesson is recorded here
 * because it is the whole point of the file: A-G were built from tidied
 * single-fact answers that matched my hypothesis, and the real answers are
 * per-product lists. The golden was green and production was still broken.
 *
 *   CASE H — the VERBATIM live answers must raise exactly the zari 5 kg vs
 *   10 kg disagreement, and must NOT name sequins or laces, which agree on both
 *   sides. This is the case A-G could not express.
 *
 *   CASE I — two grouped keys holding byte-identical text raise nothing. There
 *   is nothing for an owner to choose between, so any such report is noise.
 *
 *   CASE J — a figure's subject may not bleed into the neighbouring list entry.
 *   Measured failure: the ±60-char signature window around "2 kg" (cutdana)
 *   swallowed "custom job work", so 2 kg and 25 kg matched on a product neither
 *   was about — and the pass reported a conflict between two identical answers.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { getFactGroups } from "@/knowledge/knowledge-fact-groups";
import type { AppData, KnowledgeQuestionAnswer } from "@/lib/types";
import { detectFactGroupConflicts } from "@/services/KnowledgeFactConflictService";

const WS = "ws_fact_conflict";
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

function answer(overrides: Partial<KnowledgeQuestionAnswer> & Pick<KnowledgeQuestionAnswer, "domainKey" | "questionKey" | "question" | "answer">): KnowledgeQuestionAnswer {
  return {
    id: `kqa_${overrides.domainKey}_${overrides.questionKey}`,
    workspaceId: WS,
    answerStatus: "answered",
    sourceType: "document",
    confidenceScore: 0.9,
    isCanonical: true,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  } as KnowledgeQuestionAnswer;
}

/** The two answers exactly as the real extraction produced them (S3-17). */
function moqAnswers(varietyText: string, policyText: string) {
  return [
    answer({
      domainKey: "product_varieties",
      questionKey: "minimum_quantities_by_variety",
      question: "Are MOQ rules different by variety or product line?",
      answer: varietyText,
    }),
    answer({
      domainKey: "pricing_policy",
      questionKey: "moq_policy",
      question: "What minimum order quantity rules apply?",
      answer: policyText,
    }),
  ];
}

/**
 * The two answers VERBATIM as the live 523-answer knowledge base holds them.
 *
 * CASES A/B/E/F use tidied single-fact answers, and that is precisely how the
 * first attempt at this fix passed a green golden while changing nothing in
 * production: I built the fixture from my hypothesis instead of from the store.
 * These constants exist so the golden cannot drift back to being easier than
 * reality. They are per-product LISTS, which is the shape that defeated the
 * whole-answer number-set comparison.
 */
const REAL_VARIETY_LIST =
  "Yes. Zari thread (all grades) has a minimum of 5 kg per shade; embroidery laces and borders have a minimum of 90 metres per design (10 rolls); sequins and tikki trims have a minimum of 2 kg per shade; cutdana and beads have a minimum of 2 kg per shade; custom job work has a minimum of 25 kg. Minimums are per shade or per design, not per total order.";
const REAL_POLICY_LIST =
  "Zari thread has a minimum order of 10 kg per shade; laces have a minimum of 10 rolls; sequins have a minimum of 2 kg.";

function emptyData(answers: KnowledgeQuestionAnswer[]): AppData {
  return { knowledgeQuestionAnswers: answers, unknownQuestions: [] } as unknown as AppData;
}

function main() {
  console.log("golden-fact-conflict — N-AI-3 (one fact, two questions, two contradicting answers)\n");

  // --- CASE A: the exact measured defect ------------------------------------
  check("CASE A — 5 kg vs 10 kg across two question keys raises exactly one fact conflict", () => {
    const answers = moqAnswers(
      "Zari thread (all grades) has a minimum of 5 kg per shade for regular orders.",
      "Zari thread has a minimum order of 10 kg per shade.",
    );
    const data = emptyData(answers);
    const summary = detectFactGroupConflicts({ workspaceId: WS, data });

    assert.strictEqual(summary.factConflictsFound, 1, `expected exactly 1 fact conflict, got ${summary.factConflictsFound} (${summary.details.join(" | ")})`);
    const detail = summary.details[0];
    assert.ok(detail.includes("sales.defaultMOQ"), `conflict must be attributed to the MOQ fact group, got "${detail}"`);
    assert.ok(detail.includes("minimum_quantities_by_variety"), `detail must name the variety question, got "${detail}"`);
    assert.ok(detail.includes("moq_policy"), `detail must name the pricing-policy question, got "${detail}"`);

    assert.strictEqual(summary.factConflictReviewItemsCreated, 1, "exactly one owner-facing review item");
    const item = data.unknownQuestions![0];
    assert.strictEqual(item.status, "open", "review item must be open");
    assert.strictEqual(item.priority, "high", "a customer-facing wrong-answer risk is high priority");
    assert.strictEqual(item.generatedBy, "conflict_detection", "must reuse the existing conflict review channel");
    // The owner cannot decide without seeing BOTH figures side by side.
    assert.ok(item.suggestedAnswer?.includes("5 kg"), "review item must quote the 5 kg answer");
    assert.ok(item.suggestedAnswer?.includes("10 kg"), "review item must quote the 10 kg answer");

    assert.strictEqual(summary.answersFlagged, 2, "both answers are suspect until the owner rules — neither may stay 'answered'");
    assert.strictEqual(answers[0].answerStatus, "conflict", "variety answer must be flagged");
    assert.strictEqual(answers[1].answerStatus, "conflict", "policy answer must be flagged");
    assert.ok(answers[0].conflictReason?.includes("minimum order quantity"), `flag must say what it disagrees with, got "${answers[0].conflictReason}"`);
  });

  // --- CASE B: agreement is not a conflict ----------------------------------
  check("CASE B — the same two keys agreeing (5 kg / 5 kg) raises nothing", () => {
    const answers = moqAnswers(
      "Zari thread (all grades) has a minimum of 5 kg per shade for regular orders.",
      "Zari thread has a minimum order of 5 kg per shade.",
    );
    const data = emptyData(answers);
    const summary = detectFactGroupConflicts({ workspaceId: WS, data });

    assert.strictEqual(summary.factConflictsFound, 0, `agreeing answers must not conflict, got ${summary.details.join(" | ")}`);
    assert.strictEqual(data.unknownQuestions!.length, 0, "no review item for agreeing answers");
    assert.strictEqual(answers[0].answerStatus, "answered", "an agreeing answer must not be downgraded");
    assert.strictEqual(answers[1].answerStatus, "answered", "an agreeing answer must not be downgraded");
  });

  // --- CASE C: the fact group is shipped, not injected ----------------------
  check("CASE C — sales.defaultMOQ is a real derived group containing both keys", () => {
    const groups = getFactGroups();
    const moq = groups.find((group) => group.factKey === "sales.defaultMOQ");
    assert.ok(moq, "sales.defaultMOQ must exist in the shipped fact groups");
    const keys = moq!.members.map((member) => `${member.domainKey}/${member.questionKey}`);
    assert.ok(keys.includes("product_varieties/minimum_quantities_by_variety"), `derived from the settings mapping; got ${keys.join(", ")}`);
    assert.ok(keys.includes("pricing_policy/moq_policy"), `cross-domain sibling must be added by the extras table; got ${keys.join(", ")}`);
    // Every returned group must be capable of holding a disagreement.
    for (const group of groups) {
      assert.ok(group.members.length >= 2, `group ${group.factKey} has ${group.members.length} member(s) — single-member groups are useless and must be dropped`);
    }
  });

  // --- CASE D: unrelated questions are never compared -----------------------
  check("CASE D — two disagreeing answers outside any shared fact group raise nothing", () => {
    const answers = [
      answer({
        domainKey: "company_basics",
        questionKey: "founding_year",
        question: "When was the company founded?",
        answer: "The company was founded in 1998.",
      }),
      answer({
        domainKey: "shipping_delivery",
        questionKey: "delivery_timelines",
        question: "What are the delivery timelines?",
        answer: "Delivery takes 7 days after dispatch.",
      }),
    ];
    const data = emptyData(answers);
    const summary = detectFactGroupConflicts({ workspaceId: WS, data });
    assert.strictEqual(summary.factConflictsFound, 0, `unrelated facts must not be compared, got ${summary.details.join(" | ")}`);
  });

  // --- CASE E: idempotent ---------------------------------------------------
  check("CASE E — running twice creates no duplicate review item and no second flag", () => {
    const answers = moqAnswers(
      "Zari thread (all grades) has a minimum of 5 kg per shade for regular orders.",
      "Zari thread has a minimum order of 10 kg per shade.",
    );
    const data = emptyData(answers);
    const first = detectFactGroupConflicts({ workspaceId: WS, data });
    const second = detectFactGroupConflicts({ workspaceId: WS, data });

    assert.strictEqual(first.factConflictReviewItemsCreated, 1, "first run raises the review item");
    assert.strictEqual(second.factConflictReviewItemsCreated, 0, "second run must not duplicate it");
    assert.strictEqual(data.unknownQuestions!.length, 1, `exactly one review item after two runs, got ${data.unknownQuestions!.length}`);
    assert.strictEqual(second.answersFlagged, 0, "already-flagged answers must not be re-flagged");
    // Still detected — silence would mean the second run thinks the problem is gone.
    assert.strictEqual(second.factConflictsFound, 1, "the conflict is still reported; only the side effects are suppressed");
  });

  // --- CASE F: an owner decision is never overruled -------------------------
  check("CASE F — a user-approved answer is reported but never downgraded", () => {
    const answers = moqAnswers(
      "Zari thread (all grades) has a minimum of 5 kg per shade for regular orders.",
      "Zari thread has a minimum order of 10 kg per shade.",
    );
    answers[0].isUserApproved = true;
    answers[0].answerStatus = "answered";
    const data = emptyData(answers);
    const summary = detectFactGroupConflicts({ workspaceId: WS, data });

    assert.strictEqual(summary.factConflictsFound, 1, "the disagreement is still reported to the owner");
    assert.strictEqual(data.unknownQuestions!.length, 1, "the owner still gets a review item");
    assert.strictEqual(answers[0].answerStatus, "answered", "an answer the owner approved must keep its status");
    assert.strictEqual(answers[1].answerStatus, "conflict", "the unapproved side is still flagged");
    assert.strictEqual(summary.answersFlagged, 1, "exactly one side flagged");
  });

  // --- CASE G: the sibling bug found while fixing this one ------------------
  check("CASE G — sales.quotationValidity groups all three quotation-validity questions", () => {
    const moq = getFactGroups().find((group) => group.factKey === "sales.quotationValidity");
    assert.ok(moq, "sales.quotationValidity must exist in the shipped fact groups");
    const keys = moq!.members.map((member) => `${member.domainKey}/${member.questionKey}`);
    assert.ok(keys.includes("payment_credit_terms/gst_quotation_validity"), `got ${keys.join(", ")}`);
    assert.ok(
      keys.includes("samples_catalogue_quotation_rules/quotation_validity"),
      `the framework's third quotation-validity question must be in the comparison; got ${keys.join(", ")}`,
    );
  });

  // --- CASE H: the REAL list-shaped answers, not my tidy single-fact ones ----
  check("CASE H — the real per-product list answers raise exactly the zari conflict", () => {
    const answers = moqAnswers(REAL_VARIETY_LIST, REAL_POLICY_LIST);
    const data = emptyData(answers);
    const summary = detectFactGroupConflicts({ workspaceId: WS, data });

    assert.strictEqual(summary.factConflictsFound, 1, `expected exactly the zari disagreement, got ${summary.factConflictsFound} (${summary.details.join(" | ")})`);
    const detail = summary.details[0];
    assert.ok(detail.includes("5kg vs 10kg"), `must name the two figures, got "${detail}"`);
    assert.ok(detail.includes("zari"), `must attribute the disagreement to zari thread, got "${detail}"`);
    // The other products in the same two lists AGREE (sequins 2 kg / 2 kg, laces
    // 10 rolls / 10 rolls). If any of them shows up, the pass is matching
    // figures against the wrong products.
    assert.ok(!detail.includes("sequins"), `sequins agree at 2 kg on both sides, got "${detail}"`);
    assert.ok(!detail.includes("laces"), `laces agree at 10 rolls on both sides — naming them means a figure's subject bled across list entries, got "${detail}"`);
    assert.strictEqual(summary.answersFlagged, 2, "both answers flagged");
  });

  // --- CASE I: an answer cannot disagree with itself ------------------------
  check("CASE I — two grouped keys holding byte-identical text raise nothing", () => {
    const answers = moqAnswers(REAL_VARIETY_LIST, REAL_VARIETY_LIST);
    const data = emptyData(answers);
    const summary = detectFactGroupConflicts({ workspaceId: WS, data });

    assert.strictEqual(summary.factConflictsFound, 0, `identical answers cannot disagree, got ${summary.details.join(" | ")}`);
    assert.strictEqual(data.unknownQuestions!.length, 0, "an owner cannot choose between two identical strings — no review item");
    assert.strictEqual(answers[0].answerStatus, "answered", "must not be downgraded");
    assert.strictEqual(answers[1].answerStatus, "answered", "must not be downgraded");
  });

  // --- CASE J: a figure's subject may not bleed into the next list entry ----
  check("CASE J — figures are scoped to their own list entry, not a ±60-char window", () => {
    // Same list on both sides plus one extra sentence, so the texts are NOT
    // equivalent and CASE I's guard cannot mask a detector failure. Every figure
    // agrees with its counterpart, so the ONLY way to report a conflict here is
    // to match one entry's figure against a different entry's subject — which is
    // exactly the defect the live probe caught (2 kg cutdana vs 25 kg custom job
    // work, reported between two identical answers).
    const answers = moqAnswers(REAL_VARIETY_LIST, `${REAL_VARIETY_LIST} Contact sales for exceptions.`);
    const data = emptyData(answers);
    const summary = detectFactGroupConflicts({ workspaceId: WS, data });
    assert.strictEqual(summary.factConflictsFound, 0, `no figure disagrees with its counterpart; any hit is cross-entry bleed, got ${summary.details.join(" | ")}`);
  });

  console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
  if (failed) {
    console.error("\nFAIL golden-fact-conflict");
    process.exit(1);
  }
  console.log("PASS golden-fact-conflict: one real-world fact answered two ways under two questions is now caught and escalated to the owner.");
}

main();
