import type { Lead, WhatsAppAgentSettings } from "@/lib/types";
import type { MessageClassification } from "@/conversations/message-classification";

export type AutoReplyDecision = {
  canAutoSend: boolean;
  needsHumanReview: boolean;
  blocked: boolean;
  reason: string;
};

export function decideAutoReply(input: {
  settings: WhatsAppAgentSettings;
  classification: MessageClassification;
  lead?: Lead;
  hasSupportingKnowledge: boolean;
  isGenericSafeReply?: boolean;
  /**
   * D-2026-09-27-b — replies the AI already sent by itself to this customer
   * since the owner last acted (AutoReplyTrialService.automaticRepliesInARow).
   */
  automaticRepliesInARow?: number;
}): AutoReplyDecision {
  const { settings, classification, lead, hasSupportingKnowledge, isGenericSafeReply = false, automaticRepliesInARow = 0 } = input;

  // Session 3 audit fix: NEVER auto-reply to an unmatched number. Previously,
  // when resolveLead returned undefined (no lead found), this check was
  // skipped entirely, allowing a real auto-send to a contact with no DNC
  // record. An unresolved lead means we cannot confirm opt-out status — block.
  if (!lead) {
    return blocked("No matching lead found. Cannot verify do-not-contact status, so automation is blocked.");
  }

  if (lead?.doNotContact || lead?.status === "do_not_contact") {
    return blocked("Lead is marked do not contact.");
  }
  // Cluster 2 fix (2026-07-26 audit, P1-5 / D-2026-07-26-4): not_interested
  // is PERMANENT until the owner manually reactivates. Previously the block
  // only applied to the exact message thread that contained the opt-out —
  // a later "interested" reply re-enabled auto-reply, ignoring the earlier
  // opt-out. Now any lead whose status is not_interested is blocked from
  // auto-reply regardless of the new message's classification.
  if (lead?.status === "not_interested") {
    return blocked("Lead previously indicated they are not interested. Reactivation requires an explicit owner action.");
  }
  if (lead?.reviewStatus === "rejected" || lead?.status === "rejected" || lead?.status === "invalid" || lead?.status === "duplicate") {
    return blocked("Lead status blocks outreach automation.");
  }
  if (lead?.status === "hot_lead" || lead?.status === "sql" || lead?.status === "opportunity") {
    return review("High-value lead messages should be reviewed by a human.");
  }
  if (classification.category === "unsubscribe") {
    return blocked("Customer requested opt-out. Mark do_not_contact and stop automation.");
  }
  if (!settings.enabled) {
    return review("WhatsApp agent is disabled.");
  }
  if (settings.mode === "draft_only" || settings.mode === "human_approval") {
    return review("Workspace settings require human approval before sending.");
  }
  if (!["automatic", "safe_auto_reply"].includes(settings.mode)) {
    return review("Workspace settings are not in automatic reply mode.");
  }
  // D-2026-09-27-b (CEO) — the AI answers by itself only the kinds of
  // question the owner ticked, and a kind can only be ticked once the trial
  // proved it (AutoReplyTrialService). Nothing ticked = nothing automatic.
  if (!(settings.autoReplyTopics ?? []).includes(classification.category)) {
    return review("You haven't let the AI answer this kind of question by itself yet.");
  }
  // A cap of 0 means no automatic replies at all (review W12: it meant 3).
  const cap = Number.isFinite(settings.maxAutoRepliesPerConversation) && settings.maxAutoRepliesPerConversation >= 0 ? settings.maxAutoRepliesPerConversation : 3;
  if (automaticRepliesInARow >= cap) {
    return review(`The AI already replied ${automaticRepliesInARow} times in a row to this customer — over to you.`);
  }
  if (classification.riskLevel !== "low") {
    return review("Message risk level is not low.");
  }
  if (classification.requiresHumanReview) {
    return review("Classification requires human review.");
  }
  if (classification.confidence < 0.8) {
    return review("Classification confidence is below auto-reply threshold.");
  }
  if (["abusive_message", "complaint", "payment_question", "return_question", "needs_human_review", "price_request", "delivery_question", "customization_question", "export_question", "hot_lead", "unknown_question"].includes(classification.category)) {
    return review("Sensitive customer message requires human review.");
  }
  // R4 audit fix: deterministic block on "not_interested". Previously this was
  // only blocked implicitly via riskLevel === "medium"; a future classifier
  // change lowering it to "low" would have silently allowed auto-reply to a
  // customer who said they're not interested. Defense-in-depth: the block is
  // now explicit regardless of risk level.
  if (classification.category === "not_interested") {
    return review("Customer indicated they are not interested. No auto-reply — human review required before any further outreach.");
  }
  if (classification.category === "bulk_order_interest") {
    return review("Bulk or wholesale interest should be escalated as a high-value opportunity.");
  }
  if (["price_request", "delivery_question", "moq_request", "sample_request", "customization_question", "export_question"].includes(classification.category) && !hasSupportingKnowledge) {
    return review("The answer needs reviewed company knowledge before sending.");
  }
  if (["customization_question", "export_question"].includes(classification.category)) {
    return review("Custom order and export commitments need human confirmation.");
  }
  if (!hasSupportingKnowledge && !isGenericSafeReply) {
    return review("No supporting knowledge found. The AI should not guess.");
  }
  return {
    canAutoSend: true,
    needsHumanReview: false,
    blocked: false,
    reason: "Safe low-risk reply with supporting knowledge under safe_auto_reply mode.",
  };
}

