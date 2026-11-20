/**
 * golden-correction-supersedes-document.ts — a corrected fact cannot be
 * contradicted by the document it corrected (2026-09-18, session 57).
 *
 * ── THE SCENARIO, WHICH IS THE OWNER'S OWN ──────────────────────────────────
 * The owner uploads a price list saying the minimum order is 50 kg. The
 * framework extracts it. Later the owner corrects it: the minimum is now
 * 100 kg. The correction is stored, re-chunked, re-embedded — and the ORIGINAL
 * LINE IN THE PDF is still in the index, still matching "what is your minimum
 * order?". Without a rule, a customer gets told 50 kg, confidently, with no
 * error anywhere and nothing in any log to notice.
 *
 * This is the test that has to be true for uploaded documents to be searchable
 * at all. Making documents searchable without it trades a system that
 * sometimes finds nothing for a system that is sometimes confidently wrong,
 * which is the worse of the two.
 *
 *   CASE A — the document line is searchable before anything is corrected.
 *            (If it never was, the rest of this proves nothing.)
 *   CASE B — the owner is SHOWN the line, and nothing is retired until they
 *            confirm. Approved text is never offered for retirement.
 *   CASE C — after the owner confirms, the old line is unreachable by keyword
 *            AND by meaning, and the corrected answer is what comes back.
 *   CASE D — retiring keeps the evidence: the text is still on file, with who
 *            replaced it and when, and it can be restored.
 *   CASE E — approved answers outrank unverified document text on a tie, and
 *            document text still reaches the model labelled as unverified.
 *
 * Run: npx tsx scripts/golden/golden-correction-supersedes-document.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { SemanticRetriever } from "@/rag/SemanticRetriever";
import { isSuperseded, chunkAuthority, authorityRank } from "@/rag/chunk-authority";
import { proposeSupersededChunks, retireChunk, restoreChunk, listRetiredChunks } from "@/services/KnowledgeCorrectionService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

// Each case gets its OWN workspace: the JSON store is shared between cases in
// one run, so a seed left by an earlier case would show up as a second copy of
// the same line and the assertions would be measuring the test's own residue.
let WS = "";
const freshWorkspace = () => (WS = `ws_golden_supersede_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
const QUESTION = "What minimum order quantity rules apply?";
const OLD_LINE = "Minimum order quantity: 50 kg per order for stocked shades.";
const CORRECTED = "Minimum order quantity is 100 kg per order for stocked shades, effective this season.";

/** A stub embedder: both texts are about MOQ, so they sit near each other. */
const topics: Array<[string, string[]]> = [
  ["moq", ["minimum order", "moq", "kg per order"]],
  ["delivery", ["dispatch", "courier", "delivery"]],
];
const embed = async (_ws: string, text: string) => {
  const lower = text.toLowerCase();
  const v = topics.map(([, words]) => words.filter((w) => lower.includes(w)).length);
  return v.some((n) => n > 0) ? v : [0.001, 0.001];
};

async function seed(repos: RepositoryBundle) {
  // The uploaded document, indexed as the product now indexes it: unverified.
  const doc = await repos.knowledgeBaseDocument.create(WS, {
    title: "03-Om-Jari-Price-List.pdf",
    documentType: "uploaded_source",
    source: "uploaded_document",
    status: "active",
    contentText: OLD_LINE,
    metadata: { sourceFileName: "03-Om-Jari-Price-List.pdf", extractionUnverified: true },
  });
  const [documentChunk] = await repos.knowledgeBaseChunk.replaceForDocument(WS, doc.id, [
    {
      chunkIndex: 0,
      chunkText: OLD_LINE,
      embedding: await embed(WS, OLD_LINE),
      metadata: { source: "uploaded_document", extractionUnverified: true, sourceFileName: "03-Om-Jari-Price-List.pdf" },
    },
  ]);

  // The owner's corrected answer, stored the way the answers document stores it.
  const answersDoc = await repos.knowledgeBaseDocument.create(WS, {
    title: "Approved answers",
    documentType: "question_answer_extraction",
    source: "knowledge_question_answers",
    status: "active",
    contentText: CORRECTED,
    metadata: {},
  });
  const [approvedChunk] = await repos.knowledgeBaseChunk.replaceForDocument(WS, answersDoc.id, [
    {
      chunkIndex: 0,
      chunkText: CORRECTED,
      embedding: await embed(WS, CORRECTED),
      metadata: { source: "knowledge_question_answers" },
    },
  ]);
  return { documentChunk, approvedChunk };
}

