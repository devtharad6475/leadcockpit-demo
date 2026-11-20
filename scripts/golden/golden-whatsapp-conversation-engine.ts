/**
 * golden-whatsapp-conversation-engine.ts — pins the inbound-WhatsApp reply
 * pipeline (DARK → PROVEN, batch 3, 2026-07-27).
 *
 * WHAT THIS PROVES
 *   `handleIncomingWhatsAppMessage` is the customer-facing reply engine: it
 *   classifies the inbound text, fetches KB context, drafts an LLM reply,
 *   decides whether to auto-send, records the Reply, mutates the lead, and
 *   (for complaints) opens a Ticket. This is the most safety-critical code in
 *   the system — a bug here either (a) sends an unapproved WhatsApp to a real
 *   customer, or (b) drops an inbound message with no audit trail.
 *
 * THE CONTRACTS (hand-computed BEFORE writing assertions):
 *   CASE A — SACRED no-auto-send under mock LLM: with the default mock
 *            fallback (no real LLM key), `llm.mode === "mock"` and
 *            `send.status !== "sent"` REGARDLESS of what the keyword
 *            classifier said was safe. This is the executable pin on the
 *            "never auto-send with a mock LLM" rule.
 *   CASE B — unsubscribe keyword → DNC registry: a message containing the
 *            unsubscribe keyword registers the lead's phone on the PERMANENT
 *            DNC registry + sets lead.doNotContact=true. The opt-out survives
 *            even if the lead is later deleted (Session 3 legal-safety fix).
 *   CASE C — Reply is ALWAYS recorded (audit trail): every inbound produces a
 *            Reply row, even when no lead matches (no silent drops).
 *   CASE D — no orphan fake-id: when no lead matches, `reply.leadId` is
 *            undefined (NOT the old "unmatched_whatsapp_lead" fake id that
 *            broke erasure — Cluster F fix).
 *   CASE E — complaint → Ticket created: a complaint-classified inbound opens
 *            a Ticket (sensitive-topic → human review, per AGENTS.md).
 *
 * REAL PIPELINE: imports the real handleIncomingWhatsAppMessage + real repos.
 * The LLM call uses the default mock fallback (no real key in the test env),
 * so the no-auto-send assertion is deterministic. Each case runs on an
 * isolated workspace (Ironclad Gate #8).
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createAmbientRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { isPermanentlyDoNotContact } from "@/lib/dnc-registry";
import type { RepositoryBundle } from "@/repositories/interfaces";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function caseWs(caseId: string) { return `ws_convo_${caseId}`; }
async function clearLeads(ws: string, repos: RepositoryBundle) {
  for (const lead of await repos.lead.listLeads(ws)) { try { await repos.lead.deleteById(ws, lead.id); } catch {} }
}
/**
 * Make the tenant real, then empty its DNC registry.
 *
 * A-7 (2026-08-25): this golden used to pin itself to JSON, so the unsubscribe
 * rule - the one with a legal consequence if it is wrong - was only ever
 * proven against a file format production does not use. It now follows the
 * process: JSON on the normal suite run, a private Postgres clone under the
 * A-7 pass.
 *
 * So the tenant `ws_convo_B` has to exist before a lead can be hung off it,
 * and the registry wipe is a no-op off JSON, where the database is a throwaway
 * clone that already starts empty.
 */
