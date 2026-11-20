/**
 * GOLDEN — answering a setup card must resolve every question ON that card,
 * including the ones from a different knowledge domain.
 *
 * THE BUG (found 2026-08-25 by scripts/probes/_groupsave.ts, production auth,
 * real Postgres). The first start-here card, "Brand Identity", holds seven
 * questions: four from `company_knowledge` and three from
 * `factual_company_profile`. Answering it reported `answeredQuestions: 7` and
 * HTTP 200 — and three of the seven came straight back as open. The owner had
 * no way to tell; the card just reappeared.
 *
 * WHY. `POST /api/unknown-questions/groups/answer` (route.ts) ALWAYS passes a
 * `fallbackGroup` of `{ domainKey, relatedQuestionKeys }`. `answerUnknownQuestionGroup`
 * treated that as "use the fallback", THREW AWAY the real UnknownQuestion
 * records, and rebuilt them from the two wire fields. A group carries ONE
 * domainKey, so all seven questions were stamped `company_knowledge` — turning
 * `factual_company_profile/legal_company_name` into
 * `company_knowledge/legal_company_name`, which is not a framework key. It
 * matched no answer row, mapped to nothing, and stayed open.
 *
 * THE FIX. Real records carry their own `relatedDomain` PER QUESTION, so they
 * are always the better source. The fallback now fires only when no real record
 * resolved — which is the case it was actually built for (see
 * scripts/smoke-group-answer-concurrency.ts, which posts synthetic ids).
 *
 * WHAT THIS GOLDEN HOLDS:
 *   0. the card under test genuinely spans two domains       (CASE 0 — guard)
 *   1. every question on the card maps to an answer row      (CASE A)  <- the fix
 *   2. every question on the card stops being open           (CASE B)
 *   3. the cross-domain ones land on their OWN domain        (CASE C)
 *   4. the synthetic-id fallback still works                 (CASE D)
 *
 * WHAT IT CANNOT DO. It cannot prove the browser sends the ids — that is
 * scripts/probes/essential-stage-ui.ts against a real Chromium.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import test from "node:test";
import { answerUnknownQuestionGroup } from "@/services/AISettingsService";
import { syncMissingKnowledgeQuestions } from "@/services/DocumentQuestionAnsweringService";
import { groupEssentialSetupQuestions } from "@/services/KnowledgeQuestionPresentationService";
import { createRepositories } from "@/repositories";
import { ensureWorkspace } from "./_helpers/fixtures";
import type { UnknownQuestion } from "@/lib/types";

const repos = createRepositories();
const workspaceId = "workspace_cross_domain_golden";

/** The card the owner actually meets first, built the way the API builds it. */
async function firstStartHereCard() {
  const items = await syncMissingKnowledgeQuestions(workspaceId, repos);
  const stage = groupEssentialSetupQuestions(items);
  return { items, card: stage.groups[0] };
}

function byId(items: UnknownQuestion[]) {
  return new Map(items.map((item) => [item.id, item]));
}

/** Lazily seeded once — this file has no top-level await (tsx transforms to CJS). */
let seededOnce: Awaited<ReturnType<typeof firstStartHereCard>> | undefined;
async function seed() {
  // A-7 (2026-08-25): declare the tenant instead of assuming it. JSON has no
  // foreign keys so this golden never had to create the workspace it hangs
  // its answers off; Postgres refuses with
  // knowledge_question_answers_workspace_id_fkey.
  await ensureWorkspace(repos, workspaceId);
  seededOnce ||= await firstStartHereCard();
  const card = seededOnce.card;
  return { card, cardQuestions: card.questionIds.map((id) => byId(seededOnce!.items).get(id)!) };
}

test("CASE 0 — the card under test really does span more than one domain", async () => {
  const { card, cardQuestions } = await seed();
  // Without this the whole file passes vacuously on a single-domain card and
  // the regression walks straight back in.
  assert.ok(card, "no start-here card was produced at all");
  assert.ok(card.questionIds.length >= 2, `card "${card.title}" has ${card.questionIds.length} question(s)`);
  const domains = new Set(cardQuestions.map((item) => item.relatedDomain));
  assert.ok(
    domains.size >= 2,
    `card "${card.title}" covers only ${[...domains].join(", ")}. This golden exists to catch a cross-domain bug; ` +
      "on a single-domain card every assertion below is trivially true.",
  );
  assert.ok(
    [...domains].some((domain) => domain !== card.domainKey),
    `every question sits on the card's own domainKey (${card.domainKey}), so the stamping bug cannot show up`,
  );
});

test("CASE A — answering the card maps EVERY question, not just the ones sharing its domainKey", async () => {
  const { card } = await seed();
  const result = await answerUnknownQuestionGroup(
    workspaceId,
    card.questionIds,
    "We manufacture industrial valves and sell to plant buyers across three states.",
    true,
    repos,
    // Exactly what route.ts sends. It always sends this.
    { domainKey: card.domainKey, relatedQuestionKeys: card.relatedQuestionKeys },
  );
  assert.equal(result.answeredQuestions, card.questionIds.length, "not every question on the card was marked answered");
  assert.equal(
    result.mappedAnswers,
    card.questionIds.length,
    `${result.mappedAnswers} of ${card.questionIds.length} questions reached an answer row. The ones that did not are ` +
      "the ones whose domain differs from the card's domainKey — they were rewritten onto the wrong domain and matched nothing.",
  );
});

test("CASE B — nothing on the card is still open afterwards", async () => {
  const { card } = await seed();
  const items = await syncMissingKnowledgeQuestions(workspaceId, repos);
  const lookup = byId(items);
  const stillOpen = card.questionIds
    .map((id) => lookup.get(id))
    .filter((item) => item?.status === "open")
    .map((item) => `${item!.relatedDomain}/${item!.relatedQuestionKey}`);
  assert.deepEqual(
    stillOpen,
    [],
    "a question the owner just answered is open again. HTTP 200 and a card that reappears is the worst pairing in the product: " +
      "the owner has no signal that anything went wrong.",
  );
});

test("CASE C — each answer landed on its own domain, not the card's", async () => {
  const { cardQuestions } = await seed();
  const answers = await repos.mutateAll!((data) => (data.knowledgeQuestionAnswers || []).filter((item) => item.workspaceId === workspaceId));
  const answered = new Set(answers.filter((item) => item.answerStatus === "answered").map((item) => `${item.domainKey}/${item.questionKey}`));
  const missing = cardQuestions
    .map((item) => `${item.relatedDomain}/${item.relatedQuestionKey}`)
    .filter((marker) => !answered.has(marker));
  assert.deepEqual(missing, [], "an answer row for a question on the card is not answered — its marker was rewritten");
});

test("CASE D — the synthetic-id fallback still works when no real record exists", async () => {
  // The case the fallback was built for: a caller posts ids that are not in the
  // substrate at all (scripts/smoke-group-answer-concurrency.ts does this). It
  // must keep working, or the fix has traded one bug for another.
  const syntheticIds = ["unknown_synthetic_a", "unknown_synthetic_b"];
  const result = await answerUnknownQuestionGroup(
    workspaceId,
    syntheticIds,
    "Standard payment is 50% advance and 50% before dispatch.",
    true,
    repos,
    { domainKey: "payment_credit_terms", relatedQuestionKeys: ["credit_period", "payment_methods"] },
  );
  assert.equal(result.answeredQuestions, syntheticIds.length, "the fallback stopped generating records for ids that do not exist");
  assert.equal(result.mappedAnswers, syntheticIds.length, "the fallback stopped mapping its generated records to answer rows");
});
