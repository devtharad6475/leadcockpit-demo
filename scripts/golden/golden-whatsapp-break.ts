/**
 * golden-whatsapp-break.ts — what the 2026-09-26 break test found in the
 * WhatsApp inbound → draft → approval → send pipeline, pinned.
 *
 *   A — a photo / location / sticker a customer sends reaches the owner. The
 *       webhook claims the message id before routing media, and the media
 *       service then checked the same id, found it, and dropped every media
 *       message as a "duplicate delivery".
 *   B — a buyer is not put on the permanent do-not-contact list by words that
 *       are not an opt-out: Hindi "नहीं चाहिए" ("don't need", e.g. "no sample
 *       needed, tell me the rate") and "one-stop shop" / "non-stop".
 *   C — real opt-outs written the way people write them are caught: a phone's
 *       curly apostrophe ("Don’t message me"), "do not message", "opt out",
 *       "remove my number", Hinglish "message mat karo". STOP still works.
 *   D — a message from 919825033333 finds the lead saved as "98250 33333"
 *       instead of creating a second, empty lead for the same customer.
 *   E — dismissing a reply that was already approved and sent is refused; the
 *       record kept saying "rejected" for a message the customer received.
 *   F — when WhatsApp refuses the send, the owner is told why (a 4xx with
 *       WhatsApp's reason), not "something went wrong on our side".
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-whatsapp-break.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { NeedsActionError } from "@/lib/user-errors";
import { classifyCustomerMessage } from "@/conversations/message-classification";
import { processWhatsAppCloudWebhook, getOrCreateInboundWhatsAppLead } from "@/services/WhatsAppWebhookService";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { isPermanentlyDoNotContact } from "@/lib/dnc-registry";
import { approveAutoReplyLog, rejectAutoReplyLog } from "@/services/AutoReplyReviewService";
import type { WhatsAppSendProvider } from "@/providers/whatsapp/WhatsAppSendProvider";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

async function ws(tag: string) {
  const id = `ws_wabreak_${tag}_${RUN}`;
  await ensureWorkspace(repos, id);
  return id;
}

async function seedLead(workspaceId: string, phone: string) {
  const lead = await repos.lead.createLead({
    workspaceId, companyName: "Break Test Buyer", contactName: "Buyer", whatsappNumber: phone,
    source: "manual", status: "approved", reviewStatus: "approved", enrichmentStatus: "completed",
    doNotContact: false, consentStatus: "none",
  });
  return repos.lead.updateLead(workspaceId, lead.id, { lastInboundAt: new Date().toISOString() });
}

async function seedDraft(workspaceId: string, leadId: string) {
  const reply = await repos.reply.create({ workspaceId, leadId, channel: "whatsapp", rawText: "customer message" });
  return repos.autoReplyLog.create(workspaceId, {
    leadId, replyId: reply.id, channel: "whatsapp", incomingMessage: "customer message", retrievedContext: {},
    generatedReply: "Thanks, sharing the details.", canAutoSend: false, needsHumanReview: true, status: "held_for_review",
  });
}

function stubProvider(result: Awaited<ReturnType<WhatsAppSendProvider["sendTextMessage"]>>): WhatsAppSendProvider & { calls: number } {
  const p = {
    calls: 0,
    isConfigured: () => true,
    async sendTextMessage() { p.calls += 1; return result; },
  };
  return p as unknown as WhatsAppSendProvider & { calls: number };
}

test("K — a number saved without a country code is sent as an Indian number (+91)", async () => {
  // 2026-09-27 (CEO): customers are Indian, so a number without a code gets 91.
  const { toWhatsAppRecipient } = await import("@/providers/whatsapp/MetaWhatsAppCloudProvider");
  const expected: Array<[string, string]> = [
    ["98250 33333", "919825033333"], ["098250 33333", "919825033333"], ["+91 98250 33333", "919825033333"],
    ["919825033333", "919825033333"], ["0091 98250 33333", "919825033333"],
    ["+1 415 555 1234", "14155551234"], ["+971 50 123 4567", "971501234567"],
  ];
  for (const [input, out] of expected) assert.equal(toWhatsAppRecipient(input), out, `"${input}"`);
});

test("A — a location a customer sends is not dropped as a 'duplicate'", async () => {
  const W = await ws("a");
  const result = await processWhatsAppCloudWebhook(W, {
    entry: [{ changes: [{ value: { messages: [{ from: "919800000101", id: `wamid.A_${RUN}`, type: "location", location: { latitude: 21.1, longitude: 72.8 } }] } }] }],
  }, repos);
  const row = result.processedMessages[0];
  assert.ok(!/duplicate/i.test(String(row.reason)), `first delivery of a media message was treated as a duplicate: ${row.reason}`);
  const logs = await repos.autoReplyLog.listByWorkspace(W);
  assert.equal(logs.length, 1, "the owner got no review card for the customer's location");
});

test("B — 'no sample needed, tell the rate' in Hindi and 'one-stop shop' are not opt-outs", async () => {
  for (const text of ["सैंपल नहीं चाहिए, रेट बताओ", "We are a one-stop shop for zari, what is your rate?", "Need non-stop supply, price?"]) {
    assert.notEqual(classifyCustomerMessage(text).category, "unsubscribe", `"${text}" was read as an opt-out`);
  }
  // Through the engine: the buyer stays contactable.
  const W = await ws("b");
  const lead = await seedLead(W, "+91 98000 00102");
  await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: lead.id, phone: "919800000102", rawText: "सैंपल नहीं चाहिए, रेट बताओ" }, repos);
  assert.equal(await isPermanentlyDoNotContact(W, { phone: "919800000102" }, repos), false, "a buyer asking the rate was put on the permanent do-not-contact list");
});

test("C — opt-outs written the way people write them are caught", async () => {
  for (const text of ["STOP", "Stop.", "Don’t message me again", "Please do not message me again", "opt out", "Opt-out please", "remove my number", "message mat karo", "मैसेज मत भेजो"]) {
    assert.equal(classifyCustomerMessage(text).category, "unsubscribe", `"${text}" was not recognised as an opt-out`);
  }
});

test("D — +91 / 0 / spaces: the inbound number finds the existing lead", async () => {
  const W = await ws("d");
  const saved = await seedLead(W, "98250 33333");
  const found = await getOrCreateInboundWhatsAppLead(W, "919825033333", "Buyer", repos);
  assert.equal(found?.id, saved.id, "a second lead was created for the same customer");
  const W2 = await ws("d2");
  const saved2 = await seedLead(W2, "098250 44444");
  const found2 = await getOrCreateInboundWhatsAppLead(W2, "919825044444", "Buyer", repos);
  assert.equal(found2?.id, saved2.id, "the trunk-0 form did not match");
  // Exact match still wins over a last-ten-digits match.
  const W3 = await ws("d3");
  await seedLead(W3, "98250 55555");
  const exact = await seedLead(W3, "+91 98250 55555");
  assert.equal((await getOrCreateInboundWhatsAppLead(W3, "919825055555", "Buyer", repos))?.id, exact.id);
});

test("E — a reply already approved and sent cannot be dismissed afterwards", async () => {
  const W = await ws("e");
  const lead = await seedLead(W, "+91 98000 00105");
  const log = await seedDraft(W, lead.id);
  const provider = stubProvider({ attempted: true, status: "sent", provider: "meta_cloud", providerMessageId: "wamid.E" });
  await approveAutoReplyLog(W, log.id, {}, repos, "owner", { whatsappProvider: provider });
  await assert.rejects(() => rejectAutoReplyLog(W, log.id, repos), (e: unknown) => e instanceof NeedsActionError);
  assert.equal((await repos.autoReplyLog.getById(W, log.id))?.status, "approved", "a sent reply was relabelled as rejected");
  // Reject, then approve: refused with words meant for the owner.
  const log2 = await seedDraft(W, lead.id);
  await rejectAutoReplyLog(W, log2.id, repos);
  await assert.rejects(() => approveAutoReplyLog(W, log2.id, {}, repos, "owner", { whatsappProvider: provider }), (e: unknown) => e instanceof NeedsActionError);
  assert.equal(provider.calls, 1, "a dismissed draft was sent");
});

test("F — WhatsApp refusing the send reaches the owner with its reason", async () => {
  const W = await ws("f");
  const lead = await seedLead(W, "+91 98000 00106");
  const log = await seedDraft(W, lead.id);
  const provider = stubProvider({ attempted: true, status: "failed", provider: "meta_cloud", errorMessage: "Error validating access token: Session has expired." });
  await assert.rejects(
    () => approveAutoReplyLog(W, log.id, {}, repos, "owner", { whatsappProvider: provider }),
    (e: unknown) => e instanceof NeedsActionError && /Session has expired/.test(e.message),
  );
  assert.equal((await repos.autoReplyLog.getById(W, log.id))?.status, "held_for_review", "a failed send must stay approvable");
});

test("G — a price-change notice goes to each customer once, even if the list names them twice", async () => {
  const { defaultWorkspaceId } = await import("@/lib/db");
  const { WhatsAppCredentialService } = await import("@/services/WhatsAppCredentialService");
  const W = defaultWorkspaceId;
  await ensureWorkspace(repos, W);
  await new WhatsAppCredentialService(repos).save(W, { accessToken: "golden-test-token-not-a-real-credential", phoneNumberId: "1555000999" });
  await repos.productSettings.upsertForWorkspace(W, { products: [{ id: `prod_g_${RUN}`, name: "Gold zari" }] } as never);
  const lead = await seedLead(W, `+91 98000 ${String(Date.now()).slice(-5)}`);
  const sent: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    sent.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ messages: [{ id: "wamid.G" }] }) } as unknown as Response;
  }) as typeof fetch;
  try {
    const { POST } = await import("@/app/api/[[...path]]/route");
    const request = new Request("http://localhost/api/price-change/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: W, productId: `prod_g_${RUN}`, oldPrice: 100, newPrice: 110, leadIds: [lead.id, lead.id, lead.id] }),
    });
    const response = await POST(request as never, { params: Promise.resolve({ path: ["price-change", "send"] }) });
    assert.equal(response.status, 200, `price-change send answered ${response.status}: ${JSON.stringify(await response.json()).slice(0, 300)}`);
  } finally {
    globalThis.fetch = original;
  }
  const graph = sent.filter((u) => u.startsWith("https://graph.facebook.com/"));
  assert.equal(graph.length, 1, `the customer received the same price-change message ${graph.length} times`);
});

test("H — no re-engagement nudge is drafted for a customer who opted out", async () => {
  const { generateReEngagementNudge } = await import("@/services/ReEngagementService");
  const { registerDoNotContact } = await import("@/lib/dnc-registry");
  const W = await ws("h");
  const lead = await seedLead(W, "+91 98000 00108");
  await registerDoNotContact(W, { phone: "+91 98000 00108", reason: "Customer requested opt-out via WhatsApp.", sourceLeadId: lead.id }, repos);
  await assert.rejects(() => generateReEngagementNudge(W, lead.id, repos), (e: unknown) => e instanceof NeedsActionError);
});

test("I — the outreach review queue does not offer drafts for do-not-contact leads", async () => {
  const { getOutreachQueue } = await import("@/services/OutreachQueueService");
  const W = await ws("i");
  const lead = await seedLead(W, "+91 98000 00109");
  await repos.messageTemplate.create({ workspaceId: W, leadId: lead.id, channel: "whatsapp", body: "Hello again", status: "draft", personalizationUsed: { generationMeta: { reviewState: "pending_review" } } } as never);
  const before = await getOutreachQueue(W, repos);
  assert.equal(before.count, 1, "setup: the draft should be in the queue while the lead is contactable");
  await repos.lead.updateLead(W, lead.id, { doNotContact: true, status: "do_not_contact" });
  const after = await getOutreachQueue(W, repos);
  assert.equal(after.count, 0, "a draft to a do-not-contact lead is still offered for sending");
});

test("J — after the 24-hour window, the owner is not told to do something the app then refuses", async () => {
  const W = await ws("j");
  const lead = await seedLead(W, "+91 98000 00110");
  await repos.lead.updateLead(W, lead.id, { lastInboundAt: new Date(Date.now() - 72 * 3600_000).toISOString() });
  const log = await seedDraft(W, lead.id);
  const provider = stubProvider({ attempted: true, status: "sent", provider: "meta_cloud" });
  const approved = await approveAutoReplyLog(W, log.id, {}, repos, "owner", { whatsappProvider: provider });
  assert.equal(provider.calls, 0, "a free-text reply went out after the 24-hour window");
  const said = String(approved.providerError || "");
  assert.ok(/template/i.test(said) && /nothing was sent/i.test(said), `the owner was not told plainly that nothing was sent: "${said}"`);
  if (/\bre-approve/i.test(said)) {
    await assert.rejects(() => approveAutoReplyLog(W, log.id, { templateName: "reminder_v1" }, repos, "owner", { whatsappProvider: provider }));
    assert.fail(`the owner was told to "re-approve", which the app refuses: "${said}"`);
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  ✅ ${name}`); }
    catch (error) { failed += 1; console.error(`  ❌ ${name}: ${(error as Error).message}`); }
  }
  console.log(`\nwhatsapp-break: ${cases.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
