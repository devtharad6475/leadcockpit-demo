/**
 * golden-answer-reaches-search.ts — N1: a correction the owner makes must reach
 * the copy the AI searches, without anybody remembering a button
 * (2026-09-18, session 57).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * Approving or editing an answer wrote the answer row and stopped there. The
 * text the AI actually searches lives in a separate document, rebuilt by
 * `syncKnowledgeQuestionAnswers`, and the only thing that called it was the
 * "Sync Knowledge" button. So an owner could correct a price, see the new price
 * on the screen, and have the AI go on quoting the old one to customers for as
 * long as nobody pressed Sync.
 *
 * That is worse than a correction being refused. A refusal is visible. This one
 * leaves the owner believing the problem is fixed.
 *
 *   CASE A — approving an answer makes it findable, with NO sync called.
 *   CASE B — the correction: a changed price is what comes back, and the old
 *            price is gone from the index entirely.
 *   CASE C — withdrawing an answer removes it from search too. Adding is not
 *            the only direction a correction travels.
 *   CASE D — a change that cannot affect search does not spend an embedding
 *            call rebuilding an identical document.
 *   CASE E — a failed rebuild must not fail the owner's edit. The answer is
 *            already saved; reporting an error would say otherwise.
 *   CASE F — bulk approval rebuilds ONCE, not once per answer.
 *
 * Run: npx tsx scripts/golden/golden-answer-reaches-search.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import {
  approveKnowledgeQuestionAnswer,
  updateKnowledgeQuestionAnswer,
  approveAllSafeKnowledgeAnswers,
} from "@/services/DocumentQuestionAnsweringService";
import { getRelevantContext } from "@/services/KnowledgeBaseService";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { AppData, KnowledgeQuestionAnswer } from "@/lib/types";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();

let seq = 0;
const freshWorkspace = () => `ws_n1_${Date.now()}_${seq++}`;

const QUESTION = "What is the price of Neem Zari Thread R?";
const OLD_PRICE = "Neem Zari Thread R is Rs 335 per kg, ex-works Surat.";
const NEW_PRICE = "Neem Zari Thread R is Rs 395 per kg, ex-works Surat.";
const SEARCH = "Neem Zari Thread R price per kg";

/**
 * Plants an answer row the way extraction leaves one: answered, but NOT yet
 * approved, so nothing about it is servable until the owner acts. That is the
 * state this whole feature is about.
 */
async function plantAnswer(
  workspaceId: string,
  overrides: Partial<KnowledgeQuestionAnswer> = {},
): Promise<string> {
  const id = `kqa_${workspaceId}_${overrides.questionKey || "price"}`;
  await repos.mutateAll!((data: AppData) => {
    data.knowledgeQuestionAnswers ||= [];
    data.knowledgeQuestionAnswers.push({
      id,
      workspaceId,
      domainKey: "pricing_policy",
      questionKey: "neem_zari_price",
      question: QUESTION,
      answer: OLD_PRICE,
      answerStatus: "answered",
      sourceType: "document_extraction",
      confidenceScore: 0.9,
      humanReviewRequired: false,
      isUserApproved: false,
      isCanonical: true,
      conflictWithExisting: false,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
      ...overrides,
    } as unknown as KnowledgeQuestionAnswer);
    return id;
  });
  return id;
}

/**
 * The repository bundle, with the one write that rebuilds the search copy
 * counted — and optionally broken.
 *
 * Counting is the only honest way to assert "this did NOT rebuild": an
 * assertion about the search result cannot tell a rebuild that was skipped from
 * one that ran and produced the same text.
 */
