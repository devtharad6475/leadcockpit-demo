/**
 * GOLDEN — the setup question bank must be worth a customer's time.
 *
 * The CEO asked, 2026-08-24: "I have just written down 523 questions. I don't
 * know whether it is correct one or not. I want you to please check all those
 * questions whether it makes sense to ask or not."
 *
 * They were not all correct. The bank was 150 hand-written questions padded up
 * to per-domain quotas by a generator that cycled ten generic sentences,
 * modulo, until the count was reached. That produced 103 questions naming no
 * real business topic. Two shipped verbatim to customers:
 *
 *   "What information is still needed about required product knowledge details
 *    that are missing before safe customer replies?"
 *   "What information is still needed about product knowledge follow-up
 *    questions the system should ask after extraction?"
 *
 * The second one is the product asking the owner to write the product's own
 * to-do list, on their first day, in the onboarding screen.
 *
 * Because the padding cycled modulo 10, a domain needing more than ten fillers
 * repeated a topic word for word — which is where every duplicate in the bank
 * came from. product_knowledge/deep_12 and deep_22 differ by exactly 10.
 *
 * WHAT THIS GOLDEN HOLDS. Not the count — the count is allowed to move, and
 * pinning it would be pinning the very quota that caused this. It holds the
 * properties a question must have to be worth asking a human:
 *
 *   1. no two questions say the same thing        (CASE A)
 *   2. no key appears twice                       (CASE B)
 *   3. no question is a quota filler              (CASE C)  <- the actual fix
 *   4. every question carries an example answer   (CASE D)
 *   5. every question says why it matters         (CASE D)
 *   6. a question fits on a phone screen          (CASE E)
 *   7. a fixed-choice question offers choices     (CASE F)
 *   8. the essential set is hand-written          (CASE G)
 *
 * WHAT IT CANNOT DO. It cannot tell you a question is worth asking THIS
 * business — that needs the per-industry conditions (Q-2, still open: the bank
 * collects industry and business type in its first three questions and then
 * ignores both). And it cannot judge whether a well-formed question is a good
 * question. Those are read by a person; see docs/QUESTION-BANK-AUDIT.md.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { getAllKnowledgeQuestions, getEssentialKnowledgeQuestions } from "../../src/knowledge/knowledge-question-framework";

const all = getAllKnowledgeQuestions();

/**
 * The ten sentences the removed generator cycled through. Kept here verbatim
 * so the golden fails if any of them ever returns, under any mechanism —
 * regenerated, pasted back, or hand-written by someone who thought they read
 * like the others.
 */
const QUOTA_FILLER_PHRASES = [
  "details that are missing before safe customer replies",
  "facts that should update agent instructions after user approval",
  "questions that affect lead qualification decisions",
  "information needed before quotation or pricing discussion",
  "details that affect product recommendation accuracy",
  "details that affect campaign targeting or search queries",
  "constraints the agent must not overpromise",
  "facts that need human approval before auto-reply",
  "details needed for buyer segment personalization",
  "follow-up questions the system should ask after extraction",
];

/**
 * N13 (2026-09-25) — the six stock sentences the old generator pasted 274
 * topics into. A question starting with one of these is a template, whatever
 * its key. Keys are no evidence either way any more: rewritten questions keep
 * their old `deep_…` key so stored answers carry over.
 */
const TEMPLATE_STEMS = [
  /^what should the company knowledge include about /i,
  /^what information is still needed about /i,
  /^what is the company rule or process for /i,
  /^what documented or approved information is available about /i,
  /^what signals or criteria should be used for /i,
  /^what should the agent know about /i,
];
const isTemplate = (question: string) => TEMPLATE_STEMS.some((stem) => stem.test(question.trim()));

/** A count guard. A sweep that has lost its subject passes vacuously. */
const MIN_QUESTIONS = 100;

test("CASE 0 — there is a bank to check at all", () => {
  assert.ok(
    all.length >= MIN_QUESTIONS,
    `only ${all.length} questions found. Every case below sweeps this list, so an empty or broken framework would ` +
      `make all of them pass while proving nothing.`,
  );
});

test("CASE A — no two questions ask the same thing", () => {
  const byText = new Map<string, string[]>();
  for (const q of all) {
    const normalized = q.question.trim().toLowerCase().replace(/\s+/g, " ");
    byText.set(normalized, [...(byText.get(normalized) ?? []), `${q.domainKey}/${q.questionKey}`]);
  }
  const duplicates = [...byText.entries()].filter(([, where]) => where.length > 1);
  assert.deepEqual(
    duplicates.map(([text, where]) => `"${text}" in ${where.join(" + ")}`),
    [],
    "the same question is asked more than once. The owner answers it twice, the two answers can disagree, and the " +
      "AI then has two sources of truth for one fact.",
  );
});

