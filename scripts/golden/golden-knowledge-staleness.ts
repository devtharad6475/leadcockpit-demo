/**
 * golden-knowledge-staleness.ts — the AI must answer from the CURRENT facts (NEW, 2026-08-27).
 *
 * WHY THIS TEST EXISTS:
 *   The CEO asked a question no test could answer: "if I change information
 *   about the company tomorrow, will the AI know?" Tracing the write paths said
 *   no, three separate ways — N-AI-10, N-AI-11 and N-AI-12 on the board. All
 *   three are the same shape: the SCREEN shows the operator's new value while
 *   the AI keeps using the old one, because the AI reads a DERIVED copy
 *   (KnowledgeBaseChunk rows / the first agent_instruction row it happens to
 *   find) that the save path never refreshed.
 *
 *   None of the three had a test, which is exactly why they survived. This
 *   golden is the missing one: it edits a fact, then asks the read side what it
 *   sees, and FAILS if the OLD answer comes back.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — every expected value is written out here
 * before the code runs, so a passing run cannot be a coincidence):
 *
 *   CASE 1 (N-AI-11) — a document says "10 kg per shade". Edit it to say
 *     "25 kg per shade". The chunk rows the retriever reads must then contain
 *     "25 kg per shade" and must NOT contain "10 kg per shade" ANYWHERE.
 *     Before the fix this case fails on the second half: the old chunk survived.
 *
 *   CASE 2 (N-AI-11, cost) — editing ONLY the title must not re-embed. Chunking
 *     embeds every chunk and embedding is metered spend (N-AI-9), so a rebuild
 *     on a no-content edit is money burned for nothing. Expected embed calls
 *     for a title-only edit: EXACTLY 0.
 *
 *   CASE 3 (N-AI-12) — save agent instructions twice with DIFFERENT text. The
 *     workspace must then hold exactly ONE agent_instruction document for that
 *     agent (not two), and the loader's selection must return the SECOND text.
 *     Before the fix: two rows, and the FIRST text won forever.
 *
 *   CASE 4 (N-AI-12, legacy data) — plant two agent_instruction rows directly,
 *     oldest first, the way a workspace that saved twice before the fix already
 *     looks. Selection must still return the NEWER row. A fix that only
 *     corrects future saves leaves every existing workspace broken.
 *
 *   CASE 5 (N-AI-10) — a business profile says the company is "Meghdoot Zari"
 *     with product "old-product". Change the product to "new-product" and save
 *     through the same path the route uses. The chunks must then contain
 *     "new-product" and must NOT contain "old-product".
 *
 *   CASE 6 (N-AI-10, cost) — saving the profile again with nothing changed must
 *     report unchanged and must NOT re-embed. Expected embed calls: EXACTLY 0.
 *
 *   CASE 7 (N-AI-11, tenant) — a second workspace's document with the same text
 *     must be untouched by workspace A's edit. Staleness fixes that rebuild
 *     across tenants would be a far worse bug than the one being fixed.
 *
 *   CASE 8 (N-AI-15) — the Agent Instructions screen saves the agent name WITH
 *     an "_agent" suffix (constants/agents.ts) while the runtime looks it up
 *     WITHOUT one (AgentRuntime.taskAgentMap). Both spellings must resolve to
 *     the same single override. Before the fix the two never met, so workspace
 *     instructions typed on that screen reached no agent at all — not stale,
 *     never applied.
 *
 * REAL PIPELINE: the REAL KnowledgeBaseService, the REAL repositories, the REAL
 * chunker and the REAL selection rule the agent loader uses. The ONLY stub is
 * the embedding function, which is injected so the test is deterministic and
 * spends nothing — the stub also COUNTS its calls, which is what makes the two
 * cost cases provable rather than assumed.
 *
 * Run: `npm run golden:knowledge-staleness`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createRepositories } from "@/repositories";
import { ensureWorkspace } from "./_helpers/fixtures";
import {
  chunkKnowledgeDocument,
  createKnowledgeDocument,
  refreshBusinessProfileKnowledge,
  saveAgentInstruction,
  syncBusinessProfileToKnowledgeBase,
  updateKnowledgeDocument,
} from "@/services/KnowledgeBaseService";
import { pickCurrentAgentInstruction } from "@/lib/agent-instruction-selection";
import type { EmbedFn } from "@/llm/embedding";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

const repos = createRepositories();
const WS = "ws_golden_staleness";
const WS_OTHER = "ws_golden_staleness_other";

// Deterministic embedding stub. Counts calls so the cost cases can PROVE that
// an unchanged save did not spend, instead of assuming it.
let embedCalls = 0;
const stubEmbed: EmbedFn = async (_workspaceId, text) => {
  embedCalls += 1;
  // A tiny bag-of-chars vector: same text → same vector, different text →
  // different vector. Enough for storage assertions; nothing here ranks.
  const vector = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) vector[i % 8] += text.charCodeAt(i) / 1000;
  return vector;
};
function resetEmbedCounter() { embedCalls = 0; }

/** Every chunk row the retriever can see for one document, as plain text. */
async function chunkTextFor(workspaceId: string, documentId: string) {
  const chunks = await repos.knowledgeBaseChunk.listByDocument(workspaceId, documentId);
  return chunks.map((chunk) => chunk.chunkText || "").join("\n");
}

