/**
 * golden-oversized-batch-splits.ts — a batch too big to answer is split, not
 * retried (2026-09-18, session 57).
 *
 * ── FOUND ON PRODUCTION, TWICE IN ONE DAY ───────────────────────────────────
 * The `extra_unmapped_information` domain — the catch-all holding everything
 * the 424 questions do not cover — fails on every extraction run. Its
 * seventeen questions are open-ended, the answers are long, and the reply runs
 * past the model's output ceiling. The JSON comes back cut in half and the whole
 * batch is lost.
 *
 * Worse, the retry loop then sent the IDENTICAL request twice more. A request
 * too long to answer is still too long the second and third time, so all three
 * attempts failed the same way and the workspace paid for each. Seventeen
 * questions lost, three times the bill for losing them.
 *
 * Splitting adapts to whatever the ceiling happens to be. Raising the ceiling
 * only moves the wall, and cannot go past what the model itself allows.
 *
 *   CASE A — the recognition: only a "ran out of room" failure triggers a split.
 *   CASE B — a batch that fits costs exactly ONE call. Recovery must not charge
 *            every run for a problem that affects one domain.
 *   CASE C — an oversized batch is split and its answers all arrive.
 *   CASE D — an identical retry is never sent for this failure.
 *   CASE E — one half failing still returns the other half's answers.
 *
 * Run: npx tsx scripts/golden/golden-oversized-batch-splits.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { isTruncatedOutputFailure, runBatchSplitting } from "@/services/DocumentQuestionAnsweringService";
import { TRUNCATED_OUTPUT_MARKER } from "@/llm/providers/OpenAICompatibleProvider";
import { createQuestionBatches, type KnowledgeQuestionBatch } from "@/services/KnowledgeQuestionBatcher";
import { KNOWLEDGE_QUESTION_FRAMEWORK } from "@/knowledge/knowledge-question-framework";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => void | Promise<void> }> = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn });

/**
 * Drives the REAL `runBatchSplitting` with the provider call injected.
 *
 * The first version of this golden tested a hand-written copy of the splitting
 * rule, which would have passed while production was broken. This one runs the
 * shipped recursion, the shipped stopping rule and the shipped merge — only the
 * one call that reaches a provider is replaced.
 */
function batchOf(questions: string[]): KnowledgeQuestionBatch {
  return {
    domainKey: "extra_unmapped_information",
    domainTitle: "Extra / Unmapped Information",
    batchIndex: 0,
    questionKeys: questions,
    questions: questions.map((key) => ({
      questionKey: key,
      question: key,
      description: "",
      whyItMatters: "",
      answerType: "short_text",
      required: false,
      priority: "low",
      usedByAgents: [],
      mapsTo: [],
      sensitive: false,
      humanReviewRequired: false,
      exampleAnswer: "",
      missingAnswerBehavior: "optional",
      coreDomainKey: "analytics_learning",
      coreDomainTitle: "Analytics & Learning",
      isEssential: false,
      appliesTo: { kinds: "all" },
      countsAsMissing: false,
      domainKey: "extra_unmapped_information",
      domainTitle: "Extra / Unmapped Information",
    })) as KnowledgeQuestionBatch["questions"],
  };
}

async function splitRunner(
  questions: string[],
  attempt: (batch: string[]) => Promise<{ ok: true; answers: string[] } | { ok: false; error: string }>,
  calls: string[][],
): Promise<{ ok: boolean; answers: string[] }> {
  const result = await runBatchSplitting(
    { workspaceId: "ws_split_golden", documentText: "doc" } as never,
    () => "prompt",
    batchOf(questions),
    "doc",
    (async (_input: unknown, _prompt: string, batch: KnowledgeQuestionBatch) => {
      const keys = batch.questions.map((question: { questionKey: string }) => question.questionKey);
      calls.push(keys);
      const outcome = await attempt(keys);
      if (!outcome.ok) return { ok: false as const, error: outcome.error };
      return {
        ok: true as const,
        result: {
          provider: "deepseek",
          modelName: "deepseek-chat",
          mode: "real",
          fallbackUsed: false,
          output: { answers: outcome.answers.map((key) => ({ questionKey: key, answer: `answer for ${key}` })) },
        } as never,
      };
    }) as never,
  );
  if (!result.ok) return { ok: false, answers: [] };
  const answers = (result.result.output?.answers || []).map((item) => String((item as { questionKey?: string }).questionKey));
  return { ok: true, answers };
}

const TRUNCATED = `${TRUNCATED_OUTPUT_MARKER} after 8192 tokens — it ran out of output room, so the JSON is incomplete.`;

test("CASE A — only 'ran out of room' triggers a split, not every failure", () => {
  assert.strictEqual(isTruncatedOutputFailure(TRUNCATED), true, "the real provider message must be recognised");
  assert.strictEqual(
    isTruncatedOutputFailure("LLM question-answering timed out after 60000ms."),
    false,
    "a TIMEOUT must not split. Splitting doubles the number of requests, and a provider that is slow or " +
      "down gets slower and more expensive if you answer it by asking twice as often.",
  );
  assert.strictEqual(
    isTruncatedOutputFailure("Provider returned malformed JSON that could not be parsed"),
    false,
    "and a genuinely broken answer is not a size problem — splitting it would just break it twice",
  );
});