test("CASE B — no question key is reused", () => {
  const byKey = new Map<string, string[]>();
  for (const q of all) byKey.set(q.questionKey, [...(byKey.get(q.questionKey) ?? []), q.domainKey]);
  const duplicates = [...byKey.entries()].filter(([, where]) => where.length > 1);
  assert.deepEqual(
    duplicates.map(([key, where]) => `${key} in ${where.join(" + ")}`),
    [],
    "a question key appears in more than one domain. Answers are stored against domain/key, so a reused key means " +
      "one tenant's answer can land on the wrong question.",
  );
});

test("CASE C — no question is a quota filler", () => {
  // This is the fix. Everything else on this list is hygiene; this is the one
  // that stops 103 unanswerable questions being shipped to a paying customer.
  const offenders = all
    .filter((q) => QUOTA_FILLER_PHRASES.some((phrase) => q.question.toLowerCase().includes(phrase)))
    .map((q) => `${q.domainKey}/${q.questionKey}: "${q.question}"`);

  assert.deepEqual(
    offenders,
    [],
    "a quota-filler question is back in the bank. These name no real business topic — they ask the owner to tell " +
      "the system what the system should have asked. If a domain needs more depth, write the topic; do not pad to " +
      "a number.",
  );
});

test("CASE D — every question carries an example answer and a reason", () => {
  const noExample = all.filter((q) => !q.exampleAnswer?.trim()).map((q) => `${q.domainKey}/${q.questionKey}`);
  const noWhy = all.filter((q) => !q.whyItMatters?.trim()).map((q) => `${q.domainKey}/${q.questionKey}`);

  assert.deepEqual(noExample, [], "a question with no example answer. The owner has to guess the shape of the answer, " +
    "and a guessed shape is what the AI later repeats to a customer.");
  assert.deepEqual(noWhy, [], "a question that never says why it matters. An owner asked for private business detail " +
    "without a reason will skip it, and they are right to.");
});

test("CASE E — a question fits on a phone screen", () => {
  // 140 characters is roughly three lines on a phone. Past that, people stop
  // reading the question and answer the part they remember.
  const tooLong = all
    .filter((q) => q.question.length > 140)
    .map((q) => `${q.domainKey}/${q.questionKey} (${q.question.length} chars)`);
  assert.deepEqual(tooLong, [], "a question is too long to read on a phone.");
});

test("CASE F — a fixed-choice question actually offers choices", () => {
  const broken = all
    .filter((q) => (q.answerType === "single_choice" || q.answerType === "multi_choice") && !q.options?.length)
    .map((q) => `${q.domainKey}/${q.questionKey}`);
  assert.deepEqual(broken, [], "a question is typed as a dropdown but has no options, so it renders as an empty " +
    "control the owner cannot answer.");
});

test("CASE G — the essential questions are hand-written, never generated", () => {
  // The essential set is what a customer must answer before the AI is allowed
  // to speak for them. Every one of these must be a sentence a person wrote
  // and a business owner can answer without training.
  const essential = getEssentialKnowledgeQuestions();
  assert.ok(essential.length > 0, "no essential questions — the onboarding path has nothing to ask");

  const generated = essential
    .filter((q) => isTemplate(q.question))
    .map((q) => `${q.domainKey}/${q.questionKey}: "${q.question}"`);

  assert.deepEqual(
    generated,
    [],
    "a machine-generated question has been marked essential. Generated questions name a topic, not a question; " +
      "making one mandatory means a customer cannot finish setup until they answer something no one can answer.",
  );
});

test("CASE H — no question anywhere is a template sentence (N13)", () => {
  const templates = all.filter((q) => isTemplate(q.question)).map((q) => `${q.domainKey}/${q.questionKey}: "${q.question}"`);
  assert.deepEqual(templates, [], "a template question is back. Write the question a person would ask; see checklist-additions.ts.");
});

after(() => {
  console.log(
    `\n  question pool: ${all.length} questions, ${getEssentialKnowledgeQuestions().length} essential.\n` +
      "  NOTE: this golden holds question QUALITY. Which questions each kind of business is asked (Q-2, closed by\n" +
      "  N13) is held by golden-checklist-per-business-type.ts.\n",
  );
});
