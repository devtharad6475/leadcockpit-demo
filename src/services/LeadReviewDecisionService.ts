import type { Campaign, ICP, Lead, LeadReviewSettings } from "@/lib/types";
import { startOfIstDay } from "@/lib/time";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { AuditLogService } from "@/services/AuditLogService";
import { emitEvent } from "@/events/EventDispatcher";
import { LLMService } from "@/llm/LLMService";
import { canEnrichLead, isAiScored } from "@/lib/lead-rules";
import { safeNotFound } from "@/lib/safe-not-found";
import { NeedsActionError } from "@/lib/user-errors";
import { isContactBlocked } from "@/lib/dnc-registry";

/**
 * M3.2 / O6 audit fix: signal weights for the auto-approve confidence math.
 * Previously every matched signal added +0.08 unconditionally, so a demo
 * prospect with a name + a website + a campaign ID sailed past the 0.85
 * auto-approve threshold just for existing. Now strong signals (ICP match,
 * market-map support) add real weight; weak signals (just has a name, just
 * attached to a campaign) add little. Total bonus is capped at +0.20 so a
 * 0.58 lead can never reach 0.85 through signals alone.
 */
const SIGNAL_WEIGHTS = {
  hasFitReason: 0.04,
  hasPublicProfile: 0.04,
  hasCompanyName: 0.02,
  attachedToCampaign: 0.03,
  matchesIcp: 0.08,
  hasMarketMapSupport: 0.08,
};
const MAX_SIGNAL_BONUS = 0.2;
const RISK_SIGNAL_PENALTY = 0.2;

export function defaultLeadReviewSettings(workspaceId: string): Partial<LeadReviewSettings> {
  return {
    workspaceId,
    mode: "manual_review",
    autoApproveThreshold: 0.85,
    autoRejectThreshold: 0.25,
    maxAutoApprovedPerDay: 25,
    requireHumanForNewCampaigns: true,
    requireHumanForNewIndustries: true,
    allowAutoEnrichment: false,
    allowAutoOutreachPreparation: true,
    allowAutoSend: false,
    auditEveryDecision: true,
  };
}

export async function getLeadReviewSettings(workspaceId: string, repos: RepositoryBundle = createRepositories()) {
  return (await repos.leadReviewSettings.getByWorkspace(workspaceId)) || repos.leadReviewSettings.upsertForWorkspace(workspaceId, defaultLeadReviewSettings(workspaceId));
}

/**
 * 2026-09-25 (cleanup pass) — nothing checked these numbers. The local demo
 * workspace had its auto-approve bar saved as 80 (someone read the box as a
 * percentage) — a bar of 8000% that no lead can clear, so auto-approval had
 * silently stopped with no error anywhere. The bar is a fraction (0.85 = 85%
 * sure); out-of-range values are refused, never guessed at.
 */
export function leadReviewSettingsProblem(input: Partial<LeadReviewSettings>): string | undefined {
  if (input.autoApproveThreshold !== undefined) {
    const t = Number(input.autoApproveThreshold);
    if (!Number.isFinite(t) || t < 0.5 || t > 1) return "The auto-approve bar cannot be below 50% or above 100%.";
  }
  if (input.maxAutoApprovedPerDay !== undefined) {
    const n = Number(input.maxAutoApprovedPerDay);
    if (!Number.isInteger(n) || n < 0 || n > 500) return "The daily auto-approve limit cannot be below 0 or above 500.";
  }
  return undefined;
}

export async function updateLeadReviewSettings(workspaceId: string, input: Partial<LeadReviewSettings>, repos: RepositoryBundle = createRepositories()) {
  const problem = leadReviewSettingsProblem(input);
  if (problem) throw new Error(problem);
  return repos.leadReviewSettings.upsertForWorkspace(workspaceId, { ...input, allowAutoSend: false });
}