async function clearDnc(ws: string, repos: RepositoryBundle) {
  await ensureWorkspace(repos, ws, `whatsapp conversation golden ${ws}`);
  if (process.env.PERSISTENCE_PROVIDER === "prisma") return;
  const { mutateData } = await import("@/lib/db");
  await mutateData((d) => {
    d.doNotContactRegistry = (d.doNotContactRegistry || []).filter((e) => e.workspaceId !== ws);
    return undefined;
  });
}
async function clearReplies(ws: string, repos: RepositoryBundle) {
  // A-7: off JSON the database is a throwaway clone that starts empty, so
  // there is nothing to clear and reaching into the JSON file would be a lie
  // about which substrate was cleaned.
  void repos;
  if (process.env.PERSISTENCE_PROVIDER === "prisma") return;
  const { mutateData } = await import("@/lib/db");
  await mutateData((d) => {
    d.replies = (d.replies || []).filter((r) => r.workspaceId !== ws);
    return undefined;
  });
}

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// --- CASE A: sacred no-auto-send under mock LLM ---------------------------------
test("CASE A — SACRED no-auto-send under mock LLM (send.status !== 'sent')", async () => {
  const ws = caseWs("A");
  const repos = createAmbientRepos();
  await clearDnc(ws, repos); await clearLeads(ws, repos); await clearReplies(ws, repos);
  // Seed a lead so the engine has someone to (not) message.
  const lead = await repos.lead.createLead({
    workspaceId: ws, companyName: "Auto-Send Test Co", whatsappNumber: "919999999991",
    source: "whatsapp", status: "needs_review", reviewStatus: "pending",
    enrichmentStatus: "not_started", doNotContact: false, consentStatus: "none",
    fitReason: "seed",
  });

  // A greeting — keyword-classified as safe (low-risk). Even so, with no real
  // LLM configured, the engine MUST NOT auto-send. This is the rule that
  // prevents an accidental send while the operator is on the default mock.
  const result = await handleIncomingWhatsAppMessage({
    workspaceId: ws, leadId: lead.id, phone: lead.whatsappNumber, rawText: "Hello, good morning",
  }, repos);

  // Hand-computed truth: the default mock LLM means realModelSucceeded=false,
  // so finalCanAutoSend=false and send.status is "not_sent" / "skipped" (NOT "sent").
  assert.notStrictEqual(
    result.send.status, "sent",
    "SACRED: mock-LLM inbound NEVER auto-sends (send.status !== 'sent')",
  );
  assert.ok(
    result.llm.mode === "mock" || result.llm.mode === "fallback" || result.llm.fallbackUsed || result.llm.provider === "mock",
    `llm is honestly mock/fallback (mode='${result.llm.mode}', provider='${result.llm.provider}', fallbackUsed=${result.llm.fallbackUsed})`,
  );
  // The draft is still produced (held for human review) — no silent drop.
  assert.ok(result.suggestedReply.length > 0, "a draft suggestedReply is still produced for human review");
});

// --- CASE B: unsubscribe keyword → DNC registry + lead.doNotContact=true --------
test("CASE B — unsubscribe keyword → DNC registry + lead.doNotContact=true", async () => {
  const ws = caseWs("B");
  const repos = createAmbientRepos();
  await clearDnc(ws, repos); await clearLeads(ws, repos); await clearReplies(ws, repos);
  const UNSUB_PHONE = "919999999992";
  const lead = await repos.lead.createLead({
    workspaceId: ws, companyName: "Unsubscribe Test Co", whatsappNumber: UNSUB_PHONE,
    source: "whatsapp", status: "replied", reviewStatus: "approved",
    enrichmentStatus: "completed", doNotContact: false, consentStatus: "consent",
    fitReason: "seed",
  });

  await handleIncomingWhatsAppMessage({
    workspaceId: ws, leadId: lead.id, phone: UNSUB_PHONE, rawText: "Please unsubscribe me from all messages",
  }, repos);

  // Hand-computed truth: the phone is on the permanent DNC registry AND the
  // lead flag is flipped. The registry entry is the legal-safety guarantee
  // (survives lead deletion/re-import).
  const onRegistry = await isPermanentlyDoNotContact(ws, { phone: UNSUB_PHONE }, repos);
  assert.strictEqual(onRegistry, true, "unsubscribe → phone on PERMANENT DNC registry");
  const updated = await repos.lead.getLeadById(ws, lead.id);
  assert.strictEqual(updated!.doNotContact, true, "unsubscribe → lead.doNotContact === true");
});

