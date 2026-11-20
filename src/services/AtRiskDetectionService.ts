/**
 * 2026-08-08 — At-risk customer detection service.
 *
 * Closes coverage-map row #57 ("AI flags a customer at risk (complaint +
 * silence)") — previously ⚫ DARK. Complaints were already classified
 * individually (reply_classification, row #1/#27) but nothing looked across
 * a lead's messages to notice "this complaint was never followed up on".
 *
 * Same division of labor as the rest of the codebase: a DETERMINISTIC
 * pre-filter (findAtRiskCandidates) decides WHICH leads are actually at risk
 * — a complaint/abusive-message classification with no owner contact since —
 * so the model is never the thing deciding who counts as "at risk". The
 * model (assessLeadRisk) only explains severity and recommends one action
 * for a candidate the code already found.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Lead, Reply } from "@/lib/types";
import { gatherHistoryText } from "./ConversationSummaryService";

const TERMINAL_STATUSES = new Set<Lead["status"]>([
  "do_not_contact", "not_interested", "lost", "closed_lost", "invalid", "duplicate", "won", "closed_won",
]);

/** Classifications from replyClassificationPrompt.ts that signal a negative event worth tracking. */
const RISK_CLASSIFICATIONS = new Set(["complaint", "abusive_message"]);

export type AtRiskCandidate = {
  lead: Lead;
  triggerReply: Reply;
  daysSinceComplaint: number;
};

/**
 * Scan the workspace for leads with an unanswered complaint/negative reply.
 * "Unanswered" = the owner has not contacted the lead (lastContactedAt) since
 * the complaint was received. Bounded by nothing else — this is a cheap
 * in-memory scan, same pattern as LeadReviewBatchService.autoApproveBatch.
 */
export async function findAtRiskCandidates(
  workspaceId: string,
  repos: RepositoryBundle,
): Promise<AtRiskCandidate[]> {
  const [leads, replies] = await Promise.all([
    repos.lead.listLeads(workspaceId),
    repos.reply.listByWorkspace(workspaceId),
  ]);
  const leadsById = new Map(leads.map((l) => [l.id, l]));

  // Most recent risk-classified reply per lead.
  const latestRiskReplyByLead = new Map<string, Reply>();
  for (const reply of replies) {
    // N-DATA-19: a reply with no leadId came from a number matching no lead,
    // so there is no relationship for it to put at risk.
    if (!reply.leadId) continue;
    if (!reply.classification || !RISK_CLASSIFICATIONS.has(reply.classification)) continue;
    const existing = latestRiskReplyByLead.get(reply.leadId);
    if (!existing || reply.createdAt > existing.createdAt) {
      latestRiskReplyByLead.set(reply.leadId, reply);
    }
  }

  const now = Date.now();
  const candidates: AtRiskCandidate[] = [];
  for (const [leadId, triggerReply] of latestRiskReplyByLead) {
    const lead = leadsById.get(leadId);
    if (!lead || lead.doNotContact || TERMINAL_STATUSES.has(lead.status)) continue;
    const contactedSince = Boolean(lead.lastContactedAt && lead.lastContactedAt > triggerReply.createdAt);
    if (contactedSince) continue; // owner already followed up — not at risk anymore
    const daysSinceComplaint = Math.floor((now - new Date(triggerReply.createdAt).getTime()) / (24 * 60 * 60 * 1000));
    candidates.push({ lead, triggerReply, daysSinceComplaint });
  }
  return candidates.sort((a, b) => b.daysSinceComplaint - a.daysSinceComplaint);
}

export type AtRiskAssessment = {
  riskLevel: "low" | "medium" | "high";
  reason: string;
  recommendedAction: string;
  confidenceScore: number;
  mode: "real" | "mock" | "fallback";
  provider?: string;
  modelName?: string;
  daysSinceComplaint: number;
};

function heuristicAssessment(candidate: AtRiskCandidate): AtRiskAssessment {
  const { triggerReply, daysSinceComplaint } = candidate;
  const riskLevel: AtRiskAssessment["riskLevel"] = daysSinceComplaint >= 3 ? "high" : daysSinceComplaint >= 1 ? "medium" : "low";
  return {
    riskLevel,
    reason: `${triggerReply.classification === "abusive_message" ? "A hostile message" : "A complaint"} ("${triggerReply.rawText.slice(0, 120)}") has had no owner follow-up for ${daysSinceComplaint} day${daysSinceComplaint === 1 ? "" : "s"}.`,
    recommendedAction: "Reach out personally to acknowledge the issue before it escalates further.",
    confidenceScore: 0.5,
    mode: "fallback",
    daysSinceComplaint,
  };
}

/**
 * Assess risk severity + recommended action for one candidate the code has
 * already identified via findAtRiskCandidates. Read-only — never contacts
 * the customer.
 */
export async function assessLeadRisk(
  workspaceId: string,
  candidate: AtRiskCandidate,
  repos: RepositoryBundle,
): Promise<AtRiskAssessment> {
  const { text } = await gatherHistoryText(workspaceId, candidate.lead.id, repos);

  try {
    const { LLMService } = await import("@/llm/LLMService");
    const { atRiskAssessmentPrompt } = await import("@/llm/prompts/atRiskAssessmentPrompt");
    const llm = new LLMService();
    const result = await llm.runTask<{ riskLevel?: string; reason?: string; recommendedAction?: string; confidenceScore?: number }>(
      "message_generation",
      { leadId: candidate.lead.id, complaintText: candidate.triggerReply.rawText, daysSinceComplaint: candidate.daysSinceComplaint, history: text },
      {
        workspaceId,
        overridePrompt: `${atRiskAssessmentPrompt}\n\nComplaint/negative message: "${candidate.triggerReply.rawText}"\nDays unanswered: ${candidate.daysSinceComplaint}\nFull conversation history:\n${text}\n\nAssess the risk now:`,
      },
    );
    if (result.mode === "real" && !result.fallbackUsed && result.output?.riskLevel && result.output?.reason) {
      const riskLevel = result.output.riskLevel;
      if (riskLevel === "low" || riskLevel === "medium" || riskLevel === "high") {
        return {
          riskLevel,
          reason: result.output.reason,
          recommendedAction: result.output.recommendedAction || "Reach out personally to address this.",
          confidenceScore: typeof result.output.confidenceScore === "number" ? result.output.confidenceScore : 0.7,
          mode: "real",
          provider: result.provider,
          modelName: result.modelName,
          daysSinceComplaint: candidate.daysSinceComplaint,
        };
      }
    }
    return { ...heuristicAssessment(candidate), mode: "mock", provider: result.provider, modelName: result.modelName };
  } catch {
    return heuristicAssessment(candidate);
  }
}
