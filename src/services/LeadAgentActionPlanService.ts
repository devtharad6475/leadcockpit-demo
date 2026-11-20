import { buildAgentWorkspaceContextSummary } from "@/services/AgentContextBuilder";
import { AuditLogService } from "@/services/AuditLogService";
import { LLMService } from "@/llm/LLMService";
import type { LLMTaskResult } from "@/llm/types";
import type { Campaign, ICP, Lead, LeadReviewSettings } from "@/lib/types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { getLeadReviewSettings } from "@/services/LeadReviewDecisionService";
import { isContactBlocked } from "@/lib/dnc-registry";

type AgentPlanOutput = {
  recommendation?: string;
  confidenceScore?: number;
  reasons?: string[];
  nextSteps?: string[];
  draftMessage?: string;
  missingInformation?: string[];
  humanReviewRequired?: boolean;
};

export type LeadAgentActionPlan = {
  leadId: string;
  leadName: string;
  recommendation: string;
  confidenceScore: number;
  reasons: string[];
  nextSteps: string[];
  draftMessage: string;
  missingInformation: string[];
  humanReviewRequired: boolean;
  safetyNote: string;
  contextStatus: Awaited<ReturnType<typeof buildAgentWorkspaceContextSummary>>;
  modelStatus: {
    agentName: string;
    provider: string;
    modelName: string;
    slotId?: string;
    mode: "real" | "mock" | "fallback";
    fallbackUsed: boolean;
    routeSource?: string;
    runId?: string;
    warning?: string;
  };
};

export async function createLeadAgentActionPlan(workspaceId: string, leadId: string, repos: RepositoryBundle = createRepositories(), actorUserId: string = "system"): Promise<LeadAgentActionPlan> {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new Error("Lead not found");
  const contact = await isContactBlocked(workspaceId, lead, repos);

  const [settings, campaign, icp, contextStatus] = await Promise.all([
    getLeadReviewSettings(workspaceId, repos),
    lead.campaignId ? repos.campaign.getById(workspaceId, lead.campaignId) : Promise.resolve(undefined),
    lead.icpId ? repos.icp.getById(workspaceId, lead.icpId) : Promise.resolve(undefined),
    buildAgentWorkspaceContextSummary(workspaceId, repos),
  ]);

  const deterministic = deterministicPlan(lead, settings, campaign, icp, contextStatus);
  const llmResult = await runLeadPlanTask(workspaceId, { lead, settings, campaign, icp, contextStatus, deterministic }, repos);
  const output = normalizeOutput(llmResult?.output, deterministic, lead);
  const blocked = contact.blocked || lead.reviewStatus === "rejected" || ["rejected", "invalid", "duplicate", "not_interested"].includes(lead.status);

  const plan: LeadAgentActionPlan = {
    leadId: lead.id,
    leadName: lead.companyName || "Unnamed prospect",
    recommendation: blocked ? "Do not contact this lead." : output.recommendation,
    confidenceScore: output.confidenceScore,
    reasons: output.reasons,
    nextSteps: blocked ? ["Keep this lead out of outreach.", "Review only if the do-not-contact or rejected status was set incorrectly."] : output.nextSteps,
    draftMessage: blocked ? "" : output.draftMessage,
    missingInformation: output.missingInformation,
    humanReviewRequired: true,
    safetyNote: "Draft only. A human must review before outreach; this action never sends a message or approves the lead automatically.",
    contextStatus,
    modelStatus: {
      agentName: llmResult?.agentName || "lead_review",
      provider: llmResult?.provider || "deterministic",
      modelName: llmResult?.modelName || "rule-based",
      slotId: llmResult?.slotId,
      mode: llmResult?.mode || "mock",
      fallbackUsed: Boolean(llmResult?.fallbackUsed),
      routeSource: llmResult?.routeSource,
      runId: llmResult?.runId,
      warning: llmResult?.warning,
    },
  };

  // A-7 / N-DATA-17 (2026-08-25): pass the bundle this function was GIVEN.
  // Building a fresh one here meant the audit row was written through a
  // different repository than every other write in this function — outside
  // the caller's transaction in production, and against the real database
  // instead of the injected double in tests. On JSON both pointed at the
  // same file so it was invisible; on Postgres it fails with
  // audit_logs_workspace_id_fkey.
  await new AuditLogService(repos).logAuditEvent({
    workspaceId,
    userId: actorUserId,
    action: "lead.agent_action_plan_created",
    entityType: "lead",
    entityId: lead.id,
    newValuesJson: {
      recommendation: plan.recommendation,
      modelStatus: plan.modelStatus,
      humanReviewRequired: plan.humanReviewRequired,
    },
  });

  return plan;
}