// --- CASE C: Reply is ALWAYS recorded (audit trail) -----------------------------
test("CASE C — Reply is ALWAYS recorded (audit trail, no silent drops)", async () => {
  const ws = caseWs("C");
  const repos = createAmbientRepos();
  await clearDnc(ws, repos); await clearLeads(ws, repos); await clearReplies(ws, repos);

  // No lead seeded — the inbound is from an unknown number.
  const result = await handleIncomingWhatsAppMessage({
    workspaceId: ws, phone: "919999999993", rawText: "Hi, do you sell cotton yarn?",
  }, repos);

  // A Reply row MUST exist (the audit trail of the inbound message).
  assert.ok(result.replyId, "a Reply row was created (replyId returned)");
  // A-7: read the row back through the SAME bundle that wrote it. This used
  // to go straight to the JSON file, which meant the assertion was about a
  // file no matter which substrate the engine had just written to.
  const reply = await repos.reply.getById(ws, result.replyId!);
  assert.ok(reply, "the Reply row exists in the store");
  assert.strictEqual(reply!.channel, "whatsapp");
  assert.strictEqual(reply!.rawText, "Hi, do you sell cotton yarn?");
});

// --- CASE D: no orphan fake-id when no lead matches -----------------------------
test("CASE D — no orphan fake-id: reply.leadId is undefined when no lead matches", async () => {
  const ws = caseWs("D");
  const repos = createAmbientRepos();
  await clearDnc(ws, repos); await clearLeads(ws, repos); await clearReplies(ws, repos);

  const result = await handleIncomingWhatsAppMessage({
    workspaceId: ws, phone: "919999999994", rawText: "Hello",
  }, repos);

  // A-7: read the row back through the SAME bundle that wrote it. This used
  // to go straight to the JSON file, which meant the assertion was about a
  // file no matter which substrate the engine had just written to.
  const reply = await repos.reply.getById(ws, result.replyId!);
  assert.ok(reply, "Reply exists");
  // Cluster F fix: the OLD code wrote "unmatched_whatsapp_lead" as the leadId
  // — those rows were never cleaned up by erasure. Now leadId is undefined.
  assert.ok(
    !reply!.leadId || reply!.leadId === "",
    `reply.leadId is undefined/empty when no lead matches (NOT the old 'unmatched_whatsapp_lead' fake id), got: '${reply!.leadId}'`,
  );
  assert.notStrictEqual(reply!.leadId, "unmatched_whatsapp_lead", "the fake-id orphan pattern is gone");
});

// --- CASE E: complaint → Ticket created -----------------------------------------
test("CASE E — complaint-classified inbound → Ticket created (sensitive-topic → human review)", async () => {
  const ws = caseWs("E");
  const repos = createAmbientRepos();
  await clearDnc(ws, repos); await clearLeads(ws, repos); await clearReplies(ws, repos);
  const lead = await repos.lead.createLead({
    workspaceId: ws, companyName: "Complaint Test Co", whatsappNumber: "919999999995",
    source: "whatsapp", status: "replied", reviewStatus: "approved",
    enrichmentStatus: "completed", doNotContact: false, consentStatus: "consent",
    fitReason: "seed",
  });

  await handleIncomingWhatsAppMessage({
    workspaceId: ws, leadId: lead.id, phone: lead.whatsappNumber,
    rawText: "I am very unhappy with the product quality, this is a serious complaint",
  }, repos);

  // Per AGENTS.md, complaints are a sensitive topic that always requires human
  // review. The engine routes them to a tracked Ticket (Stage 2 fix) so the
  // owner sees it in their ticket inbox with an SLA clock — not just a held
  // auto-reply log.
  const tickets = await repos.ticket.listByWorkspace(ws);
  assert.ok(tickets.length >= 1, `complaint created a Ticket, got ${tickets.length} tickets`);
  const complaintTicket = tickets[0];
  assert.ok(
    /complaint/i.test(complaintTicket.subject || "") || /complaint/i.test(complaintTicket.description || "") || complaintTicket.type === "complaint",
    `the Ticket is a complaint type, got subject='${complaintTicket.subject}' type='${complaintTicket.type}'`,
  );
});