const retriever = (repos: RepositoryBundle) => new SemanticRetriever(repos, { embed });

test("CASE A — the uploaded document line is searchable in the first place", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  const { documentChunk } = await seed(repos);
  const hits = await retriever(repos).retrieve(WS, "what is your minimum order", { limit: 5 });
  assert.ok(
    hits.some((hit) => hit.id === documentChunk.id),
    "PRECONDITION: the document's own text must be findable, or nothing below is being tested. " +
      `Got: ${hits.map((h) => h.chunkText.slice(0, 40)).join(" | ")}`,
  );
  assert.strictEqual(chunkAuthority(documentChunk), "document", "a line from a PDF is unverified document text, not an approved fact");
});

test("CASE B — the owner is shown the line, and nothing changes until they confirm", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  const { documentChunk, approvedChunk } = await seed(repos);

  const candidates = await proposeSupersededChunks(WS, { question: QUESTION, answer: CORRECTED }, repos, { retriever: retriever(repos) });
  assert.ok(candidates.length >= 1, "the contradicting document line must be offered to the owner");
  const offered = candidates.find((c) => c.chunkId === documentChunk.id);
  assert.ok(offered, `the old line must be among the candidates. Got: ${candidates.map((c) => c.text.slice(0, 40)).join(" | ")}`);
  assert.strictEqual(offered!.text, OLD_LINE, "the owner must see the line VERBATIM — that is the whole point of confirming");
  assert.strictEqual(offered!.sourceFileName, "03-Om-Jari-Price-List.pdf", "and which file it came from");

  assert.ok(
    !candidates.some((c) => c.chunkId === approvedChunk.id),
    "an APPROVED answer must never be offered for retirement — this flow is document text losing to a correction, " +
      "not one approved fact quietly deleting another",
  );

  // Proposing must not have changed anything.
  const [after] = await repos.knowledgeBaseChunk.listByIds(WS, [documentChunk.id]);
  assert.ok(!isSuperseded(after), "proposing is not retiring: the line must still be live until the owner confirms");
});

test("CASE C — once confirmed, the old line cannot answer a customer any more", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  const { documentChunk, approvedChunk } = await seed(repos);
  await retireChunk(WS, documentChunk.id, { answerId: "ans_1", replacedBy: CORRECTED }, repos);

  const hits = await retriever(repos).retrieve(WS, "what is your minimum order", { limit: 5 });
  assert.ok(
    !hits.some((hit) => hit.id === documentChunk.id),
    "THE POINT: a retired line must be unreachable. It is still matching the customer's question, and if retrieval " +
      "returns it the customer is told the price the owner already corrected.",
  );
  assert.ok(hits.some((hit) => hit.id === approvedChunk.id), "the corrected answer must still be found");
  assert.ok(!hits.some((hit) => hit.chunkText.includes("50 kg")), "no route may reach the superseded number");

  // The keyword half alone must also refuse it — half a rule is not a rule.
  const keywordOnly = new SemanticRetriever(repos, { embed: async () => { throw new Error("no embeddings"); } });
  const keywordHits = await keywordOnly.retrieve(WS, "minimum order kg", { limit: 5 });
  assert.ok(
    !keywordHits.some((hit) => hit.id === documentChunk.id),
    "with embeddings unavailable the search falls back to keyword — a retired line must be gone from that half too",
  );
});

