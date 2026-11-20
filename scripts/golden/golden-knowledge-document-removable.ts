/**
 * Golden test — a wrong knowledge document can be taken out of the agent's mouth.
 *
 * WHY THIS EXISTS (2026-09-08, session 54)
 * ----------------------------------------
 * Found by rebuilding the live demo workspace, not by a test.
 *
 * The Knowledge Base is the agent's source of truth. Every document in it is
 * chunked, indexed, and retrieved by `searchByKeyword` when a customer asks
 * something — whatever is in there is what the agent quotes.
 *
 * Nothing in the product could remove one. There was no DELETE route, no
 * repository method on either substrate, and no control on the screen. An
 * extraction that ran while the workspace had no AI key — which is exactly what
 * happened on the demo deployment — wrote a page of canned fallback text into
 * the Knowledge Base under the title "Combined onboarding sources", describing
 * a Cloud ERP product, in a workspace that manufactures zari thread. That text
 * was then unremovable, and every retrieval could surface it.
 *
 *   CASE A — behavioural: DELETE removes the document from the workspace.
 *
 *   CASE B — behavioural, and the one that matters: the chunks go with it, so
 *     the text stops coming back from keyword search. A delete that leaves the
 *     chunks behind is worse than no delete: the document is gone from the
 *     screen and still in every answer, with nothing left to explain why.
 *
 *   CASE C — behavioural: a document belonging to another workspace cannot be
 *     deleted by guessing its id.
 *
 *   CASE D — static: the Knowledge Base screen has a control that reaches the
 *     endpoint, and it does not hide documents behind a "+N more" count that
 *     would make them unreachable.
 *
 * Substrate: runs on whichever provider the suite selects. No network, no AI.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createRepositories } from "@/repositories";
import { defaultWorkspaceId } from "@/lib/db";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const WS = defaultWorkspaceId;
const SCREEN = "src/app/sections/KnowledgeBaseSection.tsx";
const MARKER = "zzqx Cloud ERP implementation timeline zzqx";

async function deleteDocument(documentId: string) {
  const { DELETE } = await import("@/app/api/[[...path]]/route");
  const request = new Request(`http://localhost/api/knowledge/documents/${documentId}`, { method: "DELETE" });
  const response = await DELETE(
    request as never,
    { params: Promise.resolve({ path: ["knowledge", "documents", documentId] }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function main() {
  console.log("=== GOLDEN: a knowledge document can be removed ===\n");
  const repos = createRepositories();

  const doc = await repos.knowledgeBaseDocument.create(WS, {
    title: "Combined onboarding sources (canned fallback)",
    documentType: "question_answer_extraction",
    source: "question_answering:golden",
    contentText: MARKER,
  });
  assert(doc?.id, "setup: the document was not created");
  await repos.knowledgeBaseChunk.replaceForDocument(WS, doc.id, [{ chunkIndex: 0, chunkText: MARKER }]);

  const foundBefore = await repos.knowledgeBaseChunk.searchByKeyword(WS, "Cloud ERP implementation timeline", 10);
  assert(
    foundBefore.some((chunk) => chunk.chunkText.includes(MARKER)),
    "setup: the chunk should be retrievable before the delete, or CASE B proves nothing",
  );

  // ---------------------------------------------------------------- CASE A
  {
    const { status, body } = await deleteDocument(doc.id);
    assert(status === 200, `CASE A: DELETE returned HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);

    const reloaded = await repos.knowledgeBaseDocument.getById(WS, doc.id);
    assert(!reloaded, "CASE A: the document must be gone from the workspace");
    console.log("✅ CASE A — the document is removed");
  }

  // ---------------------------------------------------------------- CASE B
  {
    const chunks = await repos.knowledgeBaseChunk.listByDocument(WS, doc.id);
    assert(chunks.length === 0, `CASE B: the chunks must go with the document, ${chunks.length} left behind`);

    const foundAfter = await repos.knowledgeBaseChunk.searchByKeyword(WS, "Cloud ERP implementation timeline", 10);
    assert(
      !foundAfter.some((chunk) => chunk.chunkText.includes(MARKER)),
      "CASE B: the removed text must stop coming back from keyword search — otherwise the agent still quotes it " +
      "and the screen no longer shows where it came from",
    );
    console.log("✅ CASE B — its indexed text stops being retrievable, so the agent stops quoting it");
  }

  // ---------------------------------------------------------------- CASE C
  {
    const otherWorkspace = `${WS}_golden_other`;
    const foreign = await repos.knowledgeBaseDocument.create(otherWorkspace, {
      title: "Another workspace's price list",
      documentType: "other",
      source: "manual",
      contentText: "Not yours.",
    });
    const { status } = await deleteDocument(foreign.id);
    assert(status !== 200, `CASE C: deleting another workspace's document must not succeed, got HTTP ${status}`);
    const stillThere = await repos.knowledgeBaseDocument.getById(otherWorkspace, foreign.id);
    assert(stillThere, "CASE C: the other workspace's document must survive");
    console.log("✅ CASE C — a document in another workspace cannot be deleted by guessing its id");
  }

  // ---------------------------------------------------------------- CASE D
  {
    const source = readSource(SCREEN);
    assert(
      /\/api\/knowledge\/documents\/\$\{[^}]+\}`,\s*\{\s*method:\s*"DELETE"/.test(source),
      `CASE D: ${SCREEN} must call DELETE on the document endpoint. Without a control the route can work ` +
      "perfectly while the operator has no way to remove a wrong document.",
    );
    assert(
      // 2026-09-25: the list moved into a drawer that renders every document;
      // pin the property (no truncation of `documents`), not a variable name.
      /documents\.map\(/.test(source) && !/documents\.slice\(0,/.test(source),
      `CASE D: ${SCREEN} must be able to list every document. It used to show five and hide the rest behind a ` +
      "count, which was survivable while the list was read-only and is not now — a document that cannot be seen " +
      "cannot be removed.",
    );
    console.log("✅ CASE D — the screen still has a reachable control, for every document");
  }

  console.log("\n✅✅✅ All knowledge-document-removal golden cases PASSED (A–D). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
