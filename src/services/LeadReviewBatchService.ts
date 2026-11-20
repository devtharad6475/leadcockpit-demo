/**
 * LeadReviewBatchService.ts — Cluster 7 P1-9 (D-2026-07-26-6)
 *
 * WHAT: The lead-review mode "Auto-Approve High-Confidence Safe Leads" used
 * to NOT actually auto-approve anything — the user still had to click each
 * lead one-by-one. The mode name promised automation that didn't happen.
 *
 * Operator decision (D-2026-07-26-6): auto-approve runs ONCE per day via
 * the existing scheduler. Safe high-confidence leads get approved overnight;
 * the owner sees the results in the morning digest. Auto-SEND stays locked
 * out (per the existing Stage 4 unlock gate).
 *
 * HOW: `autoApproveBatch(workspaceId, repos)` lists all pending leads for
 * the workspace, then for each calls `recommendLeadReviewDecision` — which
 * already does the per-lead safety math (decideLead + isAutoApprovalCandidate
 * + daily cap) and auto-approves if the lead is a safe high-confidence
 * candidate. The batch just runs that helper across all pending leads +
 * collects a summary. One lead's failure does NOT block the batch.
 *
 * The contract is pinned by golden:auto-approve-batch (4 cases).
 */
import { recommendLeadReviewDecision } from "./LeadReviewDecisionService";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { createRepositories } from "@/repositories";

export interface AutoApproveBatchSummary {
  workspaceId: string;
  ranAt: string;
  mode: string;
  pendingCount: number;
  approvedCount: number;
  needsReviewCount: number;
  skippedCount: number;
  errors: Array<{ leadId: string; error: string }>;
}

/**
 * Run the daily auto-approve batch for a workspace. For each pending lead,
 * calls recommendLeadReviewDecision (which auto-approves if the workspace
 * mode is high_confidence_auto_approval AND the lead is a safe candidate).
 * One lead's failure is recorded in summary.errors and the batch continues.
 *
 * Safe by design:
 *   - If mode=manual, recommendLeadReviewDecision's internal gate means no
 *     auto-approval happens (the helper checks settings.mode).
 *   - The daily cap is enforced inside the helper (countAutoApprovesToday).
 *   - Auto-SEND is NOT touched here — this only flips reviewStatus to
 *     "approved". Sending is a separate Stage 4 gate.
 */
export async function autoApproveBatch(
  workspaceId: string,
  repos: RepositoryBundle = createRepositories(),
): Promise<AutoApproveBatchSummary> {
  const ranAt = new Date().toISOString();
  const summary: AutoApproveBatchSummary = {
    workspaceId,
    ranAt,
    mode: "unknown",
    pendingCount: 0,
    approvedCount: 0,
    needsReviewCount: 0,
    skippedCount: 0,
    errors: [],
  };

  // Load all leads for the workspace. (The helper will filter by reviewStatus
  // below — we load all so we can count skipped vs pending accurately.)
  const allLeads = await repos.lead.listLeads(workspaceId);
  const pendingLeads = allLeads.filter((l) => l.reviewStatus === "pending");
  summary.pendingCount = pendingLeads.length;
  summary.skippedCount = allLeads.filter((l) => l.reviewStatus !== "pending").length;

  // Read the mode for the summary (the helper reads it again internally, but
  // we surface it in the summary so the digest can show "ran in mode X").
  try {
    const settings = await repos.leadReviewSettings.getByWorkspace(workspaceId);
    summary.mode = settings?.mode || "manual";
  } catch {
    summary.mode = "manual";
  }

  // Process each pending lead. One failure does NOT block the rest.
  for (const lead of pendingLeads) {
    try {
      const before = lead.reviewStatus;
      await recommendLeadReviewDecision(workspaceId, lead.id, repos);
      // Re-read the lead to see what the helper did.
      const after = await repos.lead.getLeadById(workspaceId, lead.id);
      if (after?.reviewStatus === "approved") {
        summary.approvedCount++;
      } else if (after?.reviewStatus === "rejected") {
        // The helper can also reject (e.g. DNC). Count as needsReview for
        // the summary's purposes — the owner should see it.
        summary.needsReviewCount++;
      } else {
        // Still pending — the helper recommended but didn't auto-approve.
        summary.needsReviewCount++;
      }
      void before;
    } catch (error) {
      summary.errors.push({
        leadId: lead.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue to the next lead — one failure must not block the batch.
    }
  }

  return summary;
}
