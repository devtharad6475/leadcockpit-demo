/**
 * Golden test — the demo workspace has a knowledge spread worth looking at
 * (N-DEMO-3, 2026-09-04).
 *
 * WHY THIS EXISTS
 * ---------------
 * The Knowledge Base screen showed twenty-six identical cards — "0 of 17
 * answered · 17 still missing · Weak" — above a progress bar reading "0 of 424
 * questions answered". Nothing was broken. The demo workspace genuinely had an
 * empty AI brain, and the screen reported that accurately.
 *
 * The problem was that an accurate screen taught the reader nothing, and it
 * made every AI screen downstream of it look broken rather than unconfigured.
 * Worse, it hid two real defects that only became visible once real data
 * arrived: a section counter dividing answers by sections ("85 of 26"), and a
 * quality badge whose thresholds put all twenty-six domains in one band.
 *
 * So the spread is not decoration. It is the condition under which those
 * screens can be judged at all, and an empty demo is what let two visible bugs
 * sit unnoticed. This test pins the three properties that keep it useful.
 *
 * WHAT THIS DOES NOT DO. It does not check the wording of any answer, or that
 * the facts are true of the demo company — that is editorial, and pinning it
 * would make ordinary copy edits fail a test for no gain. It checks the shape.
 *
 * Run: npx tsx scripts/golden/golden-demo-knowledge-spread.ts
 */
import { KNOWLEDGE_QUESTION_FRAMEWORK } from "../../src/knowledge/knowledge-question-framework";
import { demoKnowledgeAnswers } from "../seed-demo-knowledge";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}

async function main() {
  console.log("\n=== golden:demo-knowledge-spread ===\n");

  const answers = demoKnowledgeAnswers("workspace_demo", new Date().toISOString());

  // ===========================================================================
  // CASE A — every answer names a question the framework actually has.
  //
  // The seeder throws on an unknown key, so this case is a second line rather
  // than the first. It is here because the seeder's check runs only when
  // somebody seeds; this runs in the suite, on every change.
  // ===========================================================================
  const known = new Set<string>();
  for (const domain of KNOWLEDGE_QUESTION_FRAMEWORK) {
    for (const question of domain.questions) known.add(`${domain.domainKey}::${question.questionKey}`);
  }
  const orphans = answers.filter((a) => !known.has(`${a.domainKey}::${a.questionKey}`));
  assert(
    orphans.length === 0,
    `CASE A: ${orphans.length} seeded answer(s) name a question the framework does not have (first: ${orphans[0]?.domainKey}::${orphans[0]?.questionKey}). A stored answer with an unknown key is read by no screen, so the seed would look like it had worked.`,
  );
  pass(`CASE A — all ${answers.length} seeded answers map to real framework questions`);

  // ===========================================================================
  // CASE B — the coverage is UNEVEN.
  //
  // This is the whole point. A demo where every domain is empty says nothing;
  // a demo where every domain is full says nothing either, because the screen
  // exists to show which parts of the business the AI still cannot speak for.
  // The screen needs at least one domain of each kind to be worth reading.
  // ===========================================================================
  const answeredByDomain = new Map<string, number>();
  for (const answer of answers) {
    answeredByDomain.set(answer.domainKey, (answeredByDomain.get(answer.domainKey) || 0) + 1);
  }
  const complete: string[] = [];
  const partial: string[] = [];
  const untouched: string[] = [];
  for (const domain of KNOWLEDGE_QUESTION_FRAMEWORK) {
    // Only the curated questions are ever shown to a person; the rest are
    // generated depth. "Complete" here means every curated question answered.
    const curated = domain.questions.filter((q) => !q.questionKey.startsWith("deep_")).length;
    const got = answeredByDomain.get(domain.domainKey) || 0;
    if (got === 0) untouched.push(domain.domainKey);
    else if (got >= curated) complete.push(domain.domainKey);
    else partial.push(domain.domainKey);
  }
  assert(complete.length >= 3, `CASE B: only ${complete.length} domain(s) are fully answered. With none, the Knowledge Base screen can never show what "done" looks like.`);
  assert(partial.length >= 2, `CASE B: only ${partial.length} domain(s) are partly answered. The half-finished state is the one an operator will actually be in, and it is the one the screen has to render well.`);
  assert(untouched.length >= 3, `CASE B: only ${untouched.length} domain(s) are untouched. If everything is green the screen shows nothing, and the "Not started" band that separates untouched from barely-started can never be seen.`);
  pass(`CASE B — coverage is uneven: ${complete.length} complete, ${partial.length} partial, ${untouched.length} untouched`);

  // ===========================================================================
  // CASE C — the answers a machine must not sign off on are still flagged, and
  // nothing arrives pre-approved.
  //
  // The framework marks money, delivery and legal questions humanReviewRequired.
  // A demo that quietly cleared those flags would be demonstrating a product
  // that does not exist, and would hide the review queue doing its job.
  // ===========================================================================
  const requiresReview = answers.filter((a) => a.humanReviewRequired);
  assert(
    requiresReview.length > 0,
    "CASE C: no seeded answer is marked humanReviewRequired. The demo covers pricing, payment and delivery, which the framework marks as needing a person — if none is flagged, the seed is overriding that flag and the demo shows a machine signing off on money.",
  );
  const preApproved = answers.filter((a) => a.isUserApproved);
  assert(
    preApproved.length === 0,
    `CASE C: ${preApproved.length} seeded answer(s) arrive already approved. Approving is the operator's job and the step the screen exists to demonstrate; pre-approving hides it.`,
  );
  pass(`CASE C — ${requiresReview.length} answers still require a person, and none is pre-approved`);

  // ===========================================================================
  // CASE D — every answer carries evidence pointing at the seeded document.
  //
  // The "safe to approve in one click" list requires evidence. Without it the
  // bulk-approve control has nothing to act on and the screen's main action is
  // dead on the demo — which is how this was found.
  // ===========================================================================
  const noEvidence = answers.filter((a) => !(a.evidenceJson?.sources?.length));
  assert(
    noEvidence.length === 0,
    `CASE D: ${noEvidence.length} seeded answer(s) carry no evidence. The one-click approve list only accepts answers with a source, so those rows can never be approved and the screen's main action does nothing.`,
  );
  pass("CASE D — every seeded answer carries a source it can be checked against");

  console.log(`\n✅ ${passed} passed, 0 failed — ALL GREEN ✅\n`);
}

main().catch((err) => {
  console.error(`\n❌ FAILED after ${passed} passed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
