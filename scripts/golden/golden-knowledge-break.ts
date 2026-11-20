/**
 * golden-knowledge-break.ts — what the 2026-09-26 break test found in the
 * knowledge base (what the business knows and how it is kept), pinned.
 *
 *   A — approving an answer that says nothing does not mark the question
 *       answered (its "Information Needed" card used to vanish).
 *   B — an answer of only spaces does not close an Information Needed question.
 *   C — answering the same Information Needed question twice leaves ONE
 *       searchable answer, the new one (the old one stayed searchable).
 *   D — "Add to knowledge" never publishes text the owner did not write
 *       (it published the AI's suggestion / the internal conflict text), and
 *       pressing it twice adds it once.
 *   E — a plain edit of an Information Needed question cannot set it to
 *       "added to knowledge" or to a status that does not exist.
 *   F — reading the same documents twice does not raise the same profile
 *       conflict card twice.
 *   G — choosing "use the document's value" on a profile conflict changes the
 *       profile (it recorded "resolved" and changed nothing).
 *   H — a conflict already decided cannot be decided again; an unknown choice
 *       or a blank custom value is refused.
 *   I — after the owner settles a disagreement, re-reading the same document
 *       does not ask the same question again.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-knowledge-break.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AppData, KnowledgeQuestionAnswer } from "@/lib/types";
import { NeedsActionError } from "@/lib/user-errors";
import { answerUnknownQuestion, addUnknownQuestionToKnowledge, updateUnknownQuestion } from "@/services/AISettingsService";
import { approveKnowledgeQuestionAnswer, listKnowledgeQuestionAnswers, syncMissingKnowledgeQuestions, updateKnowledgeQuestionAnswer } from "@/services/DocumentQuestionAnsweringService";
import { routeExtractedFactsToBusinessProfile, resolveSettingsConflict } from "@/services/ExtractionRoutingService";
import { mergeExtractedAnswers } from "@/services/KnowledgeAnswerMergeService";
import { getAllKnowledgeQuestions } from "@/knowledge/knowledge-question-framework";

const repos = createJsonRepos() as RepositoryBundle;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);
let seq = 0;
async function workspace() {
  const id = `ws_kbreak_${Date.now()}_${seq++}`;
  await repos.workspace.create({ id, name: "Knowledge break test", status: "active" } as never);
  return id;
}
const question = getAllKnowledgeQuestions().find((item) => item.countsAsMissing !== false && item.domainKey === "factual_company_profile") || getAllKnowledgeQuestions()[0];

test("A — approving a blank answer does not mark the question answered", async () => {
  const ws = await workspace();
  const answers = await listKnowledgeQuestionAnswers(ws, repos);
  const blank = answers.find((item) => item.domainKey === question.domainKey && item.questionKey === question.questionKey)!;
  assert.ok(blank && !blank.answer?.trim(), "fixture: the question should start blank");
  await assert.rejects(() => approveKnowledgeQuestionAnswer(ws, blank.id, repos), NeedsActionError, "approving an empty answer was accepted");
  // The edit route can send the same thing as fields.
  const edited = await updateKnowledgeQuestionAnswer(ws, blank.id, { answer: "   ", answerStatus: "answered", isUserApproved: true }, repos);
  assert.equal(edited.answerStatus, "unanswered", "a blank answer was stored as answered");
  assert.equal(Boolean(edited.isUserApproved), false, "a blank answer was stored as approved");
  const open = await syncMissingKnowledgeQuestions(ws, repos);
  assert.ok(open.some((item) => item.status === "open" && item.relatedDomain === question.domainKey && item.relatedQuestionKey === question.questionKey), "the Information Needed card for the question disappeared");
  // Not applicable with no words is still the owner's choice.
  const na = await updateKnowledgeQuestionAnswer(ws, blank.id, { answer: "", answerStatus: "not_applicable" }, repos);
  assert.equal(na.answerStatus, "not_applicable");
});

test("B — an answer of only spaces does not close an Information Needed question", async () => {
  const ws = await workspace();
  const uq = await repos.unknownQuestion.create(ws, { channel: "whatsapp", questionText: "Do you ship to Nepal?", status: "open" });
  await assert.rejects(() => answerUnknownQuestion(ws, uq.id, "   ", true, repos), NeedsActionError);
  await assert.rejects(() => answerUnknownQuestion(ws, uq.id, " \n ", false, repos), NeedsActionError);
  assert.equal((await repos.unknownQuestion.getById(ws, uq.id))?.status, "open", "a blank answer closed the question");
});

test("C — answering the same question twice leaves one searchable answer, the new one", async () => {
  const ws = await workspace();
  const uq = await repos.unknownQuestion.create(ws, { channel: "whatsapp", questionText: "Do you ship to Nepal?", status: "open" });
  await answerUnknownQuestion(ws, uq.id, "No, we do not ship to Nepal.", true, repos);
  await answerUnknownQuestion(ws, uq.id, "Yes, we ship to Nepal by road.", true, repos);
  const docs = (await repos.knowledgeBaseDocument.listByWorkspace(ws)).filter((doc) => (doc.metadata as Record<string, unknown> | undefined)?.unknownQuestionId === uq.id);
  assert.equal(docs.length, 1, `answering twice left ${docs.length} answers the AI can search`);
  const chunks = await repos.knowledgeBaseChunk.listByWorkspace(ws);
  assert.ok(!chunks.some((chunk) => chunk.chunkText.includes("do not ship")), "the replaced answer is still searchable");
  assert.ok(chunks.some((chunk) => chunk.chunkText.includes("by road")), "the new answer is not searchable");
});

test("D — Add to knowledge only publishes the owner's own answer, once", async () => {
  const ws = await workspace();
  const conflict = await repos.unknownQuestion.create(ws, {
    channel: "knowledge", questionText: "Conflicting information found for: What is your MOQ?. Which answer is correct?", status: "open",
    suggestedAnswer: "Existing answer: 5 kg\nNew document answer: 10 kg", generatedBy: "conflict_detection",
  });
  await assert.rejects(() => addUnknownQuestionToKnowledge(ws, conflict.id, repos), NeedsActionError, "the AI's / internal suggestion was published as a fact");
  assert.equal((await repos.knowledgeBaseDocument.listByWorkspace(ws)).length, 0, "something was added to the knowledge base");
  const answered = await repos.unknownQuestion.create(ws, { channel: "whatsapp", questionText: "Do you take UPI?", status: "answered", finalAnswer: "Yes, UPI is accepted." });
  await addUnknownQuestionToKnowledge(ws, answered.id, repos);
  await addUnknownQuestionToKnowledge(ws, answered.id, repos);
  assert.equal((await repos.knowledgeBaseDocument.listByWorkspace(ws)).length, 1, "pressing Add to knowledge twice added it twice");
});

test("E — a plain edit cannot mark a question added to knowledge or invent a status", async () => {
  const ws = await workspace();
  const uq = await repos.unknownQuestion.create(ws, { channel: "whatsapp", questionText: "Do you export?", status: "open" });
  await assert.rejects(() => updateUnknownQuestion(ws, uq.id, { status: "added_to_knowledge" }, repos), NeedsActionError);
  await assert.rejects(() => updateUnknownQuestion(ws, uq.id, { status: "banana" }, repos), NeedsActionError);
  assert.equal((await repos.unknownQuestion.getById(ws, uq.id))?.status, "open");
  assert.equal((await updateUnknownQuestion(ws, uq.id, { status: "ignored" }, repos)).status, "ignored");
  assert.equal((await updateUnknownQuestion(ws, uq.id, { status: "open" }, repos)).status, "open");
});

function extracted(domainKey: string, questionKey: string, answer: string): KnowledgeQuestionAnswer {
  return { id: `x_${seq++}`, workspaceId: "", domainKey, questionKey, question: questionKey, answer, answerStatus: "answered", sourceType: "document", confidenceScore: 0.9, createdAt: "", updatedAt: "" } as KnowledgeQuestionAnswer;
}

test("F — reading the same documents twice raises a profile conflict once", async () => {
  const ws = await workspace();
  await repos.businessProfile.create({ workspaceId: ws, companyName: "Balaji Zari", status: "draft" } as never);
  const answers = [extracted("factual_company_profile", "legal_company_name", "Balaji Zari Udyog Pvt Ltd")];
  await routeExtractedFactsToBusinessProfile(ws, answers, "doc_1", repos);
  await routeExtractedFactsToBusinessProfile(ws, answers, "doc_1", repos);
  const open = await repos.settingsConflict.listByWorkspace(ws, { status: "open" });
  assert.equal(open.length, 1, `the same profile conflict was raised ${open.length} times`);
});

test("G — using the document's value on a profile conflict changes the profile", async () => {
  const ws = await workspace();
  await repos.businessProfile.create({ workspaceId: ws, companyName: "Balaji Zari", status: "draft" } as never);
  await routeExtractedFactsToBusinessProfile(ws, [extracted("factual_company_profile", "legal_company_name", "Balaji Zari Udyog Pvt Ltd")], "doc_1", repos);
  const [card] = await repos.settingsConflict.listByWorkspace(ws, { status: "open" });
  await resolveSettingsConflict(ws, card.id, "use_extracted", undefined, undefined, repos);
  assert.equal((await repos.businessProfile.getByWorkspace(ws))?.companyName, "Balaji Zari Udyog Pvt Ltd", "the profile did not change although the conflict says resolved");
});

test("H — a decided conflict cannot be decided again; bad choices are refused", async () => {
  const ws = await workspace();
  const card = await repos.settingsConflict.create(ws, { settingsArea: "policy", fieldKey: "samplePolicy", existingValue: "Free samples", extractedValue: "Paid samples", extractedSource: "doc", status: "open" });
  await assert.rejects(() => resolveSettingsConflict(ws, card.id, "banana" as never, undefined, undefined, repos), NeedsActionError);
  await assert.rejects(() => resolveSettingsConflict(ws, card.id, "custom", "   ", undefined, repos), NeedsActionError);
  assert.equal((await repos.settingsConflict.getById(ws, card.id))?.status, "open", "a refused choice closed the card");
  await resolveSettingsConflict(ws, card.id, "use_extracted", undefined, undefined, repos);
  await assert.rejects(() => resolveSettingsConflict(ws, card.id, "keep_existing", undefined, undefined, repos), NeedsActionError, "a decided conflict was decided again");
  assert.equal((await repos.policySettings.getByWorkspace(ws))?.samplePolicy, "Paid samples", "the second decision flipped the setting back");
});

test("I — once the owner settles a disagreement, re-reading the same document does not ask again", async () => {
  const ws = "ws_merge_" + seq++;
  const q = getAllKnowledgeQuestions().find((item) => /moq|minimum/i.test(item.questionKey)) || question;
  const data = { knowledgeQuestionAnswers: [], unknownQuestions: [] } as unknown as AppData;
  const from = (sourceId: string, answer: string) => mergeExtractedAnswers({
    workspaceId: ws, sourceType: "document", sourceId, data, now: new Date().toISOString(),
    extractedAnswers: [{ domainKey: q.domainKey, questionKey: q.questionKey, question: q.question, answer, answerStatus: "answered", sourceType: "document", confidenceScore: 0.9 } as never],
  });
  from("doc_a", "Minimum order is 5 kg.");
  from("doc_b", "Minimum order is 10 kg.");
  const open = () => (data.unknownQuestions || []).filter((item) => item.status === "open");
  assert.equal(open().length, 1, "fixture: the disagreement should be asked once");
  // The owner decides: 5 kg (what answerUnknownQuestion does to the row).
  const row = data.knowledgeQuestionAnswers!.find((item) => item.questionKey === q.questionKey)!;
  const later = new Date(Date.now() + 1000).toISOString();
  Object.assign(row, { answer: "Minimum order is 5 kg.", answerStatus: "answered", sourceType: "user_answer", isUserApproved: true, reviewedAt: later, updatedAt: later });
  open()[0].status = "added_to_knowledge";
  from("doc_b", "Minimum order is 10 kg.");
  assert.equal(open().length, 0, "the same document asked the settled question again");
  assert.equal(row.answer, "Minimum order is 5 kg.");
  // A NEW figure from a document is still raised.
  from("doc_c", "Minimum order is 20 kg.");
  assert.equal(open().length, 1, "a new disagreement was not raised");
});

(async () => {
  console.log("golden-knowledge-break — the knowledge base keeps what the owner decided\n");
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  ✅ ${name}`); } catch (e) { failed++; console.error(`  ❌ ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`); }
  }
  console.log(`\nknowledge-break: ${cases.length - failed} passed, ${failed} failed — ${failed ? "FAIL ❌" : "ALL GREEN ✅"}`);
  if (failed) process.exit(1);
})();
