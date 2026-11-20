/**
 * golden-knowledge-conflicts.ts — pins 2 DARK knowledge-integrity engines
 * (Session 7 Coverage Map, 2026-07-28):
 *   1. ConflictDetectionService.detectKnowledgeConflicts  — regex conflict scan
 *   2. KnowledgeAnswerMergeService.getKnowledgeSourcePriority — authority rank
 *
 * WHY: these decide what facts reach customers. If a conflict regex breaks, two
 * contradictory answers (e.g. "MOQ 500m" vs "no MOQ") silently coexist and the
 * agent quotes whichever it finds first — a no-hallucination violation. If the
 * source-priority rank changes, a website scrape can silently overwrite an
 * owner-approved answer. Both were DARK (no test). This golden pins them.
 *
 * HAND-COMPUTED (anti-cheat — written BEFORE re-reading the impl):
 *
 *   ConflictDetection (detectKnowledgeConflicts):
 *     C1 — payment_terms conflict: "50% advance" vs "100% advance only" → 1 hit.
 *     C2 — moq conflict (zari): "MOQ is 500 metres" vs "No MOQ required" → 1 hit.
 *     C3 — no conflict: two consistent statements → 0 hits.
 *     C4 — each hit has requiresResolution:true + a suggestedQuestion.
 *
 *   Source priority (getKnowledgeSourcePriority) — the authority ladder:
 *     manual_edit(70) > user_answer(65) > whatsapp_unknown(60) > document(50)
 *     > website(40) > agent_inference(20) > system_generated(10) > unknown(0).
 *     C5 — the full ladder is a strict total order (each > the next).
 *     C6 — an unknown source type returns 0 (lowest — never wins).
 *
 * Run: `npm run golden:knowledge-conflicts`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { detectKnowledgeConflicts } from "@/services/ConflictDetectionService";
import { getKnowledgeSourcePriority } from "@/services/KnowledgeAnswerMergeService";

async function main() {
  console.log("golden-knowledge-conflicts: pinning conflict detection + source priority...\n");

  // === ConflictDetection =====================================================

  // C1 — payment_terms conflict.
  {
    const hits = detectKnowledgeConflicts(["We require 50% advance.", "100% advance payment only."]);
    assert.ok(hits.length >= 1, `C1: payment conflict must be detected, got ${hits.length}`);
    assert.strictEqual(hits[0].conflictType, "payment_terms", `C1: conflictType payment_terms, got ${hits[0].conflictType}`);
    assert.strictEqual(hits[0].requiresResolution, true, "C1: requiresResolution true");
    assert.ok(hits[0].suggestedQuestion, "C1: a suggestedQuestion is provided");
    console.log("  C1 OK: payment_terms conflict detected (50% vs 100% advance).");
  }

  // C2 — moq conflict (the zari/textile example from the operator's domain).
  {
    const hits = detectKnowledgeConflicts(["MOQ is 500 metres", "No MOQ required"]);
    assert.ok(hits.length >= 1, `C2: MOQ conflict must be detected, got ${hits.length}`);
    assert.strictEqual(hits[0].conflictType, "moq", `C2: conflictType moq, got ${hits[0].conflictType}`);
    assert.strictEqual(hits[0].requiresResolution, true, "C2: requiresResolution true");
    console.log("  C2 OK: moq conflict detected (500m vs none) — zari/textile domain.");
  }

  // C3 — no conflict: two consistent statements about different topics.
  {
    const hits = detectKnowledgeConflicts(["We sell zari thread.", "We ship pan-India."]);
    assert.strictEqual(hits.length, 0, `C3: consistent statements must yield 0 conflicts, got ${hits.length}`);
    console.log("  C3 OK: consistent statements → 0 conflicts (no false positive).");
  }

  // C4 — empty / single input never conflicts (no pair to compare).
  {
    assert.strictEqual(detectKnowledgeConflicts([]).length, 0, "C4: empty input → 0 conflicts");
    assert.strictEqual(detectKnowledgeConflicts(["only one statement"]).length, 0, "C4: single statement → 0 conflicts");
    console.log("  C4 OK: empty/single input → 0 conflicts.");
  }

  // === Source priority ladder (getKnowledgeSourcePriority) ===================

  // C5 — the full authority ladder is a strict total order. Higher priority
  // NEVER loses to lower (the AGENTS.md "higher-priority never silently
  // overwritten" rule). Hand-computed rank values:
  const ladder: Array<{ src: string; rank: number }> = [
    { src: "manual_edit", rank: 70 },
    { src: "user_answer", rank: 65 },
    { src: "whatsapp_unknown", rank: 60 },
    { src: "document", rank: 50 },
    { src: "website", rank: 40 },
    { src: "agent_inference", rank: 20 },
    { src: "system_generated", rank: 10 },
  ];
  for (const { src, rank } of ladder) {
    assert.strictEqual(getKnowledgeSourcePriority(src as never), rank, `C5: source "${src}" rank = ${rank}, got ${getKnowledgeSourcePriority(src as never)}`);
  }
  // Strict total order: each entry strictly greater than the next.
  for (let i = 0; i < ladder.length - 1; i++) {
    assert.ok(ladder[i].rank > ladder[i + 1].rank, `C5: ${ladder[i].src}(${ladder[i].rank}) > ${ladder[i + 1].src}(${ladder[i + 1].rank})`);
  }
  console.log(`  C5 OK: authority ladder is a strict total order (${ladder.map((l) => `${l.src}:${l.rank}`).join(" > ")}).`);

  // C6 — an unknown source type returns 0 (lowest possible — never wins).
  {
    const unknownRank = getKnowledgeSourcePriority("totally_made_up_source" as never);
    assert.strictEqual(unknownRank, 0, `C6: unknown source type → 0 (lowest), got ${unknownRank}`);
    assert.ok(unknownRank < ladder[ladder.length - 1].rank, "C6: unknown (0) is lower than the lowest known source");
    console.log("  C6 OK: unknown source type → rank 0 (never wins over a known source).");
  }

  console.log("\nPASS golden-knowledge-conflicts: ConflictDetection (4 cases) + source-priority ladder (2 cases).");
}

main().catch((err) => {
  console.error("\nFAIL golden-knowledge-conflicts:", err.message);
  process.exit(1);
});