export async function recommendLeadReviewDecision(workspaceId: string, leadId: string, repos: RepositoryBundle = createRepositories(), actorUserId: string = "system") {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new Error("Lead not found");
  const [settings, campaign, icps, marketMaps, allCampaigns, allLeads, recentAutoApproves] = await Promise.all([
    getLeadReviewSettings(workspaceId, repos),
    lead.campaignId ? repos.campaign.getById(workspaceId, lead.campaignId) : Promise.resolve(undefined),
    lead.icpId ? repos.icp.getById(workspaceId, lead.icpId) : Promise.resolve(undefined),
    repos.productApplicationMarketMap.listByWorkspace(workspaceId),
    repos.campaign.listByWorkspace(workspaceId),
    repos.lead.listLeads(workspaceId),
    countAutoApprovesToday(workspaceId, repos),
  ]);
  // M3.2: compute the flags the deterministic decision needs.
  //  - campaignIsNew: the campaign has no other approved leads yet.
  //  - industryIsNew: no previously-approved lead shares this lead's industry.
  //  - autoApprovesToday: today's auto-approval count, for the daily cap.
  const approvedLeadIds = new Set(allLeads.filter((l) => l.reviewStatus === "approved").map((l) => l.id));
  const campaignIsNew = Boolean(lead.campaignId) && !allLeads.some((l) => l.id !== lead.id && l.campaignId === lead.campaignId && approvedLeadIds.has(l.id));
  const knownIndustries = new Set(allLeads.filter((l) => l.reviewStatus === "approved" && l.id !== lead.id).map((l) => (l.industry || "").toLowerCase().trim()).filter(Boolean));
  const industryIsNew = Boolean(lead.industry) && !knownIndustries.has((lead.industry || "").toLowerCase().trim());
  const flags: LeadReviewFlags = { campaignIsNew, industryIsNew, autoApprovesToday: recentAutoApproves, awaitingAiScore: !isAiScored(lead) };

  const deterministicRecommendation = decideLead(lead, settings, campaign, icps, marketMaps.length > 0, flags);
  const recommendation = await recommendWithLLM(workspaceId, {
    lead,
    settings,
    campaign,
    icp: icps,
    hasMarketMap: marketMaps.length > 0,
    deterministicRecommendation,
  }, repos);
  const saved = await repos.leadReviewDecision.create({ workspaceId, leadId: lead.id, campaignId: lead.campaignId, ...recommendation, modeUsed: settings.mode, decidedBy: "agent" });
  // A-7 / N-DATA-17 (2026-08-25): pass the bundle this function was GIVEN.
  // Building a fresh one here meant the audit row was written through a
  // different repository than every other write in this function — outside
  // the caller's transaction in production, and against the real database
  // instead of the injected double in tests. On JSON both pointed at the
  // same file so it was invisible; on Postgres it fails with
  // audit_logs_workspace_id_fkey.
  await new AuditLogService(repos).logAuditEvent({ workspaceId, userId: actorUserId, action: "lead.review_decision_created", entityType: "lead", entityId: lead.id, newValuesJson: saved });
  await emitEvent({ eventType: "lead.review_recommended", workspaceId, entityType: "lead", entityId: lead.id, source: "backend", payload: saved });

  // M3.2: auto-approval now consults the flags (new campaign, new industry,
  // daily cap) via isAutoApprovalCandidate. Previously it only checked the
  // decision/confidence/riskSignals, ignoring the three settings.
  // 2026-09-26 (break test): the AI's answer REPLACES the risk list, so an AI
  // "approve, no risks" on a lead the owner had rejected approved it again.
  // Auto-approval is only for leads still waiting for review.
  const awaitingReview = lead.reviewStatus !== "rejected" && lead.reviewStatus !== "approved";
  if (settings.mode === "high_confidence_auto_approval" && awaitingReview && isAutoApprovalCandidate(saved, settings, flags)) {
    await approveLead(workspaceId, lead.id, repos);
    await emitEvent({ eventType: "lead.auto_approved", workspaceId, entityType: "lead", entityId: lead.id, source: "backend", payload: saved });
  }
  return saved;
}

/**
 * M3.2: count today's auto-approval audit events for the daily-cap check.
 * Looks at audit log entries with action "lead.auto_approved" createdAt today.
 */
async function countAutoApprovesToday(workspaceId: string, repos: RepositoryBundle): Promise<number> {
  // Cluster 5 P1-2: was a bare `catch { return 0 }` which silently disabled
  // the daily auto-approve cap whenever the audit-log repo threw (corrupt JSON,
  // disk error). Now: not-found (workspace has no audit log row yet) → 0 is the
  // truth. Real error → bubbles up so the caller surfaces it instead of silently
  // un-capping auto-approvals.
  // S6 D-7: was server-local midnight (setHours) — 5.5h off IST on a UTC box.
  // Now uses the IST chokepoint so "today" matches the operator's IST calendar.
  const startOfToday = startOfIstDay();
  const logs = await safeNotFound(
    () => repos.auditLog.listByWorkspace(workspaceId),
    { fallback: [], context: "countAutoApprovesToday auditLog.listByWorkspace" },
  );
  return logs.filter((log) => log.eventType === "lead.auto_approved" && new Date(log.createdAt) >= startOfToday).length;
}

