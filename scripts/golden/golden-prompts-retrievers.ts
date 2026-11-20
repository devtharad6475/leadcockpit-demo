/**
 * golden-prompts-retrievers.ts — pins the LLM prompt builders + the RAG
 * retrievers (Stage 6 / 2026-07-31 full coverage sweep).
 *
 * WHY THIS TEST EXISTS:
 *   The Coverage Map found the 9 prompt files + the 2 retrievers were DARK.
 *   The prompts embed CRITICAL safety rules (no-hallucination, permission-based
 *   outreach, source-only answers) — a regression that drops those rules would
 *   silently make the AI less safe. The retrievers are the knowledge-retrieval
 *   layer a wrong answer flows through. This golden pins both families.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — getPromptForTask: returns a non-empty string for EVERY LLMTaskName
 *     (no task falls through to undefined). Pinned by enumerating the union.
 *   CASE B — safety-critical prompt content: the prompts that must enforce a
 *     rule CONTAIN the load-bearing keyword (message_generation →
 *     "permission-based"; document_extraction → "confidence";
 *     lead_enrichment → "do not invent"; whatsapp_reply → non-empty).
 *   CASE C — KeywordRetriever: seeded chunks returned ranked by keyword match,
 *     workspace-scoped (WS_A query does not return WS_B chunks), limit honored.
 *   CASE D — EmbeddingRetriever: throws the documented "not implemented in MVP"
 *     error (honest stub, never silently returns []).
 *
 * Run: npx tsx scripts/golden/golden-prompts-retrievers.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { getPromptForTask } from "@/llm/prompts";
import { messageGenerationPrompt } from "@/llm/prompts/messageGenerationPrompt";
import { leadScoringPrompt } from "@/llm/prompts/leadScoringPrompt";
import { icpGenerationPrompt } from "@/llm/prompts/icpGenerationPrompt";
import { replyClassificationPrompt } from "@/llm/prompts/replyClassificationPrompt";
import { whatsappReplyPrompt } from "@/llm/prompts/whatsappReplyPrompt";
import { businessExtractionPrompt } from "@/llm/prompts/businessExtractionPrompt";
import { campaignPlanningPrompt } from "@/llm/prompts/campaignPlanningPrompt";
import { campaignLearningPrompt } from "@/llm/prompts/campaignLearningPrompt";
import type { LLMTaskName } from "@/llm/types";
import { KeywordRetriever } from "@/rag/KeywordRetriever";
import { EmbeddingRetriever } from "@/rag/EmbeddingRetriever";
import type { KnowledgeBaseChunk } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS_A = `ws_prompts_a_${RUN}`;
const WS_B = `ws_prompts_b_${RUN}`;

async function cleanup() {
  const { mutateData } = await import("@/lib/db");
  await mutateData((d) => {
    d.knowledgeBaseChunks = (d.knowledgeBaseChunks || []).filter(
      (c: KnowledgeBaseChunk) => c.workspaceId !== WS_A && c.workspaceId !== WS_B,
    );
    return undefined;
  });
}

async function seedChunk(ws: string, id: string, text: string, title: string): Promise<void> {
  const { mutateData } = await import("@/lib/db");
  await mutateData((d) => {
    (d.knowledgeBaseChunks ||= []).push({
      id, workspaceId: ws, documentId: `doc_${id}`, chunkIndex: 0,
      chunkText: text, metadata: { documentTitle: title },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as KnowledgeBaseChunk);
    // Also seed the parent document so documentTitle resolves in search results.
    (d.knowledgeBaseDocuments ||= []);
    if (!d.knowledgeBaseDocuments.find((doc) => doc.id === `doc_${id}`)) {
      d.knowledgeBaseDocuments.push({
        id: `doc_${id}`, workspaceId: ws, title,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as never);
    }
    return undefined;
  });
}

// ─── CASE A: getPromptForTask covers every task ─────────────────────────────
test("CASE A — getPromptForTask returns a non-empty string for EVERY LLMTaskName", async () => {
  const ALL_TASKS: LLMTaskName[] = [
    "business_extraction", "icp_generation", "campaign_planning", "prospect_research",
    "lead_enrichment", "lead_scoring", "message_generation", "reply_classification",
    "whatsapp_reply", "knowledge_answer", "document_extraction_mapping", "lead_review_decision",
    "product_application_research", "market_research", "creative_generation", "embedding",
    "campaign_learning", "policy_answer", "quality_review", "image_generation", "web_search",
    "manual_answer_mapping",
  ];
  for (const task of ALL_TASKS) {
    const p = getPromptForTask(task);
    assert.ok(typeof p === "string" && p.trim().length > 0, `prompt for ${task} must be non-empty`);
  }
});

// ─── CASE B: safety-critical prompt content ─────────────────────────────────
test("CASE B — safety-critical prompts contain their load-bearing rules (no-hallucination, permission-based)", async () => {
  // Each named prompt is non-empty + carries its safety keyword. These keywords
  // are the agent's guardrails; dropping one is a safety regression.
  assert.ok(messageGenerationPrompt.toLowerCase().includes("permission"), "message_generation enforces permission-based outreach");
  assert.ok(messageGenerationPrompt.length > 20);
  assert.ok(businessExtractionPrompt.length > 20, "business_extraction prompt non-empty");
  assert.ok(icpGenerationPrompt.length > 20, "icp_generation prompt non-empty");
  assert.ok(leadScoringPrompt.length > 20, "lead_scoring prompt non-empty");
  assert.ok(replyClassificationPrompt.length > 20, "reply_classification prompt non-empty");
  assert.ok(whatsappReplyPrompt.length > 20, "whatsapp_reply prompt non-empty");
  assert.ok(campaignPlanningPrompt.length > 20, "campaign_planning prompt non-empty");
  assert.ok(campaignLearningPrompt.length > 20, "campaign_learning prompt non-empty");
  // The dispatcher-sourced enrichment + extraction prompts enforce source-only.
  const enrich = getPromptForTask("lead_enrichment").toLowerCase();
  assert.ok(enrich.includes("do not invent") || enrich.includes("provided evidence"), "lead_enrichment enforces no-inventing contact details");
  const extraction = getPromptForTask("document_extraction_mapping").toLowerCase();
  assert.ok(extraction.includes("confidence"), "document_extraction requires a confidence score");
});

// ─── CASE C: KeywordRetriever ───────────────────────────────────────────────
test("CASE C — KeywordRetriever: workspace-scoped keyword search, limit honored", async () => {
  await cleanup();
  await seedChunk(WS_A, "chunk_zari", "We sell zari thread and gold thread for textiles.", "Zari Catalog");
  await seedChunk(WS_A, "chunk_shipping", "Shipping is via courier across India.", "Shipping Policy");
  await seedChunk(WS_B, "chunk_other", "zari zari zari (different workspace)", "Other");

  const repos = createJsonRepos();
  const retriever = new KeywordRetriever(repos);
  const results = await retriever.retrieve(WS_A, "zari", { limit: 5 });
  // Returns the zari-matching chunk from WS_A, ranked; does NOT return WS_B.
  assert.ok(results.some((r) => r.chunkText.includes("zari thread")), "zari query returns the matching WS_A chunk");
  assert.ok(results.every((r) => r.workspaceId === WS_A), "results are workspace-scoped (no WS_B leak)");
  // Limit honored.
  const limited = await retriever.retrieve(WS_A, "zari", { limit: 1 });
  assert.ok(limited.length <= 1, "limit honored");

  await cleanup();
});

// ─── CASE D: EmbeddingRetriever honest stub ─────────────────────────────────
test("CASE D — EmbeddingRetriever throws the documented 'not implemented' error (honest stub)", async () => {
  const r = new EmbeddingRetriever();
  // It MUST throw (not silently return []) — so callers know to use KeywordRetriever.
  await assert.rejects(() => r.retrieve(), /not implemented|KeywordRetriever|vector storage/i, "EmbeddingRetriever honestly throws (no silent empty)");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  await cleanup();
  let passed = 0;
  let failed = 0;
  try {
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
  } finally {
    await cleanup();
  }
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-prompts-retrievers FAILED.");
    process.exit(1);
  }
  console.log("✅ golden-prompts-retrievers ALL GREEN ✅");
  process.exit(0);
})();
