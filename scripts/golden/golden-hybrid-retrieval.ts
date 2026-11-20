/**
 * golden-hybrid-retrieval.ts — keyword AND vectors, fused (2026-09-17, session 56).
 *
 * WHY HYBRID IS THE POINT. Each search alone loses a real question:
 *   - vectors alone lose exact tokens (a GSTIN, an article code, "Rs 295"):
 *     an embedding blurs a rare string into the sentence around it;
 *     - keywords alone lose every paraphrase ("gold border" vs "zari trimming").
 * A knowledge base gets both kinds of question, so both searches run and the
 * results are fused by Reciprocal Rank Fusion.
 *
 *   CASE A — the paraphrase question: found by vectors, missed by keywords.
 *   CASE B — the exact-token question: found by keywords, missed by vectors.
 *            Both A and B must work through ONE retriever, or it is not hybrid.
 *   CASE C — RRF: a chunk in BOTH lists outranks one that merely tops keyword.
 *   CASE D — the score a caller reads stays a confidence (max of the two), not
 *            the RRF weight (~0.016 — below every threshold in the product).
 *   CASE E — vectors are only compared with their own model's vectors.
 *   CASE F — honest fallback: no embedder, embedder throwing, or no vectors at
 *            all → keyword results, never a crash and never an empty answer.
 *   CASE G — the pgvector index, when present, is used instead of loading the
 *            workspace, its ids are looked up, and a stale id is not a match.
 *   CASE H — toVectorLiteral: only a finite, correctly-sized vector is written.
 *
 * Run: npx tsx scripts/golden/golden-hybrid-retrieval.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { SemanticRetriever } from "@/rag/SemanticRetriever";
import { toVectorLiteral, vectorStoreAvailable, resetVectorStoreAvailabilityCache } from "@/rag/vector-store";
import { EMBEDDING_DIMENSIONS } from "@/llm/embedding";
import type { KnowledgeBaseChunk } from "@/lib/types";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const MODEL = "openai:text-embedding-3-small";

/**
 * A toy "meaning" space: three axes the fixture documents differ on. The stub
 * embedder scores a text on each axis by the concepts it mentions, in whatever
 * words — which is exactly what a real embedding does and what keyword matching
 * cannot do.
 */
const AXES: Array<[string, string[]]> = [
  ["trimming", ["zari", "trimming", "gold border", "lace", "kinari"]],
  ["delivery", ["dispatch", "courier", "delivery", "ships", "transit"]],
  ["tax", ["gstin", "gst", "tax", "invoice", "hsn"]],
];
function toyVector(text: string): number[] {
  const lower = text.toLowerCase();
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  AXES.forEach(([, words], axis) => {
    v[axis] = words.filter((w) => lower.includes(w)).length;
  });
  if (v.every((n) => n === 0)) v[EMBEDDING_DIMENSIONS - 1] = 0.001; // never the zero vector
  return v;
}

type Fixture = { id: string; text: string; model?: string | null; vector?: number[] };

/** The keyword score the product uses: the fraction of the query's words present. */
function keywordScore(query: string, text: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term)).length / terms.length;
}

