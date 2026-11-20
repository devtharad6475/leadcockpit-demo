/**
 * golden-structured-settings-mapping.ts — settings→KB mapping + conflict-protection (NEW, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   StructuredSettingsQuestionMappingService had NO golden test (gap-analysis
 *   finding). It syncs owner-edited sales/policy/communication settings into
 *   Knowledge Base answers. The LOAD-BEARING rule (AGENTS.md non-negotiable):
 *   "Higher-priority knowledge is never silently overwritten by lower." A
 *   user-APPROVED answer that CONFLICTS with a new setting must be flagged
 *   "conflict" for review — NOT silently replaced. If this breaks, an owner's
 *   approved answer ("credit: 30 days") gets silently overwritten by a setting
 *   edit ("credit: 15 days") and the customer is quoted the wrong terms.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — a settings field maps to the right KB question(s).
 *     Input: sales.standardCreditPeriod = "30 days"
 *     Hand-computed: a knowledgeQuestionAnswer row appears at
 *       domainKey="payment_credit_terms", questionKey="credit_period",
 *       answer contains "30", answerStatus="answered".
 *     If the mapping is dropped/renamed, this fails.
 *
 *   CASE B — the conflict-protection rule (THE no-silent-overwrite gate):
 *     Seed an EXISTING user-approved answer: credit_period = "30 days",
 *       isUserApproved=true.
 *     Then sync sales.standardCreditPeriod = "15 days" (CONFLICTS — different number).
 *     Hand-computed: the existing row is NOT overwritten. Instead:
 *       answerStatus = "conflict"
 *       conflictWithExisting = true
 *       conflictReason mentions both values
 *       the ORIGINAL answer ("30 days") is still in .answer (preserved)
 *     This is the rule that stops a setting from silently overwriting an
 *     owner-approved fact.
 *
 *   CASE C — a NON-conflicting user-approved answer is preserved as-is.
 *     Seed existing approved answer "30 days". Sync setting "30 days net"
 *     (equivalent, not a contradiction). The approved answer must stay
 *     "answered" + isUserApproved=true (no false conflict).
 *
 * REAL PIPELINE: imports the REAL syncStructuredSettingsToQuestions + the REAL
 * JSON repo (mutateAll). Unique timestamped workspace per case.
 *
 * Run: `npm run golden:structured-settings-mapping`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { syncStructuredSettingsToQuestions } from "@/services/StructuredSettingsQuestionMappingService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";
import type { KnowledgeQuestionAnswer, JsonRecord } from "@/lib/types";
import { uid, timestamp } from "@/lib/db";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_ssm_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function seedAnswer(repos: RepositoryBundle, WS: string, overrides: Partial<KnowledgeQuestionAnswer>): Promise<KnowledgeQuestionAnswer> {
  const base: KnowledgeQuestionAnswer = {
    id: uid("kqa"),
    workspaceId: WS,
    domainKey: "payment_credit_terms",
    questionKey: "credit_period",
    question: "What is your credit period?",
    answer: "",
    answerStatus: "answered",
    isUserApproved: false,
    createdAt: timestamp(),
    updatedAt: timestamp(),
    ...overrides,
  } as KnowledgeQuestionAnswer;
  await repos.mutateAll!((data: JsonRecord) => {
    (data.knowledgeQuestionAnswers as KnowledgeQuestionAnswer[]) ||= [];
    (data.knowledgeQuestionAnswers as KnowledgeQuestionAnswer[]).push(base);
  });
  return base;
}

async function findAnswer(repos: RepositoryBundle, WS: string, questionKey: string): Promise<KnowledgeQuestionAnswer | undefined> {
  const data = await repos.readAll!();
  const list = (data.knowledgeQuestionAnswers as KnowledgeQuestionAnswer[]) || [];
  return list.find((a) => a.workspaceId === WS && a.domainKey === "payment_credit_terms" && a.questionKey === questionKey);
}

test("CASE A — sales.standardCreditPeriod maps to the credit_period KB question", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  await syncStructuredSettingsToQuestions(WS, {
    sales: { standardCreditPeriod: "30 days net" },
  }, repos);
  const ans = await findAnswer(repos, WS, "credit_period");
  assert.ok(ans, "a knowledgeQuestionAnswer row was created for credit_period");
  assert.ok(/30/.test(ans!.answer || ""), `answer contains the setting value "30", got "${ans!.answer}"`);
  assert.strictEqual(ans!.answerStatus, "answered", "mapped answer status is answered");
});

test("CASE B — a CONFLICTING user-approved answer is flagged conflict, NOT overwritten (no silent overwrite)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  // Seed an OWNER-APPROVED answer: credit = 30 days.
  await seedAnswer(repos, WS, { answer: "30 days net", isUserApproved: true, answerStatus: "answered" });

  // Sync a CONFLICTING setting: credit = 15 days (different number → contradiction).
  await syncStructuredSettingsToQuestions(WS, {
    sales: { standardCreditPeriod: "15 days net" },
  }, repos);

  const ans = await findAnswer(repos, WS, "credit_period");
  assert.ok(ans, "the answer row exists");
  // THE load-bearing assertions:
  assert.strictEqual(ans!.answerStatus, "conflict", "conflicting setting → status flipped to conflict (NOT silently applied)");
  assert.strictEqual(ans!.conflictWithExisting, true, "conflictWithExisting flagged");
  assert.ok(/30 days net/.test(ans!.answer || ""), 'the ORIGINAL approved answer "30 days net" is PRESERVED in .answer (not overwritten)');
  assert.ok(ans!.conflictReason && /15/.test(ans!.conflictReason), `conflictReason mentions the new value, got "${ans!.conflictReason}"`);
});

test("CASE C — a NON-conflicting user-approved answer is preserved (no false conflict)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  // Seed approved answer: credit = 30 days.
  await seedAnswer(repos, WS, { answer: "30 days", isUserApproved: true, answerStatus: "answered" });
  // Sync an EQUIVALENT setting (same number, not a contradiction).
  await syncStructuredSettingsToQuestions(WS, {
    sales: { standardCreditPeriod: "30 days" },
  }, repos);
  const ans = await findAnswer(repos, WS, "credit_period");
  assert.ok(ans, "row exists");
  // The approved answer must stay answered + approved (no false conflict).
  assert.notStrictEqual(ans!.answerStatus, "conflict", "equivalent setting must NOT create a false conflict");
  assert.strictEqual(ans!.isUserApproved, true, "user-approved flag preserved");
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
  console.log(`structured-settings-mapping: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
