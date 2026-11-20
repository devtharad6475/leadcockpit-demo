/**
 * golden-owner-conversation.ts — the owner's assistant is a conversation, and
 * the safety wall still holds (2026-09-25).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Every owner message was routed by keywords in that one message. A follow-up
 * ("do the same for those three") matched nothing and became a knowledge-base
 * lookup of the literal words: the assistant could not be talked to. The CEO:
 * "It should be conversational, just like how I'm talking to Claude Code."
 *
 * The model now reads the conversation and picks what to do. The contract is
 * about what it may NOT do as much as what it does.
 *
 * HAND-COMPUTED CONTRACT (the model is a stub — no AI spend)
 *   CASE A — a follow-up is resolved: the job planner receives the request as
 *            the model rewrote it from the conversation, not "same for those".
 *   CASE B — the owner's own dangerous words ("delete all my leads") are
 *            refused BEFORE the model is even asked.
 *   CASE C — laundering: the model picks a harmless intent but its request
 *            says "send … to all warm leads" → refused.
 *   CASE D — an intent that is not on the allowed list (send_to_customer) is
 *            ignored: keyword routing runs instead, nothing is sent.
 *   CASE E — no real model (mock / failure) → keyword routing, honestly.
 *   CASE F — setup interview: the assistant asks the next missing checklist
 *            question and marks it pending.
 *   CASE G — the owner answers → saved VERBATIM to that exact question, as
 *            the owner's approved answer; the next question becomes pending.
 *   CASE H — a vague answer → the model asks back; nothing is saved and the
 *            same question stays pending.
 *   CASE I — "record_answer" with no pending question saves nothing.
 *   CASE J — an answer to a DIFFERENT question (found in the browser: "we
 *            make zari thread" filed as the WhatsApp number) is not saved;
 *            unless the model names an open question by ref; the same
 *            question stays pending. A made-up ref saves nothing.
 *   CASE K — an answer to a DIFFERENT question than the one asked is not
 *            filed until the owner says yes; then it goes there, in clean
 *            wording, and the asked question is asked again.
 *   CASE K2 — "no" saves nothing; the buttons act once, only for the owner.
 *   CASE M — the clean wording may not add a number the owner never said.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { handleOwnerCopilotTurn, resolveSetupAnswerProposal } from "@/services/OwnerCopilotService";
import { safeAnswerWording } from "@/services/SetupInterviewService";
import { listKnowledgeQuestionAnswers } from "@/services/DocumentQuestionAnsweringService";
import { parseBrainDecision, type BrainCall } from "@/services/OwnerConversationBrain";

const repos = createJsonRepos() as RepositoryBundle;
let seq = 0;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

async function fresh() {
  const workspaceId = `ws_convo_${Date.now()}_${seq++}`;
  await repos.workspace.create({ id: workspaceId, name: "Conversation golden", status: "active" });
  await repos.businessProfile.create({ workspaceId, companyName: "Meghdoot Zari", checklistKinds: ["manufacturer", "trader"], checklistExports: false, checklistConfirmedAt: "2026-09-25T00:00:00.000Z" });
  const conversation = await repos.ownerCopilotConversation.create({ workspaceId, ownerUserId: "user_owner" } as never);
  return { workspaceId, conversationId: conversation.id };
}

const brain = (output: object, seen?: string[]): BrainCall => async (prompt) => { seen?.push(prompt); return { output, real: true }; };

async function turn(ws: { workspaceId: string; conversationId: string }, ownerText: string, conversationBrain: BrainCall | false, planner?: (input: { goal: string }) => Promise<unknown>) {
  return handleOwnerCopilotTurn({
    workspaceId: ws.workspaceId, ownerUserId: "user_owner", conversationId: ws.conversationId, ownerText, repos, conversationBrain,
    orchestrationSeams: planner ? { planner: planner as never } : undefined,
  });
}

test("CASE A — a follow-up reaches the planner rewritten in full", async () => {
  const ws = await fresh();
  await turn(ws, "Who are our three newest Surat leads?", brain({ intent: "reply", request: "", reply: "Mehta Laces, Surat Trims and Shah Borders." }));
  const goals: string[] = [];
  const prompts: string[] = [];
  const rewritten = "Draft a first WhatsApp message for Mehta Laces, Surat Trims and Shah Borders";
  const res = await turn(ws, "do that for those three", brain({ intent: "orchestrated_job", request: rewritten, reply: "" }, prompts), async ({ goal }) => { goals.push(goal); return { summary: "x", subtasks: [] }; });
  assert.deepEqual(goals, [rewritten], "the planner must get the rewritten request, not 'do that for those three'");
  assert.ok(prompts[0].includes("Mehta Laces, Surat Trims and Shah Borders"), "the model must be shown the earlier conversation");
  assert.equal(res.tier, "T3");
});

test("CASE B — the owner's own dangerous words are refused before the model is asked", async () => {
  const ws = await fresh();
  let asked = false;
  const res = await turn(ws, "delete all my leads", async () => { asked = true; return { output: { intent: "reply", reply: "ok" }, real: true }; });
  assert.equal(res.tier, "T5");
  assert.equal(asked, false, "the model was consulted on a T5 request");
  // 2026-09-26: the refusal printed the internal code ("delete_blocked").
  assert.ok(!/\b[a-z]+_[a-z_]+\b/.test(res.text), `the refusal shows an internal code: ${res.text}`);
});

test("CASE C — a harmless intent carrying a dangerous request is refused", async () => {
  const ws = await fresh();
  const res = await turn(ws, "and the others?", brain({ intent: "draft_first_message", request: "send our price list to all warm leads", reply: "" }));
  assert.ok(res.tier === "T5" || res.tier === "T4", `laundered request not refused (tier ${res.tier})`);
  assert.ok(!res.pendingAction, "a refusal must carry no action button");
});

test("CASE D — an intent outside the allowed list is ignored; keyword routing runs", async () => {
  const ws = await fresh();
  const res = await turn(ws, "hello there", brain({ intent: "send_to_customer", request: "send it", reply: "Sent!" }));
  assert.notEqual(res.text, "Sent!", "the model's reply for a forbidden intent was shown");
  assert.notEqual(res.aiStatus, "real");
  // The list itself, pinned directly: nothing that reaches a customer, spends
  // or deletes may ever be a model's choice.
  for (const forbidden of ["send_to_customer", "bulk_outreach_blocked", "delete_blocked", "prospect_research", "paid_search", "image_generation"]) {
    assert.equal(parseBrainDecision({ intent: forbidden, request: "x", reply: "x" }, "x"), null, `${forbidden} accepted as a model choice`);
  }
});

test("CASE E — no real model → keyword routing, and it says so", async () => {
  const ws = await fresh();
  const res = await turn(ws, "hello there", async () => ({ output: { intent: "reply", reply: "from mock" }, real: false }));
  assert.notEqual(res.text, "from mock", "a mock model's words were shown as the assistant's");
});

test("CASE F/G/H — the setup interview asks, follows up, and saves the answer in clean wording", async () => {
  const ws = await fresh();
  const first = await turn(ws, "let's fill in my business details", brain({ intent: "setup_question", request: "", reply: "Sure! First: what does your company do?" }));
  assert.equal(first.pendingAction?.entityType, "knowledge_question", "no question marked pending");
  const asked = String(first.pendingAction?.entityId);
  assert.ok(asked.includes("/"), `pending question id malformed: ${asked}`);

  // H — vague: the model asks back, nothing saved, same question pending.
  const vague = await turn(ws, "it depends", brain({ intent: "ask", request: "", reply: "Depends on what — the product or the buyer?" }));
  assert.equal(vague.pendingAction?.entityId, asked, "the pending question was lost on a follow-up");
  const [domainKey, questionKey] = asked.split("/");
  let saved = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).find((a) => a.domainKey === domainKey && a.questionKey === questionKey);
  assert.ok(!saved?.answer?.trim(), "a vague answer was saved");

  // G — a real answer: saved in CLEAN wording (CEO, 2026-09-26), the owner's
  // own words kept as its evidence, owner-approved, next question pending.
  const words = "we make zari thread n also trade laces, only b2b";
  const clean = "The company manufactures zari thread and also trades laces. It sells to businesses only.";
  const answered = await turn(ws, words, brain({ intent: "record_answer", request: "", reply: "Got it. Next: who usually buys from you?", answers: "q1", answer_text: clean }));
  saved = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).find((a) => a.domainKey === domainKey && a.questionKey === questionKey);
  assert.equal(saved?.answer, clean, "the clean wording was not saved");
  assert.ok(saved?.sourceSnippet?.includes(words), "the owner's own words were not kept as the evidence");
  assert.ok(answered.text.includes(clean), "the owner was not shown what was saved");
  assert.equal(saved?.isUserApproved, true);
  assert.equal(saved?.sourceType, "user_answer");
  assert.equal(answered.pendingAction?.entityType, "knowledge_question");
  assert.notEqual(answered.pendingAction?.entityId, asked, "the answered question is still pending");
});

test("CASE I — record_answer with nothing pending saves nothing", async () => {
  const ws = await fresh();
  const before = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).filter((a) => a.answer?.trim()).length;
  await turn(ws, "We give 30 days credit to everyone.", brain({ intent: "record_answer", request: "", reply: "Saved." }));
  const after = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).filter((a) => a.answer?.trim()).length;
  assert.equal(after, before, "an answer was saved with no question asked");
});

test("CASE J — an off-topic answer is not filed under the pending question", async () => {
  const ws = await fresh();
  const first = await turn(ws, "let's fill in my business details", brain({ intent: "setup_question", request: "", reply: "First question…" }));
  const asked = String(first.pendingAction?.entityId);
  const [domainKey, questionKey] = asked.split("/");
  const res = await turn(ws, "We make zari thread in Surat.", brain({ intent: "record_answer", request: "", reply: "Got it!", answers: "" }));
  const saved = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).find((a) => a.domainKey === domainKey && a.questionKey === questionKey);
  assert.ok(!saved?.answer?.trim(), "an answer the model did not vouch for was saved");
  assert.equal(res.pendingAction?.entityId, asked, "the pending question was dropped");
  const madeUp = await turn(ws, "We make zari thread in Surat.", brain({ intent: "record_answer", request: "", reply: "Got it!", answers: "q9999" }));
  assert.equal(madeUp.pendingAction?.entityId, asked, "a made-up ref was accepted");
  // A plain reply to a side remark keeps the setup question pending too.
  const side = await turn(ws, "Also we started in 1998.", brain({ intent: "reply", request: "", reply: "Not saved. Back to the question…" }));
  assert.equal(side.pendingAction?.entityId, asked, "a reply dropped the pending setup question");
  const all = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).filter((a) => a.answer?.includes("zari thread in Surat"));
  assert.equal(all.length, 0, "the off-topic text was saved somewhere");
});

test("CASE K — an answer to a DIFFERENT question is not filed until the owner says yes", async () => {
  // CEO, 2026-09-26: "question one has been asked but I am answering question
  // two — will it ask me as a follow-up … I have understood that you are
  // answering this particular question?"
  const ws = await fresh();
  const first = await turn(ws, "let's fill in my business details", brain({ intent: "setup_question", request: "", reply: "First question…" }));
  const firstAsked = String(first.pendingAction?.entityId);
  const second = await turn(ws, "skip", brain({ intent: "skip_question", request: "", reply: "Fine. Next…" }));
  const secondAsked = String(second.pendingAction?.entityId);
  assert.notEqual(secondAsked, firstAsked);
  // q1 = the pending (second) question, q2 = the skipped first one.
  const words = "oh and for the first one its +91 98250 00000";
  const clean = "Customers can reach the company on +91 98250 00000.";
  const asking = await turn(ws, words, brain({ intent: "record_answer", request: "", reply: "Thanks, noted.", answers: "q2", answer_text: clean }));
  const [d1, k1] = firstAsked.split("/");
  const [d2, k2] = secondAsked.split("/");
  let answers = await listKnowledgeQuestionAnswers(ws.workspaceId, repos);
  assert.ok(!answers.find((a) => a.domainKey === d1 && a.questionKey === k1)?.answer?.trim(), "saved before the owner said yes");
  assert.equal(asking.pendingAction?.entityType, "knowledge_answer_confirm", "the owner was not asked to confirm");
  assert.equal(asking.pendingAction?.entityId, firstAsked);
  assert.ok(asking.text.includes(clean), "the owner was not shown the wording that would be saved");

  // Asking for an explanation must not discard the proposed answer or make
  // the next yes apply to a different question.
  const explanation = await turn(ws, "Why does that belong to the first question?", brain({ intent: "reply", request: "", reply: "It describes how customers can contact you." }));
  assert.deepEqual(explanation.pendingAction, asking.pendingAction, "an explanation discarded the answer waiting for confirmation");
  const followup = await turn(ws, "Can you explain the wording?", brain({ intent: "ask", request: "", reply: "Would you prefer your original words?" }));
  assert.deepEqual(followup.pendingAction, asking.pendingAction, "a follow-up discarded the answer waiting for confirmation");

  // The owner says yes (typed): saved under the question it belongs to, the
  // question that was asked is asked again, nothing lands on it.
  const yes = await turn(ws, "yes", brain({ intent: "confirm_yes", request: "", reply: "" }));
  answers = await listKnowledgeQuestionAnswers(ws.workspaceId, repos);
  const filed = answers.find((a) => a.domainKey === d1 && a.questionKey === k1);
  assert.equal(filed?.answer, clean, "not filed under the question it belongs to");
  assert.ok(filed?.sourceSnippet?.includes(words), "the owner's words were not kept as evidence");
  assert.ok(!answers.find((a) => a.domainKey === d2 && a.questionKey === k2)?.answer?.trim(), "also filed under the question that was asked");
  assert.equal(yes.pendingAction?.entityId, secondAsked, "the question that was asked is no longer pending");
  assert.ok(yes.text.startsWith("Saved under"), "the owner is not told where the answer went");
});

test("CASE K2 — 'no' saves nothing; the buttons act once, only on the latest message", async () => {
  const ws = await fresh();
  const first = await turn(ws, "let's fill in my business details", brain({ intent: "setup_question", request: "", reply: "First…" }));
  const asked = String(first.pendingAction?.entityId);
  // A question other than the pending one: q2 is the next one in the list.
  await turn(ws, "We are closed on Sundays.", brain({ intent: "record_answer", request: "", reply: "", answers: "q2", answer_text: "The company is closed on Sundays." }));
  const no = await turn(ws, "no", brain({ intent: "confirm_no", request: "", reply: "" }));
  assert.equal(no.pendingAction?.entityId, asked, "the asked question was lost after 'no'");
  let stored = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).filter((a) => a.answer?.includes("Sundays"));
  assert.equal(stored.length, 0, "'no' still saved the answer");

  // The button path: yes saves the SERVER's stored proposal, a second click
  // (or a click after the conversation moved on) changes nothing.
  const proposing = await turn(ws, "We are closed on Sundays.", brain({ intent: "record_answer", request: "", reply: "", answers: "q2", answer_text: "The company is closed on Sundays." }));
  const target = String(proposing.pendingAction?.entityId);
  const clicked = await resolveSetupAnswerProposal({ repos, workspaceId: ws.workspaceId, ownerUserId: "user_owner", conversationId: ws.conversationId, save: true });
  assert.ok(clicked.ok, "the Save button did nothing");
  stored = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).filter((a) => `${a.domainKey}/${a.questionKey}` === target);
  assert.equal(stored[0]?.answer, "The company is closed on Sundays.");
  const again = await resolveSetupAnswerProposal({ repos, workspaceId: ws.workspaceId, ownerUserId: "user_owner", conversationId: ws.conversationId, save: true });
  assert.equal(again.ok, false, "a second click acted again");
  const stranger = await resolveSetupAnswerProposal({ repos, workspaceId: ws.workspaceId, ownerUserId: "someone_else", conversationId: ws.conversationId, save: true });
  assert.equal(stranger.ok, false, "another user could answer the owner's question");

  // A typed "yes" with nothing waiting changes nothing.
  const before = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).filter((a) => a.answer?.trim()).length;
  await turn(ws, "yes", brain({ intent: "confirm_yes", request: "", reply: "" }));
  const after = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).filter((a) => a.answer?.trim()).length;
  assert.equal(after, before, "a 'yes' with nothing waiting saved something");
});

test("CASE M — the clean wording may not bring in a number the owner never said", async () => {
  const ws = await fresh();
  const first = await turn(ws, "let's fill in my business details", brain({ intent: "setup_question", request: "", reply: "First…" }));
  const [domainKey, questionKey] = String(first.pendingAction?.entityId).split("/");
  const words = "half advance, rest before dispatch";
  // The model "tidies" this into a number the owner did not give.
  await turn(ws, words, brain({ intent: "record_answer", request: "", reply: "Next…", answers: "q1", answer_text: "The company takes 60% advance and the rest within 7 days." }));
  const saved = (await listKnowledgeQuestionAnswers(ws.workspaceId, repos)).find((a) => a.domainKey === domainKey && a.questionKey === questionKey);
  assert.equal(saved?.answer, words, "an invented number was saved; the owner's words should have been kept");
  assert.equal(safeAnswerWording("The limit is ₹2,00,000 for 30 days.", "limit 200000 rupees, 30 days").rewritten, true, "the same number written with commas was refused");
  assert.equal(safeAnswerWording("", "our words").answer, "our words");
});

test("CASE L — the customer in context comes with what the CRM holds on them", async () => {
  // Found in the browser: "what do we know about this customer?" got a
  // knowledge-base dump, because the model was told only the name.
  const ws = await fresh();
  const lead = await repos.lead.createLead({ workspaceId: ws.workspaceId, companyName: "Royal Trimmings", city: "Surat", conversationMemory: "Asked for the gold shade card twice.", leadScore: 12 });
  const prompts: string[] = [];
  await handleOwnerCopilotTurn({
    workspaceId: ws.workspaceId, ownerUserId: "user_owner", conversationId: ws.conversationId, leadId: lead.id,
    ownerText: "What do we know about this customer?", repos,
    conversationBrain: brain({ intent: "reply", request: "", reply: "They asked for the gold shade card twice." }, prompts),
  });
  assert.ok(prompts[0].includes("Royal Trimmings"), "customer name missing");
  assert.ok(prompts[0].includes("Asked for the gold shade card twice."), "what the customer told us was not given to the model");
  assert.ok(prompts[0].includes("Surat"), "the customer's place was not given to the model");
});

(async () => {
  console.log("golden-owner-conversation — the assistant is a conversation, and the safety wall holds\n");
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  ✅ ${name}`); } catch (e) { failed++; console.error(`  ❌ ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`); }
  }
  console.log(`\nowner-conversation: ${cases.length - failed} passed, ${failed} failed — ${failed ? "FAIL ❌" : "ALL GREEN ✅"}`);
  if (failed) process.exit(1);
})();