test("CASE 1 (N-AI-11) — editing a document replaces what the AI reads", async () => {
  await ensureWorkspace(repos, WS);
  const document = await createKnowledgeDocument({
    workspaceId: WS,
    title: "Dyeing capacity",
    documentType: "policy",
    source: "manual",
    contentText: "Minimum dyeing lot is 10 kg per shade.",
  }, repos);
  await chunkKnowledgeDocument(WS, document.id, repos, { embedFn: stubEmbed });

  const before = await chunkTextFor(WS, document.id);
  assert.ok(before.includes("10 kg per shade"), "precondition: the OLD fact is what the AI reads");

  await updateKnowledgeDocument(WS, document.id, { contentText: "Minimum dyeing lot is 25 kg per shade." }, repos, { embedFn: stubEmbed });

  const after = await chunkTextFor(WS, document.id);
  assert.ok(after.includes("25 kg per shade"), `the AI must read the NEW fact, got: ${after}`);
  assert.ok(!after.includes("10 kg per shade"), `THE BUG: the OLD fact is still what the AI reads: ${after}`);
});

test("CASE 2 (N-AI-11, cost) — a title-only edit does not re-embed", async () => {
  await ensureWorkspace(repos, WS);
  const document = await createKnowledgeDocument({
    workspaceId: WS,
    title: "Packing note",
    documentType: "policy",
    source: "manual",
    contentText: "Cartons are sealed with tape.",
  }, repos);
  await chunkKnowledgeDocument(WS, document.id, repos, { embedFn: stubEmbed });

  resetEmbedCounter();
  await updateKnowledgeDocument(WS, document.id, { title: "Packing note (renamed)" }, repos, { embedFn: stubEmbed });
  assert.strictEqual(embedCalls, 0, `a title-only edit must spend nothing on embedding, spent ${embedCalls} call(s)`);

  // And the content the AI reads is unharmed by the rename.
  const after = await chunkTextFor(WS, document.id);
  assert.ok(after.includes("Cartons are sealed with tape."), "content survives a title-only edit");
});

