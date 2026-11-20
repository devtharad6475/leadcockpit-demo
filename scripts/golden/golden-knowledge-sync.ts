/**
 * golden-knowledge-sync.ts — pins KnowledgeSyncService.upsertKnowledgeEntry (DARK).
 *
 * WHAT THIS PROVES
 *   `upsertKnowledgeEntry` is the single-transaction upsert for manual KB
 *   answers. It validates the question key against the 523-question framework,
 *   dedups by questionId (preserving id + createdAt on update), and optionally
 *   resolves a linked HumanFallbackTask. This is the chokepoint the WhatsApp
 *   "Information Needed" flow + the manual KB editor both write through.
 *
 * THE CONTRACTS (hand-computed BEFORE writing assertions):
 *   CASE A — valid create: a new entry with a real framework question key
 *            (company_knowledge/company_overview) is created with mode='created',
 *            confidence=1, and the documented questionText from the framework.
 *   CASE B — malformed questionKey (no slash, no domainKey) throws — guards
 *            against silent garbage rows.
 *   CASE C — unknown domainKey/questionKey throws — the framework is the
 *            source of truth (AGENTS.md: 523-question framework is sacred;
 *            no free-form KB keys).
 *   CASE D — second upsert with same questionId → mode='updated', preserves
 *            the original id + createdAt, bumps updatedAt. (No duplicate row.)
 *   CASE E — passing taskId flips the linked HumanFallbackTask to
 *            status='RESOLVED' with resolvedAt set, and returns resolvedTask.
 *   CASE F — empty answer throws (no silent empty-row creation).
 *
 * REAL PIPELINE: imports the real upsertKnowledgeEntry + real repos. Each case
 * uses an isolated workspace (Ironclad Gate #8) so entries don't leak between
 * cases.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createJsonRepos } from "./_helpers/provider";
import { upsertKnowledgeEntry } from "@/services/KnowledgeSyncService";
import type { RepositoryBundle } from "@/repositories/interfaces";
import assert from "node:assert";

function caseWs(caseId: string) { return `ws_knowledge_sync_${caseId}`; }

async function clearWorkspace(ws: string) {
  const { mutateData } = await import("@/lib/db");
  await mutateData((data) => {
    data.knowledgeEntries = (data.knowledgeEntries || []).filter((e) => e.workspaceId !== ws);
    data.humanFallbackTasks = (data.humanFallbackTasks || []).filter((t) => t.workspaceId !== ws);
    return undefined;
  });
}

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// --- CASE A: valid create -------------------------------------------------------
test("CASE A — valid create with a real framework question key", async () => {
  const ws = caseWs("A"); await clearWorkspace(ws);
  const repos = createJsonRepos();
  const result = await upsertKnowledgeEntry({
    workspaceId: ws,
    questionKey: "company_knowledge/company_overview",
    answer: "Balaji Zari Udyog manufactures zari threads and borders for the textile industry.",
  }, repos);

  assert.strictEqual(result.mode, "created", "mode === 'created' for first upsert");
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.entry.workspaceId, ws);
  assert.strictEqual(result.entry.questionId, "company_knowledge/company_overview");
  assert.strictEqual(result.entry.domain, "company_knowledge");
  assert.strictEqual(result.entry.confidence, 1, "manual answers are confidence=1 (operator-approved truth)");
  assert.ok(result.entry.id, "entry has an id");
  assert.ok(result.entry.questionText.length > 0, "questionText populated from the framework");
  assert.ok(result.entry.createdAt, "createdAt set");
});

// --- CASE B: malformed questionKey throws --------------------------------------
test("CASE B — malformed questionKey (no slash, no domainKey) throws", async () => {
  const ws = caseWs("B"); await clearWorkspace(ws);
  const repos = createJsonRepos();
  await assert.rejects(
    () => upsertKnowledgeEntry({ workspaceId: ws, questionKey: "no_slash_here", answer: "x" }, repos),
    /domainKey/i,
    "questionKey without a slash and without domainKey must throw",
  );
});

// --- CASE C: unknown domainKey/questionKey throws -------------------------------
test("CASE C — unknown domainKey/questionKey throws (framework is source of truth)", async () => {
  const ws = caseWs("C"); await clearWorkspace(ws);
  const repos = createJsonRepos();
  await assert.rejects(
    () => upsertKnowledgeEntry({ workspaceId: ws, questionKey: "fake_domain/fake_question", answer: "x" }, repos),
    /invalid question key/i,
    "an unknown question key (not in the 523-framework) must throw — no free-form KB keys",
  );
});

// --- CASE D: second upsert → mode='updated', id+createdAt preserved -------------
test("CASE D — second upsert with same questionId → mode='updated', id + createdAt preserved", async () => {
  const ws = caseWs("D"); await clearWorkspace(ws);
  const repos = createJsonRepos();
  const first = await upsertKnowledgeEntry({
    workspaceId: ws, questionKey: "company_knowledge/company_overview",
    answer: "First answer.",
  }, repos);
  await new Promise((r) => setTimeout(r, 10)); // ensure updatedAt differs
  const second = await upsertKnowledgeEntry({
    workspaceId: ws, questionKey: "company_knowledge/company_overview",
    answer: "Second answer (revised).",
  }, repos);

  assert.strictEqual(second.mode, "updated", "mode === 'updated' for second upsert");
  assert.strictEqual(second.entry.id, first.entry.id, "id PRESERVED on update (not a duplicate)");
  assert.strictEqual(second.entry.createdAt, first.entry.createdAt, "createdAt PRESERVED on update");
  assert.strictEqual(second.entry.answer, "Second answer (revised).", "answer is the new value");
  assert.notStrictEqual(second.entry.updatedAt, first.entry.updatedAt, "updatedAt bumped");

  // Hand-computed: exactly ONE entry for this questionId (no duplicate row).
  const list = await (async () => {
    const { readData } = await import("@/lib/db");
    const data = await readData();
    return (data.knowledgeEntries || []).filter((e) => e.workspaceId === ws && e.questionId === "company_knowledge/company_overview");
  })();
  assert.strictEqual(list.length, 1, `exactly 1 entry (no duplicate), got ${list.length}`);
});

// --- CASE E: taskId resolves the linked HumanFallbackTask -----------------------
test("CASE E — passing taskId flips the linked HumanFallbackTask to RESOLVED", async () => {
  const ws = caseWs("E"); await clearWorkspace(ws);
  const repos = createJsonRepos();
  // Seed an open HumanFallbackTask that this answer will resolve.
  const { mutateData } = await import("@/lib/db");
  const TASK_ID = "task_E_1";
  await mutateData((data) => {
    data.humanFallbackTasks ||= [];
    data.humanFallbackTasks.push({
      id: TASK_ID, workspaceId: ws, leadId: "lead_E",
      questionId: "company_knowledge/company_overview",
      questionText: "What does the company do?",
      status: "OPEN", priority: "normal",
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    } as never);
    return undefined;
  });

  const result = await upsertKnowledgeEntry({
    workspaceId: ws, questionKey: "company_knowledge/company_overview",
    answer: "Answer that resolves the task.", taskId: TASK_ID,
  }, repos);

  assert.ok(result.resolvedTask, "resolvedTask returned");
  assert.strictEqual(result.resolvedTask!.id, TASK_ID);
  assert.strictEqual(result.resolvedTask!.status, "RESOLVED", "task flipped to RESOLVED");
  assert.ok(result.resolvedTask!.resolvedAt, "resolvedAt set");
});

// --- CASE F: empty answer throws -----------------------------------------------
test("CASE F — empty answer throws (no silent empty-row creation)", async () => {
  const ws = caseWs("F"); await clearWorkspace(ws);
  const repos = createJsonRepos();
  await assert.rejects(
    () => upsertKnowledgeEntry({ workspaceId: ws, questionKey: "company_knowledge/company_overview", answer: "   " }, repos),
    /answer is required/i,
    "whitespace-only answer must throw (no empty KB rows)",
  );
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
  console.log(`knowledge-sync: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
