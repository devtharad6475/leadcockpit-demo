/**
 * KnowledgeFactConflictService.ts — N-AI-3 (2026-08-18).
 *
 * Cross-question ("fact level") contradiction detection.
 *
 * KnowledgeAnswerMergeService compares an incoming answer against the canonical
 * answer FOR THE SAME QUESTION KEY. That is the right check for "this document
 * disagrees with what we already recorded", and it works — it correctly raised
 * 2 conflicts when the 18th fixture document was loaded on its own.
 *
 * It is structurally unable to catch the defect N-AI-3 describes: two documents
 * stating the same real-world fact under DIFFERENT question keys. Neither answer
 * is ever the other's "incoming", so no comparison is attempted, and both stay
 * live. See knowledge-fact-groups.ts for the measured 5 kg vs 10 kg MOQ case.
 *
 * WHAT THIS DOES
 *   For each fact group (a set of question keys meaning one real-world fact),
 *   take the canonical answer under each key and compare every pair with the
 *   SAME `detectContradiction` the merge path uses. On a hit, flag both answers
 *   and raise one owner-facing review item carrying both answers side by side.
 *
 * WHY IT REUSES detectContradiction RATHER THAN ASKING THE MODEL
 *   `detectContradiction` is pure string logic — no LLM, no tokens, no latency,
 *   fully deterministic. It already fires on the N-AI-3 pair: both answers hit
 *   the `/moq|minimum/` topic gate and their number sets ({5} vs {10}) are
 *   disjoint. The detector was never the missing piece; the CALL was. Keeping it
 *   deterministic means this can run on every merge and be pinned by a golden
 *   that needs no network and no key.
 *
 * WHY IT TAKES `data: AppData` INSTEAD OF REPOSITORIES
 *   So it can be invoked inside the same mutation that just merged the answers:
 *   one transaction, no second write, and it works identically on the JSON
 *   substrate and on Postgres (both funnel through the same AppData mutation).
 *
 * IDEMPOTENT: re-running over already-flagged answers creates no duplicate
 * review items (deduped on question text + open status, same rule the merge
 * path uses) and re-flags nothing that is already flagged.
 */
import { getFactGroups, type FactGroup } from "@/knowledge/knowledge-fact-groups";
import { timestamp, uid } from "@/lib/db";
import type { AppData, KnowledgeQuestionAnswer, UnknownQuestion } from "@/lib/types";
import { findMeasurementConflicts } from "@/services/DocumentContextRetrievalService";
import { answerStatusRank, areAnswersEquivalent, detectContradiction } from "@/services/KnowledgeAnswerComparisonService";
import { getKnowledgeSourcePriority } from "@/services/KnowledgeAnswerMergeService";

export type FactConflict = {
  factKey: string;
  label: string;
  /** The two answers that disagree, in fact-group member order. */
  left: KnowledgeQuestionAnswer;
  right: KnowledgeQuestionAnswer;
};

export type FactConflictSummary = {
  factConflictsFound: number;
  factConflictReviewItemsCreated: number;
  answersFlagged: number;
  /** "<factKey>: <domain>/<key> vs <domain>/<key>" — quoted in goldens and logs. */
  details: string[];
};

export type FactConflictInput = {
  workspaceId: string;
  data: AppData;
  now?: string;
  /** Injectable for tests; defaults to the derived framework groups. */
  factGroups?: FactGroup[];
};

