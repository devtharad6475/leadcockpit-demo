/**
 * golden-settings-repair-on-sync.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Measured on the live deployment. Five extraction conflicts were approved by
 * the operator. Four wrote. paymentPolicy returned 500 three times on a
 * Date-serialization fault and was marked `resolved` anyway, because the old
 * resolve path marked before it wrote. The end state:
 *
 *   conflicts: paymentPolicy → status "resolved", resolution "use_extracted"
 *   policy_settings.paymentPolicy → NULL
 *
 * The operator had approved the company's payment terms. The company had no
 * payment terms. And a resolved conflict never comes back, so nothing in the
 * product would ever ask again.
 *
 * Marking after the write fixes the next workspace. It does nothing for this
 * one, and there was no way to fix this one from inside the product:
 * routeExtractedFactsToSettings had exactly two callers, the website crawl and
 * the onboarding bundle, and both re-run the model from scratch. The facts
 * were already extracted, already stored in knowledgeQuestionAnswers, and
 * unreachable. Repairing a lost setting required database access.
 *
 * Sync Knowledge now re-applies stored extraction answers to settings, the way
 * it already re-applies them to the business profile.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the live end state, reconstructed: an extracted answer, a
 *   conflict already marked resolved, and an empty column. Sync puts the field
 *   back in front of the operator as an OPEN review card, and approving it now
 *   writes. paymentPolicy is a sensitive field — payment, credit, delivery,
 *   returns and pricing never auto-write, even into an empty column — so the
 *   repair is to make the question askable again, not to answer it.
 *
 *   CASE B — a value the operator set is never overwritten. Sync must be safe
 *   to press at any time, so a disagreement becomes a review card and the
 *   stored value stays theirs. A "repair" that overwrote settings would be a
 *   far worse bug than the one it fixes.
 *
 *   CASE C — pressing it twice changes nothing the second time, and does not
 *   stack up duplicate conflict cards.
 *
 *   CASE D — an unsettled answer is not a fact. needs_review / partial /
 *   conflict / unanswered must not reach settings through this path either.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { syncWorkspaceKnowledge } from "@/services/SyncKnowledgeService";
import { createJsonRepos } from "./_helpers/provider";
import type { KnowledgeQuestionAnswer } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_settingsrepair_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

const PAYMENT = "The company accepts credit cards, wire transfers, and Net-30 terms.";

let seq = 0;
function answer(
  workspaceId: string,
  domainKey: string,
  questionKey: string,
  text: string,
  answerStatus: KnowledgeQuestionAnswer["answerStatus"] = "answered",
): KnowledgeQuestionAnswer {
  seq++;
  return {
    id: `kqa_repair_${seq}`,
    workspaceId,
    domainKey,
    questionKey,
    question: `${domainKey}/${questionKey}`,
    answer: text,
    answerStatus,
    sourceType: "document",
    confidenceScore: 0.9,
    usedByAgentsJson: {},
    mapsToJson: { values: ["policy"] },
    humanReviewRequired: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as KnowledgeQuestionAnswer;
}

/** Rebuilds the exact live end state: answer stored, conflict resolved, column empty. */
async function storeAnswer(repos: ReturnType<typeof createJsonRepos>, item: KnowledgeQuestionAnswer) {
  await repos.mutateAll!((data) => {
    data.knowledgeQuestionAnswers ||= [];
    data.knowledgeQuestionAnswers.push(item);
    return undefined;
  });
}

async function seedLostSetting(repos: ReturnType<typeof createJsonRepos>, ws: string) {
  await storeAnswer(repos, answer(ws, "payment_credit_terms", "payment_methods", PAYMENT));
  const conflict = await repos.settingsConflict.create(ws, {
    settingsArea: "policy",
    fieldKey: "paymentPolicy",
    existingValue: "",
    extractedValue: PAYMENT,
    extractedSource: "document",
    status: "open",
  });
  // The write failed; the old code marked it resolved regardless.
  await repos.settingsConflict.resolve(ws, conflict.id, "use_extracted");
  return conflict;
}

test("CASE A — Sync restores a setting whose conflict is already marked resolved", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  await seedLostSetting(repos, WS);

  const before = await repos.policySettings.getByWorkspace(WS);
  assert.ok(!before?.paymentPolicy, "precondition: the column is empty, exactly as it is on the live deployment");

  await syncWorkspaceKnowledge(WS, repos);

  const open = await repos.settingsConflict.listByWorkspace(WS, { status: "open" });
  const card = open.find((c) => c.fieldKey === "paymentPolicy");
  assert.ok(
    card,
    "the fact was extracted and stored — the product must be able to put it back in front of the operator without a database session or another model call",
  );
  assert.strictEqual(card!.extractedValue, PAYMENT, "and the card carries the extracted value, not a blank");

  // And approving it now actually writes, because resolve no longer marks
  // before it writes. This is the whole loop the operator lost.
  const { resolveSettingsConflict } = await import("@/services/ExtractionRoutingService");
  await resolveSettingsConflict(WS, card!.id, "use_extracted", undefined, undefined, repos);
  const after = await repos.policySettings.getByWorkspace(WS);
  assert.strictEqual(after?.paymentPolicy, PAYMENT, "approving the restored card writes the policy");
});

test("CASE B — a value the operator set is never overwritten", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  const OWNER_VALUE = "Advance payment only. No credit terms.";
  await storeAnswer(repos, answer(WS, "payment_credit_terms", "payment_methods", PAYMENT));
  await repos.policySettings.upsertForWorkspace(WS, { paymentPolicy: OWNER_VALUE });

  await syncWorkspaceKnowledge(WS, repos);

  const after = await repos.policySettings.getByWorkspace(WS);
  assert.strictEqual(after?.paymentPolicy, OWNER_VALUE, "the operator's own value survives — this button must be safe to press");

  const conflicts = await repos.settingsConflict.listByWorkspace(WS, { status: "open" });
  assert.ok(
    conflicts.some((c) => c.fieldKey === "paymentPolicy"),
    "and the disagreement is offered as a review card rather than dropped",
  );
});

test("CASE C — pressing it twice adds nothing the second time", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  await storeAnswer(repos, answer(WS, "payment_credit_terms", "payment_methods", PAYMENT));

  await syncWorkspaceKnowledge(WS, repos);
  const afterFirst = await repos.settingsConflict.listByWorkspace(WS);
  await syncWorkspaceKnowledge(WS, repos);
  const afterSecond = await repos.settingsConflict.listByWorkspace(WS);

  assert.strictEqual(afterFirst.length, 1, `the first sync raises one card, got ${afterFirst.length}`);
  assert.strictEqual(
    afterSecond.length,
    afterFirst.length,
    `a second sync must not stack duplicate review cards, went from ${afterFirst.length} to ${afterSecond.length} — sensitive fields always card, so without a guard they duplicate on every run`,
  );
});

test("CASE D — an unsettled answer does not become a company policy", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("D");
  await storeAnswer(repos, answer(WS, "payment_credit_terms", "payment_methods", PAYMENT, "needs_review"));

  await syncWorkspaceKnowledge(WS, repos);

  const policy = await repos.policySettings.getByWorkspace(WS);
  assert.ok(
    !policy?.paymentPolicy,
    `a needs_review answer must not be written as a settled policy, got ${policy?.paymentPolicy}`,
  );
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  console.log("golden-settings-repair-on-sync — N-BUG (a setting lost to a failed write must be recoverable from inside the product)\n");
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
  console.log(`settings-repair-on-sync: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
