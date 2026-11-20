/**
 * GOLDEN — the setup backlog must open on the questions the AI is blocked on,
 * not on the whole pile.
 *
 * Q-7 (2026-08-24). A fresh workspace generates one UnknownQuestion per
 * unanswered framework question. `groupMissingBusinessDetails` buckets those by
 * inferred topic, which on a new tenant is ~90 cards, and that was the only
 * thing an owner ever saw. Nobody finishes 90 cards on their first day, and a
 * half-finished setup leaves an AI half-knowing the business — worse than one
 * that knows nothing, because it answers anyway.
 *
 * `groupEssentialSetupQuestions` carves the SAME records into a first stage of
 * at most 12 groups, one per core domain, holding only the questions the
 * framework itself marks essential.
 *
 * WHAT THIS GOLDEN HOLDS:
 *   1. the stage is genuinely smaller than the backlog        (CASE A)
 *   2. it is bounded by the 12 core domains, always           (CASE B)
 *   3. every question in it is actually essential             (CASE C)  <- the fix
 *   4. no essential question is dropped on the floor          (CASE D)
 *   5. it carries real ids, so the existing write path works  (CASE E)
 *   6. the two stages partition the backlog, no double-count  (CASE F)
 *   7. answered work leaves the open count                    (CASE G)
 *   8. core-domain order is stable, not bucket order          (CASE H)
 *
 * WHAT IT CANNOT DO. It cannot prove the browser renders the stage — that is
 * scripts/probes/essential-stage-ui.ts, which drives a real Chromium against a
 * production-auth server. And it cannot judge whether the 50 essential
 * questions are the RIGHT 50; that is Q-2 and Q-3, still open.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import test from "node:test";
import { groupEssentialSetupQuestions, groupMissingBusinessDetails, isEssentialSetupQuestion } from "../../src/services/KnowledgeQuestionPresentationService";
import { getAllKnowledgeQuestions, getEssentialKnowledgeQuestions, KNOWLEDGE_CORE_DOMAINS } from "../../src/knowledge/knowledge-question-framework";
import type { UnknownQuestion } from "../../src/lib/types";

/**
 * A fresh tenant: one open backlog record per framework question, exactly the
 * shape `createClarificationQuestions` produces (relatedDomain + relatedQuestionKey).
 */
function freshTenantBacklog(): UnknownQuestion[] {
  return getAllKnowledgeQuestions().map((question, index) => ({
    id: `uq_${index}`,
    workspaceId: "workspace_golden",
    channel: "knowledge",
    questionText: question.question,
    missingTopic: question.domainKey.replaceAll("_", " "),
    status: "open" as const,
    generatedBy: "framework" as const,
    relatedDomain: question.domainKey,
    relatedQuestionKey: question.questionKey,
    priority: question.priority,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  }));
}

const backlog = freshTenantBacklog();
const essentialCount = getEssentialKnowledgeQuestions().length;

/** A count guard. A sweep with no subject passes vacuously. */
test("CASE 0 — there is a backlog and an essential set to divide", () => {
  assert.ok(backlog.length >= 100, `only ${backlog.length} backlog records — every case below sweeps this list`);
  assert.ok(essentialCount >= 20, `only ${essentialCount} essential questions — the stage would be trivially small`);
});

test("CASE A — the start-here stage is smaller than the backlog it replaces", () => {
  const full = groupMissingBusinessDetails(backlog);
  const stage = groupEssentialSetupQuestions(backlog);
  assert.ok(
    stage.groups.length < full.length,
    `the start-here stage has ${stage.groups.length} groups and the full backlog has ${full.length}. ` +
      "If it is not smaller it is not a first stage, and the owner is back to facing everything at once.",
  );
});

test("CASE B — the stage is bounded by the core domains, whatever the tenant size", () => {
  const stage = groupEssentialSetupQuestions(backlog);
  assert.ok(
    stage.groups.length <= KNOWLEDGE_CORE_DOMAINS.length,
    `${stage.groups.length} groups from ${KNOWLEDGE_CORE_DOMAINS.length} core domains. The bound is the whole point: ` +
      "however many questions a business accumulates, the first screen stays the same size.",
  );
  const keys = stage.groups.map((group) => group.groupKey);
  assert.equal(new Set(keys).size, keys.length, "a core domain produced two groups");
});

