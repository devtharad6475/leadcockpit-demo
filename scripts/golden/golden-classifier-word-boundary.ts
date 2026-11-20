/**
 * golden-classifier-word-boundary.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Sent through the live deployment's WhatsApp dry-run:
 *
 *   "This is a complete waste of time. Your product broke on day one and your
 *    people are useless. I want this fixed today."
 *
 *   → { category: "greeting", confidence: 0.85, riskLevel: "low",
 *       requiresHumanReview: false, reason: "Customer sent a greeting." }
 *
 * `includesAny` was `text.includes(word)` — a raw substring test — and "this"
 * contains "hi".
 *
 * The consequences are not a mislabelled row. "greeting" is one of only two
 * categories the engine treats as a generic SAFE reply, which is what makes a
 * message eligible to auto-send without human review; and the ticket branch
 * fires on complaint/abusive_message/return_question, so nothing was opened
 * for the operator to see. An angry customer demanding a fix got
 * "Hi! Thanks for reaching out. What can I help you with today?" and left no
 * trace in the ticket inbox.
 *
 * "hi" is the one that surfaced, not the only one. Every keyword in the table
 * had the same fault: "rate" inside "generate", "custom" inside "customer",
 * "not me" inside "cannot meet", "hey" inside "they", "shop" inside
 * "workshop", "bad" inside "badge".
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the exact live message. Not a greeting, and it must carry the
 *   review flag its content deserves.
 *
 *   CASE B — the substring traps, one per keyword family. Each of these is an
 *   ordinary business sentence whose only connection to its wrong category is
 *   a keyword buried mid-word.
 *
 *   CASE C — the keywords still match when they are actually used. This is
 *   the half a "fix" that simply tightened everything would break.
 *
 *   CASE D — ordinary inflections still match: "prices", "returned",
 *   "designing", "samples". Matching "price" but not "prices" would be the
 *   same bug facing the other way. Short keywords ("hi", "hey", "bad") stay
 *   strict, because a suffix on those is how the defect got in.
 *
 *   CASE E — Hindi and Hinglish keywords still match. The boundary test is
 *   Unicode-aware, not \b, which is ASCII-only and would have silently
 *   disabled every Devanagari keyword in the table.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { classifyCustomerMessage } from "@/conversations/message-classification";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
function test(name: string, fn: () => void) { cases.push({ name, fn }); }

const category = (text: string) => classifyCustomerMessage(text).category;

test("CASE A — the live message is not a greeting", () => {
  const live = "This is a complete waste of time. Your product broke on day one and your people are useless. I want this fixed today.";
  const result = classifyCustomerMessage(live);
  assert.notStrictEqual(
    result.category,
    "greeting",
    'classified as a greeting because "this" contains "hi" — and greeting is one of the two categories eligible to auto-send',
  );
  // Fixing the substring match alone left this as "other" — not dangerous, but
  // not the truth either, and "other" opens no ticket. The keyword table had no
  // word for a customer who says what broke rather than the word "complaint".
  assert.strictEqual(result.category, "complaint", "this is a complaint, and the ticket branch fires on that category");
  assert.ok(
    result.requiresHumanReview,
    `an angry customer message must route to a human, got requiresHumanReview=${result.requiresHumanReview} at risk ${result.riskLevel}`,
  );
});

test("CASE A2 — a complaint that never uses the word 'complaint' is still a complaint", () => {
  const plain = [
    "The unit arrived defective and nothing we try makes it work.",
    "Your software is not working since the update.",
    "This is unacceptable, we have been waiting three weeks.",
    "The quality is terrible compared to the sample.",
  ];
  const missed = plain.filter((t) => category(t) !== "complaint");
  assert.deepStrictEqual(missed, [], "each of these opens no ticket unless it classifies as a complaint");
});

test("CASE B — a keyword buried inside another word does not classify the message", () => {
  const traps: Array<[string, string]> = [
    ["This shipment is fine, thanks for the update.", "greeting"],            // "hi" in "this"/"shipment"
    ["They confirmed the specification yesterday.", "greeting"],              // "hey" in "they"
    ["Please generate the paperwork for our records.", "price_request"],      // "rate" in "generate"
    ["The accurate figures are in the attachment.", "price_request"],         // "rate" in "accurate"
    ["Our customer signed off on the layout.", "customization_question"],     // "custom" in "customer"
    ["We cannot meet before Thursday.", "wrong_number"],                      // "not me" in "cannot meet"
    ["Our workshop is closed for the holiday.", "location_question"],         // "shop" in "workshop"
    ["Add a badge to the packing list.", "complaint"],                        // "bad" in "badge"
  ];
  const wrong = traps.filter(([text, forbidden]) => category(text) === forbidden);
  assert.deepStrictEqual(
    wrong.map(([text, forbidden]) => `"${text}" → ${forbidden}`),
    [],
    "each of these classified on a keyword that appears only inside a longer, unrelated word",
  );
});

test("CASE C — the keywords still classify when they are actually used", () => {
  assert.strictEqual(category("Hi, are you there?"), "greeting");
  assert.strictEqual(category("Please stop messaging me"), "unsubscribe");
  assert.strictEqual(category("Wrong number, I did not order anything"), "wrong_number");
  assert.strictEqual(category("What is the price for 500 units?"), "price_request");
  assert.strictEqual(category("Can you send a sample first?"), "sample_request");
  assert.strictEqual(category("What is your MOQ?"), "moq_request");
  assert.strictEqual(category("I want a refund"), "return_question");
  assert.strictEqual(category("Send me your catalogue"), "catalogue_request");
  assert.strictEqual(category("Where is your shop?"), "location_question");
});

test("CASE D — ordinary inflections match; short keywords stay strict", () => {
  assert.strictEqual(category("Share your prices please"), "price_request", "'prices' is 'price'");
  assert.strictEqual(category("The goods were returned last week"), "return_question", "'returned' is 'return'");
  assert.strictEqual(category("Are you designing this in-house?"), "customization_question", "'designing' is 'design'");
  assert.strictEqual(category("Can we get samples?"), "sample_request", "'samples' is 'sample'");

  // The short ones get no inflection allowance — that allowance is what would
  // let "hi" match "high" and put the defect straight back.
  assert.notStrictEqual(category("High volume order coming next month"), "greeting", '"high" is not "hi"');
  assert.notStrictEqual(category("He hid the invoice in the folder"), "greeting", '"hid" is not "hi"');
});

test("CASE E — Hindi and Hinglish keywords still match (the boundary test is not \\b)", () => {
  // \b is ASCII-only: every Devanagari keyword sits between two non-word
  // characters as far as \b is concerned, so a \b-based fix disables them all.
  assert.strictEqual(category("नमस्ते"), "greeting");
  assert.strictEqual(category("कीमत क्या है?"), "price_request");
  // "मुझे नहीं चाहिए" is on BOTH the unsubscribe and not_interested lists, and
  // unsubscribe is tested first — deliberately, it is the stricter outcome.
  assert.strictEqual(category("मुझे नहीं चाहिए"), "unsubscribe");
  assert.strictEqual(category("इसकी ज़रूरत नहीं है"), "not_interested");
  assert.strictEqual(category("कृपया बंद करो"), "unsubscribe");
  assert.strictEqual(category("सैंपल भेजिए"), "sample_request");
});

// --- RUNNER ---------------------------------------------------------------------
(() => {
  console.log("golden-classifier-word-boundary — N-BUG (a keyword inside another word must not classify the message)\n");
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
  console.log(`classifier-word-boundary: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
