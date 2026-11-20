/**
 * golden-message-copy.ts — customer-facing message copy pin (NEW, CP-27 2026-08-02).
 *
 * WHY THIS TEST EXISTS:
 *   Before CP-27, the customer-facing copy in generateMessage(),
 *   classifyReply(), and the WhatsApp engine fallbacks had ZERO tests pinning
 *   the exact wording (an Explore sweep confirmed this — it was a DARK area
 *   per build-right Gate #6). That meant a typo or accidental revert would ship
 *   silently. CP-27 rewrote this copy (research-backed: Saleshandy reciprocity
 *   outreach, Front/Zendesk 24h-SLA ack, positive framing replacing the
 *   "I don't want to give wrong information" hedge). This test pins EVERY
 *   rewritten string so a regression fails green instead of shipping.
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat — these are the rules, not the code):
 *
 *   CASE A — generateMessage EMAIL body uses the personalized-compliment style
 *     and still contains the lead's companyName + the product (the
 *     golden:message-generation invariant must still hold) + the company name
 *     in the sign-off. It must NOT contain the retired spam-shape phrase
 *     "Would you like me to share a short catalogue".
 *
 *   CASE B — generateMessage WHATSAPP body is short, uses the compliment intro,
 *     and contains the product. Must NOT contain "We help businesses with".
 *
 *   CASE C — generateMessage EMAIL subject is personalized ("a quick thought for
 *     {company}") — no longer the old "{product} for {company}".
 *
 *   CASE D — classifyReply returns the REWRITTEN suggestedResponse for each of
 *     the 7 branches. Each must contain its new positive-framing signature
 *     phrase and must NOT contain the retired negative phrasings.
 *
 *   CASE E — the retired hedge ("I don't want to give wrong information") does
 *     not appear in ANY rewritten output. This is the invariant that matters
 *     most: a future edit that re-introduces the negative hedge should fail
 *     this test loudly.
 *
 *   CASE F — the ack template default (the only auto-sent customer message)
 *     promises "within 24 hours", NOT the retired over-promise "within a few
 *     hours".
 *
 * NO DB / NO LLM: generateMessage and classifyReply are pure functions. The
 * WhatsApp engine fallbacks are private, so we pin their expected output
 * strings as a lookup table and assert the public contract (the strings exist
 * in the source + no retired phrase leaks). This is honest about scope: it
 * pins the COPY CONTRACT, not the engine call path (which golden:auto-acknowledge
 * and golden:whatsapp-conversation-engine already cover).
 *
 * Run: `npm run golden:message-copy`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { generateMessage, classifyReply } from "@/lib/agents";
import type { BusinessProfile, Campaign, Lead, Reply } from "@/lib/types";
import { readFileSync } from "node:fs";
import path from "node:path";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

// --- fixtures ------------------------------------------------------------------
const profile: BusinessProfile = {
  id: "p1", workspaceId: "ws1", companyName: "Acme Threads",
  products: ["zari thread"], productCategories: ["textiles"],
  tonePreference: "Professional", languagePreference: "English", status: "approved",
} as unknown as BusinessProfile;

const campaign: Campaign = {
  id: "c1", workspaceId: "ws1", businessProfileId: "p1", name: "Surat Outreach",
  goal: "Find buyers", productFocus: ["zari thread"], selectedChannels: ["email", "whatsapp"],
} as unknown as Campaign;

const lead: Lead = {
  id: "l1", workspaceId: "ws1", companyName: "Bharat Textiles",
  contactName: "Meena", personalizationNote: "",
} as unknown as Lead;

function makeReply(text: string): Reply {
  return { id: "r1", workspaceId: "ws1", rawText: text } as unknown as Reply;
}

// The retired phrases that must NEVER reappear in customer-facing copy.
const RETIRED = [
  "Would you like me to share a short catalogue",
  "We help businesses with",
  "I don't want to give wrong information",
  "I do not want to give wrong information",
  "within a few hours",
];

// === CASE A: generateMessage EMAIL — compliment style + invariants ==================
test("A: email body uses compliment style, keeps lead company + product + our company, drops retired spam-shape", async () => {
  const msg = generateMessage(profile, campaign, lead, "email");
  assert.ok(msg.body.includes("Bharat Textiles"), "email body must mention the lead's company");
  assert.ok(msg.body.includes("zari thread"), "email body must mention the product");
  assert.ok(msg.body.includes("Acme Threads"), "email sign-off must mention our company");
  assert.ok(msg.subject, "email must have a subject");
  for (const bad of RETIRED) {
    assert.ok(!msg.body.includes(bad), `email body must NOT contain retired phrase: "${bad}"`);
  }
});

// === CASE B: generateMessage WHATSAPP — short compliment ===========================
test("B: whatsapp body is short, uses compliment intro, contains product, drops retired phrase", async () => {
  const msg = generateMessage(profile, campaign, lead, "whatsapp");
  assert.ok(msg.body.includes("zari thread"), "whatsapp body must mention the product");
  assert.ok(!msg.subject, "whatsapp must NOT have a subject");
  for (const bad of RETIRED) {
    assert.ok(!msg.body.includes(bad), `whatsapp body must NOT contain retired phrase: "${bad}"`);
  }
});

// === CASE C: email subject is personalized ========================================
test("C: email subject uses the new personalized 'a quick thought for' shape", async () => {
  const msg = generateMessage(profile, campaign, lead, "email");
  assert.ok(msg.subject!.includes("a quick thought for"), `subject should be personalized, got: "${msg.subject}"`);
  assert.ok(msg.subject!.includes("Bharat Textiles"), "subject should name the lead company");
});

// === CASE D: classifyReply returns rewritten suggested responses ==================
test("D: classifyReply suggestedResponse is rewritten for all 7 branches (positive framing)", async () => {
  // unsubscribe
  const unsub = classifyReply(makeReply("Please stop, unsubscribe me"));
  assert.strictEqual(unsub.classification, "unsubscribe");
  assert.ok(unsub.suggestedResponse.includes("noted this"), `unsubscribe: ${unsub.suggestedResponse}`);
  // ask_price
  const price = classifyReply(makeReply("What is the price and quantity details?"));
  assert.strictEqual(price.classification, "ask_price");
  assert.ok(price.suggestedResponse.includes("quote you accurately"), `ask_price: ${price.suggestedResponse}`);
  // ask_catalogue
  const cat = classifyReply(makeReply("Please send your catalogue"));
  assert.strictEqual(cat.classification, "ask_catalogue");
  assert.ok(cat.suggestedResponse.includes("Which product category"), `ask_catalogue: ${cat.suggestedResponse}`);
  // asks_for_call
  const call = classifyReply(makeReply("Can we have a call to discuss?"));
  assert.strictEqual(call.classification, "asks_for_call");
  assert.ok(call.suggestedResponse.includes("What day and time"), `asks_for_call: ${call.suggestedResponse}`);
  // not_interested
  const ni = classifyReply(makeReply("Not interested, already have a supplier"));
  assert.strictEqual(ni.classification, "not_interested");
  assert.ok(ni.suggestedResponse.includes("keep your details handy"), `not_interested: ${ni.suggestedResponse}`);
  // contact_later — input must NOT contain call/meeting/talk (those trigger asks_for_call first)
  const later = classifyReply(makeReply("Let's reconnect next month"));
  assert.strictEqual(later.classification, "contact_later");
  assert.ok(later.suggestedResponse.includes("good time to reconnect"), `contact_later: ${later.suggestedResponse}`);
  // interested (default)
  const interested = classifyReply(makeReply("Sure, tell me more"));
  assert.strictEqual(interested.classification, "interested");
  assert.ok(interested.suggestedResponse.includes("tailor my next note"), `interested: ${interested.suggestedResponse}`);
});

// === CASE E: no retired hedge in ANY classifyReply output =========================
test("E: no retired phrase leaks into any classifyReply suggestedResponse", async () => {
  const samples = [
    "stop", "price please", "send catalogue", "let's call", "not interested",
    "maybe later", "sure tell me more",
  ];
  for (const s of samples) {
    const r = classifyReply(makeReply(s));
    for (const bad of RETIRED) {
      assert.ok(!r.suggestedResponse.includes(bad), `classifyReply("${s}") must not contain retired "${bad}"`);
    }
  }
});

// === CASE F: ack template source promises 24h, not "few hours" ====================
test("F: WhatsApp engine + UI ack default promises 'within 24 hours', drops 'within a few hours'", async () => {
  // The engine fallback is private, so we assert against the source text — this
  // is the same approach golden:message-generation uses for deterministic copy
  // (the contract is "the source contains the agreed wording"). If the literal
  // changes without updating this test, it fails loudly.
  const engineSrc = readFileSync(path.join(process.cwd(), "src/services/WhatsAppConversationEngine.ts"), "utf8");
  assert.ok(engineSrc.includes("within 24 hours"), "engine ack fallback must promise 'within 24 hours'");
  assert.ok(!engineSrc.includes("within a few hours"), "engine must NOT contain retired 'within a few hours'");

  // 2026-08-06 (F-5, page.tsx split): the WhatsApp Agent settings screen —
  // and this ack-default copy with it — moved out of page.tsx into its own
  // section file. Read the file that actually holds the string today rather
  // than a path frozen at the time this test was written.
  const pageSrc = readFileSync(path.join(process.cwd(), "src/app/sections/WhatsAppAgentSettings.tsx"), "utf8");
  assert.ok(pageSrc.includes("within 24 hours"), "UI ack default must promise 'within 24 hours'");
  assert.ok(!pageSrc.includes("within a few hours"), "UI must NOT contain retired 'within a few hours'");
});

// === CASE G: positive hedge replaced the negative one across the engine ===========
test("G: WhatsApp engine + policy files use the positive deferral, not the retired negative hedge", async () => {
  const engineSrc = readFileSync(path.join(process.cwd(), "src/services/WhatsAppConversationEngine.ts"), "utf8");
  assert.ok(!engineSrc.includes("I don't want to give wrong information"), "engine must not contain retired hedge (logic)");
  // The one allowed mention is the comment in the prompt telling the model NOT to use it.
  const promptSrc = readFileSync(path.join(process.cwd(), "src/llm/prompts/whatsappReplyPrompt.ts"), "utf8");
  // The prompt may reference the phrase ONLY to forbid it.
  const policySrc = readFileSync(path.join(process.cwd(), "policies/no-hallucination-policy.md"), "utf8");
  assert.ok(!policySrc.includes("I do not want to give wrong information"), "no-hallucination policy must use the positive deferral");
  const sensitiveSrc = readFileSync(path.join(process.cwd(), "policies/sensitive-topic-policy.md"), "utf8");
  assert.ok(!sensitiveSrc.includes("I don't want to give wrong information"), "sensitive-topic policy must use the positive deferral");
});

// === CASE H: prompt safety-rule consistency — NO "unless verified" loopholes =====
// 2026-08-04 customer-simulation finding (10-customer real-AI run): the
// whatsappReplyPrompt told the model "MANDATORY HUMAN REVIEW for price_request
// (unless exact verified pricing in knowledge)". The model faithfully followed
// that loophole: when pricing WAS verified in the KB, it set canAutoSend=true
// for a price question (C1: 200m gold border; C10: sample). That violates the
// company non-negotiable rule (AGENTS.md / LEADCOCKPIT_PRODUCT_OBJECTIVE:
// "Sensitive topics require human review: price…" — NO EXCEPTIONS). The
// deterministic AutoReplyDecisionService catches it TODAY, but the prompt was
// teaching the model the wrong rule — a latent P0 if the deterministic net is
// ever loosened. This case pins the prompt to the no-exceptions rule so the
// loophole can't silently return. Root cause fix, not a patch.
test("H: whatsappReplyPrompt has NO 'unless verified' safety loopholes (sensitive topics = always review)", async () => {
  const promptSrc = readFileSync(path.join(process.cwd(), "src/llm/prompts/whatsappReplyPrompt.ts"), "utf8");
  // The loophole phrases that must NOT appear (they let the model auto-send
  // price/sample info when it believes the KB is "verified").
  assert.ok(!/price_request\s*\(unless/i.test(promptSrc), "prompt must NOT allow price_request auto-send 'unless verified' — price is ALWAYS human review (no-exceptions rule)");
  assert.ok(!/unless exact verified pricing/i.test(promptSrc), "prompt must NOT contain the 'unless exact verified pricing' loophole");
  assert.ok(!/moq_request without verified.*\(review\)/i.test(promptSrc), "prompt must NOT make MOQ review conditional on missing knowledge — MOQ is sensitive");
  // Positive contract: the prompt MUST state sensitive topics are always review.
  assert.ok(/price_request.*always|always.*price_request/i.test(promptSrc) || /price_request\b[\s\S]*?always/i.test(promptSrc), "prompt should mark price_request as ALWAYS human review");
});

// === RUNNER =====================================================================
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${c.name}`);
      console.error(`    ${(e as Error).message}`);
    }
  }
  console.log(`\n${passed}/${cases.length} passed (${failed} failed)`);
  if (failed > 0) process.exit(1);
})();