function watchRebuilds(base: RepositoryBundle, options: { throws?: boolean } = {}) {
  let rebuilds = 0;
  const chunkRepo = base.knowledgeBaseChunk as unknown as Record<string, unknown>;
  const chunkProxy = new Proxy(chunkRepo, {
    get(target, prop) {
      if (prop === "replaceForDocument") {
        return async (...args: unknown[]) => {
          rebuilds++;
          if (options.throws) throw new Error("index write refused");
          return (target.replaceForDocument as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const proxied = new Proxy(base as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "knowledgeBaseChunk") return chunkProxy;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as RepositoryBundle;
  return { repos: proxied, count: () => rebuilds };
}

test("CASE A — approving an answer makes it findable, with no sync pressed", async () => {
  const workspaceId = freshWorkspace();
  const answerId = await plantAnswer(workspaceId);

  const before = await getRelevantContext(workspaceId, SEARCH, repos);
  assert.ok(
    !/335/.test(before.contextText),
    "fixture: an unapproved answer must not be searchable — otherwise this test proves nothing",
  );

  await approveKnowledgeQuestionAnswer(workspaceId, answerId, repos);

  const after = await getRelevantContext(workspaceId, SEARCH, repos);
  assert.match(
    after.contextText,
    /335/,
    "THE POINT: the owner approved it, so the AI can use it. Nothing was synced by hand in between, " +
      "because in real use nothing is — the button gets forgotten and the customer gets the old answer.",
  );
});

test("CASE B — a corrected price replaces the old one, and the old one is gone", async () => {
  const workspaceId = freshWorkspace();
  const answerId = await plantAnswer(workspaceId);
  await approveKnowledgeQuestionAnswer(workspaceId, answerId, repos);

  await updateKnowledgeQuestionAnswer(workspaceId, answerId, { answer: NEW_PRICE }, repos);

  const found = await getRelevantContext(workspaceId, SEARCH, repos);
  assert.match(found.contextText, /395/, "the corrected price must be what the AI can quote");
  assert.ok(
    !/335/.test(found.contextText),
    "AND THE OTHER HALF: the old price must be GONE. A search that returns both leaves the model to " +
      "pick, and a customer can be quoted a rate the owner has already withdrawn.",
  );
});

test("CASE C — withdrawing an answer takes it out of search as well", async () => {
  const workspaceId = freshWorkspace();
  const answerId = await plantAnswer(workspaceId);
  await approveKnowledgeQuestionAnswer(workspaceId, answerId, repos);
  assert.match((await getRelevantContext(workspaceId, SEARCH, repos)).contextText, /335/, "fixture: it is in there first");

  // The owner decides the answer was wrong and has nothing to replace it with.
  await updateKnowledgeQuestionAnswer(
    workspaceId,
    answerId,
    { answerStatus: "unanswered", isUserApproved: false, sourceType: "user_answer", answer: "" },
    repos,
  );

  const after = await getRelevantContext(workspaceId, SEARCH, repos);
  assert.ok(
    !/335/.test(after.contextText),
    "a retraction is a correction too. Rebuilding only when an answer is ADDED leaves withdrawn text " +
      "answering customers, which is the exact failure this feature exists to stop.",
  );
});

test("CASE D — a change that cannot affect search does not pay for a rebuild", async () => {
  const workspaceId = freshWorkspace();
  const stubId = await plantAnswer(workspaceId, {
    questionKey: "unanswered_stub",
    answer: "",
    answerStatus: "unanswered",
    isUserApproved: false,
  });

  const watched = watchRebuilds(repos);
  await updateKnowledgeQuestionAnswer(workspaceId, stubId, { confidenceScore: 0.2 }, watched.repos);

  assert.strictEqual(
    watched.count(),
    0,
    "an empty, unapproved stub is not servable before or after, so rebuilding would write the identical " +
      "document and pay an embedding call for it. Cost is a constraint, not an afterthought.",
  );
});

test("CASE E — a failed rebuild must not fail the owner's edit", async () => {
  const workspaceId = freshWorkspace();
  const answerId = await plantAnswer(workspaceId);

  const broken = watchRebuilds(repos, { throws: true });
  const saved = await approveKnowledgeQuestionAnswer(workspaceId, answerId, broken.repos);

  assert.ok(broken.count() > 0, "fixture: the rebuild really was attempted");
  assert.strictEqual(saved.isUserApproved, true, "the approval itself is committed");
  assert.strictEqual(
    saved.answer,
    OLD_PRICE,
    "THE POINT: the edit was already saved before the rebuild ran. Surfacing the rebuild's failure as an " +
      "error would tell the owner their correction did not save — and the correction is the part that matters.",
  );

  // And it must be recoverable by hand: the Sync button still exists for this.
  const afterManualSync = await getRelevantContext(workspaceId, SEARCH, repos);
  assert.ok(typeof afterManualSync.contextText === "string", "the workspace is still readable, not left broken");
});

test("CASE F — bulk approval rebuilds once, not once per answer", async () => {
  const workspaceId = freshWorkspace();
  // Bulk approval only takes answers that are safe unattended: non-sensitive
  // topic, confident, and carrying the snippet they came from. Anything
  // touching price, payment or delivery is excluded by design and would make
  // this case prove nothing.
  // The keys have to be REAL framework questions: bulk approval walks the
  // framework, so an invented questionKey is simply never seen and the case
  // would pass on an empty batch.
  const bulkFixture = { domainKey: "company_knowledge", sourceSnippet: "from the company profile", confidenceScore: 0.9 };
  await plantAnswer(workspaceId, { ...bulkFixture, id: `kqa_${workspaceId}_a`, questionKey: "business_type", question: "Is the company a manufacturer, trader, distributor, service provider, exporter, or mixed business?", answer: "We manufacture in house." });
  await plantAnswer(workspaceId, { ...bulkFixture, id: `kqa_${workspaceId}_b`, questionKey: "core_strengths", question: "What are the company strongest differentiators or trust points?", answer: "Gold, antique and silver shades are stocked and consistent batch to batch." });
  await plantAnswer(workspaceId, { ...bulkFixture, id: `kqa_${workspaceId}_c`, questionKey: "years_in_business", question: "How long has the company been operating?", answer: "The factory has run in Surat, Gujarat since 1998." });

  const watched = watchRebuilds(repos);
  const result = await approveAllSafeKnowledgeAnswers(workspaceId, watched.repos);

  assert.ok(result.approvedCount >= 3, `fixture: the batch really approved several answers, got ${result.approvedCount}`);
  assert.strictEqual(
    watched.count(),
    1,
    "the rebuild reads EVERY servable answer and writes one document, so doing it per answer repeats the " +
      "same whole-knowledge-base write N times to reach the identical result — with an embedding call each time.",
  );
  assert.match(
    (await getRelevantContext(workspaceId, "which shades do you keep in stock", repos)).contextText,
    /antique/i,
    "and the one rebuild really did index the batch",
  );
});

(async () => {
  console.log("\n=== GOLDEN: a correction reaches the copy the AI searches (N1) ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: answer-reaches-search");
    process.exit(1);
  }
})();