async function runLeadPlanTask(workspaceId: string, input: {
  lead: Lead;
  settings: LeadReviewSettings;
  campaign?: Campaign;
  icp?: ICP;
  contextStatus: LeadAgentActionPlan["contextStatus"];
  deterministic: AgentPlanOutput;
}, repos: RepositoryBundle): Promise<LLMTaskResult<AgentPlanOutput> | undefined> {
  try {
    return await new LLMService(undefined, repos).runTask<AgentPlanOutput>("lead_review_decision", {
      lead: summarizeLead(input.lead),
      campaign: input.campaign ? { name: input.campaign.name, goal: input.campaign.goal, productFocus: input.campaign.productFocus } : undefined,
      icp: input.icp ? { name: input.icp.name, buyerType: input.icp.buyerType, qualificationRules: input.icp.qualificationRules } : undefined,
      reviewSettings: {
        mode: input.settings.mode,
        allowAutoSend: false,
        allowAutoOutreachPreparation: input.settings.allowAutoOutreachPreparation,
      },
      syncedContext: {
        answers: input.contextStatus.answerCount,
        chunks: input.contextStatus.chunkCount,
        readyAreas: readyAreaLabels(input.contextStatus),
        conflictsPending: input.contextStatus.conflictsPending,
        previews: input.contextStatus.preview,
      },
      deterministicDraft: input.deterministic,
      instructions: "Return JSON with recommendation, confidenceScore, reasons, nextSteps, draftMessage, missingInformation, and humanReviewRequired. Never approve or send outreach automatically.",
    }, { workspaceId });
  } catch {
    return undefined;
  }
}

function deterministicPlan(lead: Lead, settings: LeadReviewSettings, campaign: Campaign | undefined, icp: ICP | undefined, contextStatus: LeadAgentActionPlan["contextStatus"]): AgentPlanOutput {
  const reasons = [
    lead.fitReason || lead.relevancyReason || "Lead has been added to the CRM pipeline for review.",
    lead.websiteUrl || lead.instagramUrl || lead.linkedinUrl ? "A public profile or contact route is available." : "Public profile and contact evidence are limited.",
    icp ? `Compared against ICP: ${icp.name}.` : "No selected ICP is attached to this lead.",
    contextStatus.syncedKnowledgeReady ? `${contextStatus.answerCount} synced knowledge answers are available for safer recommendations.` : "Synced Knowledge Base context is not ready yet.",
  ];
  if (contextStatus.conflictsPending) reasons.push(`${contextStatus.conflictsPending} knowledge conflict(s) should be reviewed before making strong claims.`);

  const missingInformation = [
    !lead.websiteUrl && !lead.instagramUrl && !lead.linkedinUrl ? "public profile or website" : "",
    !lead.whatsappNumber && !lead.email && !lead.phone ? "direct contact route" : "",
    !contextStatus.productsReady ? "reviewed Product Settings" : "",
    contextStatus.conflictsPending ? "open knowledge conflicts" : "",
  ].filter(Boolean);

  const product = campaign?.productFocus?.[0] || contextStatus.preview.products.replace(/^No product catalog available\./, "").slice(0, 80) || "your requirements";
  const leadName = lead.companyName || "there";
  return {
    recommendation: lead.reviewStatus === "approved" ? "Prepare reviewed outreach for this approved lead." : "Review fit, enrich missing contact details, then decide whether to approve.",
    confidenceScore: Math.max(0.2, Math.min(0.95, lead.confidenceScore || 0.55)),
    reasons,
    nextSteps: [
      lead.reviewStatus === "approved" ? "Keep outreach in manual review mode." : "Confirm whether this company is a real fit before approval.",
      missingInformation.length ? `Fill missing ${missingInformation.slice(0, 2).join(" and ")}.` : "Use the available CRM and synced knowledge context to draft outreach.",
      "Use the draft as a starting point only; do not send until reviewed.",
    ],
    draftMessage: `Hi ${lead.contactName || leadName}, I noticed ${lead.companyName || "your business"} may be relevant to ${campaign?.name || "our current B2B outreach"}. We can share details about ${product}. Would you like a short catalogue or a quick discussion of your current requirement?`,
    missingInformation,
    humanReviewRequired: true,
  };
}

function normalizeOutput(output: AgentPlanOutput | undefined, fallback: AgentPlanOutput, lead: Lead): Required<AgentPlanOutput> {
  return {
    recommendation: cleanString(output?.recommendation) || fallback.recommendation || "Review this lead before taking action.",
    confidenceScore: typeof output?.confidenceScore === "number" ? Math.max(0, Math.min(1, output.confidenceScore)) : fallback.confidenceScore || lead.confidenceScore || 0.5,
    reasons: cleanList(output?.reasons, fallback.reasons || []),
    nextSteps: cleanList(output?.nextSteps, fallback.nextSteps || []),
    draftMessage: cleanString(output?.draftMessage) || fallback.draftMessage || "",
    missingInformation: cleanList(output?.missingInformation, fallback.missingInformation || []),
    humanReviewRequired: true,
  };
}

function summarizeLead(lead: Lead) {
  return {
    id: lead.id,
    companyName: lead.companyName,
    status: lead.status,
    reviewStatus: lead.reviewStatus,
    buyerType: lead.buyerType,
    source: lead.source,
    websiteUrl: lead.websiteUrl,
    confidenceScore: lead.confidenceScore,
    fitReason: lead.fitReason,
    relevancyReason: lead.relevancyReason,
    doNotContact: lead.doNotContact,
    contactAvailable: Boolean(lead.whatsappNumber || lead.email || lead.phone),
  };
}

function readyAreaLabels(context: LeadAgentActionPlan["contextStatus"]) {
  return [
    context.profileReady ? "Business Profile" : "",
    context.salesReady ? "Sales Settings" : "",
    context.productsReady ? "Product Settings" : "",
    context.policyReady ? "Policy Settings" : "",
    context.communicationReady ? "WhatsApp Settings" : "",
    context.syncedKnowledgeReady ? "Knowledge Base" : "",
  ].filter(Boolean);
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanList(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  return items.length ? items : fallback;
}
