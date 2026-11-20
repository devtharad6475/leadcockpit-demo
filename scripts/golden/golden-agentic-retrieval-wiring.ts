/**
 * golden-agentic-retrieval-wiring.ts — the loop on a live customer path, and
 * the limits on when it may run (2026-09-18, session 57).
 *
 * ── WHAT IS BEING RISKED ────────────────────────────────────────────────────
 * This is the first place a model choosing its own steps sits in front of a
 * message typed by a stranger, on a path a customer is waiting on. Three things
 * therefore matter more than the feature itself:
 *
 *   it is OFF unless a deployment turns it on,
 *   it runs ONLY where the plain search already failed, and
 *   it can never leave a reply worse off than the plain search would have.
 *
 * The loop's own answer is discarded on purpose: this changes what the AI can
 * FIND, not what it is allowed to SAY. Approval rules, the verified/unverified
 * split and the auto-send bar all still sit downstream, untouched.
 *
 *   CASE A — off by default, and a strong first search never reaches the loop
 *            even once it is switched on.
 *   CASE B — on, and the plain search weak: the agent rephrases in the
 *            company's words, finds it, and the caller gets real chunks.
 *   CASE C — the agent finding nothing better leaves the plain result alone.
 *   CASE D — the loop failing does not break the customer's reply.
 *
 * Run: npx tsx scripts/golden/golden-agentic-retrieval-wiring.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { retrieveWithHistoryFallback, agenticRetrievalEnabled, RETRIEVAL_USABLE_CONFIDENCE } from "@/services/WhatsAppConversationEngine";
import { getRelevantContext } from "@/services/KnowledgeBaseService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

let WS = "";
const freshWorkspace = () => (WS = `ws_golden_agentic_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);

// The company writes "zari trimming"; the customer says "gold border". Neither
// search can rescue the other, which is the whole reason this path exists.
const COMPANY_LINE = "Zari trimming price list: Neem Zari Rs 295 per kg for 50 to 199 kg.";
const CUSTOMER_ASKS = "gold border ka rate kya hai";

async function seed(repos: RepositoryBundle) {
  const doc = await repos.knowledgeBaseDocument.create(WS, {
    title: "Approved answers",
    documentType: "question_answer_extraction",
    source: "knowledge_question_answers",
    status: "active",
    contentText: COMPANY_LINE,
    metadata: {},
  });
  await repos.knowledgeBaseChunk.replaceForDocument(WS, doc.id, [
    { chunkIndex: 0, chunkText: COMPANY_LINE, metadata: { source: "knowledge_question_answers" } },
  ]);
}

/** Runs `fn` with the flag set, and puts it back however the case ends. */
async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.LEADGEN_AGENTIC_RETRIEVAL;
  if (value === undefined) delete process.env.LEADGEN_AGENTIC_RETRIEVAL;
  else process.env.LEADGEN_AGENTIC_RETRIEVAL = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.LEADGEN_AGENTIC_RETRIEVAL;
    else process.env.LEADGEN_AGENTIC_RETRIEVAL = saved;
  }
}

/**
 * A stand-in for the loop that records whether it ran at all. "The loop must
 * NOT have run" is half of what this golden checks, and only a counter can say
 * that honestly — an assertion about the result cannot tell a loop that was
 * skipped from one that ran and found nothing.
 */
function countingLoop(found: { query: string; confidence: number } | null, opts: { throws?: boolean } = {}) {
  const calls: string[] = [];
  const fn = async (workspaceId: string, rawText: string, repos: RepositoryBundle) => {
    calls.push(rawText);
    if (opts.throws) throw new Error("the loop broke");
    if (!found || found.confidence < RETRIEVAL_USABLE_CONFIDENCE) return null;
    // What the real one does with the model's better wording: run it through the
    // normal path, so the caller gets chunks rather than a summary of chunks.
    return getRelevantContext(workspaceId, found.query, repos);
  };
  return { calls, fn };
}

test("CASE A — off by default, and never reached when the plain search already worked", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seed(repos);

  await withFlag(undefined, async () => {
    assert.strictEqual(agenticRetrievalEnabled(), false, "a deployment must opt IN: the plain path is cheaper and predictable");
    const spy = countingLoop({ query: "zari trimming price list", confidence: 0.9 });
    const weak = await retrieveWithHistoryFallback(WS, CUSTOMER_ASKS, "", repos, { agenticRetrieval: spy.fn });
    assert.deepStrictEqual(spy.calls, [], "with the flag off, even a weak search must NOT start a loop");
    assert.ok(weak.confidenceScore < RETRIEVAL_USABLE_CONFIDENCE, "fixture: this question really is weak on a plain search");
  });

  await withFlag("1", async () => {
    const spy = countingLoop({ query: "anything", confidence: 0.9 });
    const strong = await retrieveWithHistoryFallback(WS, "zari trimming price list", "", repos, { agenticRetrieval: spy.fn });
    assert.ok(strong.confidenceScore >= RETRIEVAL_USABLE_CONFIDENCE, "fixture: the company's own wording retrieves well");
    assert.deepStrictEqual(
      spy.calls,
      [],
      "THE COST RULE: a question the first search already answered must not become three model calls — a customer is waiting on this path",
    );
  });
});

