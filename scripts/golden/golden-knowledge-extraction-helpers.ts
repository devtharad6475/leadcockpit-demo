/**
 * golden-knowledge-extraction-helpers.ts — pins 4 DARK pure-logic extraction
 * helpers (Session 7 Coverage Map, 2026-07-28):
 *   1. KnowledgeQuestionBatcher — createQuestionBatches / createExtractionPlan
 *   2. DocumentContextRetrievalService — splitDocumentIntoChunks / retrieveRelevantDocumentContext
 *   3. ExtractionQualityService — calculateExtractionQuality (the quality score)
 *   4. KnowledgeSourceBundleService.buildCombinedSourceText — source-text combiner
 *
 * WHY: these control HOW documents are chunked, batched, scored, and combined
 * before LLM extraction. A regression in chunking silently drops facts; a
 * regression in the quality score hides a bad extraction behind a "Good" label.
 * All 4 were DARK. This golden pins their pure-logic contracts.
 *
 * HAND-COMPUTED (anti-cheat):
 *   Batcher: 3 questions, batchSize=2 → 2 batches (batch0=2, batch1=1).
 *   Chunking: short doc → 1 chunk; relevant-keyword retrieval → hadRelevantContext:true.
 *   Quality: 10/10 answered, 0 conflicts, NO answers and NO batches supplied
 *     → score 60, level "Needs Review". (This line used to claim "high score,
 *     level Good/Excellent". It never was: with `answers: []` and
 *     `batches: []` the confidence term contributes 0 of its 30 points and
 *     the real-model term 0 of its 10, so 60 is the ceiling for that input.
 *     Corrected 2026-08-26, S30 — A10, a walkthrough test must tell the truth.)
 *   Quality Q4: the same run WITH high-confidence answers and a real-model
 *     batch scores strictly higher than with none — the 40 points this file
 *     had never exercised.
 *   Source combine: 1 website source → "[Source: Website scan: T]\n[URL: U]\nTEXT".
 *
 * Run: `npm run golden:knowledge-extraction-helpers`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createQuestionBatches, groupQuestionsByDomain } from "@/services/KnowledgeQuestionBatcher";
import { splitDocumentIntoChunks, retrieveRelevantDocumentContext } from "@/services/DocumentContextRetrievalService";
import { calculateExtractionQuality } from "@/services/ExtractionQualityService";
import { buildCombinedSourceText } from "@/services/KnowledgeSourceBundleService";
import { KNOWLEDGE_QUESTION_FRAMEWORK, type KnowledgeDomain } from "@/knowledge/knowledge-question-framework";
import type {
  KnowledgeExtractionBatch,
  KnowledgeExtractionRun,
  KnowledgeExtractionSource,
  KnowledgeQuestionAnswer,
} from "@/lib/types";

// N-TEST-10 (2026-08-26, S30). Every fixture in this file used to end in
// `as never`, and unlike most of the suite these were genuinely load-bearing:
// they hid three separate classes of fault at once.
//
//   (a) PHANTOM INPUT. The quality fixtures set `averageConfidenceScore`,
//       `realModelBatches` and `fallbackBatches` on the run. None of the three
//       exists on KnowledgeExtractionRun (src/lib/types.ts:1666). Worse, they
//       read as the knobs the test is turning: `averageConfidenceScore: 1.0`
//       looks like "this run had perfect confidence".
//       calculateExtractionQuality never reads any of them — it derives
//       confidence from `answers` and real/fallback batch counts from
//       `batches` (ExtractionQualityService.ts:47-50), and BOTH of those
//       arrays are passed EMPTY here. So Q2/Q3 were never scoring a
//       high-confidence run; they were scoring a zero-confidence one, while
//       the comment above them said the opposite.
//   (b) MISSING REQUIRED FIELDS. `run` is typed KnowledgeExtractionRun, not
//       Partial<...>, so seven required fields were absent: id, workspaceId,
//       sourceType, unansweredCount, outputJson, createdAt, updatedAt. Same
//       for the source fixtures, missing id, workspaceId, bundleId,
//       metadataJson, status, createdAt and updatedAt.
//   (c) A QUESTION KEY THE PRODUCT HAS NEVER HAD. The retrieval fixtures
//       built a batch by hand around `questionKey: "unit_price"`. There is
//       no "unit_price" anywhere in the framework — the real pricing_policy
//       keys are pricing_structure, discount_policy, moq_policy, tax_policy,
//       price_change_policy and manager_approval_price_cases. The batch is
//       now built FROM the framework, so it cannot drift from the product.
//
// The builders below supply the real shapes once instead of at each site.

/** A complete KnowledgeExtractionRun. A case passes only the fields it
 *  actually varies; the rest is filler that satisfies the real type. */