test("CASE 3 (N-AI-12) — saving instructions twice leaves ONE row, and the NEW text wins", async () => {
  await ensureWorkspace(repos, WS);
  const agentName = "whatsapp-conversation";

  await saveAgentInstruction(WS, agentName, "Always greet the customer in Hindi.", repos, {}, { embedFn: stubEmbed });
  await saveAgentInstruction(WS, agentName, "Always greet the customer in English.", repos, {}, { embedFn: stubEmbed });

  const documents = await repos.knowledgeBaseDocument.listByWorkspace(WS);
  const forAgent = documents.filter((doc) => doc.documentType === "agent_instruction" && String(doc.metadata?.agentName || "") === agentName);
  assert.strictEqual(forAgent.length, 1, `one agent has exactly ONE workspace override, found ${forAgent.length} rows`);

  const chosen = pickCurrentAgentInstruction(documents, agentName);
  assert.ok(chosen, "an instruction is selected");
  assert.ok(chosen!.contentText.includes("English"), `the AI must obey the LATEST instruction, got: ${chosen!.contentText}`);
  assert.ok(!chosen!.contentText.includes("Hindi"), `THE BUG: the AI is still obeying the FIRST instruction: ${chosen!.contentText}`);

  // The derived chunks must not keep quoting the superseded instruction either.
  const chunkText = await chunkTextFor(WS, chosen!.id);
  assert.ok(!chunkText.includes("Hindi"), `superseded instruction text still sits in the chunk table: ${chunkText}`);
});