// --- CASE F: conversation HISTORY is passed to the reply model (memory wiring) --
// 2026-08-04 (customer-simulation follow-up): the reply engine had NO memory —
// it answered every message as if it was the first, re-asking questions the
// customer already answered. The fix wires gatherHistoryText() into the reply
// input. This case pins the wiring so it can't silently regress. Two layers:
// (a) static — the engine source passes conversationHistory to runTask; (b)
// behavioral — a lead WITH prior outreach produces a non-empty history feed.
// The probe-conversation-memory.ts script proves the END-TO-END effect on real
// Claude (without history = re-asks; with history = personalized). This golden
// pins the CONTRACT that the wiring exists; the real-AI proof is the receipt.
test("CASE F — conversation history is passed to the reply model (memory wiring, no regressions)", async () => {
  const engineSrc = readFileSync(join(process.cwd(), "src/services/WhatsAppConversationEngine.ts"), "utf8");
  // (a) The engine must gather history for a known lead + pass it to the model.
  assert.ok(engineSrc.includes("gatherHistoryText("), "engine must call gatherHistoryText to build history");
  assert.ok(/conversationHistory/.test(engineSrc), "engine must pass conversationHistory into the reply input");
  assert.ok(/runTask.*whatsapp_reply[\s\S]*conversationHistory/.test(engineSrc), "conversationHistory must reach the whatsapp_reply runTask call");
  // (b) The history fetch is best-effort — a failure must not break the reply.
  assert.ok(/catch.*conversation history unavailable|continuing without it/.test(engineSrc), "history fetch must be wrapped so a failure doesn't break the reply");
  // (c) The prompt must instruct the model to USE the history for personalization.
  const promptSrc = readFileSync(join(process.cwd(), "src/llm/prompts/whatsappReplyPrompt.ts"), "utf8");
  assert.ok(/conversationHistory/.test(promptSrc), "whatsappReplyPrompt must reference conversationHistory");
  assert.ok(/as we discussed|personalized|don.t re-ask|do NOT re-ask/i.test(promptSrc), "prompt must instruct the model to personalize using history (not re-ask answered questions)");
  // (d) Behavioral: a lead WITH prior outreach → gatherHistoryText returns events.
  const repos = createAmbientRepos();
  const WS = "ws_engine_f";
  await ensureWorkspace(repos, WS, `whatsapp conversation golden ${WS}`);
  const lead = await repos.lead.createLead({
    workspaceId: WS, companyName: "Priya Textiles", whatsappNumber: "+919999999999",
    source: "whatsapp", status: "hot_lead", reviewStatus: "approved",
    enrichmentStatus: "completed", consentStatus: "consent", fitReason: "seed",
  });
  // A-7: this used to end in `as never`, which silenced the compiler about
  // three REQUIRED fields - direction, status and sentManually. JSON stored
  // the half-record happily; Postgres refused it. The cast is gone and the
  // record now says what it actually is: an outbound WhatsApp message we sent.
  await repos.outreachActivity.create({
    workspaceId: WS, leadId: lead.id, channel: "whatsapp", direction: "outbound",
    status: "sent", sentManually: false, body: "Hi Priya! 75mm gold border ₹52/m.",
    activityAt: "2026-08-01T10:22:00Z",
  });
  const { gatherHistoryText } = await import("@/services/ConversationSummaryService");
  const history = await gatherHistoryText(WS, lead.id, repos);
  assert.ok(history.events.length > 0, "a lead with prior outreach must produce history events");
  assert.ok(/priya|75mm|gold border/i.test(history.text), "history text must contain the prior outreach content");
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
  console.log(`whatsapp-conversation-engine: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
