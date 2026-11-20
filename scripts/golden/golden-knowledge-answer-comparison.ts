/**
 * golden-knowledge-answer-comparison.ts — conflict-detection math pin (NEW, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   KnowledgeAnswerComparisonService decides what happens when a new source
 *   brings a fact that overlaps an existing one: merge silently, upgrade to a
 *   more specific answer, flag a contradiction (→ clarification review), or
 *   treat as different. It had NO golden test (gap-analysis finding). A wrong
 *   result here means either (a) a contradiction is silently merged (customer
 *   quoted a wrong price) or (b) every minor rewording creates a false
 *   conflict (review queue floods). AGENTS.md: "Conflicts → clarification
 *   review. Never guess prices, delivery, credit..." — this is the engine.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — computed from the rules, not the code):
 *
 *   CASE A — normalizeAnswerText: lowercase, strip punctuation EXCEPT .%/-,
 *     collapse whitespace. Hand-computed:
 *       "Hello,  WORLD!!" → "hello world"          (punct→space, collapse)
 *       "₹1,234.50"       → "1 234.50"             (₹ stripped, ,→space, . kept)
 *       "100% OFF"        → "100 off"              (% KEPT per regex... wait)
 *     NOTE: the regex keeps `.%/-`, so "100% OFF" → "100 off"? No — % IS kept.
 *       "100% off"        → "100% off"             (% retained)
 *       "" / undefined    → ""                     (safe default)
 *
 *   CASE B — areAnswersEquivalent: same-after-normalize OR one contains the
 *     other (only when shorter > 24 chars, to avoid "yes" matching everything).
 *       "We ship pan-India" vs "we ship pan-india"   → true  (case-insensitive equal)
 *       "Yes" vs "yes"                               → true
 *       "a" vs "a"                                   → true  (exact equal, no length gate on exact)
 *       "yes" vs "yes we do ship"                    → false (shorter "yes" is 3 chars, not >24)
 *       "" vs "anything"                             → false (empty not equivalent)
 *
 *   CASE C — detectContradiction: the load-bearing no-hallucination gate.
 *       "No, we don't offer credit" vs "Yes, credit available"  → TRUE (yes/no conflict)
 *       "MOQ is 500" vs "MOQ is 1000"                → TRUE (numeric term conflict, different numbers)
 *       "We ship pan-India" vs "we ship pan-india"   → FALSE (equivalent)
 *       "We make silk" vs "we make cotton"           → FALSE (different but not a contradiction — no yes/no, no numeric, not return/payment)
 *
 *   CASE D — compareKnowledgeAnswer: the full state machine.
 *       existing=undefined, incoming="X"             → "incoming_more_specific"
 *       existing="A", incoming=""                    → "empty"
 *       existing="yes", incoming="no", Q="do you X?" → "contradiction"
 *       existing="ship pan-india", incoming="ship pan-india" → "equivalent"
 *
 *   CASE E — answerStatusRank: priority ordering (higher = wins on merge).
 *       unanswered(0) < not_applicable(1) < conflict(2) < partial(3) < needs_review(4) < answered(5)
 *       This pins the merge priority — an "answered" fact must never be overwritten
 *       by a "needs_review" one.
 *
 *   CASE F — isAnswerMoreSpecific: longer by 1.25x OR more numeric/unit signals.
 *       "MOQ 500" vs "MOQ is 500 pieces, 30 day delivery" → incoming more specific
 *         (incoming has 2 numbers + "day" signal vs existing's 1 number)
 *
 * REAL PIPELINE: imports the REAL functions. Pure logic — no repo, no mocks.
 *
 * Run: `npm run golden:knowledge-answer-comparison`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  normalizeAnswerText,
  areAnswersEquivalent,
  detectContradiction,
  compareKnowledgeAnswer,
  answerStatusRank,
  isAnswerMoreSpecific,
} from "@/services/KnowledgeAnswerComparisonService";
import type { KnowledgeQuestionAnswer, KnowledgeQuestionAnswerStatus } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

// --- CASE A: normalizeAnswerText -------------------------------------------------
test("CASE A — normalizeAnswerText strips punctuation (keeps .%/-), lowercases, collapses ws", async () => {
  assert.strictEqual(normalizeAnswerText("Hello,  WORLD!!"), "hello world", "punct→space, collapse whitespace");
  assert.strictEqual(normalizeAnswerText("100% off"), "100% off", "% is RETAINED in the keep-set");
  assert.strictEqual(normalizeAnswerText("₹1,234.50"), "1 234.50", "₹ stripped, comma→space, . kept");
  assert.strictEqual(normalizeAnswerText("a  b   c"), "a b c", "collapsed whitespace");
  assert.strictEqual(normalizeAnswerText(""), "", "empty → empty");
  assert.strictEqual(normalizeAnswerText(undefined as unknown as string), "", "undefined → empty (safe default)");
  assert.strictEqual(normalizeAnswerText("ship pan-india"), "ship pan-india", "hyphen retained");
});

// --- CASE B: areAnswersEquivalent ------------------------------------------------
test("CASE B — areAnswersEquivalent (exact OR containment with >24 char gate)", async () => {
  assert.strictEqual(areAnswersEquivalent("We ship pan-India", "we ship pan-india"), true, "case-insensitive exact match");
  assert.strictEqual(areAnswersEquivalent("Yes", "yes"), true, "exact equal always equivalent");
  assert.strictEqual(areAnswersEquivalent("a", "a"), true, "single char exact equal");
  // The >24 gate: a short answer must NOT match via containment.
  assert.strictEqual(areAnswersEquivalent("yes", "yes we do ship everywhere"), false, '"yes" (3 chars) too short to contain-match');
  // A long enough answer contained in a longer one IS equivalent.
  const longA = "we ship our textile products across all of india pan india delivery";
  const longB = "we ship our textile products across all of india pan india delivery within seven days";
  assert.strictEqual(areAnswersEquivalent(longA, longB), true, "longer contains shorter (shorter >24 chars) → equivalent");
  assert.strictEqual(areAnswersEquivalent("", "anything"), false, "empty never equivalent");
  assert.strictEqual(areAnswersEquivalent("silk", "cotton"), false, "different short answers not equivalent");
});

// --- CASE C: detectContradiction (the no-hallucination gate) ---------------------
test("CASE C — detectContradiction (yes/no + numeric term + return/payment conflicts)", async () => {
  // Yes/No conflict on a binary question.
  assert.strictEqual(detectContradiction("No, we don't offer credit", "Yes, credit is available", "do you offer credit?"), true, "no vs yes → contradiction");
  // Numeric term conflict: same domain (MOQ/minimum), different numbers, few numbers each.
  assert.strictEqual(detectContradiction("MOQ is 500 metres", "MOQ is 1000 metres", "what is the minimum order quantity?"), true, "MOQ 500 vs 1000 → contradiction");
  // Equivalent answers are NOT contradictions.
  assert.strictEqual(detectContradiction("We ship pan-India", "we ship pan-india", "where do you ship?"), false, "equivalent → not a contradiction");
  // Different but not in a conflict domain (no yes/no, no matching numeric domain).
  assert.strictEqual(detectContradiction("We make silk fabric", "we make cotton fabric", "what do you manufacture?"), false, "different non-conflict domain → not contradiction");
  // Same number is NOT a contradiction (shared number).
  assert.strictEqual(detectContradiction("MOQ is 500", "MOQ is 500 metres", "what is MOQ?"), false, "shared number → not contradiction");
});

// --- CASE D: compareKnowledgeAnswer (full state machine) -------------------------
test("CASE D — compareKnowledgeAnswer state machine", async () => {
  const mk = (answer: string, answerStatus: KnowledgeQuestionAnswerStatus, question: string): KnowledgeQuestionAnswer =>
    ({ answer, answerStatus, question } as KnowledgeQuestionAnswer);

  // No existing → incoming wins.
  assert.strictEqual(
    compareKnowledgeAnswer(undefined, mk("ship pan-india", "answered", "where do you ship?")),
    "incoming_more_specific",
    "no existing → incoming_more_specific",
  );
  // Empty incoming → empty.
  assert.strictEqual(
    compareKnowledgeAnswer(mk("existing", "answered", "q"), mk("", "answered", "q")),
    "empty",
    "empty incoming answer → empty",
  );
  // Contradiction takes priority.
  assert.strictEqual(
    compareKnowledgeAnswer(mk("No credit", "answered", "do you offer credit?"), mk("Yes credit", "answered", "do you offer credit?")),
    "contradiction",
    "no vs yes → contradiction (before equivalence check)",
  );
  // Equivalent.
  assert.strictEqual(
    compareKnowledgeAnswer(mk("ship pan-india", "answered", "q"), mk("ship pan-india", "answered", "q")),
    "equivalent",
    "same normalized → equivalent",
  );
});

// --- CASE E: answerStatusRank (merge priority) -----------------------------------
test("CASE E — answerStatusRank priority ordering (answered wins, unanswered loses)", async () => {
  // Hand-computed ranks: unanswered=0, not_applicable=1, conflict=2, partial=3, needs_review=4, answered=5
  const r = (s: KnowledgeQuestionAnswerStatus, hasAnswer = true) => answerStatusRank(s, hasAnswer);
  assert.strictEqual(r("answered"), 5, "answered = 5 (highest)");
  assert.strictEqual(r("needs_review"), 4, "needs_review = 4");
  assert.strictEqual(r("partial"), 3, "partial = 3");
  assert.strictEqual(r("conflict"), 2, "conflict = 2");
  assert.strictEqual(r("not_applicable"), 1, "not_applicable = 1");
  assert.strictEqual(r("unanswered"), 0, "unanswered = 0 (lowest)");
  // Strict ordering: each rank is strictly greater than the one below.
  // (Avoid the JS chained-`>` pitfall: a > b > c parses as (a>b)>c, i.e.
  // boolean>c. Assert each adjacent pair explicitly instead.)
  assert.ok(r("answered") > r("needs_review"), "answered > needs_review");
  assert.ok(r("needs_review") > r("partial"), "needs_review > partial");
  assert.ok(r("partial") > r("conflict"), "partial > conflict");
  assert.ok(r("conflict") > r("not_applicable"), "conflict > not_applicable");
  assert.ok(r("not_applicable") > r("unanswered"), "not_applicable > unanswered");
  // Unknown status defaults to 0 (safe).
  assert.strictEqual(r("garbage_status" as KnowledgeQuestionAnswerStatus), 0, "unknown status → 0");
  // No answer + non-conflict status → 0 (treats empty as lowest).
  assert.strictEqual(answerStatusRank("answered", false), 0, "answered status but no answer text → 0");
});

// --- CASE F: isAnswerMoreSpecific (length 1.25x OR more signals) -----------------
test("CASE F — isAnswerMoreSpecific (length ratio or specificity signals)", async () => {
  // Existing is short/vague; incoming is long + has units + numbers → more specific.
  const existing = "MOQ is 500";
  const incoming = "MOQ is 500 pieces per order, with a 30 day delivery timeline";
  assert.strictEqual(isAnswerMoreSpecific(existing, incoming), true, "incoming has more numbers + 'day' signal + longer → more specific");
  // Reversed: the shorter existing is NOT more specific than the rich incoming.
  assert.strictEqual(isAnswerMoreSpecific(incoming, existing), false, "shorter existing is NOT more specific than rich incoming");
  // Empty incoming → never "more specific".
  assert.strictEqual(isAnswerMoreSpecific("existing fact", ""), false, "empty incoming → false");
  // Empty existing + non-empty incoming → always more specific.
  assert.strictEqual(isAnswerMoreSpecific("", "any new detail"), true, "empty existing → incoming is more specific");
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
  console.log(`knowledge-answer-comparison: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
