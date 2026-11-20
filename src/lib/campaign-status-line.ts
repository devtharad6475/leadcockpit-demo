/**
 * campaign-status-line.ts — what the Workspace status panel says about campaigns.
 *
 * ── THE DEFECT THIS EXISTS FOR (2026-09-08) ─────────────────────────────────
 * Found on the live Dashboard. Two numbers about the same thing, side by side,
 * disagreeing:
 *
 *   "Active campaigns   0"          ← the KPI tile, counting status === "active"
 *   "Campaign  1 active (Draft)"    ← the Workspace status panel
 *
 * The panel counted EVERY campaign, called the total "active", and then printed
 * the real statuses in brackets — so one unstarted draft was announced as a
 * running campaign, with the contradiction shown inside its own sentence.
 *
 * This is the same mistake as the AI chip reading "AI running 6/6" beside a dead
 * key, and the lead badge reading "Contact missing" beside a phone number: a
 * label asserting a state nobody checked. An owner who believes a campaign is
 * running does not go and start it.
 *
 * The rule here: never use the word "active" for a campaign whose status is not
 * `active`, and when nothing is running, say what IS there instead of hiding it.
 */

export type CampaignStatusLineInput = { status?: string };

/** How the product spells a status for a person. Kept local and tiny on purpose. */
function statusWord(status: string | undefined): string {
  const value = String(status || "").trim();
  if (!value) return "unknown";
  return value.replace(/_/g, " ");
}

/**
 * @param campaigns every campaign in the workspace, whatever its status.
 * @returns one sentence for the Workspace status panel.
 */
export function campaignStatusLine(campaigns: CampaignStatusLineInput[]): string {
  if (!campaigns.length) return "No campaign yet — create one from Prospecting → Campaign.";

  const running = campaigns.filter((campaign) => campaign.status === "active");
  const idle = campaigns.filter((campaign) => campaign.status !== "active");

  if (!running.length) {
    // The important half is that NOTHING IS RUNNING. Saying so first stops the
    // owner reading a count and assuming it means work is happening.
    const breakdown = [...new Set(idle.map((campaign) => statusWord(campaign.status)))].join(", ");
    return idle.length === 1
      ? `1 campaign, not running (${breakdown}).`
      : `${idle.length} campaigns, none running (${breakdown}).`;
  }

  const head = running.length === 1 ? "1 active" : `${running.length} active`;
  if (!idle.length) return `${head}.`;
  const breakdown = [...new Set(idle.map((campaign) => statusWord(campaign.status)))].join(", ");
  return `${head}, ${idle.length} not running (${breakdown}).`;
}
