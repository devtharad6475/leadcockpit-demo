/**
 * golden-agent-instruction-conflicts.ts — N-AI-13 (NEW, 2026-08-27).
 *
 * WHY THIS TEST EXISTS:
 *   The owner can type anything into the Agent Instructions box and it is saved
 *   with no check at all. Two instructions are dangerous in opposite ways:
 *
 *   (1) One that asks for something a LOCKED platform rule forbids. The runtime
 *       already refuses to obey it — the safety policies are injected last so
 *       they win. So the instruction is SILENTLY INERT: the owner believes the
 *       AI is doing what they asked, and it is not. A rule that silently
 *       ignores you is worse than one that argues with you.
 *
 *   (2) One that contradicts the workspace's OWN reviewed knowledge. Nothing
 *       compares the two, so the AI is handed both and the customer gets
 *       whichever wins the toss.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — every expected value written before the
 * code runs):
 *
 *   CASE 1 — "Reply to customers without asking me first." must raise exactly
 *     ONE locked-rule finding, ruleId `auto_send_without_approval`, and the
 *     finding must quote the owner's own sentence back.
 *
 *   CASE 2 — "Message them even if they unsubscribed." → `contact_do_not_contact`.
 *
 *   CASE 3 — "If you don't know the price, just guess." → `guess_missing_facts`.
 *
 *   CASE 4 — "Never escalate to a human." → `skip_human_review`.
 *
 *   CASE 5 — THE HONEST HALF. A perfectly ordinary instruction ("Keep replies
 *     short and polite. Always use the company knowledge base.") must raise
 *     ZERO findings. A checker that flags everything is a checker nobody reads.
 *
 *   CASE 6 — the owner has already answered "What is the minimum order
 *     quantity?" with "Minimum order is 5 kg per shade." An instruction saying
 *     "Tell customers the minimum order quantity is 10 kg per shade." must
 *     raise exactly ONE knowledge conflict, carrying BOTH the saved answer and
 *     the instruction so the owner can see the two side by side.
 *
 *   CASE 7 — the same instruction repeating the SAME number (5 kg) must raise
 *     ZERO knowledge conflicts. Agreeing is not disagreeing.
 *
 *   CASE 8 — an answer the owner has NOT settled (`answerStatus` other than
 *     "answered") is never used as the thing being contradicted. Raising a
 *     conflict against an unresolved answer is noise about a question the owner
 *     is already being asked.
 *
 *   CASE 9 — one rule said three different ways is ONE finding, not three.
 *     Three copies of the same warning is how a warning gets ignored.
 *
 * REAL PIPELINE: the REAL AgentInstructionConflictService, which in turn uses
 * the REAL `detectContradiction` and `topicOverlapScore` that the knowledge
 * merge path and the fact-conflict path already use. No LLM, no network, no
 * key — the check is deterministic string logic on purpose, because it runs on
 * every Save and must cost nothing.
 *
 * Run: `npm run golden:agent-instruction-conflicts`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { checkAgentInstruction, findKnowledgeConflicts, findLockedRuleConflicts } from "@/services/AgentInstructionConflictService";
import type { KnowledgeQuestionAnswer } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

/** A settled knowledge answer, shaped the way the repositories return one. */
function answer(question: string, text: string, status: KnowledgeQuestionAnswer["answerStatus"] = "answered"): KnowledgeQuestionAnswer {
  return {
    id: `kqa_${question.slice(0, 12).replace(/\W+/g, "_")}`,
    workspaceId: "ws_golden_instruction_conflicts",
    domainKey: "product",
    questionKey: question.slice(0, 24).replace(/\W+/g, "_").toLowerCase(),
    question,
    answer: text,
    answerStatus: status,
    sourceType: "user_answer",
    confidenceScore: 0.9,
    usedByAgentsJson: {},
    mapsToJson: {},
    humanReviewRequired: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

test("CASE 1 — 'reply without asking me first' is caught as a locked-rule conflict", async () => {
  const findings = findLockedRuleConflicts("Reply to customers without asking me first.");
  assert.strictEqual(findings.length, 1, `expected exactly 1 finding, got ${findings.length}`);
  assert.strictEqual(findings[0].ruleId, "auto_send_without_approval", `wrong rule matched: ${findings[0].ruleId}`);
  assert.ok(findings[0].quotedInstruction.includes("without asking me first"), "the finding quotes the owner's own words back");
  assert.ok(findings[0].effect.length > 20, "the finding says what will actually happen");
});

test("CASE 2 — messaging opted-out customers is caught", async () => {
  const findings = findLockedRuleConflicts("Message them even if they unsubscribed.");
  assert.strictEqual(findings.length, 1, `expected exactly 1 finding, got ${findings.length}`);
  assert.strictEqual(findings[0].ruleId, "contact_do_not_contact", `wrong rule matched: ${findings[0].ruleId}`);
});

test("CASE 3 — being told to guess a price is caught", async () => {
  const findings = findLockedRuleConflicts("If you don't know the price, just guess.");
  assert.strictEqual(findings.length, 1, `expected exactly 1 finding, got ${findings.length}`);
  assert.strictEqual(findings[0].ruleId, "guess_missing_facts", `wrong rule matched: ${findings[0].ruleId}`);
});

test("CASE 4 — being told never to involve a person is caught", async () => {
  const findings = findLockedRuleConflicts("Never escalate to a human.");
  assert.strictEqual(findings.length, 1, `expected exactly 1 finding, got ${findings.length}`);
  assert.strictEqual(findings[0].ruleId, "skip_human_review", `wrong rule matched: ${findings[0].ruleId}`);
});

test("CASE 5 (the honest half) — an ordinary instruction raises NOTHING", async () => {
  const ordinary = "Keep replies short and polite. Always use the company knowledge base. Mention our GST number when a buyer asks for it.";
  const result = checkAgentInstruction(ordinary, [answer("What is the minimum order quantity?", "Minimum order is 5 kg per shade.")]);
  assert.strictEqual(result.lockedRuleConflicts.length, 0, `false alarm on locked rules: ${JSON.stringify(result.lockedRuleConflicts)}`);
  assert.strictEqual(result.knowledgeConflicts.length, 0, `false alarm on knowledge: ${JSON.stringify(result.knowledgeConflicts)}`);
  assert.strictEqual(result.hasFindings, false, "nothing to show the owner");
});

test("CASE 6 — an instruction that contradicts a saved answer is caught, with both sides", async () => {
  const saved = [answer("What is the minimum order quantity?", "Minimum order is 5 kg per shade.")];
  const findings = findKnowledgeConflicts("Tell customers the minimum order quantity is 10 kg per shade.", saved);
  assert.strictEqual(findings.length, 1, `expected exactly 1 knowledge conflict, got ${findings.length}`);
  assert.ok(findings[0].savedAnswer.includes("5 kg"), `the finding must carry the SAVED answer, got: ${findings[0].savedAnswer}`);
  assert.ok(findings[0].quotedInstruction.includes("10 kg"), `the finding must carry the INSTRUCTION, got: ${findings[0].quotedInstruction}`);
  assert.ok(findings[0].question.includes("minimum order"), "the finding names the question they disagree about");
});

test("CASE 7 — an instruction that AGREES with the saved answer raises nothing", async () => {
  const saved = [answer("What is the minimum order quantity?", "Minimum order is 5 kg per shade.")];
  const findings = findKnowledgeConflicts("Tell customers the minimum order quantity is 5 kg per shade.", saved);
  assert.strictEqual(findings.length, 0, `agreeing is not disagreeing, got: ${JSON.stringify(findings)}`);
});

test("CASE 8 — an answer the owner has not settled is never used as the contradiction", async () => {
  const unsettled = [answer("What is the minimum order quantity?", "Minimum order is 5 kg per shade.", "needs_review")];
  const findings = findKnowledgeConflicts("Tell customers the minimum order quantity is 10 kg per shade.", unsettled);
  assert.strictEqual(findings.length, 0, `an unresolved answer must not raise a conflict, got: ${JSON.stringify(findings)}`);
});

test("CASE 9 — one rule said three ways is ONE finding", async () => {
  const repeated = [
    "Reply to customers without asking me first.",
    "Send the message directly.",
    "No approval is needed for replies.",
  ].join(" ");
  const findings = findLockedRuleConflicts(repeated);
  assert.strictEqual(findings.length, 1, `same rule three ways must be one finding, got ${findings.length}: ${findings.map((f) => f.ruleId).join(", ")}`);
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
  console.log(`agent-instruction-conflicts: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