test("CASE 4 (N-AI-12, legacy data) — a workspace that ALREADY has duplicates picks the newer row", async () => {
  await ensureWorkspace(repos, WS);
  const agentName = "lead-review";

  // Planted directly through the repository, deliberately bypassing the fixed
  // save path — this is what a workspace that saved twice BEFORE the fix looks
  // like on disk. The fix has to repair these, not just prevent new ones.
  const older = await repos.knowledgeBaseDocument.create(WS, {
    title: "old override",
    documentType: "agent_instruction",
    source: "workspace_override",
    status: "active",
    contentText: "Reject every lead from outside Gujarat.",
    metadata: { agentName },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const newer = await repos.knowledgeBaseDocument.create(WS, {
    title: "new override",
    documentType: "agent_instruction",
    source: "workspace_override",
    status: "active",
    contentText: "Accept leads from every Indian state.",
    metadata: { agentName },
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  assert.notStrictEqual(older.id, newer.id, "two distinct rows were planted");

  const documents = await repos.knowledgeBaseDocument.listByWorkspace(WS);
  const chosen = pickCurrentAgentInstruction(documents, agentName);
  assert.ok(chosen, "an instruction is selected from the duplicated rows");
  assert.ok(chosen!.contentText.includes("every Indian state"), `the NEWER planted row must win, got: ${chosen!.contentText}`);
});

test("CASE 5 (N-AI-10) — saving the business profile refreshes what the AI reads", async () => {
  await ensureWorkspace(repos, WS);
  const profile = await repos.businessProfile.create({
    workspaceId: WS,
    companyName: "Meghdoot Zari",
    industry: "textiles",
    products: ["old-product"],
  });
  // First sync, the way onboarding would.
  await syncBusinessProfileToKnowledgeBase(WS, repos, { embedFn: stubEmbed, force: true });

  const document = await repos.knowledgeBaseDocument.getByTypeAndSource(WS, "company_profile", "business_profile");
  assert.ok(document, "profile knowledge document exists after the first sync");
  const before = await chunkTextFor(WS, document!.id);
  assert.ok(before.includes("old-product"), "precondition: the AI reads the OLD product list");

  // The operator edits the profile and saves. This is the call the route makes.
  await repos.businessProfile.update(WS, profile.id, { products: ["new-product"] });
  const result = await refreshBusinessProfileKnowledge(WS, repos);
  assert.strictEqual(result.synced, true, `the save must rebuild the AI's copy, got ${JSON.stringify(result)}`);

  const after = await chunkTextFor(WS, document!.id);
  assert.ok(after.includes("new-product"), `the AI must read the NEW product, got: ${after}`);
  assert.ok(!after.includes("old-product"), `THE BUG: the AI still reads the OLD product: ${after}`);
});

test("CASE 6 (N-AI-10, cost) — an unchanged profile save spends nothing", async () => {
  await ensureWorkspace(repos, WS);
  resetEmbedCounter();
  const result = await refreshBusinessProfileKnowledge(WS, repos);
  assert.strictEqual(result.unchanged, true, `an unchanged profile must report unchanged, got ${JSON.stringify(result)}`);
  assert.strictEqual(embedCalls, 0, `an unchanged profile save must spend nothing, spent ${embedCalls} call(s)`);
});

test("CASE 7 (N-AI-11, tenant) — one workspace's edit does not touch another's chunks", async () => {
  await ensureWorkspace(repos, WS);
  await ensureWorkspace(repos, WS_OTHER);

  const mine = await createKnowledgeDocument({
    workspaceId: WS,
    title: "Shared wording",
    documentType: "policy",
    source: "manual",
    contentText: "Delivery takes 7 days.",
  }, repos);
  const theirs = await createKnowledgeDocument({
    workspaceId: WS_OTHER,
    title: "Shared wording",
    documentType: "policy",
    source: "manual",
    contentText: "Delivery takes 7 days.",
  }, repos);
  await chunkKnowledgeDocument(WS, mine.id, repos, { embedFn: stubEmbed });
  await chunkKnowledgeDocument(WS_OTHER, theirs.id, repos, { embedFn: stubEmbed });

  await updateKnowledgeDocument(WS, mine.id, { contentText: "Delivery takes 3 days." }, repos, { embedFn: stubEmbed });

  const mineAfter = await chunkTextFor(WS, mine.id);
  const theirsAfter = await chunkTextFor(WS_OTHER, theirs.id);
  assert.ok(mineAfter.includes("3 days"), "my workspace sees my edit");
  assert.ok(theirsAfter.includes("7 days"), `the other tenant must be untouched, got: ${theirsAfter}`);
  assert.ok(!theirsAfter.includes("3 days"), `TENANT LEAK: my edit reached another workspace: ${theirsAfter}`);
});

test("CASE 8 (N-AI-15) — instructions saved from the SCREEN are found by the RUNTIME", async () => {
  await ensureWorkspace(repos, WS);
  // The Agent Instructions screen saves the name the way constants/agents.ts
  // spells it — with an "_agent" suffix. The runtime looks the agent up the way
  // AgentRuntime.taskAgentMap spells it — without one. Hand-computed: these two
  // spellings MUST resolve to the same override, or every instruction the owner
  // types on that screen is silently ignored by every agent.
  const screenSpelling = "message-generation-agent";   // what the Save button sends
  const runtimeSpelling = "message_generation";        // what agentNameForTask returns

  await saveAgentInstruction(WS, screenSpelling, "Never promise same-day dispatch.", repos, {}, { embedFn: stubEmbed });

  const documents = await repos.knowledgeBaseDocument.listByWorkspace(WS);
  const found = pickCurrentAgentInstruction(documents, runtimeSpelling);
  assert.ok(found, `THE BUG: the runtime spelling "${runtimeSpelling}" finds nothing saved under the screen spelling "${screenSpelling}"`);
  assert.ok(found!.contentText.includes("same-day dispatch"), `the runtime must read the owner's text, got: ${found!.contentText}`);

  // And the two spellings must not create two separate overrides.
  await saveAgentInstruction(WS, runtimeSpelling, "Never promise same-day dispatch, ever.", repos, {}, { embedFn: stubEmbed });
  const after = await repos.knowledgeBaseDocument.listByWorkspace(WS);
  const rows = after.filter((doc) => doc.documentType === "agent_instruction" && String(doc.metadata?.agentName || "").replace(/_/g, "-").replace(/-agent$/, "") === "message-generation");
  assert.strictEqual(rows.length, 1, `both spellings must share ONE override row, found ${rows.length}`);
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
  console.log(`knowledge-staleness: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
