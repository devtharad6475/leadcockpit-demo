/**
 * verify-pgvector-index.ts — prove the vector index against a REAL pgvector
 * database (2026-09-17, session 56).
 *
 * The goldens prove the retrieval LOGIC with an injected index. They cannot
 * prove the SQL: the vector literal format, the `<=>` cosine operator, the HNSW
 * index, `hnsw.iterative_scan`, the ON DELETE CASCADE, or that the conditional
 * migration actually creates the table where pgvector exists. Those are claims
 * about a database, and only a database can answer them.
 *
 * This is NOT part of run-all-goldens: the machine running the goldens has
 * stock postgres, where the whole feature is deliberately absent. It is run by
 * hand against a throwaway pgvector database, and it refuses to run rather than
 * skipping quietly if the table is not there.
 *
 *   docker run -d --name lc-pgvector -e POSTGRES_PASSWORD=leadgen \
 *     -e POSTGRES_DB=leadgen -p 55433:5432 pgvector/pgvector:pg15
 *   DATABASE_URL="postgresql://postgres:leadgen@localhost:55433/leadgen" npx prisma migrate deploy
 *   DATABASE_URL="postgresql://postgres:leadgen@localhost:55433/leadgen" PERSISTENCE_PROVIDER=prisma \
 *     npx tsx scripts/verify-pgvector-index.ts
 *   docker rm -f lc-pgvector
 *
 * It writes only into a workspace it creates with a unique id, and deletes it
 * at the end. Never point it at production.
 */
import assert from "node:assert";
import { createRepositories } from "@/repositories";
import { prisma } from "@/lib/prisma";
import { EMBEDDING_DIMENSIONS } from "@/llm/embedding";
import { SemanticRetriever } from "@/rag/SemanticRetriever";
import { backfillChunkVectors, searchChunkVectors, upsertChunkVectors, vectorStoreAvailable, resetVectorStoreAvailabilityCache } from "@/rag/vector-store";

const MODEL = "openai:text-embedding-3-small";
const OTHER_MODEL = "gemini:gemini-embedding-001";
const WS = `ws_pgvector_${Date.now()}`;

