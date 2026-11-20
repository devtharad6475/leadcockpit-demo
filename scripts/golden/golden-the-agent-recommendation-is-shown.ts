/**
 * Golden test — the recommendation the agent was paid to produce reaches the
 * operator.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo with fifty-three real leads waiting on Lead Review.
 * Pressing "Agent recommendation" on a lead ran the whole path:
 * `recommendLeadReviewDecision` loaded the lead, the review settings, the
 * campaign, the ICP and the market maps, computed a deterministic decision,
 * called the model, wrote a `leadReviewDecision` row carrying decision,
 * confidenceScore, reason, matchedSignals, riskSignals and suggestedNextStep,
 * wrote an audit row and emitted `lead.review_recommended`.
 *
 * The screen then showed nothing. The header said "Agent lead recommendation
 * completed" and the card was byte-for-byte what it was before. The POST's
 * response was discarded by the click handler, no route existed to read a
 * saved decision back, and no part of the UI referenced one. The operator paid
 * for a model call, the product stored the answer, and the answer was
 * unreachable from the product.
 *
 * This is the third instance of the same shape found in two sessions — the API
 * key that could be set but not read (session 54), the spend cap that could be
 * read but not set (this session), and now the decision that could be written
 * but not read.
 *
 *   CASE A — a saved decision can be read back. Without this the answer dies
 *     with the page and the operator pays again to see it.
 *
 *   CASE B — the screen renders the decision, not merely the fact that a call
 *     happened. Each of the six fields the service persists is worth money to
 *     produce; a card showing only "approve" throws away the reason.
 *
 *   CASE C — the screen keeps the decision it just received rather than
 *     dropping the response, so the answer appears without a reload.
 *
 *   CASE D — the recommendation is presented as a recommendation. The service
 *     writes `decidedBy: "agent"` and the human still approves or rejects; a
 *     card that reads like a verdict invites the operator to rubber-stamp it,
 *     which is the failure mode that put a comparison paragraph into the
 *     knowledge base earlier in this same session.
 *
 * Substrate: static read of the route and the screen. No repository, no
 * network, no AI.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const ROUTE = "src/app/api/[[...path]]/route.ts";
const SCREEN = "src/app/page.tsx";
const SERVICE = "src/services/LeadReviewDecisionService.ts";

function main() {
  console.log("=== GOLDEN: the agent's recommendation reaches the operator ===\n");

  const route = readSource(ROUTE);
  const screen = readSource(SCREEN);
  const service = readSource(SERVICE);

  // ---------------------------------------------------------------- CASE A
  {
    assert(
      /repos\.leadReviewDecision\.create\(/.test(service),
      `CASE A setup: ${SERVICE} no longer writes a decision`,
    );
    assert(
      /if \(match\(path, \["lead-review-decisions"\]\)\)/.test(route),
      `CASE A: no route reads saved decisions back — the answer dies with the page`,
    );
    assert(
      /repos\.leadReviewDecision\.listByWorkspace\(workspaceId\)/.test(route),
      `CASE A: the read route must return the workspace's saved decisions`,
    );
    console.log("✅ CASE A — a decision that was written can be read back");
  }

  // ---------------------------------------------------------------- CASE B
  {
    // Every field the service persists and pays a model call for.
    for (const field of ["decision", "confidenceScore", "reason", "matchedSignals", "riskSignals", "suggestedNextStep"]) {
      assert(
        new RegExp(`decisions\\[lead\\.id\\]\\.${field}`).test(screen),
        `CASE B: ${SCREEN} never shows ${field}, which the agent produced and the product stored`,
      );
    }
    console.log("✅ CASE B — the card shows all six fields the agent produced");
  }

  // ---------------------------------------------------------------- CASE C
  {
    assert(
      !/run\("Agent lead recommendation", \(\) => api\(`\/api\/leads\/\$\{lead\.id\}\/review-decision`[^)]*\)\)\}/.test(screen),
      `CASE C: ${SCREEN} still discards the POST response`,
    );
    assert(
      /setDecisions\(\(prev\) => \(\{ \.\.\.prev, \[lead\.id\]: saved \}\)\)/.test(screen),
      `CASE C: ${SCREEN} must keep the decision it just received`,
    );
    assert(
      /api<LeadReviewDecision\[\]>\("\/api\/lead-review-decisions"\)/.test(screen),
      `CASE C: ${SCREEN} must load decisions already paid for when it opens`,
    );
    console.log("✅ CASE C — the answer appears at once, and survives a reload");
  }

  // ---------------------------------------------------------------- CASE D
  {
    assert(
      /Agent says approve/.test(screen) && /Agent says reject/.test(screen),
      `CASE D: ${SCREEN} must attribute the decision to the agent, not state it as fact`,
    );
    assert(
      /This is a recommendation\. Approving or rejecting is still yours\./.test(screen),
      `CASE D: ${SCREEN} must say the human decision is still the operator's`,
    );
    assert(
      /decidedBy: "agent"/.test(service),
      `CASE D setup: ${SERVICE} no longer records the agent as the decider`,
    );
    console.log("✅ CASE D — it reads as a recommendation, and the decision stays the operator's");
  }

  console.log("\n=== GOLDEN PASSED (A-D) ===");
}

main();