export function detectFactGroupConflicts(input: FactConflictInput): FactConflictSummary {
  const now = input.now || timestamp();
  const answers = (input.data.knowledgeQuestionAnswers ||= []);
  const unknownQuestions = (input.data.unknownQuestions ||= []);

  const summary: FactConflictSummary = {
    factConflictsFound: 0,
    factConflictReviewItemsCreated: 0,
    answersFlagged: 0,
    details: [],
  };

  for (const group of input.factGroups || getFactGroups()) {
    // One canonical answer per member key. A member with no useful answer
    // simply drops out — an unanswered question cannot contradict anything.
    const canonicals: KnowledgeQuestionAnswer[] = [];
    for (const member of group.members) {
      const canonical = pickCanonical(answers.filter((item) =>
        item.workspaceId === input.workspaceId &&
        item.domainKey === member.domainKey &&
        item.questionKey === member.questionKey
      ));
      if (canonical) canonicals.push(canonical);
    }
    if (canonicals.length < 2) continue;

    for (let i = 0; i < canonicals.length; i += 1) {
      for (let j = i + 1; j < canonicals.length; j += 1) {
        const left = canonicals[i];
        const right = canonicals[j];

        // An answer cannot disagree with itself. Two questions in one fact group
        // very often carry the SAME extracted text (the model answered both from
        // one paragraph), and a "conflict" between identical strings is by
        // definition a detector artefact — there is nothing for the owner to
        // choose between.
        //
        // HONEST NOTE ON WHAT THIS IS WORTH: the live probe DID report exactly
        // that (minimum_quantities_by_variety vs deep_06_..., identical text,
        // "2kg vs 25kg"), but the cause was cross-entry bleed in the signature
        // window, and scoping figures to their own list entry
        // (measurementsBySegment) fixes it on its own — measured: with this
        // guard disabled and segmentation restored, all 10 golden cases still
        // pass. So this is belt-and-braces, not the fix. It holds the invariant
        // at the layer that decides the owner's queue, so a later detector
        // change cannot reintroduce self-conflicts. Internal self-consistency
        // (one answer contradicting itself) is a different check, not done here.
        if (areAnswersEquivalent(left.answer || "", right.answer || "")) continue;

        // Both question texts are passed as context because the detector's
        // topic gates (moq/minimum/credit/delivery/...) read the question as
        // well as the answers. Two questions about one fact rarely share
        // wording, so feeding only one of them would silently narrow the gate.
        const questionContext = `${left.question || ""} ${right.question || ""}`;

        // TWO detectors, because one shape of answer defeats each of them.
        //
        //  1. detectContradiction — whole-answer logic (yes/no flips, number
        //     sets). Right for short single-fact answers: "credit is 30 days"
        //     vs "credit is 45 days".
        //
        //  2. findMeasurementConflicts — figure-by-figure. Needed because the
        //     REAL answers here are per-product lists, and detectContradiction
        //     is structurally blind to those: it returns false as soon as the
        //     two answers share any number, and again when either side has
        //     more than three. The measured MOQ answers trip both guards (they
        //     share "2 kg" for sequins, and the variety answer lists five
        //     figures), so the genuine 5 kg vs 10 kg disagreement about zari
        //     thread scored as "no conflict". Verified against the live
        //     523-answer knowledge base, not assumed.
        const measurementConflicts = findMeasurementConflicts(left.answer || "", right.answer || "");
        const contradicts = detectContradiction(left.answer || "", right.answer || "", questionContext) || measurementConflicts.length > 0;
        if (!contradicts) continue;

        summary.factConflictsFound += 1;
        const how = measurementConflicts.length
          ? ` (${measurementConflicts.map((c) => `${c.subject.join("/")}: ${c.valueA}${c.unit} vs ${c.valueB}${c.unit}`).join("; ")})`
          : "";
        summary.details.push(`${group.factKey}: ${left.domainKey}/${left.questionKey} vs ${right.domainKey}/${right.questionKey}${how}`);

        if (createFactConflictQuestion(unknownQuestions, input.workspaceId, group, left, right, now)) {
          summary.factConflictReviewItemsCreated += 1;
        }
        summary.answersFlagged += flagAnswer(left, group, right, now);
        summary.answersFlagged += flagAnswer(right, group, left, now);
      }
    }
  }

  return summary;
}

function pickCanonical(candidates: KnowledgeQuestionAnswer[]) {
  // Same ordering the merge path uses to decide which answer is authoritative
  // (user-approved first, then status rank, then source priority, then recency),
  // restricted to answers that actually say something.
  return candidates
    .filter((item) => !item.supersededByAnswerId && hasUsefulAnswer(item))
    .sort((a, b) =>
      Number(Boolean(b.isUserApproved)) - Number(Boolean(a.isUserApproved)) ||
      answerStatusRank(b.answerStatus, true) - answerStatusRank(a.answerStatus, true) ||
      getKnowledgeSourcePriority(b.sourceType) - getKnowledgeSourcePriority(a.sourceType) ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )[0];
}

/**
 * Flags one side of a fact conflict. Returns 1 if it changed anything.
 *
 * A user-approved answer is NEVER downgraded — same guard as the merge path.
 * The owner already made a decision; the review item informs them, it does not
 * overrule them.
 */
function flagAnswer(target: KnowledgeQuestionAnswer, group: FactGroup, other: KnowledgeQuestionAnswer, now: string) {
  if (target.isUserApproved) return 0;
  if (target.answerStatus === "conflict" && target.conflictWithExisting) return 0;
  target.answerStatus = "conflict";
  target.conflictWithExisting = true;
  target.conflictReason = `Disagrees with the answer to "${other.question}" about the same fact (${group.label}).`;
  target.updatedAt = now;
  return 1;
}

/** Returns true if a new review item was pushed (false if one was already open). */
function createFactConflictQuestion(
  unknownQuestions: UnknownQuestion[],
  workspaceId: string,
  group: FactGroup,
  left: KnowledgeQuestionAnswer,
  right: KnowledgeQuestionAnswer,
  now: string,
) {
  // Distinct from the merge path's "Conflicting information found for: <q>."
  // text so the two kinds of conflict stay tellable apart in the review queue —
  // this one is about a fact spanning two questions, not one question with two
  // answers.
  const questionText = `Two answers disagree about ${group.label}. Which is correct?`;
  if (unknownQuestions.some((item) => item.workspaceId === workspaceId && item.questionText === questionText && item.status === "open")) return false;

  unknownQuestions.push({
    id: uid("uq"),
    workspaceId,
    channel: "knowledge",
    questionText,
    missingTopic: left.domainKey,
    status: "open",
    suggestedAnswer: `"${left.question}" says: ${left.answer || "No answer"}\n"${right.question}" says: ${right.answer || "No answer"}`,
    generatedBy: "conflict_detection",
    relatedDomain: left.domainKey,
    relatedQuestionKey: left.questionKey,
    conflictSourcesJson: {
      question: left.question,
      existing: { label: `"${left.question}" says`, sourceType: left.sourceType, sourceId: left.sourceId, answer: left.answer },
      incoming: { label: `"${right.question}" says`, sourceType: right.sourceType, sourceId: right.sourceId, answer: right.answer },
    },
    sourceIds: [left.sourceId, right.sourceId].filter(Boolean) as string[],
    priority: "high",
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

function hasUsefulAnswer(answer: Pick<KnowledgeQuestionAnswer, "answer" | "answerStatus">) {
  return Boolean(answer.answer?.trim()) && !["unanswered", "not_applicable"].includes(answer.answerStatus);
}
