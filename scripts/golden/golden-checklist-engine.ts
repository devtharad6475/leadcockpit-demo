/**
 * golden-checklist-engine.ts — N13 acceptance conditions 1 and 2 (2026-09-25).
 *
 * The CEO's condition for replacing the 424 questions with a checklist per
 * kind of business: the replacement must still
 *   (1) find contradictions, and
 *   (2) say what is incomplete BY NAME — the actual questions, not a count —
 * and it must do both against the business's own checklist.
 *
 * Runs the real services on the JSON substrate. No AI call: the two documents
 * are fed through the same merge + fact-group pass that extraction runs after
 * the model answers, so what is tested is exactly the post-AI machinery.
 *
 * HAND-COMPUTED CONTRACT (a workspace confirmed as a TRADER)
 *   CASE A — the extraction plan is the trader checklist: every checklist
 *            question in it, and no question a trader is not asked
 *            (production_location) — so no AI money is spent on it.
 *   CASE B — half the checklist is answered. The open "what is missing" list
 *            names exactly the unanswered checklist questions, by their text.
 *   CASE C — a blank row left over from the old 424 for a question traders are
 *            not asked (production_location), and an old open question about
 *            it, are NOT shown as missing.
 *   CASE D — an answer to a retired question is kept and listed as "not on
 *            your checklist", never deleted.
 *   CASE E — two documents give the same checklist question different answers
 *            (MOQ 5 kg vs 10 kg) → the answer is flagged as a conflict, and an
 *            open conflict question is raised for the owner.
 *   CASE F — the same fact under two checklist questions (variety MOQ vs MOQ
 *            policy) disagreeing → both flagged by the fact-group pass.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import type { AppData, KnowledgeQuestionAnswer } from "@/lib/types";
import {
  listKnowledgeQuestionAnswers,
  syncMissingKnowledgeQuestions,
  workspaceChecklist,
  type ExtractedQuestionAnswer,
} from "@/services/DocumentQuestionAnsweringService";
import { createExtractionPlan } from "@/services/KnowledgeQuestionBatcher";
import { mergeExtractedAnswers } from "@/services/KnowledgeAnswerMergeService";
import { detectFactGroupConflicts } from "@/services/KnowledgeFactConflictService";

const repos = createJsonRepos();
const WS = `ws_checklist_engine_${Date.now()}`;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

function row(domainKey: string, questionKey: string, question: string, answer: string, status: KnowledgeQuestionAnswer["answerStatus"] = "answered"): KnowledgeQuestionAnswer {
  return {
    id: `kqa_${WS}_${questionKey}`, workspaceId: WS, domainKey, questionKey, question, answer, answerStatus: status,
    sourceType: "document", confidenceScore: 0.9, isCanonical: true,
    createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z",
  } as KnowledgeQuestionAnswer;
}

function extracted(domainKey: string, questionKey: string, question: string, answer: string): ExtractedQuestionAnswer {
  return {
    domainKey, domainTitle: domainKey, questionKey, question, answer, answerStatus: "answered", sourceType: "document",
    confidenceScore: 0.85, humanReviewRequired: true, sourceSnippet: answer,
  } as ExtractedQuestionAnswer;
}

let answeredKeys = new Set<string>();

async function setup() {
  await repos.workspace.create({ id: WS, name: "Checklist engine golden", status: "active" });
  await repos.businessProfile.create({
    workspaceId: WS, companyName: "Lace Traders", industry: "Wholesale laces",
    checklistKinds: ["trader"], checklistExports: false, checklistConfirmedAt: "2026-09-25T00:00:00.000Z",
  });
  await repos.mutateAll!((data: AppData) => {
    const checklist = workspaceChecklist(WS, data);
    const gaps = checklist.questions.filter((q) => q.countsAsMissing);
    data.knowledgeQuestionAnswers ||= [];
    // Answer every other checklist question.
    gaps.forEach((q, index) => {
      if (index % 2 === 0) {
        data.knowledgeQuestionAnswers!.push(row(q.domainKey, q.questionKey, q.question, `Answer for ${q.questionKey}.`));
        answeredKeys.add(`${q.domainKey}/${q.questionKey}`);
      }
    });
    // Leftovers of the old 424 for a question traders are not asked.
    data.knowledgeQuestionAnswers.push(row("production_manufacturing", "production_location", "Where are the goods made?", "", "unanswered"));
    data.unknownQuestions ||= [];
    data.unknownQuestions.push({
      id: `uq_${WS}_old`, workspaceId: WS, channel: "knowledge", questionText: "Where are the goods made?", missingTopic: "production manufacturing",
      status: "open", relatedDomain: "production_manufacturing", relatedQuestionKey: "production_location",
      suggestedAnswer: "Framework question: production_manufacturing/production_location.", generatedBy: "framework", priority: "medium",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    } as never);
    // An answer to a template question the old bank asked, now retired.
    data.knowledgeQuestionAnswers.push(row("product_knowledge", "deep_13_product_knowledge_facts_that_should_update_age", "What should the company knowledge include about …?", "Gold shades are stocked year-round."));
    return undefined;
  });
}

test("CASE A — the extraction plan is the trader checklist, nothing else", async () => {
  const checklist = await repos.mutateAll!((data: AppData) => workspaceChecklist(WS, data));
  assert.equal(checklist.choice.source, "confirmed");
  const planned = createExtractionPlan(checklist.framework).flatMap((batch) => batch.questions.map((q) => `${batch.domainKey}/${q.questionKey}`));
  assert.deepEqual(new Set(planned), checklist.keys, "extraction must ask the AI exactly the checklist");
  assert.ok(!checklist.keys.has("production_manufacturing/production_location"), "a trader's plan includes a manufacturing question");
  assert.ok(checklist.keys.has("sourcing_stock/supply_source"), "a trader's plan lacks the trader question");
});

test("CASE B — missing is named, exactly the unanswered checklist questions", async () => {
  const open = (await syncMissingKnowledgeQuestions(WS, repos)).filter((q) => q.channel === "knowledge" && q.status === "open");
  const checklist = await repos.mutateAll!((data: AppData) => workspaceChecklist(WS, data));
  const expected = checklist.questions.filter((q) => q.countsAsMissing && !answeredKeys.has(`${q.domainKey}/${q.questionKey}`));
  const asked = new Set(open.map((q) => `${q.relatedDomain}/${q.relatedQuestionKey}`));
  assert.ok(expected.length > 20, `fixture: half the checklist should be missing, got ${expected.length}`);
  for (const q of expected) {
    assert.ok(asked.has(`${q.domainKey}/${q.questionKey}`), `missing question not named: ${q.domainKey}/${q.questionKey}`);
    const item = open.find((o) => o.relatedQuestionKey === q.questionKey)!;
    assert.equal(item.questionText, q.question, "the missing item must carry the question's own words");
  }
  for (const key of answeredKeys) assert.ok(!asked.has(key), `an answered question is listed as missing: ${key}`);
});

test("CASE C — leftovers from the old bank are not shown as missing", async () => {
  const open = (await syncMissingKnowledgeQuestions(WS, repos)).filter((q) => q.channel === "knowledge" && q.status === "open");
  assert.ok(!open.some((q) => q.relatedQuestionKey === "production_location"), "a trader is shown a manufacturing question as missing");
  // And no NEW question about it was stored (only the one planted from the old bank).
  const stored = await repos.mutateAll!((data: AppData) => (data.unknownQuestions || []).filter((q) => q.workspaceId === WS && q.relatedQuestionKey === "production_location").length);
  assert.equal(stored, 1, "a new question about a manufacturing topic was created for a trader");
  const listed = await listKnowledgeQuestionAnswers(WS, repos);
  const leftover = listed.find((a) => a.questionKey === "production_location");
  assert.ok(!leftover || leftover.onChecklist === false, "the leftover blank row is counted as on the checklist");
});

test("CASE D — an answer to a retired question is kept and marked off the checklist", async () => {
  const listed = await listKnowledgeQuestionAnswers(WS, repos);
  const kept = listed.find((a) => a.questionKey === "deep_13_product_knowledge_facts_that_should_update_age");
  assert.ok(kept, "the retired question's answer disappeared");
  assert.equal(kept!.answer, "Gold shades are stocked year-round.");
  assert.equal(kept!.onChecklist, false);
});

test("CASE E — two documents disagree on one checklist question → conflict raised", async () => {
  const q = "What minimum order quantity rules apply?";
  await repos.mutateAll!((data: AppData) => {
    data.knowledgeQuestionAnswers = (data.knowledgeQuestionAnswers || []).filter((a) => !(a.workspaceId === WS && a.questionKey === "moq_policy"));
    mergeExtractedAnswers({ workspaceId: WS, sourceType: "document", sourceId: "doc_a", sourceTitle: "Price list", extractedAnswers: [extracted("pricing_policy", "moq_policy", q, "Minimum order is 5 kg per shade.")], data });
    mergeExtractedAnswers({ workspaceId: WS, sourceType: "document", sourceId: "doc_b", sourceTitle: "Sales notes", extractedAnswers: [extracted("pricing_policy", "moq_policy", q, "Minimum order is 10 kg per shade.")], data });
    return undefined;
  });
  const listed = await listKnowledgeQuestionAnswers(WS, repos);
  const moq = listed.find((a) => a.questionKey === "moq_policy");
  assert.equal(moq?.answerStatus, "conflict", `5 kg vs 10 kg must be a conflict, got ${moq?.answerStatus}`);
  assert.equal(moq?.onChecklist, true);
  const open = (await syncMissingKnowledgeQuestions(WS, repos)).filter((item) => item.status === "open" && item.generatedBy === "conflict_detection");
  assert.ok(open.some((item) => item.relatedQuestionKey === "moq_policy" || String(item.suggestedAnswer || "").includes("moq_policy")), "no open conflict question for the owner");
});

test("CASE F — one fact under two checklist questions disagreeing → both flagged", async () => {
  const summary = await repos.mutateAll!((data: AppData) => {
    data.knowledgeQuestionAnswers = (data.knowledgeQuestionAnswers || []).filter((a) => !(a.workspaceId === WS && ["moq_policy", "minimum_quantities_by_variety"].includes(a.questionKey)));
    data.knowledgeQuestionAnswers.push(row("product_varieties", "minimum_quantities_by_variety", "Are MOQ rules different by variety or product line?", "Zari thread has a minimum of 5 kg per shade."));
    data.knowledgeQuestionAnswers.push(row("pricing_policy", "moq_policy", "What minimum order quantity rules apply?", "Zari thread has a minimum order of 10 kg per shade."));
    return detectFactGroupConflicts({ workspaceId: WS, data });
  });
  assert.ok(summary.factConflictsFound >= 1, `no fact conflict found: ${JSON.stringify(summary.details)}`);
  const listed = await listKnowledgeQuestionAnswers(WS, repos);
  for (const key of ["minimum_quantities_by_variety", "moq_policy"]) {
    const item = listed.find((a) => a.questionKey === key);
    assert.equal(item?.answerStatus, "conflict", `${key} not flagged`);
    assert.equal(item?.onChecklist, true, `${key} is not on the trader checklist`);
  }
});

(async () => {
  console.log("golden-checklist-engine — the checklist still finds contradictions and names what is missing\n");
  await setup();
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  ✅ ${name}`); } catch (e) { failed++; console.error(`  ❌ ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`); }
  }
  console.log(`\nchecklist-engine: ${cases.length - failed} passed, ${failed} failed — ${failed ? "FAIL ❌" : "ALL GREEN ✅"}`);
  if (failed) process.exit(1);
})();