test("CASE C — every question in the stage is genuinely essential", () => {
  // The fix. If a non-essential question leaks in, the "start here" promise is
  // false and the stage silently grows back into the backlog it replaced.
  const stage = groupEssentialSetupQuestions(backlog);
  const byId = new Map(backlog.map((item) => [item.id, item]));
  const leaked = stage.groups
    .flatMap((group) => group.questionIds)
    .map((id) => byId.get(id)!)
    .filter((item) => !isEssentialSetupQuestion(item))
    .map((item) => `${item.relatedDomain}/${item.relatedQuestionKey}`);
  assert.deepEqual(leaked, [], "a non-essential question is in the start-here stage.");
});

test("CASE D — no essential question is dropped", () => {
  const stage = groupEssentialSetupQuestions(backlog);
  const inStage = new Set(stage.groups.flatMap((group) => group.questionIds));
  const missing = backlog
    .filter(isEssentialSetupQuestion)
    .filter((item) => !inStage.has(item.id))
    .map((item) => `${item.relatedDomain}/${item.relatedQuestionKey}`);
  assert.deepEqual(missing, [], "an essential question is in neither the stage nor anywhere the owner will look. " +
    "A question the AI is blocked on that nobody is ever asked is the worst outcome of the whole change.");
  assert.equal(stage.essentialTotalCount, backlog.filter(isEssentialSetupQuestion).length, "essentialTotalCount disagrees with the records");
});

test("CASE E — the stage carries real ids, so the existing write path works", () => {
  // Deliberately the same MissingBusinessDetailGroup shape and the same
  // questionIds as the full backlog, so answering a start-here card goes
  // through POST /api/unknown-questions/groups/answer unchanged. If these ids
  // were synthetic the screen would render and the save would silently do
  // nothing.
  const stage = groupEssentialSetupQuestions(backlog);
  const known = new Set(backlog.map((item) => item.id));
  for (const group of stage.groups) {
    assert.ok(group.questionIds.length > 0, `${group.groupKey} has no question ids`);
    assert.ok(group.questionIds.every((id) => known.has(id)), `${group.groupKey} carries an id that is not a real backlog record`);
    assert.equal(group.questionsCount, group.questionIds.length, `${group.groupKey} count disagrees with its ids`);
    assert.ok(group.title.trim().length > 0 && group.description.trim().length > 0, `${group.groupKey} has no title or description to show`);
  }
});

test("CASE F — the two stages partition the open backlog", () => {
  const stage = groupEssentialSetupQuestions(backlog);
  const openKnowledge = backlog.filter((item) => item.channel === "knowledge" && item.status === "open").length;
  assert.equal(
    stage.essentialOpenCount + stage.remainingOpenCount,
    openKnowledge,
    "essential + remaining does not add up to the open backlog. The owner would be told a total that does not exist.",
  );
  assert.ok(stage.remainingOpenCount > 0, "nothing is deferred, so the split is doing no work");
});

test("CASE G — answered work leaves the open count", () => {
  const answered = backlog.map((item, index) =>
    isEssentialSetupQuestion(item) && index % 2 === 0 ? { ...item, status: "added_to_knowledge" as const } : item,
  );
  const before = groupEssentialSetupQuestions(backlog);
  const after = groupEssentialSetupQuestions(answered);
  assert.ok(
    after.essentialOpenCount < before.essentialOpenCount,
    `open count did not move: ${before.essentialOpenCount} -> ${after.essentialOpenCount}. A progress number that ` +
      "never moves is the one thing guaranteed to make an owner stop.",
  );
  assert.equal(after.essentialTotalCount, before.essentialTotalCount, "the total moved when only statuses changed");
  const resolved = after.groups.filter((group) => group.status === "resolved" || group.status === "mixed");
  assert.ok(resolved.length > 0, "no group reports progress after half its questions were answered");
});

test("CASE H — the owner meets the areas in core-domain order, not bucket order", () => {
  // Shuffled input must produce the same order out. Otherwise the screen
  // reorders itself between visits and the owner loses their place.
  const shuffled = [...backlog].reverse();
  const straight = groupEssentialSetupQuestions(backlog).groups.map((group) => group.groupKey);
  const reversed = groupEssentialSetupQuestions(shuffled).groups.map((group) => group.groupKey);
  assert.deepEqual(reversed, straight, "the group order depends on the order records arrive in");

  const expected = KNOWLEDGE_CORE_DOMAINS.map((domain) => `essential:${domain.coreDomainKey}`).filter((key) => straight.includes(key));
  assert.deepEqual(straight, expected, "the stage is not in core-domain order");
});