/**
 * 2026-09-28 (real-AI eval, docs/AI-QUALITY-EVAL-2026-09-28.md) — read the
 * reply itself before it goes out on its own.
 *
 * Everything above judges the customer's MESSAGE. Nothing judged the REPLY: a
 * greeting or minimum-order answer the owner let go out by itself could carry
 * any sentence the model wrote. Measured with DeepSeek: asked for the sequins
 * minimum, it wrote "10 packs (500g packs)" — the 10 packs is approved
 * knowledge, "500g" appears nowhere. It was held only because the model rated
 * its own reply "medium"; a model that says "low" sends it.
 *
 * So an automatic reply is held for the owner when it:
 *   - names a price, a discount or a currency amount;
 *   - promises a day ("tomorrow", "by Friday", "within 3 days", "kal");
 *   - talks credit, advance, udhaar or cash on delivery;
 *   - claims stock ("in stock", "ready stock");
 *   - contains a number that is in neither the approved knowledge the AI was
 *     given nor the customer's own message.
 * Returns the reason, or "" when the reply may go. Only ever holds; never sends.
 */
export function automaticReplyContentProblem(reply: string, grounding: { knowledgeText: string; customerText: string }): string {
  const text = normaliseDigits(reply);
  if (PRICE_WORDS.test(text)) return "The reply names a price or a discount — prices always go to you.";
  if (DATE_PROMISE_WORDS.test(text)) return "The reply promises a day or a delivery time — that goes to you.";
  if (CREDIT_WORDS.test(text)) return "The reply talks about credit or payment terms — that goes to you.";
  if (STOCK_WORDS.test(text)) return "The reply claims stock is available — that goes to you.";
  const invented = numbersNotGrounded(text, `${grounding.knowledgeText}\n${grounding.customerText}`);
  if (invented.length) return `The reply states ${invented.slice(0, 3).join(", ")}, which is not in your approved knowledge — held for you.`;
  return "";
}

const PRICE_WORDS = /(₹|\brs\.?\s*\d|\binr\b|rupee|रुपय|रुपए|रु\.|રૂપિયા|રૂ\.|\d+\s*(\/|per)\s*(kg|kilo|metre|meter|mtr|m|pack|piece|pc)\b|\bdiscount|\boffer price|छूट|डिस्काउंट|ડિસ્કાઉન્ટ|\bbhav\b|\brate (is|hai)\b)/i;
const DATE_PROMISE_WORDS = /(tomorrow|\bkal\b|(?<![\p{L}\p{M}])कल(?![\p{L}\p{M}])|આવતીકાલે|\bby (mon|tues|wednes|thurs|fri|satur|sun)day|within \d|\d+\s*(-|to|–)\s*\d+\s*(working\s*)?(days?|din|दिन|દિવસ)|\d+\s*(working\s*)?(days?|din|दिन|દિવસ)\b|(dispatch|deliver|ship|send|bhej)\w*[^.?!]{0,25}\b(today|aaj)\b)/iu;
const CREDIT_WORDS = /(\bcredit\b|udhaa?r|उधार|ઉધાર|\badvance\b|एडवांस|એડવાન્સ|cash on delivery|\bcod\b)/i;
const STOCK_WORDS = /(in stock|ready stock|stock (me|mein|में)|स्टॉक में|સ્ટોકમાં|available (now|today|right now))/i;

/** Numbers in `text` (Devanagari / Gujarati digits included) that `grounding` never states. */
export function numbersNotGrounded(text: string, grounding: string): string[] {
  // Knowledge often spells small numbers out ("two to three working days");
  // a reply that writes "2-3" is still saying what the knowledge says.
  const spelled = (grounding.toLowerCase().match(/\b[a-z]+\b/g) || []).map((w) => NUMBER_WORDS[w]).filter(Boolean);
  const allowed = new Set([...numbersIn(normaliseDigits(grounding)), ...spelled]);
  return numbersIn(normaliseDigits(text)).filter((n) => !allowed.has(n));
}

const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100",
};

function normaliseDigits(text: string): string {
  return text
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/[૦-૯]/g, (d) => String(d.charCodeAt(0) - 0x0AE6));
}

function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", "."));
}

function blocked(reason: string): AutoReplyDecision {
  return { canAutoSend: false, needsHumanReview: true, blocked: true, reason };
}

function review(reason: string): AutoReplyDecision {
  return { canAutoSend: false, needsHumanReview: true, blocked: false, reason };
}