export async function approveLead(workspaceId: string, leadId: string, repos: RepositoryBundle = createRepositories(), actorUserId: string = "system") {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  // 2026-09-26 (break test): NeedsActionError so bulk approve can tell "this
  // lead cannot be approved" from a real fault (and the screen shows the words).
  if (!lead) throw new NeedsActionError("Lead not found — it may have been deleted.", 404);
  if ((await isContactBlocked(workspaceId, lead, repos)).blocked) throw new NeedsActionError("Cannot approve a do-not-contact lead.", 400);
  if (lead.status === "invalid" || lead.status === "duplicate") throw new NeedsActionError("Cannot approve an invalid or duplicate lead.", 400);
  // 2026-09-26 (break test): approving an already-approved lead set its stage
  // back to "approved" — a lead already contacted, replying or won fell back
  // to the start — reset its enrichment, and logged and announced a second
  // approval. A double-click or an old screen did this. Already approved means
  // nothing to do.
  if (lead.reviewStatus === "approved") return lead;

  const updated = await repos.lead.updateLead(workspaceId, leadId, {
    reviewStatus: "approved",
    status: "approved",
    enrichmentStatus: lead.enrichmentStatus === "completed" ? "completed" : "not_started",
  });
  await new AuditLogService(repos).logAuditEvent({
    workspaceId,
    userId: actorUserId,
    action: "lead.approved",
    entityType: "lead",
    entityId: updated.id,
    newValuesJson: { status: updated.status, reviewStatus: updated.reviewStatus, enrichmentStatus: updated.enrichmentStatus },
    metadataJson: { decidedBy: "human" },
  });
  await emitEvent({ eventType: "lead.approved", workspaceId, entityType: "lead", entityId: updated.id, source: "backend", payload: { status: updated.status, reviewStatus: updated.reviewStatus, canEnrich: canEnrichLead(updated) } });
  return updated;
}

export async function rejectLead(workspaceId: string, leadId: string, repos: RepositoryBundle = createRepositories(), options?: { reason?: string }, actorUserId: string = "system") {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new NeedsActionError("Lead not found — it may have been deleted.", 404);
  // 2026-09-26 (break test): rejecting a do-not-contact, invalid or duplicate
  // lead overwrote that stage with "rejected", so screens and filters that go
  // by stage stopped showing it as do-not-contact. Those stages are kept; only
  // the review becomes "rejected".
  const keepStage = lead.status === "do_not_contact" || lead.status === "invalid" || lead.status === "duplicate";
  const status: Lead["status"] = keepStage ? lead.status : "rejected";
  // Same as approve: rejecting twice logs nothing new.
  if (lead.reviewStatus === "rejected" && lead.status === status) return lead;
  const updated = await repos.lead.updateLead(workspaceId, leadId, { reviewStatus: "rejected", status });
  await new AuditLogService(repos).logAuditEvent({
    workspaceId,
    userId: actorUserId,
    action: "lead.rejected",
    entityType: "lead",
    entityId: updated.id,
    newValuesJson: { status: updated.status, reviewStatus: updated.reviewStatus },
    metadataJson: { decidedBy: "human", ...(options?.reason ? { reason: options.reason } : {}) },
  });
  await emitEvent({ eventType: "lead.rejected", workspaceId, entityType: "lead", entityId: updated.id, source: "backend", payload: { status: updated.status, reviewStatus: updated.reviewStatus, reason: options?.reason } });
  return updated;
}

/**
 * Flags used by decideLead. The caller (recommendLeadReviewDecision) computes
 * `campaignIsNew`, `industryIsNew`, and `autoApprovesToday` from the repos.
 * The pure helper below consumes them so it can be unit-tested directly.
 */
export type LeadReviewFlags = {
  campaignIsNew?: boolean;
  industryIsNew?: boolean;
  autoApprovesToday?: number;
  /** 2026-09-25 — the AI has not scored this lead yet (lead scoring is AI only). */
  awaitingAiScore?: boolean;
};

