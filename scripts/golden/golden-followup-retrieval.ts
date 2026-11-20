/**
 * Golden test — N-KB-2: knowledge retrieval must survive a vague follow-up.
 *
 * WHERE THIS CAME FROM (not theory — a measurement)
 * -------------------------------------------------
 * The ten-company acceptance run (docs/acceptance/TEN-COMPANY-RUN.md, 2026-08-20)
 * put 60 real customer messages through the real reply engine on the real model.
 * One failure had a different shape from all the others. Aqualis Water Systems
 * has this line in its knowledge base:
 *
 *     "Installation lead time: 8 weeks from signed order."
 *
 * The customer asked:
 *
 *     "If we sign this month, when would it be running?"
 *
 * and the product answered "let me confirm the exact installation timeline with
 * our team" — about a timeline the company had already written down.
 *
 * A retrieval probe (scripts/probes/retrieval-recall-probe.ts) showed why:
 * ZERO chunks, confidence 0.000. The model was not ignoring the fact. It was
 * never handed the fact. Retrieval used `input.rawText` as its only query, and
 * that sentence contains no word the knowledge base has — the SUBJECT of the
 * question lives in the previous message, not in this one.
 *
 * That is not an edge case. It is what every sales conversation looks like from
 * message two onward, once the customer stops repeating the product name. The
 * conversation history was already being gathered — it was just handed to the
 * model and never to retrieval.
 *
 * WHAT THIS GOLDEN PINS
 * ---------------------
 *   CASE A — the bug's own footprint. The vague follow-up, asked on its own,
 *     retrieves nothing usable. This is asserted rather than assumed: if it ever
 *     starts retrieving well, CASE B is proving nothing and this golden must be
 *     re-derived instead of silently passing.
 *
 *   CASE B — the fix. With the conversation history available,
 *     retrieveWithHistoryFallback returns the "8 weeks" fact.
 *
 *   CASE C — no dilution. This is the regression a naive "always concatenate the
 *     history into the query" fix would introduce. A question that ALREADY
 *     retrieves well must return the identical top chunk whether or not
 *     unrelated history is supplied.
 *
 *   CASE D — the empty cases. An empty history, and the literal sentence
 *     gatherHistoryText returns for a lead with no events ("No interactions
 *     yet."), must never be used as a retrieval query.
 *
 * Retrieval here runs on the keyword floor: the golden stores no embeddings and
 * the suite runs without an embedding key, so SemanticRetriever degrades to
 * KeywordRetriever (CP-16 honest fallback). That is deliberate — the contract
 * being pinned is about WHICH TEXT becomes the query, and it must hold on the
 * weakest retriever the product ships with.
 *
 * Test isolation (Gate #8): own workspace ids (ws_fur_*), deleted at the end.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createKnowledgeDocument, chunkKnowledgeDocument, getRelevantContext } from "@/services/KnowledgeBaseService";
import { retrieveWithHistoryFallback, RETRIEVAL_USABLE_CONFIDENCE } from "@/services/WhatsAppConversationEngine";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const KB_TEXT = [
  "Site water test: 1200 AED, deducted from the plant price on order.",
  "Reverse osmosis plant, 5000 litres per hour: 165000 AED installed.",
  "Membrane replacement set: 9500 AED.",
  "Installation lead time: 8 weeks from signed order.",
  "All plants are installed by our own engineers. We do not sell plants for self-installation.",
].join("\n\n");

/** What gatherHistoryText produces after the customer has asked about the plant. */
const HISTORY = [
  'Customer replied: "We run a 300-room hotel in Dubai. What would a reverse osmosis plant cost us?"',
  'AI suggested: "Happy to help. We size every plant after a site water test — the test is 1200 AED and comes off the plant price on order."',
  "Status: needs_review (price_request)",
].join("\n");

/** The measured message. Contains no word the knowledge base has. */
const VAGUE_FOLLOW_UP = "If we sign this month, when would it be running?";

/** A question that stands on its own — used to prove the fix cannot dilute it. */
const SELF_CONTAINED = "What does the membrane replacement set cost?";

async function seed(repos: RepositoryBundle, workspaceId: string) {
  await repos.workspace.create({ id: workspaceId, name: `Aqualis test ${workspaceId}`, status: "active" });
  const doc = await createKnowledgeDocument({
    workspaceId,
    title: "Aqualis - pricing and service terms",
    contentText: KB_TEXT,
    documentType: "pricing",
    // "manual" = owner-entered = verified. An uploaded_document would be stamped
    // extractionUnverified and prefixed "do not quote as fact", which would make
    // this golden measure the verification gate instead of retrieval.
    source: "manual",
    status: "active",
  }, repos);
  await chunkKnowledgeDocument(workspaceId, doc.id, repos);
}

