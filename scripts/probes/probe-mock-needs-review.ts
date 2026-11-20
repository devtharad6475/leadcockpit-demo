/**
 * probe-mock-needs-review.ts — N-AI-6 verification on the REAL extraction
 * pipeline, not on constructed inputs.
 *
 * The golden proves `normalizeLLMQuestionAnswers` in isolation on two fixture
 * questions. This runs the WHOLE thing: the real 523-question framework, real
 * batching, the real mock provider standing in for a budget-exhausted model,
 * and the real persistence path — then reports what an owner would actually
 * find sitting in the review list afterwards.
 *
 * WHY THIS COSTS NOTHING. The provider is `mock`. No DeepSeek call is made.
 *
 * WHY IT IS SAFE. Run under the golden preload, which pins the JSON provider and
 * redirects LEADGEN_DATA_DIR to a per-process temp dir, so the ship database is
 * untouchable. The extraction writes hundreds of answers; it must not write them
 * into the demo store.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/probes/probe-mock-needs-review.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  const { getPersistenceProvider } = await import("@/repositories");
  const { answerDocumentQuestions } = await import("@/services/DocumentQuestionAnsweringService");

  console.log(`persistence provider: ${getPersistenceProvider()}`);
  console.log(`isolated data dir:    ${process.env.LEADGEN_DATA_DIR}\n`);

  // N-SAFETY-1: nothing here is contactable. No phone numbers, and any domain
  // would be RFC 2606 .example.
  const documentText = [
    "Company: Example Trims and Embroidery Supplier",
    "Products: zari thread, embroidery laces, borders, sequins and beads.",
    "Minimums: zari thread 5 kg per shade; laces 90 metres per design.",
    "Payment: advance payment is required for custom job work.",
    "Shipping: ready stock dispatch is usually 3 business days after confirmation.",
  ].join("\n");

  const qa = await answerDocumentQuestions({
    workspaceId: "workspace_demo",
    documentText,
    documentMetadata: { title: "N-AI-6 probe document", sourceType: "manual_text" },
  });

  console.log(`provider used:        ${qa.modelUsed.provider}   fallbackUsed=${qa.modelUsed.fallbackUsed}`);
  console.log(`run status:           ${qa.run.status}`);
  console.log(`questions in run:     ${qa.totalQuestions}`);

  const byStatus = new Map<string, number>();
  for (const item of qa.answers) {
    byStatus.set(item.answerStatus, (byStatus.get(item.answerStatus) || 0) + 1);
  }
  console.log("\nanswer status distribution after a fully-mock extraction:");
  for (const [status, count] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(14)} ${count}`);
  }

  // The question that matters: could any of this be served to a customer?
  const withText = qa.answers.filter((item) => Boolean(item.answer?.trim()));
  const stillAnswered = withText.filter((item) => item.answerStatus === "answered");
  const needsReview = withText.filter((item) => item.answerStatus === "needs_review");

  console.log(`\nanswers carrying text:            ${withText.length}`);
  console.log(`  of those, status "answered":     ${stillAnswered.length}   <- these WOULD be servable once approved`);
  console.log(`  of those, status "needs_review": ${needsReview.length}   <- these are locked out of serving`);

  const overCap = withText.filter((item) => (item.confidenceScore || 0) > 0.45);
  console.log(`answers above the 0.45 mock cap:  ${overCap.length}   (expected 0 on a fully-mock run)`);

  console.log(`\nanswered-count reported to the owner: ${qa.answeredCount}   (counts "answered" + "needs_review", so the run does not look empty)`);

  if (stillAnswered.length > 0) {
    console.error(`\nPROBE FAILED: ${stillAnswered.length} invented answer(s) still carry status "answered" and would become servable on approval.`);
    process.exit(1);
  }
  console.log("\nRESULT: every invented answer produced by this run is marked needs_review. None can be served, even if approved.");
}

main().catch((e) => {
  console.error("PROBE FAILED:", e instanceof Error ? e.message : e);
  process.exit(2);
});
