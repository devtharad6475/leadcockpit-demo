/**
 * Stage 4 / 2026-07-21 — Daily digest + kill-switch service.
 *
 * Per docs/LOGIC.md 2026-07-21:
 *   - Daily digest is delivered TWO ways: (a) written to a DailyDigest
 *     record per workspace per day, surfaced on the Today screen; (b) sent
 *     as a brief WhatsApp message to the owner's number.
 *   - Kill-switch is owner-only, audit-logged. Distinct from per-customer
 *     autoSendToggle. AutoSendGate checks kill-switch FIRST.
 *
 * Pure functions for digest math + WhatsApp message rendering + the kill-
 * switch flip event. Caller persists.
 *
 * Pinned by scripts/golden/golden-kill-switch-digest.ts.
 */
import type { Workspace } from "@/lib/types";
import { timestamp } from "@/lib/db";

// ---------------------------------------------------------------------------
// Daily digest.
// ---------------------------------------------------------------------------

export type DigestCampaignError = {
  campaignId: string;
  message: string;
};

export type DigestCampaignRun = {
  campaignId: string;
  campaignName: string;
  leadsDiscovered: number;
  draftsGenerated: number;
  errors: DigestCampaignError[];
};

export type DailyDigestSummary = {
  workspaceId: string;
  /** ISO date (YYYY-MM-DD) the digest covers. */
  day: string;
  totalCampaignsRun: number;
  totalLeadsDiscovered: number;
  totalDraftsGenerated: number;
  totalErrors: number;
  errors: DigestCampaignError[];
  campaignRuns: DigestCampaignRun[];
};

/**
 * Build the per-day digest summary from the daily run's per-campaign
 * results. Pure function — does NOT persist. Caller writes the result
 * to the DailyDigest repository (one record per workspace per day;
 * re-runs overwrite the same day's record so the operator always sees
 * the latest).
 */
export function buildDigestSummary(input: {
  workspaceId: string;
  day: string;
  campaignRuns: DigestCampaignRun[];
}): DailyDigestSummary {
  const totalLeadsDiscovered = input.campaignRuns.reduce((acc, r) => acc + r.leadsDiscovered, 0);
  const totalDraftsGenerated = input.campaignRuns.reduce((acc, r) => acc + r.draftsGenerated, 0);
  const errors = input.campaignRuns.flatMap((r) => r.errors);
  return {
    workspaceId: input.workspaceId,
    day: input.day,
    totalCampaignsRun: input.campaignRuns.length,
    totalLeadsDiscovered,
    totalDraftsGenerated,
    totalErrors: errors.length,
    errors,
    campaignRuns: input.campaignRuns,
  };
}

/**
 * Render the digest summary as a brief WhatsApp message to send to the
 * workspace owner. Plain text, no markdown (WhatsApp business templates
 * are plain text).
 *
 * The message intentionally keeps it short — the owner opens the app for
 * the full breakdown; the WhatsApp is just an attention-grabber.
 *
 * 2026-09-28: the message actually sent to the owner is now
 * OwnerNotifyService.renderOwnerMorningSummary (built from the Needs-you
 * list). This older renderer is kept for its golden (kill-switch-digest).
 */
export function renderDigestWhatsAppMessage(summary: DailyDigestSummary): string {
  const lines: string[] = [
    `Daily prospect digest for ${summary.day}:`,
    `Campaigns run: ${summary.totalCampaignsRun}`,
    `New leads discovered: ${summary.totalLeadsDiscovered}`,
    `Drafts ready for review: ${summary.totalDraftsGenerated}`,
  ];
  if (summary.totalErrors > 0) {
    lines.push(`Errors: ${summary.totalErrors} (see app for details)`);
  }
  lines.push("Open the app to review drafts.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Kill-switch.
// ---------------------------------------------------------------------------

export type KillSwitchAuditEvent = {
  workspaceId: string;
  eventType: "kill_switch_toggled";
  actor: { userId: string; actorType: "owner" | "admin" | "system" };
  /** Previous value of the kill-switch. */
  previousValue: boolean;
  /** New value of the kill-switch. */
  newValue: boolean;
  note?: string;
  at: string;
};

export type KillSwitchFlipResult = {
  updatedWorkspace: Workspace;
  auditEvent: KillSwitchAuditEvent;
};

/**
 * Flip the workspace kill-switch. Returns the updated workspace object
 * and an audit event the caller persists. Pure function — does NOT
 * write to repository.
 *
 * The audit event captures who flipped, when, from→to, so a future
 * investigation can trace every panic-stop and re-enable.
 */
export function flipKillSwitch(input: {
  workspace: Workspace;
  newKillSwitchValue: boolean;
  actor: { userId: string; actorType: "owner" | "admin" | "system" };
  note?: string;
}): KillSwitchFlipResult {
  const previousValue = Boolean(input.workspace.autonomyKillSwitch);
  const at = timestamp();
  const updatedWorkspace: Workspace = {
    ...input.workspace,
    autonomyKillSwitch: input.newKillSwitchValue,
    updatedAt: at,
  };
  const auditEvent: KillSwitchAuditEvent = {
    workspaceId: input.workspace.id,
    eventType: "kill_switch_toggled",
    actor: input.actor,
    previousValue,
    newValue: input.newKillSwitchValue,
    note: input.note,
    at,
  };
  return { updatedWorkspace, auditEvent };
}
