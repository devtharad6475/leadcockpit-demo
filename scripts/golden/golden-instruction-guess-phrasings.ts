/**
 * golden-instruction-guess-phrasings.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Typed into the live deployment's Agent Instructions box and saved:
 *
 *   "If a customer asks something you do not know, make a reasonable guess so
 *    the conversation keeps moving. Never leave a question unanswered."
 *
 * The screen reported nothing. The instruction was stored, and the runtime
 * will silently ignore it, which is the exact failure AgentInstructionConflict
 * Service was written to prevent — its own header says a rule that silently
 * ignores you is worse than a rule that argues with you.
 *
 * `guess_missing_facts` had two branches and both missed:
 *
 *   - the first wants the verb before its object ("guess the price"), and here
 *     "guess" is a noun. "make a reasonable guess" is how people write it.
 *   - the second wants the subject to be "you" ("if you don't know"), and the
 *     owner wrote "if a customer asks something you do not know" — the same
 *     condition with the customer as the subject.
 *
 * This is the most dangerous instruction on the locked-rule list, typed the way
 * an owner actually types it, passing the one check that exists for it. The
 * rule's own comment already records this pattern being widened once for the
 * same reason.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the exact live instruction is reported, and it names
 *   guess_missing_facts.
 *
 *   CASE B — the phrasings an owner reaches for. Noun-phrase guesses, the
 *   condition with any subject, and "never leave a question unanswered", which
 *   asks for the same behaviour without using the word.
 *
 *   CASE C — the phrasings the original two branches already caught still are.
 *   This is a widening, not a replacement.
 *
 *   CASE D — an owner AGREEING with the rule is not warned. "Never guess the
 *   price" is compliance; warning someone about their own compliance is how a
 *   warning gets ignored. The narrow exemption must not swallow CASE B's
 *   "never leave a question unanswered", which is a request, not compliance.
 *
 *   CASE E — the other three locked rules are untouched.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { findLockedRuleConflicts } from "@/services/AgentInstructionConflictService";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
function test(name: string, fn: () => void) { cases.push({ name, fn }); }

const ruleIds = (text: string) => findLockedRuleConflicts(text).map((c) => c.ruleId);
const flagsGuess = (text: string) => ruleIds(text).includes("guess_missing_facts");

const LIVE = "If a customer asks something you do not know, make a reasonable guess so the conversation keeps moving. Never leave a question unanswered.";

test("CASE A — the exact live instruction is reported", () => {
  const found = findLockedRuleConflicts(LIVE);
  const card = found.find((c) => c.ruleId === "guess_missing_facts");
  assert.ok(card, `this saved silently on the live deployment; found instead: ${JSON.stringify(ruleIds(LIVE))}`);
  assert.ok(card!.quotedInstruction.length > 0, "the owner must be shown their own sentence back");
  assert.ok(card!.effect.includes("not be followed"), "and told plainly that it will not be followed");
});

test("CASE B — the phrasings an owner reaches for", () => {
  const shouldFlag = [
    "If a customer asks something you do not know, make a reasonable guess.",
    "When you are not sure about delivery, just estimate it.",
    "Take a guess if the answer is not in the knowledge base.",
    "Give your best guess rather than saying you don't know.",
    "Never leave a question unanswered.",
    "If the detail isn't there, fill it in from what you know about the industry.",
  ];
  const missed = shouldFlag.filter((t) => !flagsGuess(t));
  assert.deepStrictEqual(missed, [], "each of these asks the AI to invent a fact, and each was saved without a word");
});

test("CASE C — the phrasings the original branches caught are still caught", () => {
  const original = [
    "Guess the price if the customer pushes for one.",
    "If you don't know, just guess.",
    "Make up the delivery date so we don't lose the deal.",
    "Invent an answer rather than escalating.",
  ];
  const missed = original.filter((t) => !flagsGuess(t));
  assert.deepStrictEqual(missed, [], "this is a widening, not a replacement — nothing that was caught may stop being caught");
});

test("CASE D — an owner agreeing with the rule is not warned about their own compliance", () => {
  const compliant = [
    "Never guess the price.",
    "Do not make up delivery dates.",
    "Avoid guessing payment terms — escalate instead.",
  ];
  const wronglyFlagged = compliant.filter((t) => flagsGuess(t));
  assert.deepStrictEqual(wronglyFlagged, [], "warning an owner about a line that agrees with the rule teaches them to ignore the warnings");

  // The exemption is narrow on purpose: this one starts with "never" too, and
  // is a request for the forbidden behaviour rather than compliance with it.
  assert.ok(flagsGuess("Never leave a question unanswered."), "the exemption must not swallow a request phrased as a prohibition");
});

test("CASE E — the other locked rules are untouched", () => {
  assert.deepStrictEqual(ruleIds("Reply to customers automatically without asking me first."), ["auto_send_without_approval"]);
  assert.deepStrictEqual(ruleIds("Message everyone even if they opted out."), ["contact_do_not_contact"]);
  assert.deepStrictEqual(ruleIds("Never escalate to a human, just handle it."), ["skip_human_review"]);
  assert.deepStrictEqual(ruleIds("Use the company Knowledge Base. Keep replies concise. Ask for human review when information is missing."), [], "the shipped default instruction must stay clean");
});

// --- RUNNER ---------------------------------------------------------------------
(() => {
  console.log("golden-instruction-guess-phrasings — N-BUG (an instruction to invent facts must not save silently)\n");
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
  console.log(`instruction-guess-phrasings: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