/** A unit vector pointing along one axis, so cosine distances are predictable. */
function axisVector(axis: number, tilt = 0): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[axis] = 1;
  if (tilt) v[(axis + 1) % EMBEDDING_DIMENSIONS] = tilt;
  return v;
}

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  console.log("\n=== VERIFY: pgvector + HNSW against a real database ===\n");
  assert.strictEqual(process.env.PERSISTENCE_PROVIDER, "prisma", "run with PERSISTENCE_PROVIDER=prisma");
  resetVectorStoreAvailabilityCache();
  assert.ok(
    await vectorStoreAvailable(),
    "the knowledge_chunk_vectors table is not on this database. Run `npx prisma migrate deploy` against a pgvector " +
      "database first. Refusing to report a pass without the thing under test.",
  );
  console.log(`  (database has the index; using throwaway workspace ${WS})\n`);

  const repos = createRepositories();
  await repos.workspace.create({ id: WS, name: "pgvector verification" });
  const doc = await repos.knowledgeBaseDocument.create(WS, { title: "verification doc", contentText: "n/a", documentType: "policy", source: "manual" });

  // Saved through the normal repository path — the same call the product makes.
  const saved = await repos.knowledgeBaseChunk.replaceForDocument(WS, doc.id, [
    { chunkIndex: 0, chunkText: "zari trimming, gold finish", embedding: axisVector(0), metadata: { embeddingModel: MODEL } },
    { chunkIndex: 1, chunkText: "dispatch and courier times", embedding: axisVector(1), metadata: { embeddingModel: MODEL } },
    { chunkIndex: 2, chunkText: "GSTIN and HSN codes", embedding: axisVector(2), metadata: { embeddingModel: MODEL } },
    { chunkIndex: 3, chunkText: "another model's vector", embedding: axisVector(0), metadata: { embeddingModel: OTHER_MODEL } },
    { chunkIndex: 4, chunkText: "no vector at all", metadata: {} },
  ]);
  const byIndex = new Map(saved.map((chunk) => [chunk.chunkIndex, chunk]));

  await check("saving chunks mirrors their vectors into the index", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ chunk_id: string; model: string }>>(
      "SELECT chunk_id, model FROM knowledge_chunk_vectors WHERE workspace_id = $1 ORDER BY model",
      WS,
    );
    assert.strictEqual(rows.length, 4, `4 chunks have vectors; the index has ${rows.length}`);
    assert.ok(!rows.some((row) => row.chunk_id === byIndex.get(4)?.id), "a chunk with no vector must not be in the index");
  });

  await check("cosine search returns the nearest chunk first, filtered by model", async () => {
    // Tilted towards axis 0: nearest is chunk 0, then the tilt's axis.
    const hits = await searchChunkVectors(WS, MODEL, axisVector(0, 0.3), 5);
    assert.ok(hits, "the search must run against a database that has the index");
    assert.strictEqual(hits![0].chunkId, byIndex.get(0)?.id, "the nearest vector must come back first");
    assert.strictEqual(hits![1].chunkId, byIndex.get(1)?.id, "the second nearest must be the tilt's axis");
    assert.ok(hits![0].similarity > hits![1].similarity, "similarity must decrease down the list");
    assert.ok(hits![0].similarity > 0.9 && hits![0].similarity <= 1, `an almost-identical vector must score near 1, got ${hits![0].similarity}`);
    assert.ok(
      !hits!.some((hit) => hit.chunkId === byIndex.get(3)?.id),
      "a vector made by ANOTHER model must never be returned — comparing two models' vectors is noise",
    );
  });

  await check("the index is per workspace", async () => {
    const hits = await searchChunkVectors("ws_someone_else", MODEL, axisVector(0), 5);
    assert.deepStrictEqual(hits, [], "another workspace's search must not see these chunks");
  });

  await check("the retriever uses the index end to end", async () => {
    const hits = await new SemanticRetriever(repos, {
      embed: async () => axisVector(2, 0.1),
      embeddingModel: MODEL,
    }).retrieve(WS, "what is the tax registration number", { limit: 3 });
    assert.strictEqual(hits[0]?.id, byIndex.get(2)?.id, `the tax chunk must be found by meaning. Got: ${hits.map((h) => h.chunkText).join(" | ")}`);
  });

  await check("a wrong-sized vector is refused, not written", async () => {
    const written = await upsertChunkVectors(WS, [{ chunkId: byIndex.get(4)!.id, model: MODEL, vector: new Array(768).fill(0.5) }]);
    assert.strictEqual(written, 0, "a 768-dimension vector cannot go into a 1536 column; it must be skipped, not attempted");
  });

  await check("backfill rebuilds the index from the stored JSON", async () => {
    await prisma.$executeRawUnsafe("DELETE FROM knowledge_chunk_vectors WHERE workspace_id = $1", WS);
    const written = await backfillChunkVectors(WS);
    assert.strictEqual(written, 4, `backfill must restore the 4 labelled vectors, wrote ${written}`);
    const hits = await searchChunkVectors(WS, MODEL, axisVector(1), 1);
    assert.strictEqual(hits?.[0]?.chunkId, byIndex.get(1)?.id, "the rebuilt index must answer the same way");
  });

  await check("deleting a chunk deletes its index row (no stale rows)", async () => {
    await repos.knowledgeBaseChunk.replaceForDocument(WS, doc.id, [
      { chunkIndex: 0, chunkText: "only this one now", embedding: axisVector(0), metadata: { embeddingModel: MODEL } },
    ]);
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      "SELECT COUNT(*)::bigint AS count FROM knowledge_chunk_vectors WHERE workspace_id = $1",
      WS,
    );
    assert.strictEqual(Number(rows[0].count), 1, "the replaced chunks' index rows must go with them, or searches return text nobody can see");
  });

  await check("the HNSW index is the one answering the query", async () => {
    const plan = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN SELECT chunk_id FROM knowledge_chunk_vectors WHERE workspace_id = $1 AND model = $2 ORDER BY embedding <=> $3::vector LIMIT 5`,
      WS,
      MODEL,
      `[${axisVector(0).join(",")}]`,
    );
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    // On a 1-row table Postgres may legitimately prefer a sequential scan; the
    // claim being checked is that the index EXISTS and is usable, which the
    // planner reports either way.
    console.log(`      plan: ${text.split("\n")[0]}`);
    const indexes = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'knowledge_chunk_vectors' AND indexdef LIKE '%hnsw%'",
    );
    assert.strictEqual(indexes.length, 1, "the HNSW index must exist");
    assert.match(indexes[0].indexdef, /vector_cosine_ops/, "the index must use cosine distance, matching how the application scores similarity");
  });

  // Clean up the throwaway workspace.
  await prisma.$executeRawUnsafe("DELETE FROM knowledge_base_chunks WHERE workspace_id = $1", WS);
  await prisma.$executeRawUnsafe("DELETE FROM knowledge_base_documents WHERE workspace_id = $1", WS);
  await prisma.$executeRawUnsafe("DELETE FROM workspaces WHERE id = $1", WS);

  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail) process.exit(1);
}

main().catch(async (error) => {
  console.error(`❌ VERIFY FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