function runFixture(overrides: Partial<KnowledgeExtractionRun> = {}): KnowledgeExtractionRun {
  const at = "2026-08-26T00:00:00.000Z";
  return {
    id: "run_golden_kex", workspaceId: "ws_golden_kex", sourceType: "document",
    status: "completed", totalQuestions: 10, answeredCount: 10, unansweredCount: 0,
    partialCount: 0, conflictCount: 0, failedBatchCount: 0,
    outputJson: {}, createdAt: at, updatedAt: at,
    ...overrides,
  };
}

/** A complete KnowledgeExtractionSource. */
function sourceFixture(overrides: Partial<KnowledgeExtractionSource> = {}): KnowledgeExtractionSource {
  const at = "2026-08-26T00:00:00.000Z";
  return {
    id: "src_golden_kex", workspaceId: "ws_golden_kex", bundleId: "bundle_golden_kex",
    sourceType: "website", sourceTitle: "Untitled", extractedText: "",
    metadataJson: {}, status: "ready", createdAt: at, updatedAt: at,
    ...overrides,
  };
}

/** A complete KnowledgeQuestionAnswer. `confidenceScore` is the field the
 *  quality score actually reads — see Q4. */
function answerFixture(overrides: Partial<KnowledgeQuestionAnswer> = {}): KnowledgeQuestionAnswer {
  const at = "2026-08-26T00:00:00.000Z";
  return {
    id: "ans_golden_kex", workspaceId: "ws_golden_kex", domainKey: "pricing_policy",
    questionKey: "pricing_structure", question: "How is pricing structured?",
    answer: "Per kilogram, slab-based.", answerStatus: "answered", sourceType: "document",
    confidenceScore: 1, usedByAgentsJson: {}, mapsToJson: {}, humanReviewRequired: false,
    createdAt: at, updatedAt: at,
    ...overrides,
  };
}

/** A complete KnowledgeExtractionBatch. A batch counts as real-model work only
 *  when status is "completed" AND modelProvider is set and not "mock"
 *  (ExtractionQualityService.ts:50). */
function batchFixture(overrides: Partial<KnowledgeExtractionBatch> = {}): KnowledgeExtractionBatch {
  const at = "2026-08-26T00:00:00.000Z";
  return {
    id: "batch_golden_kex", workspaceId: "ws_golden_kex", extractionRunId: "run_golden_kex",
    domainKey: "pricing_policy", batchIndex: 0, questionKeysJson: {}, status: "completed",
    attemptCount: 1, maxAttempts: 3, modelProvider: "deepseek", modelName: "deepseek-chat",
    timeoutMs: 60000, resultJson: {}, createdAt: at, updatedAt: at,
    ...overrides,
  };
}

/** The real pricing_policy batch, straight out of the shipping framework. */
function pricingBatch() {
  const domain = groupQuestionsByDomain().find((item) => item.domainKey === "pricing_policy");
  assert.ok(domain, "fixture: the framework must contain the pricing_policy domain");
  const batch = createQuestionBatches(domain)[0];
  assert.ok(batch, "fixture: pricing_policy must yield at least one batch");
  return batch;
}

