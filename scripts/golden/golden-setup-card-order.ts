/**
 * GOLDEN — the order a new owner meets the setup cards in.
 *
 * THE BUG (A-12, found 2026-08-25 while explaining a number in a green test).
 * The Q-7 browser proof reported the essential backlog moving 50 -> 49 after
 * answering "the first card". Seven-question cards exist in that stage, so 49
 * was arithmetically impossible for the card the server puts first — unless the
 * screen was showing a different card. It was.
 *
 * QuestionsFromAI.tsx sorted the cards with
 *   (a, b) => a.priority === "high" ? -1 : b.priority === "high" ? 1 : b.questionsCount - a.questionsCount
 * That comparator answers "a first" for (a, b) AND "b first" for (b, a) whenever
 * both cards are high priority. Every start-here card is high priority, so it
 * returned -1 for every pair and the engine handed back the list REVERSED.
 * Measured on a fresh tenant: 132 self-contradicting pairs, and the output
 * changed when the same twelve cards arrived in a different order. The owner
 * opened on "Analytics & Learning" — one question, the least useful thing to ask
 * a business that has told the system nothing yet — with "Brand Identity",
 * "Products & Services" and "Pricing & MOQ" pushed to the end of a 12-card walk.
 *
 * THE FIX. The client sort is gone. The server already orders both lists, and
 * orders them properly: the start-here stage follows the curated
 * KNOWLEDGE_CORE_DOMAINS sequence, the backlog is sorted by priority then size.
 * Filtering preserves order, so the screen walks what the server sent.
 *
 * WHAT THIS GOLDEN HOLDS:
 *   A. the start-here cards come out in the curated onboarding order
 *   B. the owner opens on identity/product, not on a one-question tail card
 *   C. the backlog order really is non-increasing by (priority, size)
 *   D. the screen does not re-sort what the server ordered   <- the regression
 *   E. the ordering does not depend on the order the records arrive in
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { syncMissingKnowledgeQuestions } from "@/services/DocumentQuestionAnsweringService";
import { groupEssentialSetupQuestions, groupMissingBusinessDetails } from "@/services/KnowledgeQuestionPresentationService";
import { KNOWLEDGE_CORE_DOMAINS } from "@/knowledge/knowledge-question-framework";
import { createRepositories } from "@/repositories";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { UnknownQuestion } from "@/lib/types";

const repos = createRepositories();
const workspaceId = "workspace_setup_card_order_golden";

let seededOnce: UnknownQuestion[] | undefined;
async function seed() {
  // A-7 (2026-08-25): declare the tenant instead of assuming it. JSON has no
  // foreign keys so this golden never had to create the workspace it hangs
  // its answers off; Postgres refuses with
  // knowledge_question_answers_workspace_id_fkey.
  await ensureWorkspace(repos, workspaceId);
  seededOnce ||= await syncMissingKnowledgeQuestions(workspaceId, repos);
  return seededOnce;
}

const SCREEN = "src/app/sections/QuestionsFromAI.tsx";

function priorityRank(priority: string) {
  return priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

test("CASE A — the start-here cards arrive in the curated onboarding order", async () => {
  const stage = groupEssentialSetupQuestions(await seed());
  const curated = KNOWLEDGE_CORE_DOMAINS.map((domain) => domain.coreDomainKey);
  const actual = stage.groups.map((group) => group.groupKey.replace(/^essential:/, ""));
  const expected = curated.filter((key) => actual.includes(key));
  assert.deepEqual(
    actual,
    expected,
    "the start-here stage is no longer walking KNOWLEDGE_CORE_DOMAINS in order. That sequence IS the onboarding " +
      "script — identity before analytics — so shuffling it changes what a new owner is asked first.",
  );
});

test("CASE B — the owner opens on a substantial card, not a one-question tail card", async () => {
  const stage = groupEssentialSetupQuestions(await seed());
  const first = stage.groups[0];
  assert.ok(first, "the start-here stage produced no cards at all");
  const biggest = Math.max(...stage.groups.map((group) => group.questionsCount));
  assert.ok(
    first.questionsCount > 1,
    `the first card is "${first.title}" with ${first.questionsCount} question(s) while the stage holds cards of up to ` +
      `${biggest}. A reversed list looks exactly like this.`,
  );
  assert.equal(
    first.groupKey.replace(/^essential:/, ""),
    KNOWLEDGE_CORE_DOMAINS[0].coreDomainKey,
    "the first card is not the first curated core domain",
  );
});

test("CASE C — the backlog really is non-increasing by priority, then by size", async () => {
  const groups = groupMissingBusinessDetails(await seed());
  assert.ok(groups.length >= 2, "not enough backlog cards to have an order at all");
  const wrong = groups
    .slice(1)
    .map((group, index) => ({ before: groups[index], after: group }))
    .filter(({ before, after }) => {
      if (priorityRank(before.priority) !== priorityRank(after.priority)) {
        return priorityRank(before.priority) < priorityRank(after.priority);
      }
      return before.questionsCount < after.questionsCount;
    })
    .map(({ before, after }) => `${before.title} (${before.priority}/${before.questionsCount}) before ${after.title} (${after.priority}/${after.questionsCount})`);
  assert.deepEqual(wrong, [], "the backlog is out of order — a lower-priority or smaller card is listed ahead of a bigger one");
});

test("CASE D — the screen does not re-sort what the server ordered", () => {
  const source = readFileSync(SCREEN, "utf-8");
  const chain = source.slice(source.indexOf("const visibleGroups = progressGroups"));
  const statement = chain.slice(0, chain.indexOf(";"));
  assert.ok(statement.length > 0 && statement.length < 4000, "could not find the visibleGroups statement in the screen source");
  assert.ok(
    !statement.includes(".sort("),
    "visibleGroups sorts again on the client. The server already ordered both lists; a second ordering can only " +
      "disagree with the first, and the one that used to live here reversed the entire start-here stage. " +
      "If a different order is genuinely wanted, change it on the server so one policy serves every caller.",
  );
});

test("CASE E — the order does not depend on the order the records arrive in", async () => {
  const items = await seed();
  const shuffled = [...items].reverse();
  const forward = groupEssentialSetupQuestions(items).groups.map((group) => group.groupKey);
  const backward = groupEssentialSetupQuestions(shuffled).groups.map((group) => group.groupKey);
  assert.deepEqual(
    backward,
    forward,
    "feeding the same records in a different order produced a different card order. That is the signature of a " +
      "comparator that contradicts itself, and it means what the owner sees depends on the engine, not the product.",
  );
});