function fakeRepos(fixtures: Fixture[], spy: string[] = []) {
  const chunks: KnowledgeBaseChunk[] = fixtures.map((f, index) => ({
    id: f.id,
    workspaceId: "ws",
    documentId: "doc_1",
    chunkIndex: index,
    chunkText: f.text,
    embedding: f.vector === undefined ? toyVector(f.text) : f.vector,
    metadata: f.model === null ? {} : { embeddingModel: f.model ?? MODEL },
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  }));
  const repos = {
    // Retrieval also checks parent documents to exclude legacy agent guidance.
    knowledgeBaseDocument: {
      listByWorkspace: async () => [{ id: "doc_1", documentType: "company_profile", source: "manual" }],
    },
    knowledgeBaseChunk: {
      listByWorkspace: async () => {
        spy.push("listByWorkspace");
        return chunks;
      },
      listByIds: async (_ws: string, ids: string[]) => {
        spy.push(`listByIds:${ids.join(",")}`);
        return chunks.filter((c) => ids.includes(c.id));
      },
      searchByKeyword: async (_ws: string, query: string, limit = 5) => {
        spy.push("searchByKeyword");
        return chunks
          .map((chunk) => ({ ...chunk, score: keywordScore(query, chunk.chunkText) }))
          .filter((row) => row.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      },
    },
  };
  return repos as unknown as RepositoryBundle;
}

const stubEmbed = async (_ws: string, text: string) => toyVector(text);

const DOCS: Fixture[] = [
  { id: "c_zari", text: "Our zari kinari is woven with a real silver core and a gold finish." },
  { id: "c_gstin", text: "Registration details: GSTIN 24ABCDE1234F1Z5, HSN code 5809." },
  { id: "c_ship", text: "Orders are dispatched by courier and reach most cities in transit within four days." },
  { id: "c_noise", text: "The partners visit the Fulpada works every Tuesday morning." },
];

test("CASE A — a paraphrase is found although it shares no word with the question", async () => {
  const repos = fakeRepos(DOCS);
  // Not one of these words appears in the chunk that answers it.
  const question = "lace trimming";
  // Sanity: the keyword half genuinely cannot answer this, or the case proves nothing.
  const keywordOnly = await repos.knowledgeBaseChunk.searchByKeyword("ws", question, 5);
  assert.ok(!keywordOnly.some((r) => r.id === "c_zari"), "fixture: keyword must MISS the paraphrase");

  const hits = await new SemanticRetriever(repos, { embed: stubEmbed, embeddingModel: MODEL }).retrieve("ws", question, { limit: 3 });
  assert.strictEqual(hits[0]?.id, "c_zari", `the paraphrase must be found and ranked first. Got: ${hits.map((h) => h.id).join(", ")}`);
});

test("CASE B — an exact token is found although vectors rank it nowhere", async () => {
  const repos = fakeRepos(DOCS);
  const question = "24ABCDE1234F1Z5";
  // The stub embedder scores this question on no axis, so vectors cannot find it.
  const hits = await new SemanticRetriever(repos, { embed: stubEmbed, embeddingModel: MODEL }).retrieve("ws", question, { limit: 3 });
  assert.strictEqual(hits[0]?.id, "c_gstin", `the exact string must still be found. Got: ${hits.map((h) => h.id).join(", ")}`);
});

test("CASE C — RRF: found by both beats topping only one list", async () => {
  // "tuesday morning dispatch": keyword ranks c_noise first (2 of 3 words) and
  // c_ship second (1 of 3); vectors rank ONLY c_ship. Fusion must lift c_ship
  // above the chunk that happens to top the keyword list alone.
  const repos = fakeRepos(DOCS);
  const question = "tuesday morning dispatch";
  const keywordOnly = await repos.knowledgeBaseChunk.searchByKeyword("ws", question, 5);
  assert.strictEqual(keywordOnly[0]?.id, "c_noise", "fixture: keyword alone must put the weaker chunk first");

  const hits = await new SemanticRetriever(repos, { embed: stubEmbed, embeddingModel: MODEL }).retrieve("ws", question, { limit: 3 });
  assert.strictEqual(hits[0]?.id, "c_ship", `the chunk both searches agree on must win. Got: ${hits.map((h) => h.id).join(", ")}`);
  assert.ok(hits.some((h) => h.id === "c_noise"), "the keyword-only match must still be present, just lower");
});

test("CASE D — the score stays a confidence, not the fusion weight", async () => {
  const repos = fakeRepos(DOCS);
  const hits = await new SemanticRetriever(repos, { embed: stubEmbed, embeddingModel: MODEL }).retrieve("ws", "gold border", { limit: 3 });
  const top = hits[0];
  assert.ok(
    top.score > 0.35,
    `callers threshold this field (getRelevantContext: answerUsed at 0.35). An RRF weight (~0.016) here would silently ` +
      `turn every answer into "not confident enough". Got ${top.score}`,
  );
  assert.ok(top.score <= 1, `a confidence must stay in [0, 1]. Got ${top.score}`);
});

test("CASE E — a vector from another model is never compared", async () => {
  // "lace trimming" shares no word with the chunk, so ONLY the vector half can
  // find it — which makes the model label the whole decision.
  const zari = { id: "c_zari", text: "Our zari kinari is woven with a real silver core and a gold finish." };
  const question = "lace trimming";

  const sameModel = fakeRepos([zari, { id: "c_noise", text: "The partners visit the Fulpada works every Tuesday morning." }]);
  const found = await new SemanticRetriever(sameModel, { embed: stubEmbed, embeddingModel: MODEL }).retrieve("ws", question, { limit: 3 });
  assert.deepStrictEqual(found.map((h) => h.id), ["c_zari"], "control: with a matching label the chunk IS found by meaning");

  const otherModel = fakeRepos([
    { ...zari, model: "gemini:gemini-embedding-001" },
    { id: "c_noise", text: "The partners visit the Fulpada works every Tuesday morning." },
  ]);
  const hits = await new SemanticRetriever(otherModel, { embed: stubEmbed, embeddingModel: MODEL }).retrieve("ws", question, { limit: 3 });
  assert.deepStrictEqual(
    hits.map((h) => h.id),
    [],
    "cosine between two models' vectors is noise that looks like a number. A chunk labelled with another model must not " +
      "be ranked — and with no keyword match either, the honest answer is nothing.",
  );
});

test("CASE F — honest fallback: no embedder, a failing embedder, or no vectors", async () => {
  const repos = fakeRepos(DOCS);
  const failing = new SemanticRetriever(repos, {
    embed: async () => {
      throw new Error("over the spend cap");
    },
    embeddingModel: MODEL,
  });
  const hits = await failing.retrieve("ws", "zari kinari", { limit: 3 });
  assert.strictEqual(hits[0]?.id, "c_zari", "a failing embedder must fall back to keyword, not crash or return nothing");

  const empty = new SemanticRetriever(repos, { embed: async () => [], embeddingModel: MODEL });
  assert.strictEqual((await empty.retrieve("ws", "zari kinari", { limit: 3 }))[0]?.id, "c_zari", "an empty vector is not a real embedding");

  const noVectors = fakeRepos(DOCS.map((d) => ({ ...d, vector: [] })));
  const none = await new SemanticRetriever(noVectors, { embed: stubEmbed, embeddingModel: MODEL }).retrieve("ws", "zari kinari", { limit: 3 });
  assert.strictEqual(none[0]?.id, "c_zari", "chunks without vectors are still findable by keyword");
});

test("CASE G — with a pgvector index: ids are looked up, the workspace is not loaded", async () => {
  const spy: string[] = [];
  const repos = fakeRepos(DOCS, spy);
  // Stand in for the database index: it answers with ids and similarities, and
  // includes one id whose chunk no longer exists (a stale index row).
  const retriever = new SemanticRetriever(repos, {
    embed: stubEmbed,
    embeddingModel: MODEL,
    vectorSearch: async (_ws, model, _vector, limit) => {
      spy.push(`index:${model}:${limit}`);
      return [
        { chunkId: "c_zari", similarity: 0.91 },
        { chunkId: "c_deleted", similarity: 0.88 },
      ];
    },
  });
  const hits = await retriever.retrieve("ws", "gold border", { limit: 3 });
  assert.ok(spy.some((s) => s.startsWith(`index:${MODEL}:`)), "the index must be asked, and told which model's vectors to compare");
  assert.ok(spy.some((s) => s.startsWith("listByIds:")), "the ids the index returned must be fetched by id");
  assert.ok(
    !spy.includes("listByWorkspace"),
    "THE POINT OF THE INDEX: the whole workspace was loaded into memory anyway, so the index bought nothing",
  );
  assert.strictEqual(hits[0]?.id, "c_zari");
  assert.ok(!hits.some((h) => h.id === "c_deleted"), "a stale index row is not a match — there is no text behind it");
  assert.strictEqual(hits[0]?.score, 0.91, "the similarity the index computed must be the score reported");

  // And when there is no index on this database, the same query still answers.
  const memorySpy: string[] = [];
  const noIndex = new SemanticRetriever(fakeRepos(DOCS, memorySpy), {
    embed: stubEmbed,
    embeddingModel: MODEL,
    vectorSearch: async () => null,
  });
  assert.strictEqual((await noIndex.retrieve("ws", "gold border", { limit: 3 }))[0]?.id, "c_zari", "no index → compare in memory, same answer");
  assert.ok(memorySpy.includes("listByWorkspace"), "the in-memory fallback is what must have run");
});

test("CASE H — toVectorLiteral writes only a real vector, and availability is honest", async () => {
  const good = new Array(EMBEDDING_DIMENSIONS).fill(0.5);
  assert.strictEqual(toVectorLiteral(good), `[${good.join(",")}]`);
  assert.strictEqual(toVectorLiteral(new Array(768).fill(0.5)), null, "a 768-dimension vector cannot go in a 1536 column");
  assert.strictEqual(toVectorLiteral([...good.slice(1), Number.NaN]), null, "NaN would poison the index");
  assert.strictEqual(toVectorLiteral([...good.slice(1), Infinity]), null);
  assert.strictEqual(toVectorLiteral(null), null);
  assert.strictEqual(toVectorLiteral("[0.1,0.2]"), null, "a string is not a vector");

  resetVectorStoreAvailabilityCache();
  const saved = process.env.PERSISTENCE_PROVIDER;
  process.env.PERSISTENCE_PROVIDER = "json";
  try {
    assert.strictEqual(await vectorStoreAvailable(), false, "there is no pgvector index on the JSON substrate");
  } finally {
    if (saved === undefined) delete process.env.PERSISTENCE_PROVIDER;
    else process.env.PERSISTENCE_PROVIDER = saved;
    resetVectorStoreAvailabilityCache();
  }
});

(async () => {
  console.log("\n=== GOLDEN: hybrid retrieval (keyword + vectors, fused) ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? (process.env.GOLDEN_STACK ? error.stack : error.message) : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: hybrid-retrieval");
    process.exit(1);
  }
})();
