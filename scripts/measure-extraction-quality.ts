/**
 * measure-extraction-quality.ts — how many of the 424 knowledge questions does
 * the product actually answer from the same documents, before vs after?
 *
 * Deliberately NOT a test. It spends real money on DeepSeek and reports a
 * number; it is run by hand, on the same input, on two versions of the code.
 *
 *   PERSISTENCE_PROVIDER=prisma npx tsx scripts/measure-extraction-quality.ts <tag>
 *
 * The input is the extracted TEXT of the five Om Jari documents (not the PDFs),
 * so the comparison isolates chunking, retrieval and the prompt — the things
 * that changed — rather than PDF parsing.
 *
 * Writes a JSON result per run to .measure/<tag>.json so two runs can be
 * compared after the code has been switched underneath.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRepositories } from "@/repositories";
import { prisma } from "@/lib/prisma";
import { answerDocumentQuestions, listKnowledgeQuestionAnswers } from "@/services/DocumentQuestionAnsweringService";

const TEXT_DIR = "C:\\Users\\Admin\\Desktop\\LeadCockpit Test Documents\\text-versions";
const OUT_DIR = join(process.cwd(), ".measure");

async function main() {
  const tag = process.argv[2];
  if (!tag) throw new Error("usage: npx tsx scripts/measure-extraction-quality.ts <tag>");
  if (process.env.PERSISTENCE_PROVIDER !== "prisma") throw new Error("run with PERSISTENCE_PROVIDER=prisma");

  const files = readdirSync(TEXT_DIR).filter((name) => name.toLowerCase().endsWith(".md")).sort();
  if (files.length !== 5) throw new Error(`expected the 5 Om Jari documents, found ${files.length}`);
  const documentText = files
    .map((name) => `[Source: File - ${name.replace(/\.md$/, ".pdf")}]\n${readFileSync(join(TEXT_DIR, name), "utf8")}`)
    .join("\n\n");

  const repos = createRepositories();
  const workspaceId = `ws_measure_${tag}_${Date.now()}`;
  await repos.workspace.create({ id: workspaceId, name: `measurement ${tag}` });

  // Identical, generous caps for every run. The first measurement was truncated
  // by the old 500,000-token default — 7 of 25 question groups were refused —
  // and a comparison between two differently-truncated runs measures the cap,
  // not the product. Set explicitly here so the run does not depend on whichever
  // default the checked-out code happens to carry.
  await repos.aiUsageLimit.upsertForWorkspace(workspaceId, {
    dailyTokenLimit: 5_000_000,
    monthlyTokenLimit: 50_000_000,
    dailyCostLimit: 25,
    monthlyCostLimit: 180,
    currentDailyTokens: 0,
    currentMonthlyTokens: 0,
    currentDailyCost: 0,
    currentMonthlyCost: 0,
  });

  const startedAt = Date.now();
  const summary = await answerDocumentQuestions(
    { workspaceId, documentText, documentMetadata: { title: "Om Jari document set", sourceType: "document" } },
    repos,
  );
  const elapsedMs = Date.now() - startedAt;

  const answers = await listKnowledgeQuestionAnswers(workspaceId, repos);
  // Batches refused by a cap are NOT a quality result; the run says so loudly.
  const batches = await prisma.$queryRawUnsafe<Array<{ status: string; domain_key: string; error_message: string | null }>>(
    `SELECT status, domain_key, error_message FROM knowledge_extraction_batches WHERE workspace_id = $1`,
    workspaceId,
  );
  const failedBatches = batches.filter((b) => b.status !== "completed");
  const byStatus: Record<string, number> = {};
  for (const answer of answers) byStatus[answer.answerStatus] = (byStatus[answer.answerStatus] || 0) + 1;

  const answered = answers.filter((a) => a.answerStatus === "answered" && (a.answer || "").trim());
  const confidences = answered.map((a) => Number(a.confidenceScore || 0));
  const meanConfidence = confidences.length ? confidences.reduce((s, n) => s + n, 0) / confidences.length : 0;
  const meanAnswerChars = answered.length ? answered.reduce((s, a) => s + (a.answer || "").length, 0) / answered.length : 0;

  // Per domain, so a gain can be attributed rather than just claimed.
  const perDomain: Record<string, { answered: number; total: number }> = {};
  for (const answer of answers) {
    const row = (perDomain[answer.domainKey] ||= { answered: 0, total: 0 });
    row.total += 1;
    if (answer.answerStatus === "answered" && (answer.answer || "").trim()) row.answered += 1;
  }

  // Spot questions whose wording shares little with the documents — the ones
  // keyword retrieval is expected to miss and whole-document reading to catch.
  const spotKeys = [
    "pricing_policy::moq_policy",
    "pricing_policy::discount_policy",
    "payment_credit_terms::payment_methods",
    "factual_company_profile::deep_01_gst_iec_registration_or_tax_identifiers_safe_t",
    "faqs::deep_10_return_or_replacement_faq",
  ];
  const spot = spotKeys.map((key) => {
    const [domainKey, questionKey] = key.split("::");
    const found = answers.find((a) => a.domainKey === domainKey && a.questionKey === questionKey);
    return { key, status: found?.answerStatus ?? "missing", answer: (found?.answer || "").slice(0, 220) };
  });

  const result = {
    tag,
    workspaceId,
    elapsedMs,
    documentChars: documentText.length,
    totalQuestions: answers.length,
    answered: answered.length,
    batchesTotal: batches.length,
    batchesFailed: failedBatches.length,
    batchFailures: failedBatches.map((b) => `${b.domain_key}: ${(b.error_message || "").slice(0, 80)}`),
    byStatus,
    meanConfidence: Number(meanConfidence.toFixed(3)),
    meanAnswerChars: Math.round(meanAnswerChars),
    summary: {
      answeredCount: (summary as { answeredCount?: number }).answeredCount,
      unansweredCount: (summary as { unansweredCount?: number }).unansweredCount,
      conflictCount: (summary as { conflictCount?: number }).conflictCount,
      qualityScore: (summary as { qualityScore?: number }).qualityScore,
    },
    perDomain,
    spot,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${tag}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, perDomain: undefined, spot: undefined }, null, 2));
  // The result file is the artefact; the workspace is scaffolding. Removing it
  // keeps the dev database clean (golden-unroutable-contacts fails the whole
  // suite on stray workspaces, and it is right to).
  for (const table of [
    "knowledge_extraction_batches",
    "knowledge_extraction_runs",
    "knowledge_question_answers",
    "knowledge_base_chunks",
    "knowledge_base_documents",
    "unknown_questions",
    "agent_runs",
    "ai_usage_limits",
    "audit_logs",
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE workspace_id = $1`, workspaceId).catch(() => 0);
  }
  await prisma.$executeRawUnsafe("DELETE FROM workspaces WHERE id = $1", workspaceId).catch(() => 0);
  console.log(`\nwritten to .measure/${tag}.json (workspace ${workspaceId} removed)`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