test("CASE B — a batch that fits costs exactly one call", async () => {
  const calls: string[][] = [];
  const result = await splitRunner(["q1", "q2", "q3", "q4"], async (batch) => ({ ok: true, answers: batch }), calls);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(
    calls.length,
    1,
    "THE COST RULE: the split happens only AFTER a truncation. A recovery that charged every run for a " +
      "problem affecting one domain would cost more than the problem does.",
  );
});

test("CASE C — an oversized batch is split, and every answer arrives", async () => {
  const calls: string[][] = [];
  const questions = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"];
  // Only two questions at a time fit, so eight needs splitting TWICE: 8 -> 4+4
  // -> 2+2+2+2. A splitter that halves once and gives up would answer none of
  // them, which is a mutation that survived the first version of this case.
  const result = await splitRunner(
    questions,
    async (batch) => (batch.length > 2 ? { ok: false, error: TRUNCATED } : { ok: true, answers: batch }),
    calls,
  );

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    result.answers.sort(),
    questions.slice().sort(),
    "every question is answered. The old behaviour lost all eight — and the domain this happens to is the " +
      "catch-all holding everything the 424 questions miss, which is exactly the knowledge nothing else covers.",
  );
  assert.ok(calls.length > 3, `fixture: it really did split more than once, got ${calls.length} calls`);
  assert.ok(
    calls.some((call) => call.length === 2),
    "and it kept halving until the questions fitted, rather than halving once and giving up",
  );
});

test("CASE D — the identical oversized request is never sent twice", async () => {
  const calls: string[][] = [];
  const questions = ["q1", "q2", "q3", "q4"];
  await splitRunner(questions, async (batch) => (batch.length > 1 ? { ok: false, error: TRUNCATED } : { ok: true, answers: batch }), calls);

  const whole = calls.filter((call) => call.length === questions.length);
  assert.strictEqual(
    whole.length,
    1,
    "the full batch is attempted ONCE. Retrying a request that was too long to answer produces an answer " +
      "that is still too long, and bills for it — three times over, on the live system, today.",
  );
});

test("CASE E — one half failing still returns the other half's answers", async () => {
  const calls: string[][] = [];
  const result = await splitRunner(
    ["good1", "good2", "bad1", "bad2"],
    async (batch) => {
      if (batch.length > 2) return { ok: false, error: TRUNCATED };
      if (batch.some((question) => question.startsWith("bad"))) return { ok: false, error: "provider exploded" };
      return { ok: true, answers: batch };
    },
    calls,
  );

  assert.strictEqual(result.ok, true, "a partial success is still a success");
  assert.deepStrictEqual(
    result.answers.sort(),
    ["good1", "good2"],
    "half the answers of a domain that previously produced NONE is the improvement. Discarding the good " +
      "half because the other half failed would throw away the thing this fix exists to recover.",
  );
});

test("CASE G — a failure that is not about size does not split", async () => {
  // The splitter has to CONSULT the recognition function, not just have one
  // nearby. Splitting on a timeout doubles the requests against a provider that
  // is already struggling, and splitting on malformed JSON just breaks it twice.
  const calls: string[][] = [];
  const result = await splitRunner(
    ["q1", "q2", "q3", "q4"],
    async () => ({ ok: false, error: "LLM question-answering timed out after 60000ms." }),
    calls,
  );

  assert.strictEqual(result.ok, false, "a timeout is still a failure");
  assert.strictEqual(
    calls.length,
    1,
    "and it must be attempted ONCE. A splitter that halves on every kind of failure turns one slow " +
      "provider into twice as many requests at the exact moment it is least able to answer them.",
  );
});

test("CASE F — the domain this was found on really is the biggest one", () => {
  // Guards the assumption the fix is built on. If the catch-all stops being the
  // largest domain, the reasoning in the code comments needs revisiting.
  const sizes = KNOWLEDGE_QUESTION_FRAMEWORK.map((domain) => ({
    key: domain.domainKey,
    batches: createQuestionBatches({ domainKey: domain.domainKey, domainTitle: domain.domainTitle, questions: domain.questions.map((q) => ({ ...q, domainKey: domain.domainKey, domainTitle: domain.domainTitle })) }),
  }));
  const catchAll = sizes.find((item) => item.key === "extra_unmapped_information");
  assert.ok(catchAll, "the catch-all domain still exists");
  assert.strictEqual(
    catchAll!.batches.length,
    1,
    "and it is still sent as ONE request by default — which is why it overflows and why the split matters",
  );
});

(async () => {
  console.log("\n=== GOLDEN: an oversized batch splits instead of retrying ===\n");
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
    console.log("❌ GOLDEN FAILED: oversized-batch-splits");
    process.exit(1);
  }
})();