export type LeadReviewDecisionResult = {
  decision: "approve" | "reject" | "needs_review";
  confidenceScore: number;
  reason: string;
  matchedSignals: string[];
  riskSignals: string[];
  suggestedNextStep: string;
  /** M3.2: when set, an otherwise-approvable lead is held for human review. */
  autoApprovalBlockedReason?: string;
};

/**
 * Pure deterministic lead-review decision. Exported as `decideLeadForTest`
 * via the alias below so the golden test can call it with known inputs.
 */
function decideLead(lead: Lead, settings: LeadReviewSettings, campaign?: Campaign, icp?: ICP, hasMarketMap = false, flags: LeadReviewFlags = {}): LeadReviewDecisionResult {
  const matchedSignals: string[] = [];
  const riskSignals: string[] = [];
  if (lead.doNotContact || lead.status === "do_not_contact") riskSignals.push("Do not contact");
  if (lead.status === "invalid" || lead.status === "duplicate" || lead.reviewStatus === "rejected") riskSignals.push("Blocked lead status");

  // M3.2: weight each signal by strength instead of a flat +0.08.
  let signalBonus = 0;
  if (lead.fitReason) { matchedSignals.push(lead.fitReason); signalBonus += SIGNAL_WEIGHTS.hasFitReason; }
  if (lead.websiteUrl || lead.instagramUrl || lead.linkedinUrl) { matchedSignals.push("Has a reachable public profile"); signalBonus += SIGNAL_WEIGHTS.hasPublicProfile; }
  if (lead.companyName) { matchedSignals.push("Company-level prospect identified"); signalBonus += SIGNAL_WEIGHTS.hasCompanyName; }
  if (campaign) { matchedSignals.push(`Connected to campaign: ${campaign.name}`); signalBonus += SIGNAL_WEIGHTS.attachedToCampaign; }
  if (icp) { matchedSignals.push(`Matches ICP context: ${icp.name}`); signalBonus += SIGNAL_WEIGHTS.matchesIcp; }
  // Session 55: the owner's own exclusions. Checked BEFORE the score is
  // computed because no score can express a disqualification — the F-N-R-T
  // weights are dominated by Reachability, so a competitor with a good website
  // and a listed phone number scores HIGHER than a genuine buyer who is hard to
  // reach. "We do not sell to these" is a different kind of statement from "how
  // promising is this", and it has to be able to win.
  for (const phrase of matchedExclusions(lead, icp)) {
    riskSignals.push(`Excluded by your ICP rule: "${phrase}"`);
  }
  if (hasMarketMap) { matchedSignals.push("Supported by product application research"); signalBonus += SIGNAL_WEIGHTS.hasMarketMapSupport; }
  signalBonus = Math.min(signalBonus, MAX_SIGNAL_BONUS);

  const confidenceScore = Math.min(0.95, Math.max(0.1, (lead.confidenceScore || 0.45) + signalBonus - riskSignals.length * RISK_SIGNAL_PENALTY));

  // M3.2: auto-approval candidate check uses the flags. If any flag blocks,
  // downgrade an otherwise-approvable lead to needs_review.
  const autoApprovalBlockedReason = autoApprovalBlockReason(settings, flags);
  const decision: "approve" | "reject" | "needs_review" = riskSignals.length
    ? "reject"
    : confidenceScore >= settings.autoApproveThreshold
      ? (autoApprovalBlockedReason ? "needs_review" : "approve")
      : confidenceScore <= settings.autoRejectThreshold
        ? "reject"
        : "needs_review";

  const reason = decision === "approve"
    ? "Lead has enough positive signals and no obvious risk flags."
    : decision === "reject"
      ? "Lead has blocking or weak-fit signals."
      : autoApprovalBlockedReason || "Lead needs human confirmation before enrichment/outreach.";

  return {
    decision,
    confidenceScore,
    reason,
    matchedSignals,
    riskSignals,
    suggestedNextStep: decision === "approve" ? "Approve and enrich before drafting outreach." : decision === "reject" ? "Reject or keep out of outreach." : "Review company fit, source, and relevance.",
    autoApprovalBlockedReason,
  };
}

/**
 * Which of the ICP's exclusion phrases this lead trips, if any.
 *
 * Matching is deliberately dull: case-insensitive, whitespace-normalised
 * substring, against the text the product actually knows about a lead. The
 * owner types the phrase and the risk signal quotes it back, so a rule that
 * fires too broadly is visible as itself rather than as an unexplained
 * rejection — and Lead Review is a queue a human works through, so an
 * over-eager rule costs a click, not a customer.
 *
 * A one- or two-character entry is ignored: it would match nearly everything,
 * and an ICP saved with a stray character in the list should not silently
 * reject the whole pipeline.
 */