test("CASE D — retiring keeps the evidence, and can be undone", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  const { documentChunk } = await seed(repos);
  await retireChunk(WS, documentChunk.id, { answerId: "ans_1", replacedBy: CORRECTED }, repos);

  const [stored] = await repos.knowledgeBaseChunk.listByIds(WS, [documentChunk.id]);
  assert.strictEqual(stored.chunkText, OLD_LINE, "the text must still be on file: it is the evidence of what the PDF said");
  const mark = stored.metadata?.supersededBy as { answerId?: string; at?: string; replacedBy?: string };
  assert.strictEqual(mark?.answerId, "ans_1", "the record must say which correction replaced it");
  assert.ok(mark?.at, "and when");
  assert.strictEqual(mark?.replacedBy, CORRECTED, "and what replaced it");

  const retired = await listRetiredChunks(WS, repos);
  assert.strictEqual(retired.length, 1, "the owner must be able to review what has been retired");
  assert.strictEqual(retired[0].sourceFileName, "03-Om-Jari-Price-List.pdf");

  // Retiring twice is not an error, and does not rewrite the first record.
  await retireChunk(WS, documentChunk.id, { answerId: "ans_2" }, repos);
  const [again] = await repos.knowledgeBaseChunk.listByIds(WS, [documentChunk.id]);
  assert.strictEqual((again.metadata?.supersededBy as { answerId?: string })?.answerId, "ans_1", "the FIRST retirement is the record");

  await restoreChunk(WS, documentChunk.id, repos);
  const [restored] = await repos.knowledgeBaseChunk.listByIds(WS, [documentChunk.id]);
  assert.ok(!isSuperseded(restored), "a retirement must be undoable — the owner can be wrong too");
  const hits = await retriever(repos).retrieve(WS, "what is your minimum order", { limit: 5 });
  assert.ok(hits.some((hit) => hit.id === documentChunk.id), "a restored line returns to search");
});

test("CASE E — approved text outranks unverified document text on a tie", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  const { documentChunk, approvedChunk } = await seed(repos);
  assert.strictEqual(authorityRank(approvedChunk), 1);
  assert.strictEqual(authorityRank(documentChunk), 0);

  const { getRelevantContext } = await import("@/services/KnowledgeBaseService");
  const context = await getRelevantContext(WS, "minimum order quantity kg", repos);
  const lines = context.contextText.split("\n\n");
  const documentLine = lines.find((line) => line.includes("50 kg"));
  assert.ok(documentLine, "document text must still REACH the model — it is evidence, it just is not approved");
  assert.match(
    documentLine!,
    /UNVERIFIED/i,
    "and it must arrive labelled, so the model does not quote an unreviewed PDF line as a company fact",
  );
  assert.ok(context.unverifiedChunkCount >= 1, "the caller must be told unverified text was included");
});

test('CASE F — failed audit rolls back retirement and restoration', async () => {
  const repos = createJsonRepos(); freshWorkspace();
  const { documentChunk } = await seed(repos);
  const createAudit = repos.auditLog.create;
  repos.auditLog.create = async () => { throw new Error('Injected knowledge audit failure'); };
  try { await assert.rejects(() => retireChunk(WS, documentChunk.id, { answerId: 'ans_1' }, repos), /Injected knowledge audit/); }
  finally { repos.auditLog.create = createAudit; }
  assert.equal(isSuperseded((await repos.knowledgeBaseChunk.listByIds(WS, [documentChunk.id]))[0]), false);
  await retireChunk(WS, documentChunk.id, { answerId: 'ans_1' }, repos);
  repos.auditLog.create = async () => { throw new Error('Injected knowledge audit failure'); };
  try { await assert.rejects(() => restoreChunk(WS, documentChunk.id, repos), /Injected knowledge audit/); }
  finally { repos.auditLog.create = createAudit; }
  assert.equal(isSuperseded((await repos.knowledgeBaseChunk.listByIds(WS, [documentChunk.id]))[0]), true);
});

(async () => {
  console.log("\n=== GOLDEN: a correction retires the line it corrected ===\n");
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
    console.log("❌ GOLDEN FAILED: correction-supersedes-document");
    process.exit(1);
  }
})();
