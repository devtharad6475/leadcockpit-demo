/**
 * golden-meaning-search-labels.ts — meaning search must compare against the
 * model that actually made the vectors (N10, 2026-09-23, session 58).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Stored vectors are labelled with the model that made them, and a query is
 * only compared with vectors of the same label. The query's label came from
 * activeEmbeddingModel() — the FIRST configured provider. With Ollama switched
 * on but not running, the vectors really come from the next provider (OpenAI),
 * so the query said "ollama", every stored vector said "openai", and meaning
 * search silently compared against nothing. On the write side the same rule
 * judged every OpenAI vector "not ours" and paid for it again on each rebuild.
 *
 *   CASE A — a query is compared against vectors of the model that made IT.
 *   CASE B — a rebuild reuses vectors from any configured provider, keeps
 *            their true label, and pays for nothing it already has.
 *   CASE C — the status line tells the truth in each state.
 *
 * No case calls a provider.
 *
 * Run: npx tsx scripts/golden/golden-meaning-search-labels.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { SemanticRetriever } from "@/rag/SemanticRetriever";
import { embedChunks } from "@/rag/embed-chunks";
import { getSearchStatus } from "@/rag/search-status";
import { activeEmbeddingModel, configuredEmbeddingModels } from "@/llm/embedding";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let seq = 0;
const freshWorkspace = () => `ws_n10_${Date.now()}_${seq++}`;

// The exact local and production-like setup: Ollama switched on, OpenAI key set.
process.env.PLATFORM_OLLAMA_BASE_URL = "http://127.0.0.1:9"; // nothing listens here
process.env.OPENAI_API_KEY = "sk-test-not-used";
delete process.env.EMBEDDING_PROVIDER;
const OPENAI_LABEL = configuredEmbeddingModels().find((label) => label.startsWith("openai:"))!;

/** A vector pointing one way, so cosine similarity is easy to reason about. */
const unit = (n: number) => Array.from({ length: 8 }, (_, i) => (i === n ? 1 : 0));

async function plantDocument(workspaceId: string, chunks: Array<{ text: string; vector?: number[]; label?: string }>) {
  const doc = await repos.knowledgeBaseDocument.create(workspaceId, {
    title: "Terms", documentType: "policy", source: "upload", status: "active", contentText: chunks.map((c) => c.text).join("\n"), metadata: {},
  });
  await repos.knowledgeBaseChunk.createMany(workspaceId, doc.id, chunks.map((chunk, index) => ({
    chunkIndex: index,
    chunkText: chunk.text,
    embedding: chunk.vector,
    metadata: chunk.label ? { embeddingModel: chunk.label } : {},
  })));
  return doc;
}

test("CASE A — a query is compared against vectors of the model that made IT", async () => {
  assert.ok(activeEmbeddingModel()?.startsWith("ollama:"), "fixture: the FIRST provider is Ollama, which is not running");

  const workspaceId = freshWorkspace();
  // No word in common with the query: only meaning search can find this.
  await plantDocument(workspaceId, [
    { text: "Dispatch leaves Surat five working days after confirmation.", vector: unit(1), label: OPENAI_LABEL },
    { text: "Our catalogue has sixty shades.", vector: unit(5), label: OPENAI_LABEL },
  ]);

  const retriever = new SemanticRetriever(repos, {
    vectorSearch: async () => null, // no pgvector here: compare in memory
    // Ollama is down, so the vector really came from OpenAI — and says so.
    embedWithModel: async () => ({ vector: unit(1), model: OPENAI_LABEL }),
  });
  const result = await retriever.retrieve(workspaceId, "maal kab tak milega", { limit: 3 });
  assert.ok(
    result.some((chunk) => chunk.chunkText.startsWith("Dispatch")),
    "THE DEFECT: the passage is found by MEANING. Labelled with the first provider's name, the query was " +
      "compared against no vectors at all, and meaning search silently did nothing.",
  );
});

test("CASE B — a rebuild reuses any configured provider's vectors and pays for nothing it has", async () => {
  const workspaceId = freshWorkspace();
  const previous = [{ chunkText: "Dispatch in five working days.", embedding: unit(2), metadata: { embeddingModel: OPENAI_LABEL } }];

  let providerCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { providerCalls += 1; return realFetch(...args); }) as typeof fetch;
  try {
    const [rebuilt] = await embedChunks<Partial<import("@/lib/types").KnowledgeBaseChunk>>(workspaceId, [{ chunkText: "Dispatch in five working days.", metadata: {} }], repos, previous);
    assert.deepStrictEqual(rebuilt.embedding, unit(2), "the existing vector is kept");
    assert.strictEqual(
      rebuilt.metadata?.embeddingModel,
      OPENAI_LABEL,
      "with the label of the model that MADE it — relabelled 'ollama', it would be compared against the wrong queries",
    );
    assert.strictEqual(
      providerCalls,
      0,
      "and nothing is paid for. The old rule judged every OpenAI vector 'not ours' and bought it again on each " +
        "rebuild — and the rebuild runs on every approved answer.",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("CASE C — the status line tells the truth in each state", async () => {
  const none = freshWorkspace();
  await plantDocument(none, [{ text: "a" }, { text: "b" }]);
  const unindexed = await getSearchStatus(none, repos);
  assert.strictEqual(unindexed.meaningSearch, "off");
  assert.match(unindexed.summary, /nothing to search/, "set up but not indexed is NOT 'on' — the state nobody could see before");

  const half = freshWorkspace();
  await plantDocument(half, [{ text: "a", vector: unit(0), label: OPENAI_LABEL }, { text: "b" }]);
  const partial = await getSearchStatus(half, repos);
  assert.strictEqual(partial.meaningSearch, "partial");
  assert.strictEqual(partial.searchable, 1);

  const full = freshWorkspace();
  await plantDocument(full, [{ text: "a", vector: unit(0), label: OPENAI_LABEL }]);
  assert.strictEqual((await getSearchStatus(full, repos)).meaningSearch, "on");

  const stale = freshWorkspace();
  await plantDocument(stale, [{ text: "a", vector: unit(0), label: "gemini:some-retired-model" }]);
  const orphan = await getSearchStatus(stale, repos);
  assert.strictEqual(orphan.meaningSearch, "off", "vectors from a model no longer configured cannot be searched");
  assert.strictEqual(orphan.orphaned, 1, "and are counted as such, not as coverage");
});

(async () => {
  console.log("\n=== GOLDEN: meaning search compares like with like (N10) ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: meaning-search-labels");
    process.exit(1);
  }
})();
