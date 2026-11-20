/**
 * golden-owner-question-queue.ts — 2026-09-29, owner walk-through NY3–NY7.
 * "The AI is asking you" in Needs you, as the owner reads it.
 *
 *   A — titles in the owner's words: no "Conflicting information found for: …
 *       Which answer is correct?" machine wrapper, no "MOQ".
 *   B — a disagreement inside the question bank's own catch-all section is
 *       setup work (Knowledge screen), not a daily interruption — unless a
 *       customer is waiting on it.
 *   C — the same disagreement raised by several documents is ONE card
 *       ("Raised 3 times"), and answering it closes the copies.
 *   D — a question a customer is waiting on comes first.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-owner-question-queue.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { isNewDetailQuestion, plainQuestionTitle } from "@/lib/owner-question-text";
import { buildNeedsYouList } from "@/services/NeedsYouService";
import { answerUnknownQuestion } from "@/services/AISettingsService";

const repos = createJsonRepos() as RepositoryBundle;
const RUN = Date.now().toString(36);
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);
const NOW = new Date();

async function ws(tag: string) {
  const id = `ws_qqueue_${tag}_${RUN}`;
  await ensureWorkspace(repos, id);
  return id;
}
async function question(W: string, extra: Record<string, unknown>) {
  return repos.unknownQuestion.create(W, { channel: "knowledge", status: "open", questionText: "Q?", generatedBy: "conflict_detection", ...extra } as never);
}
const questions = (list: Awaited<ReturnType<typeof buildNeedsYouList>>) => list.items.filter((i) => i.bucket === "question");

test("A — titles in the owner's words", async () => {
  assert.equal(plainQuestionTitle("Conflicting information found for: What product categories exist?. Which answer is correct?"), "Two answers disagree: What product categories exist?");
  assert.equal(plainQuestionTitle("A new source has more detail for: Is catalogue available?. Should this update the approved answer?"), "New detail found: Is catalogue available?");
  assert.equal(plainQuestionTitle("MOQ for zari thread per grade/shade"), "Minimum order for zari thread per grade/shade", "and it starts with a capital");
  assert.equal(isNewDetailQuestion("A new source has more detail for: X?. Should this update the approved answer?"), true);
  assert.equal(isNewDetailQuestion("Conflicting information found for: X?. Which answer is correct?"), false);
  assert.equal(plainQuestionTitle("Are MOQs different by line?"), "Are minimum orders different by line?");
  assert.equal(plainQuestionTitle("Delivery kitne din me hogi?"), "Delivery kitne din me hogi?", "anything else is left as written");
});

test("B — the catch-all section stays on the Knowledge screen", async () => {
  const W = await ws("b");
  const internal = await question(W, { relatedDomain: "extra_unmapped_information", relatedQuestionKey: "unmapped_facts", questionText: "Conflicting information found for: What extra policy notes should be reviewed later?. Which answer is correct?" });
  const customerOnIt = await question(W, { relatedDomain: "extra_unmapped_information", relatedQuestionKey: "unmapped_notes", channel: "whatsapp", generatedBy: "whatsapp_unknown" });
  const real = await question(W, { relatedDomain: "payment_credit_terms", relatedQuestionKey: "advance_payment_rule" });
  const list = await buildNeedsYouList(W, repos, { now: NOW });
  const ids = questions(list).map((i) => i.question?.id);
  assert.ok(!ids.includes(internal.id), "an internal catch-all disagreement must not interrupt the owner");
  assert.ok(ids.includes(customerOnIt.id), "unless a customer is waiting on it");
  assert.ok(ids.includes(real.id));
  assert.ok(list.setupBacklog >= 1, "it is still counted in the setup backlog, not lost");
});

test("C — one card per disagreement; answering it closes the copies", async () => {
  const W = await ws("c");
  const older = await question(W, { relatedDomain: "product varieties", relatedQuestionKey: "minimum_quantities_by_variety", questionText: "What is the minimum order for each product line?" });
  await new Promise((r) => setTimeout(r, 5));
  await question(W, { relatedDomain: "product_varieties", relatedQuestionKey: "minimum_quantities_by_variety", questionText: "Are MOQ rules different by variety?" });
  await new Promise((r) => setTimeout(r, 5));
  const newest = await question(W, { relatedDomain: "product_varieties", relatedQuestionKey: "minimum_quantities_by_variety", questionText: "Two answers disagree about Default MOQ. Which is correct?" });
  const other = await question(W, { relatedDomain: "product_varieties", relatedQuestionKey: "sample_rule" });
  const list = await buildNeedsYouList(W, repos, { now: NOW });
  const cards = questions(list);
  assert.equal(cards.length, 2, "three copies of one disagreement + one other = two cards");
  const card = cards.find((c) => c.question?.id === newest.id);
  assert.ok(card, "the newest copy is the one shown");
  assert.ok(card!.chips.some((c) => c.text === "Raised 3 times"));
  assert.equal(card!.title, "Two answers disagree about Default minimum order. Which is correct?");
  assert.equal(list.count, list.items.length, "the count is the cards, not the copies");

  const result = await answerUnknownQuestion(W, older.id, "5 kg per shade for thread; 90 m per design for laces.", false, repos);
  assert.equal((result as { closedCopies?: number }).closedCopies, 2, "answering one closes the other two copies");
  const open = (await repos.unknownQuestion.listByWorkspace(W)).filter((q) => q.status === "open").map((q) => q.id);
  assert.deepEqual(open, [other.id], "only the unrelated question stays open");
});

test("D — a question a customer is waiting on comes first", async () => {
  const W = await ws("d");
  // The customer's question is created FIRST, so it is the oldest: newest-first
  // ordering alone would put it last.
  const lead = await repos.lead.createLead({ workspaceId: W, companyName: "Waiting Buyer", contactName: "B", whatsappNumber: "919770000999", source: "manual", status: "replied", reviewStatus: "approved", enrichmentStatus: "completed", doNotContact: false, consentStatus: "none" } as never);
  const customer = await repos.unknownQuestion.create(W, { channel: "whatsapp", status: "open", questionText: "Rate for 500 m?", generatedBy: "whatsapp_unknown", leadId: lead.id } as never);
  await new Promise((r) => setTimeout(r, 15));
  await question(W, { relatedDomain: "faqs", relatedQuestionKey: "catalogue_faq" });
  await new Promise((r) => setTimeout(r, 15));
  await question(W, { relatedDomain: "faqs", relatedQuestionKey: "delivery_faq" });
  const cards = questions(await buildNeedsYouList(W, repos, { now: NOW }));
  assert.equal(cards[0].question?.id, customer.id, "the customer's question must be first even though it is the oldest");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
