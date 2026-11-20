/**
 * measure-retrieval-quality.ts — N10: what does meaning-search actually buy?
 * (2026-09-18, session 57)
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Three of the six retrieval items built in session 56 — batched embeddings,
 * hybrid fusion, the pgvector index — contributed EXACTLY NOTHING to the
 * measured gain, because no embedding key was configured when the measurement
 * ran. A key is configured now. The honest question is whether those three are
 * earning their keep, and the only honest answer is a number.
 *
 * ── HOW IT MEASURES ─────────────────────────────────────────────────────────
 * The same questions, against the same workspace, twice:
 *
 *   KEYWORD ONLY   the vector half is disabled by injection. This is what the
 *                  product did before session 56 and what it still falls back
 *                  to wherever no embedding provider is configured.
 *   HYBRID         the real path: keyword and vector fused with RRF.
 *
 * A question counts as ANSWERED when a chunk containing the expected fact is in
 * the top 5. That is deliberately the same bar the WhatsApp path uses — a fact
 * retrieved at rank 40 does not reach a customer.
 *
 * ── THE QUESTIONS ARE WRITTEN IN CUSTOMER WORDING, ON PURPOSE ───────────────
 * Hand-written, not generated, and deliberately NOT using the company's own
 * words. A buyer types "gold border ka rate", not "zari trimming price list".
 * Questions phrased in the document's own vocabulary would be answered by
 * keyword search alone and would measure nothing at all — that is exactly how a
 * retrieval benchmark flatters itself.
 *
 * Run:
 *   PERSISTENCE_PROVIDER=prisma npx tsx scripts/measure-retrieval-quality.ts
 *   PERSISTENCE_PROVIDER=prisma npx tsx scripts/measure-retrieval-quality.ts --workspace ws_xyz
 */
import { createRepositories } from "@/repositories";
import { defaultWorkspaceId } from "@/lib/db";
import { SemanticRetriever } from "@/rag/SemanticRetriever";

// The questions live in RetrievalMeasurementService now, shared with the
// owner-only /api/ai/measure-retrieval endpoint that runs the same measurement
// on production's real knowledge. Two copies would drift.
import { DEFAULT_PROBES as PROBES } from "@/services/RetrievalMeasurementService";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const repos = createRepositories();
  const workspaceId = arg("workspace") || process.env.MEASURE_WORKSPACE_ID || defaultWorkspaceId;
  const limit = Number(arg("limit") || 5);

  // The corpus, stated up front. A measurement whose corpus is empty is not a
  // measurement, and the previous round of this work was invalidated by exactly
  // that kind of unstated precondition.
  const documents = await repos.knowledgeBaseDocument.listByWorkspace(workspaceId);
  let chunkCount = 0;
  for (const document of documents) {
    chunkCount += (await repos.knowledgeBaseChunk.listByDocument(workspaceId, document.id)).length;
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`WORKSPACE   ${workspaceId}`);
  console.log(`CORPUS      ${documents.length} documents, ${chunkCount} chunks`);
  console.log(`TOP-K       ${limit}`);
  console.log(`PROBES      ${PROBES.length} questions, in a customer's words`);
  console.log("────────────────────────────────────────────────────────────\n");

  if (!chunkCount) {
    console.log("NOTHING TO MEASURE: this workspace has no chunks. Press Sync Knowledge first.");
    process.exit(1);
  }

  const hybrid = new SemanticRetriever(repos);
  // Keyword only: the vector lookup is replaced with one that finds nothing, so
  // fusion has a single list to fuse. This is the pre-session-56 behaviour and
  // the behaviour anywhere no embedding provider is configured.
  const keywordOnly = new SemanticRetriever(repos, { vectorSearch: async () => [] });

  const rows: Array<{ about: string; keyword: boolean; hybrid: boolean }> = [];
  for (const probe of PROBES) {
    const [keywordResult, hybridResult] = await Promise.all([
      keywordOnly.retrieve(workspaceId, probe.asked, { limit }),
      hybrid.retrieve(workspaceId, probe.asked, { limit }),
    ]);
    const hit = (chunks: Array<{ chunkText: string }>) => chunks.some((chunk) => probe.expect.test(chunk.chunkText));
    rows.push({ about: probe.about, keyword: hit(keywordResult), hybrid: hit(hybridResult) });
  }

  const mark = (value: boolean) => (value ? "found" : "  —  ");
  console.log(`${"question".padEnd(18)} ${"keyword only".padEnd(14)} hybrid`);
  for (const row of rows) {
    const changed = row.keyword !== row.hybrid ? (row.hybrid ? "   ← gained" : "   ← LOST") : "";
    console.log(`${row.about.padEnd(18)} ${mark(row.keyword).padEnd(14)} ${mark(row.hybrid)}${changed}`);
  }

  const keywordHits = rows.filter((row) => row.keyword).length;
  const hybridHits = rows.filter((row) => row.hybrid).length;
  const gained = rows.filter((row) => !row.keyword && row.hybrid).length;
  const lost = rows.filter((row) => row.keyword && !row.hybrid).length;

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`KEYWORD ONLY  ${keywordHits} of ${rows.length} answered`);
  console.log(`HYBRID        ${hybridHits} of ${rows.length} answered`);
  console.log(`GAINED ${gained}, LOST ${lost}`);
  // Losing a question matters more than gaining one: it means turning this on
  // made some answers WORSE than leaving it off, which no average can excuse.
  if (lost > 0) console.log(`⚠️  ${lost} question(s) the keyword search answered and the hybrid did not. Investigate before claiming a win.`);
  console.log("────────────────────────────────────────────────────────────\n");
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
