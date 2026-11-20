/**
 * golden-question-counts-agree.ts — 2026-09-30 (page guide finding).
 *
 * Needs you said "31 essential setup questions still unanswered … 479 deeper
 * questions can wait" while Questions from AI, the screen where the owner
 * actually answers them, counted 37 and 227. Needs you counted every open
 * non-live question, including ones kept on file for questions this business
 * is no longer asked and ones from other channels.
 *
 *   A — both screens report the same essential and total open counts.
 *   B — a question this business is no longer asked is counted by neither.
 *   C — a customer's WhatsApp question is not setup work on either screen.
 *   D — answering an essential question lowers both counts together.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-question-counts-agree.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { buildNeedsYouList } from "@/services/NeedsYouService";
import { getWorkspaceChecklist, syncMissingKnowledgeQuestions } from "@/services/DocumentQuestionAnsweringService";
import { groupEssentialSetupQuestions } from "@/services/KnowledgeQuestionPresentationService";
import { getEssentialKnowledgeQuestions } from "@/knowledge/knowledge-question-framework";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

async function questionsScreen(W: string) {
  const items = await syncMissingKnowledgeQuestions(W, repos);
  const essential = groupEssentialSetupQuestions(items);
  return {
    essential: essential.essentialOpenCount,
    total: items.filter((i) => i.status === "open" && i.channel === "knowledge").length,
  };
}
async function needsYou(W: string) {
  const list = await buildNeedsYouList(W, repos, {});
  return { essential: list.essentialBacklog, total: list.setupBacklog };
}

const W = `ws_qcount_${RUN}`;
let offChecklist = "";

test("A — both screens report the same counts", async () => {
  await ensureWorkspace(repos, W);
  const keys = (await getWorkspaceChecklist(W, repos)).keys;
  const essential = getEssentialKnowledgeQuestions().filter((q) => keys.has(`${q.domainKey}/${q.questionKey}`));
  assert.ok(essential.length >= 2, "the checklist has essential questions");
  for (const q of essential.slice(0, 2)) {
    await repos.unknownQuestion.create(W, { questionText: q.question, channel: "knowledge", status: "open", relatedDomain: q.domainKey, relatedQuestionKey: q.questionKey, generatedBy: "framework" } as never);
  }
  const q = await questionsScreen(W);
  const n = await needsYou(W);
  assert.ok(q.essential >= 2);
  assert.deepEqual(n, q, "Needs you and Questions from AI show the same numbers");
});

test("B — a question this business is no longer asked is counted by neither", async () => {
  const before = await questionsScreen(W);
  const row = await repos.unknownQuestion.create(W, { questionText: "An old question", channel: "knowledge", status: "open", relatedDomain: "retired_domain", relatedQuestionKey: "retired_question", generatedBy: "framework" } as never);
  offChecklist = row.id;
  assert.deepEqual(await questionsScreen(W), before);
  assert.deepEqual(await needsYou(W), before);
});

test("C — a customer's WhatsApp question is not setup work", async () => {
  const before = await questionsScreen(W);
  await repos.unknownQuestion.create(W, { questionText: "Rate for 500 m?", channel: "whatsapp", status: "open", generatedBy: "whatsapp_unknown" } as never);
  assert.deepEqual(await needsYou(W), before);
});

test("D — answering an essential question lowers both counts together", async () => {
  const before = await questionsScreen(W);
  const open = (await repos.unknownQuestion.listByWorkspace(W, { status: "open" })).find((q) => q.channel === "knowledge" && q.id !== offChecklist && q.generatedBy === "framework" && q.relatedDomain !== "retired_domain");
  assert.ok(open);
  await repos.unknownQuestion.update(W, open!.id, { status: "answered" } as never);
  const q = await questionsScreen(W);
  assert.equal(q.total, before.total - 1);
  assert.deepEqual(await needsYou(W), q);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
