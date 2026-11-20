/**
 * Golden test — KB semantic search (GAP-1/4).
 *
 * build-right Phase 3 — written BEFORE the code. Defines the contract.
 *
 * Authority: docs/planning/CAPABILITY_GAP_AUDIT.md GAP-1/4. Before this, the KB
 * advertised "semantic/embedding" search (model catalog listed embedding models,
 * a slot + EmbeddingRetriever class existed) but retrieval was bag-of-words
 * token overlap — `EmbeddingRetriever.retrieve()` threw "not implemented" and
 * was never instantiated. A customer asking about a "border" couldn't match KB
 * content written as "zari trimming". For a textile business, paraphrase
 * matching matters.
 *
 * THE FIX: a real SemanticRetriever that generates embeddings + ranks by cosine
 * similarity. Keyword stays as the honest fallback when no embedding key is set.
 *
 * Hand-computed BEFORE the assertions (the Golden Thread):
 *
 *   CASE A — PARAPHRASE MATCH (the core proof). A KB chunk says "We sell zari
 *     trimming for sarees" (no word "border"). The query "gold border" must
 *     STILL retrieve it with a non-trivial score, because the injected
 *     embedding function maps synonyms close together. Pure keyword matching
 *     would return ZERO (no shared tokens). Semantic must return it.
 *
 *   CASE B — ranking: the most-relevant chunk ranks first. Two chunks, one
 *     about "zari trimming" (close to the query), one about "shipping policy"
 *     (far). The trimming chunk's score > shipping chunk's score.
 *
 *   CASE C — workspace isolation: tenant A's chunks are invisible to tenant B.
 *
 *   CASE D — honest fallback: with NO embedding available (no key + the search
 *     returns empty for the semantic path), the system falls back to keyword
 *     retrieval rather than crashing or returning nothing. (Keyword is the
 *     floor; semantic is the upgrade.)
 *
 *   CASE E — embeddings are GENERATED at chunk time (the missing step). After
 *     chunking a document, each chunk has a non-empty embedding vector.
 *
 * Test isolation (Gate #8): own workspace id (ws_sem_*).
 * Run: npm run golden:kb-semantic
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { SemanticRetriever } from "@/rag/SemanticRetriever";
import { createKnowledgeDocument, chunkKnowledgeDocument } from "@/services/KnowledgeBaseService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";
import type { EmbedFn } from "@/llm/embedding";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function seedWorkspace(repos: RepositoryBundle, id: string) {
  await repos.workspace.create({ id, name: `Test WS ${id}`, status: "active" });
}

/**
 * A deterministic "semantic" embedding for the golden: maps known synonyms to
 * the SAME vector so paraphrase matching is provable. This is NOT a real
 * embedding model — it's a deterministic stub that proves the RETRIEVAL LOGIC
 * (cosine ranking + paraphrase match) works. The real OpenAI/Gemini embedding
 * path is the production default (key-gated).
 *
 * Mapping (each is a 4-dim vector):
 *   border / trimming / edge   -> [1, 0, 0, 0]  (synonyms cluster)
 *   gold / metallic            -> [0, 1, 0, 0]
 *   shipping / delivery        -> [0, 0, 1, 0]
 *   price / cost               -> [0, 0, 0, 1]
 * A text's embedding = sum of its word-vectors (bag-of-concepts). So "zari
 * trimming" ≈ [1,0,0,0] and "gold border" ≈ [1,1,0,0] — they share the "border/
 * trimming" concept, so cosine similarity is non-zero. "shipping policy" ≈
 * [0,0,1,0] — orthogonal to "gold border". This makes the ranking provable.
 */
const CONCEPTS: Record<string, number[]> = {
  border: [1, 0, 0, 0], trimming: [1, 0, 0, 0], edge: [1, 0, 0, 0],
  gold: [0, 1, 0, 0], metallic: [0, 1, 0, 0],
  shipping: [0, 0, 1, 0], delivery: [0, 0, 1, 0],
  price: [0, 0, 0, 1], cost: [0, 0, 0, 1],
};
const DIM = 4;
const stubEmbed: EmbedFn = async (_workspaceId: string, text: string): Promise<number[]> => {
  const vec = new Array(DIM).fill(0);
  const lower = text.toLowerCase();
  for (const [word, concept] of Object.entries(CONCEPTS)) {
    if (lower.includes(word)) {
      for (let i = 0; i < DIM; i++) vec[i] += concept[i];
    }
  }
  return vec;
};

