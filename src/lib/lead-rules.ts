import type { Lead, LeadStatus } from "./types";
import type { QualificationStatusValue, ReplyClassificationValue } from "@/constants/statuses";

type LeadLike = Pick<Lead, "status" | "reviewStatus" | "doNotContact">;

const BLOCKED_LEAD_STATUSES = new Set<LeadStatus>(["rejected", "do_not_contact", "invalid", "duplicate"]);
const PROTECTED_LEAD_STATUSES = new Set<LeadStatus>(["mql", "sql", "hot_lead", "opportunity", "won"]);

export function canEnrichLead(lead: LeadLike) {
  return lead.reviewStatus === "approved" && !BLOCKED_LEAD_STATUSES.has(lead.status) && lead.doNotContact !== true;
}

export function canCreateOutreachActivity(lead: LeadLike) {
  return lead.reviewStatus !== "rejected" && !BLOCKED_LEAD_STATUSES.has(lead.status) && lead.doNotContact !== true;
}

export function shouldProtectQualifiedStatus(status: LeadStatus | string | undefined) {
  return PROTECTED_LEAD_STATUSES.has(status as LeadStatus);
}

export function getLeadStatusFromReplyClassification(
  classification: ReplyClassificationValue | string | undefined,
  currentStatus: LeadStatus,
): LeadStatus {
  if (shouldProtectQualifiedStatus(currentStatus) && !["unsubscribe", "ask_price", "ask_sample", "ask_moq", "ask_delivery", "asks_for_call", "hot_lead"].includes(classification || "")) {
    return currentStatus;
  }

  switch (classification) {
    case "unsubscribe":
      return "do_not_contact";
    case "ask_catalogue":
      return shouldProtectQualifiedStatus(currentStatus) ? currentStatus : "mql";
    case "ask_price":
    case "ask_sample":
    case "ask_moq":
    case "ask_delivery":
    case "hot_lead":
      return "hot_lead";
    case "asks_for_call":
      return "sql";
    case "not_interested":
      return "not_interested";
    case "contact_later":
    case "interested":
      return shouldProtectQualifiedStatus(currentStatus) ? currentStatus : "interested";
    default:
      return currentStatus;
  }
}

export function calculateFNRTScore(input: {
  fitScore: number;
  needScore: number;
  reachabilityScore: number;
  timingScore: number;
}): {
  fitScore: number;
  needScore: number;
  reachabilityScore: number;
  timingScore: number;
  totalScore: number;
  qualificationStatus: QualificationStatusValue;
} {
  const fitScore = clampScore(input.fitScore);
  const needScore = clampScore(input.needScore);
  const reachabilityScore = clampScore(input.reachabilityScore);
  const timingScore = clampScore(input.timingScore);
  const totalScore = fitScore + needScore + reachabilityScore + timingScore;

  return {
    fitScore,
    needScore,
    reachabilityScore,
    timingScore,
    totalScore,
    qualificationStatus: qualificationFromTotal(totalScore),
  };
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(5, Math.round(value)));
}

function qualificationFromTotal(totalScore: number): QualificationStatusValue {
  if (totalScore <= 5) return "unqualified";
  if (totalScore <= 10) return "possible";
  if (totalScore <= 14) return "good_prospect";
  if (totalScore <= 17) return "mql";
  return "sql";
}


/**
 * 2026-09-25 (CEO decision: lead scoring is AI only). A lead's numbers count as
 * a score only when a real model produced them. Everything else — never
 * scored, scored by the old rules, a sample-mode answer, or waiting because
 * the AI was down — is shown as "Not scored yet" and is what "Score with AI"
 * and the daily scheduler pick up. The stored numbers are left alone.
 */
export function isAiScored(lead: { qualificationStatus?: string; scoreReason?: unknown }): boolean {
  if (lead.qualificationStatus === "not_scored") return false;
  const reason = lead.scoreReason as { scoresFrom?: string; mode?: string } | undefined;
  return reason?.scoresFrom === "model" && reason?.mode === "real";
}
