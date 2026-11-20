import { getAllKnowledgeQuestions } from "@/knowledge/knowledge-question-framework";
import type { KnowledgeExtractionBatch, KnowledgeExtractionRun, KnowledgeQuestionAnswer } from "@/lib/types";

export type ExtractionQualityLevel = "Excellent" | "Good" | "Needs Review" | "Weak" | "Failed";

export type ExtractionQualitySummary = {
  score: number;
  level: ExtractionQualityLevel;
  message: string;
  nextAction: string;
  highPriorityMissingCount: number;
  criticalMissingDomains: string[];
  averageConfidence: number;
  realLlmBatchCount: number;
  fallbackBatchCount: number;
  failedBatchCount: number;
  averageBatchMs: number;
};

const CRITICAL_DOMAINS = new Set([
  "company_knowledge",
  "factual_company_profile",
  "product_knowledge",
  "product_varieties",
  "lead_qualification",
  "whatsapp_communication",
  "payment_credit_terms",
  "shipping_delivery",
  "returns_replacement",
  "pricing_policy",
]);

export function calculateExtractionQuality(input: {
  run?: KnowledgeExtractionRun | null;
  answers?: KnowledgeQuestionAnswer[];
  batches?: KnowledgeExtractionBatch[];
}): ExtractionQualitySummary {
  const run = input.run;
  const answers = input.answers || [];
  const batches = input.batches || [];
  const totalQuestions = Math.max(run?.totalQuestions || answers.length || 0, 1);
  const answered = run?.answeredCount ?? answers.filter((item) => ["answered", "needs_review"].includes(item.answerStatus)).length;
  const partial = run?.partialCount ?? answers.filter((item) => item.answerStatus === "partial").length;
  const conflicts = run?.conflictCount ?? answers.filter((item) => item.answerStatus === "conflict").length;
  const failedBatchCount = run?.failedBatchCount ?? batches.filter((item) => item.status === "failed").length;
  const fallbackBatchCount = batches.filter((item) => item.status === "fallback").length + (run?.fallbackUsed ? 1 : 0);
  const completedReal = batches.filter((item) => item.status === "completed" && item.modelProvider && item.modelProvider !== "mock").length;
  const confidenceItems = answers.filter((item) => item.answer?.trim() && item.answerStatus !== "unanswered");
  const averageConfidence = confidenceItems.length
    ? confidenceItems.reduce((sum, item) => sum + (item.confidenceScore || 0), 0) / confidenceItems.length
    : 0;
  const highPriorityQuestions = new Map(
    getAllKnowledgeQuestions()
      .filter((question) => question.priority === "high" || question.required || question.humanReviewRequired)
      .map((question) => [`${question.domainKey}:${question.questionKey}`, question])
  );
  const highPriorityMissing = answers.filter((item) =>
    ["unanswered", "partial", "conflict"].includes(item.answerStatus) &&
    highPriorityQuestions.has(`${item.domainKey}:${item.questionKey}`)
  );
  const criticalMissingDomains = Array.from(new Set(
    answers
      .filter((item) => CRITICAL_DOMAINS.has(item.domainKey) && ["unanswered", "conflict"].includes(item.answerStatus))
      .map((item) => item.domainKey.replaceAll("_", " "))
  )).slice(0, 6);
  const completedWithTimes = batches.filter((item) => item.startedAt && item.completedAt);
  const averageBatchMs = completedWithTimes.length
    ? Math.round(completedWithTimes.reduce((sum, item) => sum + (Date.parse(item.completedAt || "") - Date.parse(item.startedAt || "")), 0) / completedWithTimes.length)
    : 0;

  let score = 0;
  score += (answered / totalQuestions) * 50;
  score += (partial / totalQuestions) * 10;
  score += Math.min(30, averageConfidence * 30);
  score += Math.max(0, 10 - failedBatchCount * 2);
  score += completedReal > 0 ? 10 : 0;
  score -= Math.min(20, conflicts * 4);
  score -= Math.min(20, failedBatchCount * 5);
  score -= Math.min(15, fallbackBatchCount * 3);
  score -= Math.min(8, highPriorityMissing.length * 0.15);
  score -= Math.min(6, criticalMissingDomains.length);
  score = Math.max(0, Math.min(100, Math.round(score)));

  let level: ExtractionQualityLevel = "Needs Review";
  if (!run || run.status === "failed" || score < 25) level = "Failed";
  else if (score >= 85 && !conflicts && failedBatchCount === 0 && highPriorityMissing.length < 10) level = "Excellent";
  else if (score >= 70 && conflicts === 0 && failedBatchCount === 0) level = "Good";
  else if (score >= 45) level = "Needs Review";
  else level = "Weak";

  const message = buildQualityMessage(level, highPriorityMissing.length, conflicts, failedBatchCount, fallbackBatchCount);
  const nextAction = buildNextAction(level, conflicts, failedBatchCount, highPriorityMissing.length, fallbackBatchCount);
  return {
    score,
    level,
    message,
    nextAction,
    highPriorityMissingCount: highPriorityMissing.length,
    criticalMissingDomains,
    averageConfidence: Math.round(averageConfidence * 100) / 100,
    realLlmBatchCount: completedReal,
    fallbackBatchCount,
    failedBatchCount,
    averageBatchMs,
  };
}

function buildQualityMessage(level: ExtractionQualityLevel, highPriorityMissing: number, conflicts: number, failedBatches: number, fallbackBatches: number) {
  if (level === "Excellent") return "Strong extraction. Review and approve safe answers before syncing.";
  if (level === "Good") return highPriorityMissing ? `Good extraction. ${highPriorityMissing} high-priority questions still need review.` : "Good extraction. Review and sync knowledge.";
  if (level === "Weak") return "Weak extraction. Too much important knowledge is still missing.";
  if (level === "Failed") return "Extraction did not produce enough reliable knowledge.";
  if (conflicts) return `Needs review because ${conflicts} conflict${conflicts === 1 ? "" : "s"} must be resolved.`;
  if (failedBatches) return `Needs review because ${failedBatches} section${failedBatches === 1 ? "" : "s"} failed.`;
  if (fallbackBatches) return `Needs review because ${fallbackBatches} batch${fallbackBatches === 1 ? "" : "es"} used fallback.`;
  return `Needs review. ${highPriorityMissing} high-priority questions still need answers.`;
}

function buildNextAction(level: ExtractionQualityLevel, conflicts: number, failedBatches: number, highPriorityMissing: number, fallbackBatches: number) {
  if (failedBatches) return "Retry failed sections before final sync.";
  if (conflicts) return "Resolve conflicts before syncing.";
  if (highPriorityMissing > 0) return "Answer high-priority Missing Knowledge questions before syncing.";
  if (fallbackBatches) return "Review fallback-generated answers before syncing.";
  if (level === "Excellent" || level === "Good") return "Review safe answers, approve them, then Sync Knowledge.";
  return "Upload stronger documents or answer Missing Knowledge questions.";
}
