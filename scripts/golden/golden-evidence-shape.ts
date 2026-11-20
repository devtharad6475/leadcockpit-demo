/**
 * Golden test — a knowledge answer whose evidence was never filled in must not
 * crash the merge (N-BUG-1, 2026-09-04).
 *
 * WHY THIS EXISTS
 * ---------------
 * Uploading a document to the demo workspace failed outright. The operator was
 * told "Company knowledge extraction stopped because the configured LLM did not
 * complete", which pointed at the AI provider. The AI provider was fine. The
 * real error, three layers down, was:
 *
 *     TypeError: Cannot read properties of undefined (reading 'some')
 *
 * The chain: a knowledge answer saved with no evidence was written to Postgres
 * as the JSON value `{}`. On the way back out, `{}` is a perfectly good object,
 * so the guard every caller had written —
 *
 *     target.evidenceJson ||= { sources: [] };
 *
 * — did nothing, because `evidenceJson` was not missing. It was present and
 * empty. The very next line read `.sources.some(...)` and threw.
 *
 * It only happened on the Postgres substrate. The end-to-end suite runs in JSON
 * mode, where the field really is absent and the guard really does fire, so 238
 * passing browser tests never touched it. The live half of the smoke would have
 * caught it, but that half had been pointed at the wrong port since it was
 * written and had never once run.
 *
 * WHAT THIS PINS. Not the crash — the shape. `addEvidence` has to survive the
 * three shapes a stored answer can actually have: no evidence at all, evidence
 * present but sourceless (the shape that broke it), and evidence with sources
 * already in it. And it has to keep the sources it was given.
 *
 * Run: npx tsx scripts/golden/golden-evidence-shape.ts
 */
import { mergeExtractedAnswers } from "../../src/services/KnowledgeAnswerMergeService";
import type { ExtractedQuestionAnswer } from "../../src/services/DocumentQuestionAnsweringService";
import type { AppData, KnowledgeQuestionAnswer } from "../../src/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}

const NOW = "2026-09-04T00:00:00.000Z";

/** An answer already stored in the workspace, with whatever evidence shape. */
function storedAnswer(evidenceJson: unknown): KnowledgeQuestionAnswer {
  return {
    id: "kqa_existing",
    workspaceId: "workspace_demo",
    domainKey: "company_knowledge",
    questionKey: "company_overview",
    question: "What does the company do?",
    answer: "We manufacture zari thread.",
    answerStatus: "answered",
    sourceType: "document",
    confidenceScore: 0.8,
    humanReviewRequired: false,
    isUserApproved: false,
    isCanonical: true,
    conflictWithExisting: false,
    evidenceJson: evidenceJson as KnowledgeQuestionAnswer["evidenceJson"],
    createdAt: NOW,
    updatedAt: NOW,
  } as KnowledgeQuestionAnswer;
}

/** A freshly extracted answer arriving from a document. */
const incoming = {
  domainTitle: "Company knowledge",
  domainKey: "company_knowledge",
  questionKey: "company_overview",
  question: "What does the company do?",
  answer: "We manufacture zari thread and supply embroidery trims.",
  answerStatus: "answered" as const,
  sourceType: "document" as const,
  confidenceScore: 0.86,
  humanReviewRequired: false,
  isUserApproved: false,
  isCanonical: true,
  conflictWithExisting: false,
  sourceSnippet: "We manufacture zari thread and supply embroidery trims.",
} as ExtractedQuestionAnswer;

function mergeWith(evidenceJson: unknown) {
  return mergeExtractedAnswers({
    workspaceId: "workspace_demo",
    sourceType: "document",
    sourceId: "doc_test",
    sourceTitle: "Test document",
    extractedAnswers: [incoming],
    data: { knowledgeQuestionAnswers: [storedAnswer(evidenceJson)], unknownQuestions: [] } as unknown as AppData,
    now: NOW,
  });
}

function main() {
  console.log("\n=== golden:evidence-shape ===\n");

  // ===========================================================================
  // CASE A — evidence present but SOURCELESS. This is the exact shape Postgres
  // returned, and the exact shape that crashed document upload.
  // ===========================================================================
  let result: ReturnType<typeof mergeWith>;
  try {
    result = mergeWith({});
  } catch (error) {
    throw new Error(
      `CASE A: merging against a stored answer whose evidenceJson is {} threw instead of merging (${error instanceof Error ? error.message : error}). ` +
      "That is N-BUG-1: an object with no `sources` passes an `||=` guard and then breaks on `.sources`. Every document upload fails when any stored answer has this shape.",
    );
  }
  assert(result.persisted.length > 0, "CASE A: the merge returned no answers at all, so nothing was actually merged.");
  pass("CASE A — a stored answer with sourceless evidence ({}) merges instead of crashing");

  // ===========================================================================
  // CASE B — no evidence field at all. The JSON-substrate shape, and the only
  // one that was ever exercised before this bug was found.
  // ===========================================================================
  const withoutEvidence = mergeWith(undefined);
  assert(withoutEvidence.persisted.length > 0, "CASE B: a stored answer with no evidenceJson at all must still merge.");
  pass("CASE B — a stored answer with no evidence field at all still merges");

  // ===========================================================================
  // CASE C — evidence that already has sources must KEEP them.
  //
  // Without this, the obvious "fix" of overwriting evidenceJson with a fresh
  // { sources: [] } would pass both cases above while silently throwing away
  // every source an answer had been checked against.
  // ===========================================================================
  const existingSource = {
    sourceType: "website" as const,
    sourceId: "crawl_1",
    answer: "We manufacture zari thread.",
    createdAt: NOW,
  };
  const withSources = mergeWith({ sources: [existingSource] });
  const merged = withSources.persisted.find((item) => item.questionKey === "company_overview");
  assert(merged, "CASE C: the merged answer went missing.");
  const kept = (merged.evidenceJson?.sources || []).some((source) => source.sourceId === "crawl_1");
  assert(kept, "CASE C: the source this answer was already backed by (crawl_1) was dropped by the merge. Normalising the evidence shape must not cost the evidence.");
  pass("CASE C — evidence that already had sources keeps them through the merge");

  console.log(`\n✅ ${passed} passed, 0 failed — ALL GREEN ✅\n`);
}

try {
  main();
} catch (error) {
  console.error(`\n❌ FAILED after ${passed} passed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