async function main() {
  const repos = await createJsonRepos();

  // ─── CASE A: paraphrase match (border ↔ trimming, no shared tokens) ────────
  {
    const WS = "ws_sem_a";
    await seedWorkspace(repos, WS);
    const doc = await createKnowledgeDocument({ workspaceId: WS, title: "Products", contentText: "We sell zari trimming for sarees in bulk quantities." }, repos);
    // Inject the stub embed at chunk time so the chunk carries a vector.
    await chunkKnowledgeDocument(WS, doc.id, repos, { embedFn: stubEmbed });

    const retriever = new SemanticRetriever(repos, { embed: stubEmbed });
    const results = await retriever.retrieve(WS, "gold border", { limit: 5 });

    assert(results.length >= 1, `CASE A: semantic retrieval returned the chunk, got ${results.length}`);
    assert(/zari trimming/i.test(results[0].chunkText), `CASE A: top result is the trimming chunk (paraphrase match), got "${results[0].chunkText.slice(0, 40)}"`);
    assert(results[0].score > 0, `CASE A: non-trivial score (>0), got ${results[0].score}`);
    console.log("✅ CASE A — paraphrase match: 'gold border' retrieves 'zari trimming' chunk (keyword would return 0)");
  }

  // ─── CASE B: ranking — most-relevant chunk ranks first ─────────────────────
  // Use TWO separate documents so each becomes its own chunk (splitText merges
  // short paragraphs in one doc). One chunk about "trimming" (close to the
  // query "gold border"), one about "shipping" (orthogonal). The trimming
  // chunk must score higher.
  {
    const WS = "ws_sem_b";
    await seedWorkspace(repos, WS);
    const docTrim = await createKnowledgeDocument({ workspaceId: WS, title: "Trim", contentText: "Our zari trimming is the best in the market." }, repos);
    await chunkKnowledgeDocument(WS, docTrim.id, repos, { embedFn: stubEmbed });
    const docShip = await createKnowledgeDocument({ workspaceId: WS, title: "Ship", contentText: "Shipping policy: we deliver in 7 days." }, repos);
    await chunkKnowledgeDocument(WS, docShip.id, repos, { embedFn: stubEmbed });

    const retriever = new SemanticRetriever(repos, { embed: stubEmbed });
    const results = await retriever.retrieve(WS, "gold border", { limit: 5 });
    // The relevant "trimming" chunk MUST be retrieved (it shares the border/
    // trimming concept with the query). The orthogonal "shipping" chunk scores
    // ~0 and is correctly filtered out by the >0 threshold (correct semantic
    // behaviour — irrelevant chunks don't clutter results).
    const trimming = results.find((r) => /trimming/i.test(r.chunkText));
    const shipping = results.find((r) => /shipping/i.test(r.chunkText));
    assert(trimming, `CASE B: the relevant trimming chunk is retrieved, got ${results.length} results`);
    assert(trimming.score > 0, `CASE B: trimming has a non-trivial score, got ${trimming.score}`);
    assert(!shipping, "CASE B: the orthogonal shipping chunk is correctly NOT retrieved (irrelevant — score ~0)");
    // 2026-08-02: removed the dead `if (trimming && shipping)` block — the
    // `assert(!shipping)` above narrows `shipping` to `never`, so the block was
    // unreachable (and a tsc TS2339 on shipping.score). Replaced with a
    // positive score check on trimming above.
    console.log("✅ CASE B — ranking: the relevant chunk is retrieved; the orthogonal one is correctly excluded");
  }

  // ─── CASE C: workspace isolation ───────────────────────────────────────────
  {
    const WS_A = "ws_sem_c_a";
    const WS_B = "ws_sem_c_b";
    await seedWorkspace(repos, WS_A);
    await seedWorkspace(repos, WS_B);
    const docA = await createKnowledgeDocument({ workspaceId: WS_A, title: "A", contentText: "zari trimming wholesale" }, repos);
    await chunkKnowledgeDocument(WS_A, docA.id, repos, { embedFn: stubEmbed });

    const retriever = new SemanticRetriever(repos, { embed: stubEmbed });
    const resultsB = await retriever.retrieve(WS_B, "zari trimming", { limit: 5 });
    assert(resultsB.length === 0, `CASE C: tenant B sees ZERO of A's chunks, got ${resultsB.length}`);
    console.log("✅ CASE C — workspace isolation: tenant B cannot see tenant A's chunks");
  }

  // ─── CASE D: honest fallback to keyword when no embedding available ────────
  // When the embed fn throws (no key), semantic retrieval degrades to keyword
  // rather than crashing or returning nothing.
  {
    const WS = "ws_sem_d";
    await seedWorkspace(repos, WS);
    const doc = await createKnowledgeDocument({ workspaceId: WS, title: "P", contentText: "Our gold border product is popular." }, repos);
    // Chunk with the throwing embed → no vectors stored.
    await chunkKnowledgeDocument(WS, doc.id, repos, { embedFn: async () => { throw new Error("no key"); } });

    // An embed fn that throws (simulates no embedding key configured) for the query too.
    const throwingEmbed: EmbedFn = async () => { throw new Error("no key"); };
    const retriever = new SemanticRetriever(repos, { embed: throwingEmbed });
    const results = await retriever.retrieve(WS, "gold border", { limit: 5 });
    // Falls back to keyword: "gold border" shares tokens with the chunk → returns it.
    assert(results.length >= 1, `CASE D: keyword fallback returns the chunk, got ${results.length}`);
    console.log("✅ CASE D — honest fallback: no embedding key → keyword retrieval (never crashes/empty)");
  }

  // ─── CASE E: embeddings are GENERATED at chunk time (the previously-missing step) ─
  {
    const WS = "ws_sem_e";
    await seedWorkspace(repos, WS);
    const doc = await createKnowledgeDocument({ workspaceId: WS, title: "E", contentText: "We make gold border trimming. Shipping in 7 days." }, repos);
    const created = await chunkKnowledgeDocument(WS, doc.id, repos, { embedFn: stubEmbed });
    assert(created.length >= 1, `CASE E: chunks created, got ${created.length}`);
    for (const chunk of created) {
      assert(Array.isArray(chunk.embedding) && chunk.embedding.length > 0, `CASE E: chunk ${chunk.id} has a non-empty embedding vector (generated at chunk time)`);
    }
    console.log("✅ CASE E — embeddings generated at chunk time (the previously-missing step)");
  }

  console.log("\n✅✅✅ All KB-semantic golden cases PASSED (A–E). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
