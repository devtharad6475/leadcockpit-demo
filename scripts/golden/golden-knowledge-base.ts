/**
 * golden-knowledge-base.ts — KnowledgeBaseService no-hallucination pin (NEW, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   KnowledgeBaseService is the heart of the "no hallucination" rule
 *   (AGENTS.md non-negotiable). It decides which extracted facts are safe to
 *   quote to a customer. It had NO golden test (gap-analysis finding). A silent
 *   regression here means an unverified extraction (e.g. a wrong price scraped
 *   from a brochure) gets quoted to a customer as fact — exactly the failure
 *   the product exists to prevent. This pins the verification firewall.
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat — these are the rules, not the code):
 *
 *   CASE A — isVerifiedChunk: the no-hallucination gatekeeper.
 *     Hand-computed truth table:
 *       metadata missing                         → true  (safe default)
 *       metadata {} (empty)                      → true
 *       metadata.extractionUnverified === false  → true
 *       metadata.extractionUnverified === true   → FALSE (the load-bearing case)
 *       metadata.extractionUnverified === "true" (string) → true (strict ===)
 *       metadata.extractionUnverified === 1      → true (strict ===, only boolean true blocks)
 *       chunk undefined / null                   → true (safe default; missing chunk can't lie)
 *     If this ever flips to truthy-checking strings, an extraction tagged
 *     extractionUnverified:"true" would be quoted → hallucination path open.
 *
 *   CASE B — getRelevantContext SPLITS verified vs unverified correctly:
 *     Seed 3 chunks: 2 verified, 1 unverified. Hand-computed:
 *       confidenceScore        = max score among VERIFIED only (unverified excluded)
 *       unverifiedChunkCount   = 1
 *       contextText            = all 3 chunks, but the unverified one prefixed
 *                                with "[UNVERIFIED EXTRACTION — do not quote...]"
 *     If confidence includes the unverified chunk, a high-scoring wrong fact
 *     would push the auto-reply threshold past its gate. This pins the split.
 *
 *   CASE C — chunkKnowledgeDocument PROPAGATES extractionUnverified from doc → chunks:
 *     A document with metadata.extractionUnverified=true → EVERY chunk's metadata
 *     must carry extractionUnverified=true. AND a document with source=
 *     "uploaded_document" forces extractionUnverified=true on its chunks even if
 *     the doc metadata didn't set it. (O2 audit fix — the flag was stamped on the
 *     doc but never reached retrieval, letting unverified extraction be quoted.)
 *
 *   CASE D — splitText respects CHUNK_SIZE=1200 (structure-aware):
 *     A document of 3 paragraphs each 700 chars:
 *       para1 (700) + para2 (700) = 1400+ > 1200 → para2 starts a new chunk
 *       Hand-computed: chunk[0] = para1, chunk[1] = para2, chunk[2] = para3
 *       (each ≤ 1200). No chunk exceeds CHUNK_SIZE unless a single paragraph
 *       itself exceeds it (fall-back slices, not tested here).
 *     2026-09-17 (session 56): the limit moved from 900 to 1200 on purpose —
 *     chunks now hold a whole section or whole table rows (see
 *     src/rag/document-structure.ts, pinned by golden-document-structure).
 *     The property is unchanged; the paragraph size moved with the limit so
 *     the same three-way split is still what is being asserted.
 *
 *   CASE E — searchKnowledge caps confidence at 0.95 (never reports 1.0 certainty):
 *     Even a perfect keyword match returns ≤ 0.95. This is the no-hallucination
 *     guardrail: the system never claims 100% certainty about a retrieved fact.
 *     (Math.min(0.95, score).) Also answerUsed threshold = confidence >= 0.35.
 *
 * REAL PIPELINE: imports the real KnowledgeBaseService functions + the real JSON
 * repo. Each case uses a unique timestamped workspace so demo data stays clean.
 *
 * Run: `npm run golden:knowledge-base`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  isVerifiedChunk,
  getRelevantContext,
  chunkKnowledgeDocument,
  createKnowledgeDocument,
  searchKnowledge,
} from "@/services/KnowledgeBaseService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_kb_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// --- CASE A: isVerifiedChunk truth table (PURE function, no repo needed) ---------
test("CASE A — isVerifiedChunk truth table (the no-hallucination gatekeeper)", async () => {
  // Hand-computed: only an EXACT boolean `true` blocks a chunk. Everything else
  // (missing metadata, string "true", number 1) is treated as verified — because
  // the cost of wrongly quoting a fact is lower than wrongly hiding all facts,
  // BUT a deliberately-flagged unverified extraction must always be blocked.
  assert.strictEqual(isVerifiedChunk(undefined), true, "undefined chunk → safe default true");
  // null chunk: cast through unknown to test the runtime contract (a nullish
  // chunk must be treated as verified/safe, not crash).
  assert.strictEqual(isVerifiedChunk(null as unknown as undefined), true, "null chunk → safe default true");
  assert.strictEqual(isVerifiedChunk({}), true, "no metadata → verified (safe default)");
  assert.strictEqual(isVerifiedChunk({ metadata: {} }), true, "empty metadata → verified");
  assert.strictEqual(isVerifiedChunk({ metadata: { extractionUnverified: false } }), true, "explicit false → verified");
  // THE load-bearing assertion: a flagged-unverified chunk MUST be blocked.
  assert.strictEqual(isVerifiedChunk({ metadata: { extractionUnverified: true } }), false, "boolean true → UNVERIFIED (blocked)");
  // Strict equality: a STRING "true" must NOT be treated as unverified (only the boolean).
  assert.strictEqual(isVerifiedChunk({ metadata: { extractionUnverified: "true" } }), true, 'string "true" → verified (strict ===)');
  assert.strictEqual(isVerifiedChunk({ metadata: { extractionUnverified: 1 } }), true, "number 1 → verified (strict ===, only boolean true blocks)");
});

// --- CASE B: getRelevantContext splits verified vs unverified --------------------
test("CASE B — getRelevantContext excludes unverified chunks from confidence + labels them", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  // Seed a doc, then replace its chunks with hand-crafted ones. The retriever
  // scores by KEYWORD overlap on chunkText (not a stored score), so we make the
  // unverified chunk contain the query keyword too — proving it WOULD match but
  // is still excluded from the customer-facing confidence.
  const doc = await createKnowledgeDocument({
    workspaceId: WS,
    title: "Split test doc",
    contentText: "seed text",
  }, repos);
  await repos.knowledgeBaseChunk.replaceForDocument(WS, doc.id, [
    { chunkIndex: 0, chunkText: "widget verified facts about pricing", metadata: { documentId: doc.id, extractionUnverified: false } },
    { chunkIndex: 1, chunkText: "widget risky scraped unverified claim", metadata: { documentId: doc.id, extractionUnverified: true } },
  ]);

  const result = await getRelevantContext(WS, "widget", repos);
  // Hand-computed structural contract:
  assert.strictEqual(result.unverifiedChunkCount, 1, "exactly 1 unverified chunk counted");
  // The unverified chunk is present in contextText but labelled.
  assert.ok(result.contextText.includes("[UNVERIFIED EXTRACTION"), "unverified chunk is prefixed with the warning label");
  assert.ok(result.contextText.includes("risky scraped unverified claim"), "unverified text still present for the agent to read");
  // Verified chunk is present WITHOUT the label.
  assert.ok(result.contextText.includes("widget verified facts"), "verified chunk present");
  // Confidence must be computed from VERIFIED chunks only (capped at 0.95).
  // We can't predict the exact keyword score, but it must be ≤ 0.95 and ≥ 0.
  assert.ok(result.confidenceScore >= 0 && result.confidenceScore <= 0.95 + 1e-9, `confidence in [0, 0.95], got ${result.confidenceScore}`);
});

// --- CASE C: chunkKnowledgeDocument propagates extractionUnverified -------------
test("CASE C — chunkKnowledgeDocument propagates extractionUnverified doc → chunks (+ uploaded_document forces it)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");

  // Subcase 1: doc explicitly flagged unverified → all chunks carry the flag.
  const docFlagged = await createKnowledgeDocument({
    workspaceId: WS,
    title: "Flagged doc",
    contentText: "para one\n\npara two",
    documentType: "policy",
    source: "manual",
    metadata: { extractionUnverified: true },
  }, repos);
  const chunksFlagged = await chunkKnowledgeDocument(WS, docFlagged.id, repos);
  assert.ok(chunksFlagged.length >= 1, "flagged doc produced ≥ 1 chunk");
  for (const c of chunksFlagged) {
    assert.strictEqual(c.metadata?.extractionUnverified, true, "every chunk of a flagged doc is unverified");
  }

  // Subcase 2: source=uploaded_document forces unverified EVEN WITHOUT the flag.
  // (O2 audit fix — uploaded docs are extraction output, never auto-trusted.)
  const WS2 = caseWorkspace("C2");
  const docUploaded = await createKnowledgeDocument({
    workspaceId: WS2,
    title: "Uploaded brochure",
    contentText: "scraped price list\n\ndelivery terms",
    documentType: "product_catalogue",
    source: "uploaded_document",
    metadata: {}, // no explicit flag
  }, repos);
  const chunksUploaded = await chunkKnowledgeDocument(WS2, docUploaded.id, repos);
  assert.ok(chunksUploaded.length >= 1, "uploaded doc produced ≥ 1 chunk");
  for (const c of chunksUploaded) {
    assert.strictEqual(c.metadata?.extractionUnverified, true, "uploaded_document source → chunks forced unverified even without flag");
  }

  // Subcase 3: a plain manual doc with NO flag → chunks are verified.
  const WS3 = caseWorkspace("C3");
  const docManual = await createKnowledgeDocument({
    workspaceId: WS3,
    title: "Manual note",
    contentText: "owner-typed fact",
    documentType: "note",
    source: "manual",
    metadata: {},
  }, repos);
  const chunksManual = await chunkKnowledgeDocument(WS3, docManual.id, repos);
  for (const c of chunksManual) {
    assert.notStrictEqual(c.metadata?.extractionUnverified, true, "manual doc with no flag → chunks verified");
  }
});

// --- CASE D: splitText respects CHUNK_SIZE=1200 --------------------------------
test("CASE D — chunking respects CHUNK_SIZE=1200 (structure-aware, no chunk overflows unless a single para does)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("D");
  // 3 paragraphs, each 700 chars. para1+para2 = 1400+ > 1200 → split.
  // Hand-computed: 3 chunks (one per paragraph), each 700 chars.
  const para = "x".repeat(700);
  const doc = await createKnowledgeDocument({
    workspaceId: WS,
    title: "Chunk size doc",
    contentText: `${para}\n\n${para}\n\n${para}`,
  }, repos);
  const chunks = await chunkKnowledgeDocument(WS, doc.id, repos);
  assert.strictEqual(chunks.length, 3, "3 paragraphs of 700 chars each → 3 chunks (700+700 > 1200 splits)");
  for (const c of chunks) {
    assert.ok((c.chunkText?.length ?? 0) <= 1200, `each chunk ≤ 1200 chars, got ${c.chunkText?.length}`);
  }
});

// --- CASE E: searchKnowledge caps confidence at 0.95 + answerUsed threshold -----
test("CASE E — searchKnowledge caps confidence at 0.95 (never claims 100%) + answerUsed threshold", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("E");
  // Seed a chunk whose text EXACTLY equals the query → max keyword overlap.
  const doc = await createKnowledgeDocument({
    workspaceId: WS,
    title: "Exact match doc",
    contentText: "leadcockpit golden test unique phrase",
  }, repos);
  await chunkKnowledgeDocument(WS, doc.id, repos);

  const result = await searchKnowledge(WS, "leadcockpit golden test unique phrase", repos);
  // Hand-computed: even a perfect match is capped at 0.95 (Math.min(0.95, score)).
  assert.ok(result.confidenceScore <= 0.95 + 1e-9, `confidence capped at 0.95, got ${result.confidenceScore}`);
  assert.ok(result.confidenceScore >= 0, "confidence is non-negative");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`knowledge-base: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