async function main() {
  console.log("golden-knowledge-extraction-helpers: pinning batcher + chunker + quality + combiner...\n");

  // === 1. KnowledgeQuestionBatcher ==========================================
  // Use the REAL framework's first domain (correctly typed, deterministic) but
  // slice to 3 questions so the batch math is hand-computable + obvious. The
  // real pipeline is: KnowledgeDomain -> groupQuestionsByDomain (stamps
  // domainKey/domainTitle onto each question) -> createQuestionBatches.
  const realDomain = KNOWLEDGE_QUESTION_FRAMEWORK[0];
  const tinyDomain: KnowledgeDomain = {
    ...realDomain,
    questions: realDomain.questions.slice(0, 3),
  };
  const grouped = groupQuestionsByDomain([tinyDomain])[0]; // the stamped, batchable domain
  const firstThreeKeys = tinyDomain.questions.map((q) => q.questionKey);

  // B1 — batchSize=2 over 3 questions → 2 batches (batch0 has 2, batch1 has 1).
  {
    const batches = createQuestionBatches(grouped, 2);
    assert.strictEqual(batches.length, 2, `B1: 3 questions at batchSize=2 → 2 batches, got ${batches.length}`);
    assert.strictEqual(batches[0].questionKeys.length, 2, "B1: batch 0 has 2 questions");
    assert.strictEqual(batches[1].questionKeys.length, 1, "B1: batch 1 has 1 question");
    assert.strictEqual(batches[0].batchIndex, 0, "B1: batch 0 index is 0");
    assert.strictEqual(batches[1].batchIndex, 1, "B1: batch 1 index is 1");
    assert.deepStrictEqual(batches[0].questionKeys, firstThreeKeys.slice(0, 2), "B1: batch 0 questionKeys in order");
    assert.strictEqual(batches[0].domainKey, tinyDomain.domainKey, "B1: domainKey carried through");
    console.log("  B1 OK: 3 questions / batchSize 2 → batches of [2, 1] with correct indices + keys.");
  }

  // B2 — batchSize larger than question count → 1 batch with everything.
  {
    const batches = createQuestionBatches(grouped, 999);
    assert.strictEqual(batches.length, 1, `B2: batchSize 999 over 3 questions → 1 batch, got ${batches.length}`);
    assert.strictEqual(batches[0].questionKeys.length, 3, "B2: the single batch has all 3 questions");
    console.log("  B2 OK: batchSize > question count → 1 batch with all questions.");
  }

  // B3 — groupQuestionsByDomain preserves domain structure + stamps domainKey.
  {
    assert.strictEqual(grouped.questions.length, 3, "B3: 3 questions in the group");
    assert.strictEqual(grouped.domainKey, tinyDomain.domainKey, "B3: domainKey preserved");
    // Each stamped question carries the domainKey (the batcher relies on this).
    assert.ok(grouped.questions.every((q) => q.domainKey === tinyDomain.domainKey), "B3: every question stamped with domainKey");
    console.log("  B3 OK: groupQuestionsByDomain preserves domain + stamps domainKey on each question.");
  }

  // === 2. DocumentContextRetrievalService ===================================

  // C1 — splitDocumentIntoChunks: a short doc becomes 1 chunk.
  {
    const doc = "Our zari thread pricing is ₹450/kg. MOQ is 500 metres.";
    const chunks = splitDocumentIntoChunks(doc, 900);
    assert.ok(chunks.length >= 1, `C1: short doc → ≥1 chunk, got ${chunks.length}`);
    assert.ok(chunks.join("").includes("₹450/kg"), "C1: the price is preserved in the chunks");
    console.log(`  C1 OK: short doc → ${chunks.length} chunk(s), content preserved.`);
  }

  // C2 — retrieveRelevantDocumentContext: a pricing doc + pricing batch → relevant.
  {
    const doc = "Our zari thread pricing is ₹450/kg. MOQ is 500 metres. We export worldwide.";
    const batch = pricingBatch();
    const result = retrieveRelevantDocumentContext(doc, batch);
    assert.strictEqual(result.hadRelevantContext, true, "C2: pricing doc + pricing batch → hadRelevantContext true");
    assert.ok(result.chunksUsed >= 1, `C2: at least 1 chunk used, got ${result.chunksUsed}`);
    assert.ok(result.contextText.length > 0, "C2: contextText is non-empty");
    assert.ok(result.keywords.length > 0, "C2: keywords extracted");
    console.log(`  C2 OK: relevant retrieval (chunksUsed=${result.chunksUsed}, keywords=${result.keywords.length}).`);
  }

  // C3 — retrieveRelevantDocumentContext: an UNRELATED doc still returns something
  //     (top-2 fallback) but hadRelevantContext reflects low relevance. We just
  //     assert it doesn't crash + returns a contextText (the fallback path).
  {
    const doc = "The weather today is sunny and warm.";
    const batch = pricingBatch();
    const result = retrieveRelevantDocumentContext(doc, batch);
    assert.ok(typeof result.hadRelevantContext === "boolean", "C3: hadRelevantContext is a boolean (no crash)");
    assert.ok(result.contextText.length > 0, "C3: fallback returns non-empty contextText");
    console.log("  C3 OK: unrelated doc → graceful fallback (no crash, returns context).");
  }

  // === 3. ExtractionQualityService ==========================================

  // Q1 — no run + no answers → level "Failed" (the empty/missing case). The
  // numeric score has a small base even without a run; the LOAD-BEARING contract
  // is the LEVEL ("Failed" signals "nothing extracted / run missing"), not an
  // exact score of 0. (Verified the real behavior first — Test-Honesty.)
  {
    const q = calculateExtractionQuality({ answers: [], batches: [] });
    assert.strictEqual(q.level, "Failed", `Q1: no run → level "Failed", got "${q.level}"`);
    assert.ok(q.score >= 0 && q.score <= 100, `Q1: score in [0,100], got ${q.score}`);
    console.log(`  Q1 OK: missing run → level "Failed" (score ${q.score} — the level is the load-bearing signal).`);
  }

  // Q2 — a clean run (10/10 answered, 0 conflicts) scores well + is NOT "Failed".
  // The exact score depends on the full formula (confidence, real-model count,
  // high-priority coverage); rather than assert a brittle exact number, we pin
  // the meaningful contract: a clean run is not "Failed", score is in [0,100],
  // and it scores STRICTLY HIGHER than the same run WITH conflicts (Q3). The
  // real value for this input is ~60 / "Needs Review" (verified, not assumed).
  {
    const q = calculateExtractionQuality({
      run: runFixture({ conflictCount: 0 }),
      answers: [],
      batches: [],
    });
    assert.ok(q.score > 0, `Q2: clean run scores > 0, got ${q.score}`);
    assert.ok(q.score <= 100, `Q2: score never exceeds 100, got ${q.score}`);
    assert.notStrictEqual(q.level, "Failed", `Q2: clean run is not "Failed", got "${q.level}"`);
    console.log(`  Q2 OK: clean run → score ${q.score}, level "${q.level}" (not Failed).`);
  }

  // Q3 — the SAME run WITH conflicts scores STRICTLY LOWER (conflicts are penalized).
  // This is the load-bearing contract: conflicts must hurt the score so a
  // reviewer is signaled. Hand-computed: same input as Q2 but conflictCount=5.
  {
    const clean = calculateExtractionQuality({
      run: runFixture({ conflictCount: 0 }),
      answers: [], batches: [],
    });
    const withConflicts = calculateExtractionQuality({
      run: runFixture({ conflictCount: 5 }),
      answers: [], batches: [],
    });
    assert.ok(withConflicts.score < clean.score, `Q3: conflicts lower the score (${withConflicts.score} < ${clean.score})`);
    // And the conflicted run's level is worse (lexically lower quality tier).
    const tierRank = (l: string) => ({ Excellent: 5, Good: 4, "Needs Review": 3, Weak: 2, Failed: 1 } as Record<string, number>)[l] ?? 0;
    assert.ok(tierRank(withConflicts.level) < tierRank(clean.level), `Q3: conflicted level "${withConflicts.level}" is worse than clean "${clean.level}"`);
    console.log(`  Q3 OK: conflicts penalize (clean ${clean.score}/${clean.level} → conflicted ${withConflicts.score}/${withConflicts.level}).`);
  }

  // Q4 — NEW GUARD (2026-08-26, S30). Removing the phantom fields in this file
  // exposed a hole rather than closing one. `calculateExtractionQuality` builds
  // its score from five positive terms; two of them —
  //   `Math.min(30, averageConfidence * 30)` and `completedReal > 0 ? 10 : 0`
  //   (ExtractionQualityService.ts:74-75)
  // are worth 40 of the 100 points, and NOTHING in this file had ever
  // exercised either. Every case passed `answers: []` and `batches: []`, so
  // both terms contributed zero in every single run. The fixtures LOOKED like
  // they covered it — they set `averageConfidenceScore: 1.0` and
  // `realModelBatches: 1` on the run — but the function never reads those, so
  // the appearance of coverage was the whole problem.
  //
  // Hand-computed, and verified against the real code rather than assumed:
  //   bare (Q2's input): answered 10/10 → 50, confidence 0 → 0,
  //     failedBatch bonus → 10, completedReal → 0. Total 60, "Needs Review".
  //   rich: same 50 + 10, plus confidence 1.0 → 30, plus a real-model batch
  //     → 10. Total 100, and with no conflicts and no failed batches that
  //     clears the "Excellent" gate at ExtractionQualityService.ts:85.
  {
    const bare = calculateExtractionQuality({
      run: runFixture(), answers: [], batches: [],
    });
    const rich = calculateExtractionQuality({
      run: runFixture(),
      answers: [answerFixture({ confidenceScore: 1 })],
      batches: [batchFixture()],
    });
    assert.ok(rich.score > bare.score,
      `Q4: confidence + a real-model batch must raise the score (${rich.score} > ${bare.score})`);
    assert.strictEqual(bare.score, 60, `Q4: the no-evidence run scores exactly 60, got ${bare.score}`);
    assert.strictEqual(rich.score, 100, `Q4: full evidence scores exactly 100, got ${rich.score}`);
    assert.strictEqual(rich.level, "Excellent", `Q4: full evidence is "Excellent", got "${rich.level}"`);

    // And the two terms are INDEPENDENT — a mock provider must not earn the
    // real-model points, which is the difference between a run a customer can
    // trust and a run that never called a model at all.
    const mocked = calculateExtractionQuality({
      run: runFixture(),
      answers: [answerFixture({ confidenceScore: 1 })],
      batches: [batchFixture({ modelProvider: "mock" })],
    });
    assert.strictEqual(mocked.score, 90,
      `Q4: a mock-provider batch earns no real-model points (expected 90, got ${mocked.score})`);
    assert.ok(mocked.score < rich.score,
      "Q4: a mock run must score below a real-model run");
    console.log(`  Q4 OK: evidence moves the score (bare ${bare.score} → real ${rich.score}/${rich.level}, mock ${mocked.score}).`);
  }

  // === 4. buildCombinedSourceText ===========================================

  // S1 — a single source is formatted with a [Source: <title>] header + [URL: <url>]
  // line + the extracted text. (Verified the real format first — Test-Honesty —
  // rather than guessing the header prefix.) The load-bearing contract: the
  // source title, URL, and extracted text are ALL present so a downstream LLM
  // extraction can attribute facts to their source.
  {
    const combined = buildCombinedSourceText([
      sourceFixture({ sourceTitle: "ZariCo site", sourceUrl: "https://zari.example", extractedText: "MOQ 500m" }),
    ]);
    assert.ok(combined.includes("ZariCo site"), `S1: source title present, got: ${combined.slice(0, 80)}`);
    // N-SAFETY-1: the fixture URL is RFC 2606 `.example`, unroutable by
    // construction. The assertion is pinned to the same literal.
    assert.ok(combined.includes("https://zari.example"), "S1: URL included");
    assert.ok(combined.includes("MOQ 500m"), "S1: extracted text included");
    assert.ok(/\[Source:/.test(combined), "S1: a [Source:...] header line is present");
    console.log("  S1 OK: source → [Source: title] + [URL] + text (all attributable).");
  }

  // S2 — multiple sources are joined with a separator (not concatenated raw).
  {
    const combined = buildCombinedSourceText([
      sourceFixture({ id: "src_golden_kex_a", sourceTitle: "A", sourceUrl: "https://a.example", extractedText: "TEXT_A" }),
      sourceFixture({ id: "src_golden_kex_b", sourceTitle: "B", sourceUrl: "https://b.example", extractedText: "TEXT_B" }),
    ]);
    assert.ok(combined.includes("TEXT_A") && combined.includes("TEXT_B"), "S2: both sources' text present");
    assert.ok(combined.includes("---"), "S2: a separator appears between sources");
    console.log("  S2 OK: multiple sources joined with a separator.");
  }

  console.log("\nPASS golden-knowledge-extraction-helpers: batcher (3) + chunker/retrieval (3) + quality (4) + combiner (2).");
}

main().catch((err) => {
  console.error("\nFAIL golden-knowledge-extraction-helpers:", err.message);
  process.exit(1);
});