export function matchedExclusions(lead: Lead, icp?: ICP): string[] {
  const phrases = (icp?.exclusions || []).map((phrase) => phrase.trim()).filter((phrase) => phrase.length >= 3);
  if (!phrases.length) return [];
  const haystack = [
    lead.companyName,
    lead.fitReason,
    lead.industry,
    lead.buyerType,
    lead.discoveredInfo,
    lead.relevancyReason,
    typeof lead.scoreReason?.reason === "string" ? lead.scoreReason.reason : "",
  ].filter(Boolean).join(" \n ").toLowerCase().replace(/\s+/g, " ");
  if (!haystack.trim()) return [];
  return phrases.filter((phrase) => haystack.includes(phrase.toLowerCase().replace(/\s+/g, " ")));
}

/**
 * M3.2 / O7: returns a human-readable reason when auto-approval must be
 * blocked by the requireHuman* settings or the daily cap. Returns undefined
 * when auto-approval is allowed.
 */
function autoApprovalBlockReason(settings: LeadReviewSettings, flags: LeadReviewFlags): string | undefined {
  // 2026-09-25 — never auto-approve a lead the AI has not scored. Checked first
  // and regardless of settings: this is the owner's "AI only" rule, not a mode.
  if (flags.awaitingAiScore) {
    return "Auto-approval blocked: the AI has not scored this lead yet.";
  }
  if (settings.requireHumanForNewCampaigns && flags.campaignIsNew) {
    return "Auto-approval blocked: lead is in a new campaign (requireHumanForNewCampaigns is on).";
  }
  if (settings.requireHumanForNewIndustries && flags.industryIsNew) {
    return "Auto-approval blocked: lead is in a new industry (requireHumanForNewIndustries is on).";
  }
  const cap = typeof settings.maxAutoApprovedPerDay === "number" ? settings.maxAutoApprovedPerDay : 0;
  if (cap > 0 && (flags.autoApprovesToday || 0) >= cap) {
    return `Auto-approval blocked: daily cap of ${cap} auto-approvals already reached.`;
  }
  return undefined;
}

/**
 * M3.2: pure helper used by both the runtime path and the golden test to
 * decide whether a `decideLead` result is eligible for auto-approval.
 * Accepts either the runtime LeadReviewDecisionResult or the saved
 * LeadReviewDecision record (from types.ts) — both have the load-bearing
 * fields: decision, confidenceScore, riskSignals.
 */
function isAutoApprovalCandidate(decision: { decision: string; confidenceScore: number; riskSignals: string[] }, settings: LeadReviewSettings, flags: LeadReviewFlags): boolean {
  if (decision.decision !== "approve") return false;
  if (decision.confidenceScore < settings.autoApproveThreshold) return false;
  if (decision.riskSignals.length > 0) return false;
  return !autoApprovalBlockReason(settings, flags);
}

// Test-only exports (golden test imports these directly).
export const decideLeadForTest = decideLead;
export const isAutoApprovalCandidateForTest = isAutoApprovalCandidate;

