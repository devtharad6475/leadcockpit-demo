/**
 * golden-review-whatsapp-fixes.ts — the 2026-09-27 six-agent review found holes
 * in WhatsApp handling and in the new automatic replies (docs/REVIEW-2026-09-27.md
 * W1–W12, S1). Each case below failed on the code before the fix.
 *
 *   A — keyword pass: "Hi + a question" is not a greeting; a stray "stop" is not
 *       an opt-out; romanised Hindi and Gujarati price/credit/delivery/complaint
 *       and opt-out phrases are recognised (W2, W3, W4).
 *   B — "Hi, please don't send these anymore" with greeting ticked: the AI says
 *       unsubscribe → nothing is sent, the number goes on do-not-contact (W1).
 *   C — "Hi, is 500m available?" with greeting ticked: not sent (W2).
 *   D — two messages at once with 2 automatic replies already sent: only one more
 *       goes out (cap of 3, W5).
 *   E — a send that throws keeps the draft for the owner (W6).
 *   F — a settings-page test draft cannot be approved and sent (W7).
 *   G — the reply goes to the number that wrote (W8).
 *   H — an approval that never reached the customer is not trial evidence (W9).
 *   I — incoming WhatsApp is filed under the company that owns the number; an
 *       unknown number is dropped in production (S1).
 *
 * The AI and Meta are stubbed: the model reports itself as real, sends are
 * captured. Nothing leaves the machine.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-review-whatsapp-fixes.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AutoReplyLog } from "@/lib/types";
import { classifyCustomerMessage } from "@/conversations/message-classification";
import { LLMService } from "@/llm/LLMService";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { routeWhatsAppWebhook } from "@/services/WhatsAppWebhookService";
import { approveAutoReplyLog } from "@/services/AutoReplyReviewService";
import { computeTrialRecords } from "@/services/AutoReplyTrialService";
import { isPermanentlyDoNotContact } from "@/lib/dnc-registry";
import { NeedsActionError } from "@/lib/user-errors";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

// ---- stubs -----------------------------------------------------------------
let llmOut: Record<string, unknown> = {};
let llmDelayMs = 0;
(LLMService.prototype as unknown as { runTask: unknown }).runTask = async () => {
  if (llmDelayMs) await new Promise((r) => setTimeout(r, llmDelayMs));
  return { output: llmOut, provider: "anthropic", modelName: "stub", mode: "real", fallbackUsed: false, validationStatus: "valid" };
};
const sent: Array<{ to: string; body: string }> = [];
let sendThrows = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("graph.facebook.com")) {
    if (sendThrows) throw new Error("WhatsApp sending is switched off by the operator");
    const b = JSON.parse(String(init?.body || "{}"));
    sent.push({ to: b.to, body: b.text?.body || "" });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 });
  }
  return realFetch(url, init);
}) as typeof fetch;
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = "fake-token-for-test";
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "123";

function llm(classification: string, reply: string, extra: Record<string, unknown> = {}) {
  llmOut = { classification, riskLevel: "low", suggestedReply: reply, confidenceScore: 0.95, needsHumanReview: false, canAutoSend: true, missingKnowledge: false, missingQuestion: "", leadStatusSuggestion: "interested", reason: "stub", ...extra };
}
async function workspace(tag: string, topics: string[]) {
  const W = `ws_rvw_${tag}_${RUN}`;
  await ensureWorkspace(repos, W);
  await repos.whatsAppAgentSettings.upsertForWorkspace(W, { enabled: true, mode: "safe_auto_reply", maxAutoRepliesPerConversation: 3, autoReplyTopics: topics } as never);
  return W;
}
let phoneSeq = 0;
async function buyer(W: string, extra: Record<string, unknown> = {}) {
  phoneSeq++;
  return repos.lead.createLead({ workspaceId: W, companyName: `Buyer ${phoneSeq}`, contactName: "B", whatsappNumber: `9198000${String(phoneSeq).padStart(5, "0")}`, source: "manual", status: "replied", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none", lastInboundAt: new Date().toISOString(), ...extra } as never);
}

test("A — the keyword pass reads what the message actually says", async () => {
  const expect: Array<[string, string]> = [
    ["Hi", "greeting"], ["Namaste ji 🙏", "greeting"], ["Stop", "unsubscribe"], ["Stop messaging me", "unsubscribe"],
    ["Hi, is 500m gold zari available?", "unknown_question"],
    ["Please stop the dispatch, I need to change the quantity", "delivery_question"],
    ["Payment stop ho gaya hai", "payment_question"],
    ["namaste, gold zari ka bhav kya hai?", "price_request"],
    ["Hi, udhaar milega?", "payment_question"],
    ["hello, kab tak milega maal", "delivery_question"],
    ["Hi, maal kharab aaya hai", "complaint"],
    ["message band karo", "unsubscribe"], ["મેસેજ ના મોકલો", "unsubscribe"],
    ["Hi, please don't send these anymore", "unsubscribe"],
  ];
  for (const [message, category] of expect) {
    assert.equal(classifyCustomerMessage(message).category, category, `"${message}"`);
  }
  assert.notEqual(classifyCustomerMessage("Your shop is near which bus stop?").category, "unsubscribe", "a bus stop is not an opt-out");
});

test("B — an opt-out after 'Hi' gets no automatic reply and goes on do-not-contact", async () => {
  const W = await workspace("b", ["greeting"]);
  const lead = await buyer(W);
  sent.length = 0;
  llm("unsubscribe", "Hi! What can I help you with today?");
  // The keyword pass sees only a greeting; the AI, reading the whole conversation, says unsubscribe.
  await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: lead.whatsappNumber, rawText: "Hello sir" }, repos, { allowRealSend: true });
  assert.equal(sent.length, 0, "a reply went out to a buyer who opted out");
  assert.equal(await isPermanentlyDoNotContact(W, { phone: lead.whatsappNumber } as never, repos), true, "the opt-out was not recorded");
});

test("C — 'Hi' plus a real question is not sent as a greeting", async () => {
  const W = await workspace("c", ["greeting"]);
  const lead = await buyer(W);
  sent.length = 0;
  llm("other", "Yes, 500m is in stock and we can dispatch today.");
  await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: lead.whatsappNumber, rawText: "Hi, is 500m gold zari available?" }, repos, { allowRealSend: true });
  assert.equal(sent.length, 0, "an unapproved stock promise went out as a 'greeting'");
});

test("D — two messages at once cannot break the cap of 3 in a row", async () => {
  const W = await workspace("d", ["greeting"]);
  const lead = await buyer(W);
  for (let i = 0; i < 2; i++) {
    await repos.autoReplyLog.create(W, { leadId: lead.id, channel: "whatsapp", incomingMessage: "hi", retrievedContext: {}, classification: "greeting", generatedReply: "Hello!", canAutoSend: true, needsHumanReview: false, status: "auto_sent", createdAt: new Date(Date.now() - (10 - i) * 60_000).toISOString() } as never);
  }
  sent.length = 0;
  llm("greeting", "Hello! How can we help?");
  llmDelayMs = 60;
  await Promise.all([
    handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: lead.whatsappNumber, rawText: "Hi" }, repos, { allowRealSend: true }),
    handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: lead.whatsappNumber, rawText: "Hello" }, repos, { allowRealSend: true }),
  ]);
  llmDelayMs = 0;
  assert.equal(sent.length, 1, `expected 1 more automatic reply (cap 3), got ${sent.length}`);
});

test("E — a send that fails keeps the customer's message and the draft for the owner", async () => {
  const W = await workspace("e", ["greeting"]);
  const lead = await buyer(W);
  sendThrows = true;
  llm("greeting", "Hello! How can we help?");
  let result;
  try {
    result = await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: lead.whatsappNumber, rawText: "Hello" }, repos, { allowRealSend: true });
  } finally {
    sendThrows = false;
  }
  const log = await repos.autoReplyLog.getById(W, String(result.autoReplyLogId));
  assert.ok(log, "the draft was lost");
  assert.ok(["drafted", "held_for_review"].includes(String(log?.status)), `the draft is not in the owner's queue (status ${log?.status})`);
});

test("F — a settings-page test draft cannot be approved and sent", async () => {
  const W = await workspace("f", []);
  const lead = await buyer(W);
  const testLog = await repos.autoReplyLog.create(W, { leadId: lead.id, channel: "whatsapp", incomingMessage: "price?", retrievedContext: {}, classification: "price_request", generatedReply: "Our price is Rs 900/kg", canAutoSend: false, needsHumanReview: true, status: "test_only_held_for_review" as never });
  sent.length = 0;
  await assert.rejects(() => approveAutoReplyLog(W, testLog.id, {}, repos), NeedsActionError);
  assert.equal(sent.length, 0, "a test draft reached a real customer");
});

test("G — the automatic reply goes to the number that wrote", async () => {
  const W = await workspace("g", ["greeting"]);
  const lead = await buyer(W, { phone: "919811111111" });
  sent.length = 0;
  llm("greeting", "Hello! How can we help?");
  await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: "919811111111", rawText: "Hello" }, repos, { allowRealSend: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to.slice(-10), "9811111111", `replied to ${sent[0].to}, not the number that wrote`);
});

test("H — an approval that never reached the customer is not trial evidence", async () => {
  const logs = Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, workspaceId: "w", channel: "whatsapp", incomingMessage: "hi", retrievedContext: {}, classification: "greeting", canAutoSend: false, needsHumanReview: false, status: "approved", sendStatus: "blocked", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) as AutoReplyLog);
  const record = computeTrialRecords(logs).find((r) => r.topic === "greeting");
  assert.equal(record?.proven, false, "blocked sends proved a kind");
});

test("I — incoming WhatsApp goes to the company that owns the number", async () => {
  const A = `ws_rvw_route_a_${RUN}`;
  const B = `ws_rvw_route_b_${RUN}`;
  await ensureWorkspace(repos, A);
  await ensureWorkspace(repos, B);
  await repos.llmProviderCredential.create(B, { provider: "whatsapp_cloud", displayName: "WhatsApp Cloud", encryptedApiKey: "x", status: "connected", config: { phoneNumberId: `PN_B_${RUN}` } } as never);
  const body = (numberId: string) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: numberId }, messages: [{ from: "919822222222", id: `m_${numberId}`, type: "text", text: { body: "hi" } }] } }] }] });
  const toB = await routeWhatsAppWebhook(body(`PN_B_${RUN}`), repos, { defaultWorkspaceId: A, deploymentPhoneNumberId: "123", demoFallback: false });
  assert.deepEqual(toB.routed.map((r) => r.workspaceId), [B], "company B's customer was not filed under company B");
  const toDeployment = await routeWhatsAppWebhook(body("123"), repos, { defaultWorkspaceId: A, deploymentPhoneNumberId: "123", demoFallback: false });
  assert.deepEqual(toDeployment.routed.map((r) => r.workspaceId), [A], "the deployment's own number belongs to the default company");
  const unknown = await routeWhatsAppWebhook(body("PN_NOBODY"), repos, { defaultWorkspaceId: A, deploymentPhoneNumberId: "123", demoFallback: false });
  assert.equal(unknown.routed.length, 0, "a number no company owns was filed under the default company");
  assert.equal(unknown.unrouted, 1);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
