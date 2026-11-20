/**
 * golden-auto-reply-topics.ts — D-2026-09-27-b (CEO): the AI may answer a
 * customer who messaged first, by itself, but only for the kinds of question
 * the owner ticked, and a kind can only be ticked once the trial proved it.
 * Plan: docs/planning/AUTO-REPLY-PLAN.md.
 *
 *   A — the trial record: 10+ reviewed and 90%+ sent unchanged = proven;
 *       automatic sends are not evidence; old drafts fall out of the window;
 *       the kind the send decision used is what is counted.
 *   B — saving settings: a locked kind (price) is refused, an unproven kind is
 *       refused, a proven kind is saved, a kind already on stays on.
 *   C — the master switch: automatic mode AND a ticked kind, else no send.
 *   D — the decision: an unticked kind waits; a ticked kind goes; price never
 *       goes even if smuggled into the list; MOQ needs approved knowledge; the
 *       per-conversation cap hands over to the owner.
 *   E — the cap counts automatic replies since the owner last acted.
 *   F — in automatic mode, a reply that merely needs the owner is held for
 *       review, not marked "blocked" (it used to vanish from the queue).
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-auto-reply-topics.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AutoReplyLog, Lead, WhatsAppAgentSettings } from "@/lib/types";
import { NeedsActionError } from "@/lib/user-errors";
import {
  automaticRepliesInARow,
  autoRepliesSwitchedOn,
  computeTrialRecords,
  TRIAL_MIN_REVIEWED,
} from "@/services/AutoReplyTrialService";
import { decideAutoReply } from "@/services/AutoReplyDecisionService";
import { getWhatsAppSettings, updateWhatsAppSettings } from "@/services/AISettingsService";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";

const repos = createJsonRepos() as RepositoryBundle;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);
const RUN = Date.now().toString(36);
const NOW = new Date("2026-09-27T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let seq = 0;
function log(partial: Partial<AutoReplyLog>): AutoReplyLog {
  seq++;
  return {
    id: `arl_${seq}`, workspaceId: "w", channel: "whatsapp", incomingMessage: "hi", retrievedContext: {},
    canAutoSend: false, needsHumanReview: true, status: "held_for_review",
    createdAt: daysAgo(1), updatedAt: daysAgo(1), ...partial,
  };
}
function reviewed(topic: string, unchanged: number, changed: number, rejectedCount = 0, when = 1): AutoReplyLog[] {
  return [
    ...Array.from({ length: unchanged }, () => log({ classification: topic, status: "approved", createdAt: daysAgo(when), updatedAt: daysAgo(when) })),
    ...Array.from({ length: changed }, () => log({ classification: topic, status: "approved", ownerEdited: true, createdAt: daysAgo(when), updatedAt: daysAgo(when) })),
    ...Array.from({ length: rejectedCount }, () => log({ classification: topic, status: "rejected", createdAt: daysAgo(when), updatedAt: daysAgo(when) })),
  ];
}
const record = (logs: AutoReplyLog[], topic: string) => computeTrialRecords(logs, NOW).find((r) => r.topic === topic)!;

test("A — the trial record decides when a kind is proven", async () => {
  assert.equal(record(reviewed("greeting", 9, 1), "greeting").proven, true, "10 reviewed, 9 unchanged (90%) must be proven");
  assert.equal(record(reviewed("greeting", 8, 2), "greeting").proven, false, "80% unchanged must not be proven");
  assert.equal(record(reviewed("greeting", 9, 0), "greeting").proven, false, `fewer than ${TRIAL_MIN_REVIEWED} reviewed must not be proven`);
  assert.equal(record(reviewed("greeting", 8, 0, 2), "greeting").proven, false, "rejected drafts count against the kind");
  assert.equal(record(reviewed("greeting", 10, 0, 0, 61), "greeting").reviewed, 0, "drafts older than the window must not count");
  const withAuto = [...reviewed("greeting", 5, 0), ...Array.from({ length: 20 }, () => log({ classification: "greeting", status: "auto_sent" }))];
  const r = record(withAuto, "greeting");
  assert.equal(r.reviewed, 5, "automatic sends are not the owner's evidence");
  assert.equal(r.sentByAi, 20);
  // The decision's category is what counts, not the AI reader's label.
  const decided = Array.from({ length: 10 }, () => log({ classification: "other", retrievedContext: { decisionCategory: "location_question" }, status: "approved" }));
  assert.equal(record(decided, "location_question").proven, true, "the kind the send decision used must be what is counted");
  assert.equal(computeTrialRecords([], NOW).some((x) => (x.topic as string) === "price_request"), false, "price must never be a tickable kind");
});

test("B — saving settings refuses locked and unproven kinds", async () => {
  const W = `ws_autoreply_b_${RUN}`;
  await ensureWorkspace(repos, W);
  await getWhatsAppSettings(W, repos);
  await assert.rejects(() => updateWhatsAppSettings(W, { enabled: true, mode: "safe_auto_reply", autoReplyTopics: ["price_request"] }, repos), NeedsActionError, "price must be refused");
  await assert.rejects(() => updateWhatsAppSettings(W, { enabled: true, mode: "safe_auto_reply", autoReplyTopics: ["greeting"] }, repos), NeedsActionError, "an unproven kind must be refused");
  for (let i = 0; i < 10; i++) {
    const created = await repos.autoReplyLog.create(W, { channel: "whatsapp", incomingMessage: "hello", retrievedContext: {}, classification: "greeting", generatedReply: "Hello!", canAutoSend: false, needsHumanReview: true, status: "held_for_review" });
    await repos.autoReplyLog.approve(W, created.id, { generatedReply: "Hello!" });
  }
  const saved = await updateWhatsAppSettings(W, { enabled: true, mode: "safe_auto_reply", autoReplyTopics: ["greeting"] }, repos);
  assert.deepEqual(saved.autoReplyTopics, ["greeting"]);
  const kept = await updateWhatsAppSettings(W, { enabled: true, mode: "safe_auto_reply" }, repos);
  assert.deepEqual(kept.autoReplyTopics, ["greeting"], "a save without the list must keep the owner's choice");
});

test("C — nothing is sent unless automatic mode is on AND a kind is ticked", async () => {
  const base = { enabled: true, mode: "safe_auto_reply" as const, autoReplyTopics: ["greeting"] };
  assert.equal(autoRepliesSwitchedOn(base), true);
  assert.equal(autoRepliesSwitchedOn({ ...base, mode: "automatic" }), true);
  assert.equal(autoRepliesSwitchedOn({ ...base, mode: "draft_only" }), false);
  assert.equal(autoRepliesSwitchedOn({ ...base, mode: "human_approval" }), false);
  assert.equal(autoRepliesSwitchedOn({ ...base, enabled: false }), false);
  assert.equal(autoRepliesSwitchedOn({ ...base, autoReplyTopics: [] }), false);
  assert.equal(autoRepliesSwitchedOn({ ...base, autoReplyTopics: ["price_request"] }), false, "a locked kind must not switch sending on");
  assert.equal(autoRepliesSwitchedOn(undefined), false);
});

const lead = { id: "lead_1", status: "replied", reviewStatus: "approved", doNotContact: false } as unknown as Lead;
function settings(topics: string[]): WhatsAppAgentSettings {
  return { id: "s", workspaceId: "w", enabled: true, mode: "safe_auto_reply", defaultLanguage: "English", maxAutoRepliesPerConversation: 3, businessHours: {}, unknownAnswerBehavior: "", abusiveMessageBehavior: "", priceQuestionBehavior: "", autoReplyTopics: topics, createdAt: "", updatedAt: "" };
}
const low = (category: string) => ({ category, confidence: 0.9, reason: "", riskLevel: "low", requiresHumanReview: false }) as never;

test("D — only ticked kinds go; price never; MOQ needs knowledge; the cap hands over", async () => {
  assert.equal(decideAutoReply({ settings: settings([]), classification: low("greeting"), lead, hasSupportingKnowledge: false, isGenericSafeReply: true }).canAutoSend, false, "an unticked kind must wait");
  assert.equal(decideAutoReply({ settings: settings(["greeting"]), classification: low("greeting"), lead, hasSupportingKnowledge: false, isGenericSafeReply: true }).canAutoSend, true, "a ticked greeting must go");
  assert.equal(decideAutoReply({ settings: settings(["price_request"]), classification: low("price_request"), lead, hasSupportingKnowledge: true }).canAutoSend, false, "price must never go, even if put in the list");
  assert.equal(decideAutoReply({ settings: settings(["moq_request"]), classification: low("moq_request"), lead, hasSupportingKnowledge: false }).canAutoSend, false, "MOQ without approved knowledge must wait");
  assert.equal(decideAutoReply({ settings: settings(["moq_request"]), classification: low("moq_request"), lead, hasSupportingKnowledge: true }).canAutoSend, true, "a ticked MOQ question with approved knowledge must go");
  const capped = decideAutoReply({ settings: settings(["greeting"]), classification: low("greeting"), lead, hasSupportingKnowledge: false, isGenericSafeReply: true, automaticRepliesInARow: 3 });
  assert.equal(capped.canAutoSend, false, "after 3 automatic replies in a row the owner takes over");
  const dnc = decideAutoReply({ settings: settings(["greeting"]), classification: low("greeting"), lead: { ...lead, doNotContact: true } as Lead, hasSupportingKnowledge: false, isGenericSafeReply: true });
  assert.equal(dnc.blocked, true, "do-not-contact still blocks");
});

test("E — the cap counts automatic replies since the owner last acted", async () => {
  const at = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();
  const history = [
    log({ status: "auto_sent", createdAt: at(1) }),
    log({ status: "approved", createdAt: at(2) }),
    log({ status: "auto_sent", createdAt: at(3) }),
    log({ status: "held_for_review", createdAt: at(4) }),
    log({ status: "auto_sent", createdAt: at(5) }),
  ];
  assert.equal(automaticRepliesInARow(history), 2, "a waiting draft must not reset the count; the owner's approval does");
  assert.equal(automaticRepliesInARow([]), 0);
});

test("F — in automatic mode a reply that needs the owner is held for review, not 'blocked'", async () => {
  const W = `ws_autoreply_f_${RUN}`;
  await ensureWorkspace(repos, W);
  await repos.whatsAppAgentSettings.upsertForWorkspace(W, { enabled: true, mode: "safe_auto_reply", autoReplyTopics: [] });
  const buyer = await repos.lead.createLead({
    workspaceId: W, companyName: "Trial Buyer", contactName: "Buyer", whatsappNumber: "919800000555",
    source: "manual", status: "approved", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none",
  });
  const result = await handleIncomingWhatsAppMessage({ workspaceId: W, leadId: buyer.id, phone: "919800000555", rawText: "What is your minimum order for gold zari?" }, repos, { allowRealSend: true });
  const saved = await repos.autoReplyLog.getById(W, String(result.autoReplyLogId));
  assert.equal(saved?.status, "held_for_review", `expected held_for_review, got ${saved?.status}`);
  assert.notEqual(saved?.sendStatus, "sent", "nothing may be sent for an unticked kind");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
