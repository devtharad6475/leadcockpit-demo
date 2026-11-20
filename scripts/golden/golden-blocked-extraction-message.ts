/**
 * golden-blocked-extraction-message.ts — N-AI-5 pin (2026-08-18, CEO-loop
 * session 4).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * When the AI budget cap blocked an extraction, the product told the operator
 * this, verbatim:
 *
 *   "Extraction did not produce usable LLM answers. Knowledge Base was not
 *    changed. Configure and test a real Daily Workhorse model before running
 *    company knowledge extraction."
 *
 * The Daily Workhorse model was configured, real, and had answered a call 90
 * seconds earlier. The true reason — "Usage limit would be exceeded: daily
 * tokens (63105 > 50000)" — was built correctly by AIUsageService, carried
 * correctly through the batch warnings, aggregated correctly by
 * summarizeWarnings into `modelUsed.warning`, and then thrown away.
 *
 * This is a wrong-diagnosis bug, not a cosmetic one: it sends the operator to
 * re-check an API key that was never broken, while the actual cause (a budget
 * they can raise in one field) goes unmentioned. N-AI-4 had just made that
 * exact situation reachable on a fresh install.
 *
 * HAND-COMPUTED CONTRACT (written BEFORE running the implementation):
 *
 *   CASE A — a budget block on a working model must name the budget, and must
 *   NOT tell the operator to go and configure a model. This is the defect.
 *
 *   CASE B — a genuine mock run must still carry the configuration advice. A
 *   "fix" that simply deleted the advice would pass CASE A and fail here.
 *
 *   CASE C — with no reason available, the message must be byte-for-byte what
 *   it always was. Anything else is an unrequested change to behaviour that is
 *   already correct.
 *
 *   CASE D — a whitespace-only warning is not a reason. It must not produce an
 *   empty "Reason:" clause.
 *
 *   CASE E — the product requirement, stated directly: the budget message and
 *   the misconfiguration message must be tellable apart by an operator who
 *   reads only the message.
 *
 *   CASE F — no cause is ever invented. Every word after "Reason:" must appear
 *   in the warning that was passed in.
 *
 *   CASE G — an actual mock extraction with no usable facts requests owner
 *   action (400), retains its failed run and leaves existing knowledge intact.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import "./_helpers/no-platform-ai-keys";
import assert from "node:assert";
import { answerDocumentQuestions, buildBlockedExtractionMessage } from "@/services/DocumentQuestionAnsweringService";
import { NeedsActionError } from "@/lib/user-errors";
import { createJsonRepos } from "./_helpers/provider";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

/** The exact string AIUsageService builds, as measured in S3-17. */
const BUDGET_WARNING = "Usage limit would be exceeded: daily tokens (63105 > 50000). (20 batches)";
/** The exact string answerQuestionsWithLLM builds for a mock/fallback batch. */
const MOCK_WARNING = "Demo/mock extraction used mock; answers are usable for preview and review, but retry with a real model before production use.";
/** The message as it shipped before this fix — CASE C must reproduce it exactly. */
const LEGACY_MESSAGE = "Extraction did not produce usable LLM answers. Knowledge Base was not changed. Configure and test a real Daily Workhorse model before running company knowledge extraction.";

const ADVICE = "Configure and test a real Daily Workhorse model";

