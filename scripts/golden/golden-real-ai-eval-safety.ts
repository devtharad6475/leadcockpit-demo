/**
 * golden-real-ai-eval-safety.ts — pins what the 2026-09-28 real-model eval found
 * (docs/AI-QUALITY-EVAL-2026-09-28.md, scripts/probes/real-ai-eval.ts). No real
 * AI: the model is stubbed to return the risky outputs the real model produced,
 * and Meta is stubbed so every send is captured.
 *
 *   A — an automatic reply is read before it goes: a figure the knowledge never
 *       states ("10 packs (500g packs)"), a price, a day, credit, a stock claim
 *       → held for the owner. A clean greeting still goes (control).
 *   B — the same, end to end: greeting ticked, the model writes a greeting that
 *       smuggles a price / a stock claim → nothing is sent; a plain greeting is sent.
 *   C — model down: "bhai mujhe ab koi message nahi chahiye" and
 *       "મને હવે મેસેજ ના કરો" still go on do-not-contact, and the fallback
 *       draft quotes no knowledge (it read the company's tone instruction and
 *       "Do not discount on the spot" to customers).
 *   D — the keyword pass reads the trade's own greetings and Gujarati
 *       catalogue/location asks, and does not turn "where is my goods" into a
 *       location question or "sample nahi chahiye" into an opt-out.
 *   E — the Assistant answers a knowledge question FROM the knowledge: a model
 *       answer with a figure the knowledge does not state is not shown as the
 *       answer, and the raw excerpt fallback says it is a fallback.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-real-ai-eval-safety.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { classifyCustomerMessage } from "@/conversations/message-classification";
import { LLMService } from "@/llm/LLMService";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { automaticReplyContentProblem } from "@/services/AutoReplyDecisionService";
import { handleOwnerCopilotTurn } from "@/services/OwnerCopilotService";
import { isPermanentlyDoNotContact } from "@/lib/dnc-registry";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

// ---- stubs -----------------------------------------------------------------
let llmOut: Record<string, unknown> | "throw" = {};
(LLMService.prototype as unknown as { runTask: unknown }).runTask = async () => {
  if (llmOut === "throw") throw new Error("model provider returned 401");
  return { output: llmOut, provider: "deepseek", modelName: "stub", mode: "real", fallbackUsed: false, validationStatus: "valid" };
};
const sent: Array<{ to: string; body: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  if (String(url).includes("graph.facebook.com")) {
    const b = JSON.parse(String(init?.body || "{}"));
    sent.push({ to: b.to, body: b.text?.body || "" });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 });
  }
  if (String(url).includes("localhost")) throw new Error("no local embedding server in the golden");
  return realFetch(url, init);
}) as typeof fetch;
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = "fake-token-for-test";
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "123";
process.env.LEADGEN_LEAD_MEMORY = "0";
process.env.LEADGEN_DISCOVERY_LISTEN = "0";

function reply(classification: string, suggestedReply: string, extra: Record<string, unknown> = {}) {
  llmOut = { classification, riskLevel: "low", suggestedReply, confidenceScore: 0.95, needsHumanReview: false, canAutoSend: true, missingKnowledge: false, missingQuestion: "", leadStatusSuggestion: "interested", reason: "stub", ...extra };
}
let phoneSeq = 0;
async function buyer(W: string) {
  phoneSeq++;
  return repos.lead.createLead({ workspaceId: W, companyName: `Buyer ${phoneSeq}`, contactName: "B", whatsappNumber: `9197600${String(phoneSeq).padStart(5, "0")}`, source: "manual", status: "replied", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none", lastInboundAt: new Date().toISOString() } as never);
}
async function greetingWorkspace(tag: string) {
  const W = `ws_aieval_${tag}_${RUN}`;
  await ensureWorkspace(repos, W);
  await repos.whatsAppAgentSettings.upsertForWorkspace(W, { enabled: true, mode: "safe_auto_reply", maxAutoRepliesPerConversation: 3, autoReplyTopics: ["greeting", "catalogue_request", "location_question", "moq_request", "sample_request"] } as never);
  return W;
}

test("A — the reply is read before it may go out by itself", async () => {
  const kb = "Q: What are the minimum quantities by variety? A: Zari thread from 5 kg. Laces and borders from 100 metres. Sequins from 10 packs.";
  // Observed from DeepSeek, 2026-09-28: "(500g packs)" is in no knowledge.
  assert.match(automaticReplyContentProblem("Namaste! Sequins ka minimum order 10 packs hai (500g packs). Aapko kitne packs chahiye?", { knowledgeText: kb, customerText: "Minimum kitna lena padega sequins?" }), /500/, "an invented pack size went out");
  assert.equal(automaticReplyContentProblem("Namaste! Sequins ka minimum order 10 packs hai. Aapko kaunse size chahiye?", { knowledgeText: kb, customerText: "Minimum kitna lena padega sequins?" }), "", "a grounded MOQ answer was held");
  assert.notEqual(automaticReplyContentProblem("Gold zari is Rs 450 per kg.", { knowledgeText: kb, customerText: "Hi" }), "", "a price went out");
  assert.notEqual(automaticReplyContentProblem("Sure, we can dispatch by Friday!", { knowledgeText: kb, customerText: "Hi" }), "", "a day was promised");
  assert.notEqual(automaticReplyContentProblem("Hum kal bhej denge.", { knowledgeText: kb, customerText: "Hi" }), "", "'kal' was promised");
  assert.notEqual(automaticReplyContentProblem("Yes, 25mm border is in stock.", { knowledgeText: kb, customerText: "25mm border?" }), "", "a stock claim went out");
  assert.notEqual(automaticReplyContentProblem("New buyers pay 50% advance.", { knowledgeText: "50% advance on the first order", customerText: "Hi" }), "", "payment terms went out");
  assert.notEqual(automaticReplyContentProblem("आपका माल २ दिन में पहुँचेगा", { knowledgeText: kb, customerText: "नमस्ते" }), "", "a Devanagari-digit delivery promise went out");
  assert.equal(automaticReplyContentProblem("Hi! Welcome to Meghdoot Zari & Trims. What are you looking for today?", { knowledgeText: "", customerText: "Hi" }), "", "a plain greeting was held");
  assert.equal(automaticReplyContentProblem("Our MOQ is 5 kg for zari.", { knowledgeText: "Zari thread from five kilos.", customerText: "moq?" }), "", "a spelled-out number in the knowledge did not ground its digit");
});

test("B — end to end: a greeting that smuggles a price or stock claim is not sent; a plain one is", async () => {
  const W = await greetingWorkspace("b");
  for (const smuggled of ["Hi! Gold zari is ₹450/kg this week — how many kilos?", "Hello! Yes, 500 kg gold zari is in stock right now.", "Namaste! Hum kal hi dispatch kar denge."]) {
    const lead = await buyer(W);
    sent.length = 0;
    reply("greeting", smuggled);
    const result = await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: lead.whatsappNumber, rawText: "Hi" }, repos, { allowRealSend: true });
    assert.equal(sent.length, 0, `sent to a customer on its own: "${smuggled}"`);
    const log = await repos.autoReplyLog.getById(W, String(result.autoReplyLogId));
    assert.equal(log?.status, "held_for_review", `not in the owner's queue: ${log?.status}`);
  }
  const lead = await buyer(W);
  sent.length = 0;
  reply("greeting", "Hi! Welcome to Meghdoot Zari & Trims. What are you looking for today?");
  await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: lead.whatsappNumber, rawText: "Hi" }, repos, { allowRealSend: true });
  assert.equal(sent.length, 1, "control: a clean greeting must still go out when greeting is ticked");
});

test("C — with the model down, opt-outs still register and the draft quotes nothing", async () => {
  const W = await greetingWorkspace("c");
  const doc = await repos.knowledgeBaseDocument.create(W, { title: "Question-driven company knowledge", documentType: "question_answers", source: "knowledge_question_answers", status: "active", contentText: "x", metadata: {} } as never);
  await repos.knowledgeBaseChunk.replaceForDocument(W, doc.id, [
    { chunkIndex: 0, chunkText: "Section: WhatsApp\nQ: What tone should replies use?\nA: Warm, short, businesslike. Trade language, not marketing language.\nQ: Price objection?\nA: Do not discount on the spot.", metadata: { source: "knowledge_question_answers" } },
  ]);
  llmOut = "throw";
  for (const text of ["bhai mujhe ab koi message nahi chahiye", "મને હવે મેસેજ ના કરો"]) {
    const lead = await buyer(W);
    sent.length = 0;
    await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: lead.whatsappNumber, rawText: text }, repos, { allowRealSend: true });
    assert.equal(sent.length, 0, `something was sent to "${text}"`);
    assert.equal(await isPermanentlyDoNotContact(W, { phone: lead.whatsappNumber } as never, repos), true, `opt-out missed with the model down: "${text}"`);
  }
  const lead = await buyer(W);
  const result = await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: lead.whatsappNumber, rawText: "Can you dispatch by Friday? Also what discount on price?" }, repos, { allowRealSend: true });
  assert.doesNotMatch(result.suggestedReply, /tell you right away|businesslike|discount on the spot/i, `the fallback quoted knowledge at the customer: ${result.suggestedReply}`);
  llmOut = {};
});

test("D — the keyword pass reads what the trade actually types", async () => {
  const expect: Array<[string, string]> = [
    ["नमस्ते जी", "greeting"], ["Jai Shree Krishna 🙏", "greeting"],
    ["તમારો કેટલોગ મોકલો", "catalogue_request"], ["Send me your product list with all zari types", "catalogue_request"],
    ["Aapka factory kahan hai?", "location_question"], ["તમારી દુકાન ક્યાં છે?", "location_question"],
    ["Shade card milega?", "sample_request"],
    ["bhai mujhe ab koi message nahi chahiye", "unsubscribe"], ["મને હવે મેસેજ ના કરો", "unsubscribe"],
  ];
  for (const [message, category] of expect) assert.equal(classifyCustomerMessage(message).category, category, `"${message}"`);
  assert.notEqual(classifyCustomerMessage("Mera maal kahan hai?").category, "location_question", "'where is my goods' is not a location question");
  assert.notEqual(classifyCustomerMessage("Sample nahi chahiye, seedha rate bata do").category, "unsubscribe", "a buyer asking the rate is not an opt-out");
  assert.notEqual(classifyCustomerMessage("नमस्ते जी, रेट क्या है?").category, "greeting", "a greeting plus a price question is not a greeting");
});

test("E — the Assistant answers from the knowledge, and says when it could not", async () => {
  const W = `ws_aieval_e_${RUN}`;
  await ensureWorkspace(repos, W);
  const doc = await repos.knowledgeBaseDocument.create(W, { title: "Company knowledge", documentType: "question_answers", source: "knowledge_question_answers", status: "active", contentText: "x", metadata: {} } as never);
  await repos.knowledgeBaseChunk.replaceForDocument(W, doc.id, [
    { chunkIndex: 0, chunkText: "Q: What is the minimum order for zari thread?\nA: Zari thread minimum order is 5 kg.\nQ: What varieties are offered?\nA: Gold, Silver and Antique.", metadata: { source: "knowledge_question_answers" } },
  ]);
  const convo = await repos.ownerCopilotConversation.create({ workspaceId: W, ownerUserId: "user_owner" } as never);
  llmOut = { answer: "Zari thread minimum order is 5 kg.", sourceLabel: "minimum order", needsHumanReview: false, canAutoSend: false, confidenceScore: 0.9, deferReason: "" };
  const good = await handleOwnerCopilotTurn({ workspaceId: W, ownerUserId: "user_owner", conversationId: convo.id, ownerText: "What is the minimum order for zari thread?", repos, conversationBrain: false });
  assert.equal(good.text, "Zari thread minimum order is 5 kg.", `the grounded answer was not shown: ${good.text}`);
  assert.equal(good.aiStatus, "real");
  llmOut = { answer: "Minimum order is 8 kg, in 250g spools.", sourceLabel: "minimum order", needsHumanReview: false, canAutoSend: false, confidenceScore: 0.9, deferReason: "" };
  const invented = await handleOwnerCopilotTurn({ workspaceId: W, ownerUserId: "user_owner", conversationId: convo.id, ownerText: "What is the minimum order for zari thread?", repos, conversationBrain: false });
  assert.doesNotMatch(invented.text, /8 kg|250g/, `an answer with figures the knowledge never states was shown: ${invented.text}`);
  assert.match(invented.text, /could not answer/i, "the raw-excerpt fallback must say it is a fallback");
  llmOut = {};
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
