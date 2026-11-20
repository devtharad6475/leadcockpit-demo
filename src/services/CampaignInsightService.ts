/**
 * Stage 4 / 2026-07-21 — Manual insights notebook.
 *
 * Per docs/LOGIC.md 2026-07-21:
 *   - The system does NOT auto-adjust ICPs/campaigns/messaging based on
 *     past results. Instead:
 *     (a) Auto report — campaign metrics are computed and shown.
 *     (b) Manual insights — owner writes free-text notes that surface as
 *         reminders on campaign setup.
 *
 * This module is the manual-insights half. The owner creates insight
 * notes; the campaign-setup surface reads them back as reminders. There
 * is intentionally NO `applyInsightToCampaign` function — the system
 * never auto-modifies anything based on insights.
 *
 * Pinned by scripts/golden/golden-kill-switch-digest.ts (CASES G+H).
 */
import { uid, timestamp } from "@/lib/db";

export type CampaignInsight = {
  id: string;
  workspaceId: string;
  /** Optional: link to a specific campaign. If absent, applies workspace-wide. */
  campaignId?: string;
  /** The owner's free-text note. */
  note: string;
  /** The user who wrote it. */
  authorUserId: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Create a new insight. Pure constructor — caller persists.
 */
export function createInsight(input: {
  workspaceId: string;
  note: string;
  authorUserId: string;
  campaignId?: string;
}): CampaignInsight {
  const now = timestamp();
  if (!input.note || input.note.trim().length === 0) {
    throw new Error("Cannot create an insight with empty note text.");
  }
  return {
    id: uid("insight"),
    workspaceId: input.workspaceId,
    campaignId: input.campaignId,
    note: input.note.trim(),
    authorUserId: input.authorUserId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * List insights for a workspace, newest first. Pure function — operates
 * on whatever list the caller passes (typically from the repository).
 */
export function listInsightsForWorkspace(
  insights: CampaignInsight[],
  workspaceId: string,
): CampaignInsight[] {
  return insights
    .filter((i) => i.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
