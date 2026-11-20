/**
 * golden-reply-classification-labels.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The Replies inbox on the live deployment showed four replies side by side:
 *
 *   Abusive message      ← labelled
 *   Opt-out request      ← labelled
 *   Price question       ← labelled
 *   catalogue_request    ← raw enum key, in front of the operator
 *
 * displayReplyClassification falls back to `?? code`, which is the right
 * behaviour for an unknown value from an old record — and the wrong thing to
 * rely on for categories the product emits every day. Six of them had no
 * entry: greeting, catalogue_request, sample_request, moq_request,
 * not_interested and other, plus location_question and needs_human_review from
 * the deterministic classifier.
 *
 * A missing label is not cosmetic here. This screen is where an operator
 * decides whether to send an AI-written reply to a customer, and
 * "catalogue_request" vs "Catalogue request" is the difference between a
 * product and a database dump.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — every MessageCategory the deterministic classifier can return has
 *   a human label. The union in message-classification.ts is the contract.
 *
 *   CASE B — every category the LLM path accepts has a human label. That list
 *   lives separately in WhatsAppConversationEngine.validClassifications, and
 *   the two lists are not identical, which is exactly how a gap survives.
 *
 *   CASE C — labels are human-readable: no snake_case survives, because a key
 *   that reaches the screen unchanged is the defect itself.
 *
 *   CASE D — an unknown code still falls back to itself rather than throwing
 *   or rendering blank. An old record with a retired category must not break
 *   the inbox.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { displayReplyClassification } from "@/lib/display-labels";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
function test(name: string, fn: () => void) { cases.push({ name, fn }); }

/** Mirrors the MessageCategory union in src/conversations/message-classification.ts. */
const DETERMINISTIC_CATEGORIES = [
  "greeting", "catalogue_request", "price_request", "sample_request", "moq_request",
  "delivery_question", "payment_question", "return_question", "customization_question",
  "export_question", "location_question", "bulk_order_interest", "complaint",
  "abusive_message", "not_interested", "unsubscribe", "wrong_number", "hot_lead",
  "unknown_question", "needs_human_review", "other",
];

/** Mirrors validClassifications in src/services/WhatsAppConversationEngine.ts. */
const LLM_CATEGORIES = [
  "greeting", "catalogue_request", "price_request", "sample_request", "moq_request",
  "delivery_question", "payment_question", "return_question", "customization_question",
  "export_question", "complaint", "abusive_message", "unsubscribe", "not_interested",
  "hot_lead", "unknown_question", "other",
];

function unlabelled(codes: string[]): string[] {
  return codes.filter((code) => displayReplyClassification(code) === code);
}

test("CASE A — every category the deterministic classifier returns has a human label", () => {
  const missing = unlabelled(DETERMINISTIC_CATEGORIES);
  assert.deepStrictEqual(missing, [], `these reach the operator as raw enum keys: ${missing.join(", ")}`);
});

test("CASE B — every category the LLM path accepts has a human label", () => {
  const missing = unlabelled(LLM_CATEGORIES);
  assert.deepStrictEqual(missing, [], `these reach the operator as raw enum keys: ${missing.join(", ")}`);
});

test("CASE C — no label is snake_case, because a raw key on screen IS the defect", () => {
  const all = [...new Set([...DETERMINISTIC_CATEGORIES, ...LLM_CATEGORIES])];
  const rawLooking = all
    .map((code) => [code, displayReplyClassification(code)] as const)
    .filter(([, label]) => /_/.test(label) || label === label.toLowerCase() && /^[a-z]+$/.test(label));
  assert.deepStrictEqual(
    rawLooking.map(([code]) => code),
    [],
    `these labels still read like enum keys: ${rawLooking.map(([c, l]) => `${c} → "${l}"`).join(", ")}`,
  );
  // Spot-check the one that was actually wrong on screen.
  assert.strictEqual(displayReplyClassification("catalogue_request"), "Catalogue request");
});

test("CASE D — an unknown code falls back to words, never blank and never a throw", () => {
  // 2026-09-25: was "falls back to itself" — the raw key. The model names
  // categories freely and "moq_question" reached the Replies screen raw; an
  // unknown code now reads as words (same chokepoint as every other label).
  assert.strictEqual(displayReplyClassification("retired_category_from_2024"), "Retired category from 2024");
  assert.strictEqual(displayReplyClassification("moq_question"), "Minimum order question");
  assert.strictEqual(displayReplyClassification(""), "");
});

// --- RUNNER ---------------------------------------------------------------------
(() => {
  console.log("golden-reply-classification-labels — N-BUG (no raw enum key may reach the Replies inbox)\n");
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`reply-classification-labels: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