async function main() {
  const repos = createJsonRepos();
  const created: string[] = [];

  // --- CASE A: the bug's own footprint -------------------------------------
  {
    const WS = "ws_fur_a";
    await seed(repos, WS); created.push(WS);
    const direct = await getRelevantContext(WS, VAGUE_FOLLOW_UP, repos);
    const usable = direct.chunks.length > 0 && direct.confidenceScore >= RETRIEVAL_USABLE_CONFIDENCE;
    assert(!usable,
      `CASE A: the vague follow-up asked ALONE must retrieve nothing usable — that is the bug this golden exists for. ` +
      `Got ${direct.chunks.length} chunks at confidence ${direct.confidenceScore.toFixed(3)}. ` +
      `If retrieval genuinely improved, re-derive this golden; do not delete the assertion.`);
    assert(!/8\s*weeks/i.test(direct.contextText),
      `CASE A: the "8 weeks" fact must be ABSENT from the message-only context. This is the mutation proof: ` +
      `revert retrieveWithHistoryFallback and CASE B fails.`);
    console.log(`CASE A PASS - message-only retrieval is blind here: ${direct.chunks.length} chunks, confidence ${direct.confidenceScore.toFixed(3)}`);
  }

  // --- CASE B: the fix ------------------------------------------------------
  {
    const WS = "ws_fur_b";
    await seed(repos, WS); created.push(WS);
    const ctx = await retrieveWithHistoryFallback(WS, VAGUE_FOLLOW_UP, HISTORY, repos);
    assert(ctx.chunks.length > 0, `CASE B: history-expanded retrieval returns chunks, got ${ctx.chunks.length}`);
    assert(/8\s*weeks/i.test(ctx.contextText),
      `CASE B: the installation lead time must reach the model. Context was:\n${ctx.contextText.slice(0, 400)}`);
    console.log(`CASE B PASS - history-expanded retrieval recovers the fact: ${ctx.chunks.length} chunks, confidence ${ctx.confidenceScore.toFixed(3)}`);
  }

  // --- CASE C: no dilution of a question that already works -----------------
  {
    const WS = "ws_fur_c";
    await seed(repos, WS); created.push(WS);
    const withoutHistory = await retrieveWithHistoryFallback(WS, SELF_CONTAINED, "", repos);
    // History about a completely different subject. If the implementation
    // concatenated unconditionally, this would drag the ranking sideways.
    const unrelated = [
      'Customer replied: "Do you handle customs clearance for frozen seafood into Sweden?"',
      'AI suggested: "We can look at that — let me confirm with our team."',
    ].join("\n");
    const withHistory = await retrieveWithHistoryFallback(WS, SELF_CONTAINED, unrelated, repos);

    assert(withoutHistory.chunks.length > 0, `CASE C: the self-contained question must retrieve on its own, got ${withoutHistory.chunks.length}`);
    assert(/9\s?500/.test(withoutHistory.contextText), "CASE C: baseline retrieves the membrane price");
    assert(withHistory.chunks[0]?.id === withoutHistory.chunks[0]?.id,
      `CASE C: unrelated history must not change the top chunk. ` +
      `Without: ${withoutHistory.chunks[0]?.id}  With: ${withHistory.chunks[0]?.id}`);
    assert(/9\s?500/.test(withHistory.contextText), "CASE C: the membrane price survives unrelated history");
    console.log("CASE C PASS - a question that already retrieves well is not diluted by unrelated history");
  }

  // --- CASE D: the empty cases ----------------------------------------------
  {
    const WS = "ws_fur_d";
    await seed(repos, WS); created.push(WS);
    const direct = await getRelevantContext(WS, VAGUE_FOLLOW_UP, repos);

    const emptyHistory = await retrieveWithHistoryFallback(WS, VAGUE_FOLLOW_UP, "", repos);
    assert(emptyHistory.chunks.length === direct.chunks.length,
      `CASE D: empty history returns the direct result unchanged, got ${emptyHistory.chunks.length} vs ${direct.chunks.length}`);

    // gatherHistoryText's literal no-events sentence. Searching the knowledge
    // base for the words "no interactions yet" is worse than not searching.
    const noEvents = await retrieveWithHistoryFallback(WS, VAGUE_FOLLOW_UP, "No interactions yet.", repos);
    assert(noEvents.chunks.length === direct.chunks.length,
      `CASE D: the "No interactions yet." sentinel is not used as a query, got ${noEvents.chunks.length} vs ${direct.chunks.length}`);
    console.log('CASE D PASS - empty history and the "No interactions yet." sentinel are never used as queries');
  }

  for (const ws of created) await repos.workspace.delete(ws);
  console.log("\nAll follow-up-retrieval golden cases PASSED (A-D).");
}

main().catch((err) => {
  console.error("\nGOLDEN FAILED:", err);
  process.exit(1);
});