async function main() {
  console.log("golden-blocked-extraction-message — N-AI-5 (a blocked budget must not be reported as a broken model)\n");

  // --- CASE A: the measured defect -----------------------------------------
  check("CASE A — a budget block names the budget and does not blame the model config", () => {
    // provider is "llm", not "mock": failedBatchResult() reports the configured
    // provider and sets fallbackUsed:true, which is what trips the guard. The
    // model here is real and working.
    const message = buildBlockedExtractionMessage("llm", BUDGET_WARNING);

    assert.ok(message.includes("63105 > 50000"), `must quote the numbers the operator can act on, got "${message}"`);
    assert.ok(message.includes("Usage limit would be exceeded"), `must name the blocker, got "${message}"`);
    assert.ok(message.includes("Knowledge Base was not changed"), "must still say the knowledge base is untouched");
    assert.ok(
      !message.includes(ADVICE),
      `must NOT send the operator to re-check a model that is working — this is the whole defect. Got "${message}"`,
    );
  });

  // --- CASE B: the advice is still right when it IS right -------------------
  check("CASE B — a genuine mock run still carries the configuration advice", () => {
    const message = buildBlockedExtractionMessage("mock", MOCK_WARNING);
    assert.ok(message.includes(ADVICE), `a mock run is exactly when this advice applies, got "${message}"`);
    assert.ok(message.includes("retry with a real model"), `the batch's own warning must survive, got "${message}"`);
  });

  // --- CASE C: unchanged where it was already correct -----------------------
  check("CASE C — with no reason available, the message is byte-for-byte the original", () => {
    assert.strictEqual(buildBlockedExtractionMessage("mock", undefined), LEGACY_MESSAGE);
    assert.strictEqual(buildBlockedExtractionMessage("llm", undefined), LEGACY_MESSAGE);
  });

  // --- CASE D: no empty Reason clause --------------------------------------
  check("CASE D — a whitespace-only warning is not a reason", () => {
    const message = buildBlockedExtractionMessage("llm", "   \n  ");
    assert.ok(!message.includes("Reason:"), `an empty reason is worse than none, got "${message}"`);
    assert.strictEqual(message, LEGACY_MESSAGE, "must fall back to the original message");
  });

  // --- CASE E: the product requirement, stated directly ---------------------
  check("CASE E — an operator can tell a budget block from a misconfiguration by the message alone", () => {
    const budget = buildBlockedExtractionMessage("llm", BUDGET_WARNING);
    const misconfigured = buildBlockedExtractionMessage("mock", undefined);
    assert.notStrictEqual(budget, misconfigured, "the two situations must not read identically — that was the bug");
    assert.ok(budget.includes("Usage limit") && !budget.includes(ADVICE), "budget message points at the budget");
    assert.ok(misconfigured.includes(ADVICE) && !misconfigured.includes("Usage limit"), "misconfiguration message points at the model");
  });

  // --- CASE F: never invent a cause ----------------------------------------
  check("CASE F — every word after \"Reason:\" comes from the warning that was passed in", () => {
    const warning = "Provider returned HTTP 429 (rate limited).";
    const message = buildBlockedExtractionMessage("deepseek", warning);
    const after = message.slice(message.indexOf("Reason:") + "Reason:".length).trim();
    assert.ok(after.startsWith(warning), `the reason must be the warning verbatim, got "${after}"`);
    assert.ok(!message.includes("daily tokens"), "nothing may be inferred that the caller did not report");
  });

  // Exercise the actual mock extraction pipeline and persisted run, rather
  // than merely asserting the wording of the helper above. No paid keys are
  // available and the repository is redirected to disposable JSON storage.
  try {
    const repos = createJsonRepos();
    const workspaceId = `blocked_extraction_${Date.now()}`;
    const sourceId = `empty_source_${Date.now()}`;
    const before = await repos.readAll!();
    const approvedData = (data: typeof before) => JSON.stringify({
      answers: data.knowledgeQuestionAnswers,
      documents: data.knowledgeBaseDocuments,
      chunks: data.knowledgeBaseChunks,
    });
    const original = approvedData(before);
    await assert.rejects(() => answerDocumentQuestions({
      workspaceId, documentId: sourceId,
      documentText: "Unrelated decorative abstract illustration.",
      documentMetadata: { title: "No business facts", sourceType: "document" },
    }, repos), (error: unknown) => {
      assert.ok(error instanceof NeedsActionError, "a configuration refusal must be an owner-action error");
      assert.strictEqual(error.statusCode, 400, "this refusal must not become HTTP 500");
      assert.match(error.message, /Configure and test a real Daily Workhorse model/);
      assert.match(error.message, /Knowledge Base was not changed/);
      return true;
    });
    const after = await repos.readAll!();
    const run = after.knowledgeExtractionRuns?.find(item => item.workspaceId === workspaceId && item.sourceId === sourceId);
    assert.ok(run, "the refused extraction must leave a traceable run");
    assert.strictEqual(run.status, "failed");
    assert.strictEqual(run.answeredCount, 0);
    assert.strictEqual(run.modelProvider, "mock");
    assert.match(run.errorMessage || "", /Configure and test a real Daily Workhorse model/);
    assert.ok(run.completedAt, "the failed run must have finished, rather than remain running");
    assert.strictEqual(approvedData(after), original, "a blocked mock run must neither invent nor replace knowledge");
    passed++;
    console.log("  PASS  CASE G — blocked mock extraction requests owner action (400), persists failed run and leaves knowledge untouched");
  } catch (error) {
    failed++;
    console.error(`  FAIL  CASE G: ${(error as Error).message}`);
  }
  console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
  if (failed) {
    console.error("\nFAIL golden-blocked-extraction-message");
    process.exit(1);
  }
  console.log("PASS golden-blocked-extraction-message: blocked extraction reports its cause and owner-action status without changing knowledge.");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