async function recommendWithLLM(workspaceId: string, input: {
  lead: Lead;
  settings: LeadReviewSettings;
  campaign?: Campaign;
  icp?: ICP;
  hasMarketMap: boolean;
  deterministicRecommendation: ReturnType<typeof decideLead>;
}, repos: RepositoryBundle): Promise<ReturnType<typeof decideLead>> {
  try {
    const result = await new LLMService(undefined, repos).runTask<Record<string, unknown>>("lead_review_decision", {
      lead: input.lead,
      settings: {
        mode: input.settings.mode,
        autoApproveThreshold: input.settings.autoApproveThreshold,
        autoRejectThreshold: input.settings.autoRejectThreshold,
        allowAutoSend: false,
      },
      campaign: input.campaign,
      icp: input.icp,
      hasMarketMap: input.hasMarketMap,
      deterministicRecommendation: input.deterministicRecommendation,
      instructions: "Return JSON with decision, confidenceScore, reason, matchedSignals, riskSignals, and suggestedNextStep. Never allow auto-send.",
    }, { workspaceId });
    const output = result.output || {};
    const decision = ["approve", "reject", "needs_review"].includes(String(output.decision)) ? String(output.decision) as "approve" | "reject" | "needs_review" : input.deterministicRecommendation.decision;
    const confidenceScore = typeof output.confidenceScore === "number"
      ? Math.max(0, Math.min(1, output.confidenceScore))
      : input.deterministicRecommendation.confidenceScore;
    const riskSignals = Array.isArray(output.riskSignals) ? output.riskSignals.map(String) : input.deterministicRecommendation.riskSignals;
    const matchedSignals = Array.isArray(output.matchedSignals) ? output.matchedSignals.map(String) : input.deterministicRecommendation.matchedSignals;
    if (input.lead.doNotContact || input.lead.status === "do_not_contact") {
      return {
        ...input.deterministicRecommendation,
        decision: "reject",
        confidenceScore: Math.min(confidenceScore, 0.2),
        reason: "Lead is marked do-not-contact. LLM recommendation cannot override safety rules.",
        riskSignals: Array.from(new Set([...riskSignals, "Do not contact"])),
        matchedSignals,
      };
    }
    // 2026-09-26 (break test): same for a lead the owner rejected, or one
    // marked invalid or duplicate — the model cannot clear that risk.
    if (input.lead.reviewStatus === "rejected" || input.lead.status === "invalid" || input.lead.status === "duplicate") {
      return {
        ...input.deterministicRecommendation,
        decision: "reject",
        confidenceScore: Math.min(confidenceScore, 0.2),
        reason: input.lead.reviewStatus === "rejected" ? "You rejected this lead. The AI's view cannot undo that." : "This lead is marked invalid or duplicate.",
        riskSignals: Array.from(new Set([...riskSignals, "Blocked lead status"])),
        matchedSignals,
      };
    }
    // Session 55: the owner's own exclusions are not a judgement the model gets
    // to revisit. The whole ICP is passed into the prompt, so the model sees
    // them and usually agrees — but "we do not sell to these" is a statement of
    // fact about the business, and the model returning "approve" must not
    // quietly overturn it. Same shape as the do-not-contact guard above: the
    // model can inform the reason, never the outcome.
    const excluded = matchedExclusions(input.lead, input.icp);
    if (excluded.length) {
      return {
        ...input.deterministicRecommendation,
        decision: "reject",
        confidenceScore: Math.min(confidenceScore, 0.2),
        reason: `Excluded by a rule you set on this ideal customer: "${excluded[0]}". You can change it under "Who you do NOT sell to".`,
        riskSignals: Array.from(new Set([...riskSignals, ...excluded.map((phrase) => `Excluded by your ICP rule: "${phrase}"`)])),
        matchedSignals,
      };
    }
    return {
      decision,
      confidenceScore,
      reason: typeof output.reason === "string" && output.reason.trim() ? output.reason : input.deterministicRecommendation.reason,
      matchedSignals,
      riskSignals,
      suggestedNextStep: typeof output.suggestedNextStep === "string" && output.suggestedNextStep.trim() ? output.suggestedNextStep : input.deterministicRecommendation.suggestedNextStep,
    };
  } catch {
    return input.deterministicRecommendation;
  }
}

/**
 * 2026-09-26 (break test): "Approve selected" ran approveLead on each lead in
 * turn and stopped at the first one that could not be approved (do not
 * contact, invalid, duplicate, deleted in another tab). The owner got an error,
 * the leads before it were approved and the ones after it were not, with
 * nothing saying which. A lead that cannot take the action is now skipped with
 * the reason, and the rest are done.
 */
export async function bulkReviewLeads(
  workspaceId: string,
  ids: string[],
  action: "approve" | "reject",
  repos: RepositoryBundle = createRepositories(),
  options?: { reason?: string },
  actorUserId: string = "system",
): Promise<{ leads: Lead[]; skipped: Array<{ leadId: string; reason: string }> }> {
  const leads: Lead[] = [];
  const skipped: Array<{ leadId: string; reason: string }> = [];
  for (const id of new Set(ids)) {
    try {
      leads.push(action === "approve"
        ? await approveLead(workspaceId, id, repos, actorUserId)
        : await rejectLead(workspaceId, id, repos, options, actorUserId));
    } catch (error) {
      if (!(error instanceof NeedsActionError)) throw error;
      skipped.push({ leadId: id, reason: error.message });
    }
  }
  return { leads, skipped };
}