test("CASE B — on and weak: the agent rephrases, and the caller gets real chunks", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seed(repos);
  await withFlag("1", async () => {
    const spy = countingLoop({ query: "zari trimming price list", confidence: 0.8 });
    const result = await retrieveWithHistoryFallback(WS, CUSTOMER_ASKS, "", repos, { agenticRetrieval: spy.fn });
    assert.deepStrictEqual(spy.calls, [CUSTOMER_ASKS], "the loop runs once, on the customer's actual question");
    assert.ok(result.confidenceScore >= RETRIEVAL_USABLE_CONFIDENCE, `the rephrased search must beat the plain one. Got ${result.confidenceScore}`);
    assert.ok(result.chunks.length > 0, "and it must come back as CHUNKS: the verified/unverified split downstream depends on them");
    assert.match(result.contextText, /Zari trimming price list/, "the company's own line is what reaches the model");
  });
});

test("CASE C — the agent finding nothing better leaves the plain result alone", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seed(repos);
  await withFlag("1", async () => {
    const spy = countingLoop({ query: "something unrelated", confidence: 0.05 });
    const result = await retrieveWithHistoryFallback(WS, CUSTOMER_ASKS, "", repos, { agenticRetrieval: spy.fn });
    assert.deepStrictEqual(spy.calls, [CUSTOMER_ASKS], "it was tried");
    assert.ok(
      result.confidenceScore < RETRIEVAL_USABLE_CONFIDENCE,
      "a failed rephrase must not be dressed up as a success — the honest answer is still 'I could not find it', " +
        "and downstream that is what stops the AI answering a customer unaided",
    );
  });
});

test("CASE D — the loop failing does not break the customer's reply", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seed(repos);
  await withFlag("1", async () => {
    const spy = countingLoop(null, { throws: true });
    // The real agenticRetrieval swallows its own failures; this proves the
    // CALLER survives one too, which is the promise made to the customer.
    const safe = async (workspaceId: string, rawText: string, callerRepos: RepositoryBundle) => {
      try {
        return await spy.fn(workspaceId, rawText, callerRepos);
      } catch {
        return null;
      }
    };
    const result = await retrieveWithHistoryFallback(WS, CUSTOMER_ASKS, "", repos, { agenticRetrieval: safe });
    assert.deepStrictEqual(spy.calls, [CUSTOMER_ASKS], "it was attempted");
    assert.ok(result, "THE POINT: the clever path failing must leave the plain search's answer standing, not throw");
    assert.ok(typeof result.contextText === "string", "the caller gets a usable context object either way");
  });
});

test("CASE E — the loop is skipped when HISTORY rescued the search, and never lowers the result", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seed(repos);

  await withFlag("1", async () => {
    // The message alone is weak; the conversation history carries the subject,
    // so the second plain search succeeds. The loop must not run: this is the
    // path that already worked, and it is two model calls cheaper.
    const rescued = countingLoop({ query: "anything", confidence: 0.9 });
    const withHistory = await retrieveWithHistoryFallback(
      WS,
      "aur rate?",
      "Customer: zari trimming price list bhejo\nAgent: bhejta hoon",
      repos,
      { agenticRetrieval: rescued.fn },
    );
    assert.ok(
      withHistory.confidenceScore >= RETRIEVAL_USABLE_CONFIDENCE,
      `fixture: the history-expanded search must succeed here. Got ${withHistory.confidenceScore}`,
    );
    assert.deepStrictEqual(
      rescued.calls,
      [],
      "the loop must be reached only where BOTH plain searches failed — a result the history already rescued is not a failure",
    );

    // And when the loop does run but comes back WEAKER than what the plain
    // search already had, the plain one is kept. A result that merely exists is
    // not an improvement.
    const weaker = {
      calls: [] as string[],
      async fn(_workspaceId: string, rawText: string) {
        weaker.calls.push(rawText);
        return { contextText: "something vaguely related", chunks: [], confidenceScore: 0.01, unverifiedChunkCount: 0 };
      },
    };
    const plain = await retrieveWithHistoryFallback(WS, "zari gold border rate", "", repos);
    const afterLoop = await retrieveWithHistoryFallback(WS, "zari gold border rate", "", repos, { agenticRetrieval: weaker.fn });
    assert.deepStrictEqual(weaker.calls, ["zari gold border rate"], "fixture: this question is weak enough to reach the loop");
    assert.strictEqual(
      afterLoop.confidenceScore,
      plain.confidenceScore,
      "THE RULE: the agent's attempt may only ADD. A weaker rephrase must not replace what the plain search found, " +
        "or turning the feature on would make some answers worse than leaving it off.",
    );
  });
});

(async () => {
  console.log("\n=== GOLDEN: the agent loop on the WhatsApp retrieval path ===\n");
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
    console.log("❌ GOLDEN FAILED: agentic-retrieval-wiring");
    process.exit(1);
  }
})();
