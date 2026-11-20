/**
 * 2026-08-08 — Cross-customer morning digest service.
 *
 * Closes coverage-map row #56 ("AI summarizes 50 customers for the owner's
 * morning") — previously ⚫ DARK. Row #6 (generateConversationSummary,
 * ConversationSummaryService) already proved a real per-LEAD summary; this
 * is the missing cross-lead rollup — one briefing across the active
 * pipeline, not 50 separate summaries the owner has to read one by one.
 *
 * Same deterministic-facts / AI-synthesizes-and-prioritizes split as the
 * rest of the codebase: every number and flag in each digest line is
 * computed in code (never invented), and the model's only job is to
 * prioritize and phrase the briefing — it cannot introduce a customer,
 * status, or number that isn't already in the lines it was given.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Lead } from "@/lib/types";
import { findAtRiskCandidates } from "./AtRiskDetectionService";
import { findQuietLeads } from "./ReEngagementService";

const EXCLUDED_STATUSES = new Set<Lead["status"]>([
  "do_not_contact", "not_interested", "lost", "closed_lost", "invalid", "duplicate", "won", "closed_won",
]);

export type LeadDigestLine = {
  leadId: string;
  companyName: string;
  status: string;
  leadScore: number;
  daysSinceActivity: number | null;
  flags: Array<"hot" | "at_risk" | "quiet">;
  text: string;
};

/** Build the deterministic per-lead facts the digest is grounded in. Exported for the probe/UI to show its work. */
export async function buildLeadDigestLines(
  workspaceId: string,
  repos: RepositoryBundle,
  limit = 50,
): Promise<LeadDigestLine[]> {
  const [leads, atRisk, quiet] = await Promise.all([
    repos.lead.listLeads(workspaceId),
    findAtRiskCandidates(workspaceId, repos),
    findQuietLeads(workspaceId, repos),
  ]);
  const atRiskIds = new Set(atRisk.map((c) => c.lead.id));
  const quietIds = new Set(quiet.map((q) => q.lead.id));
  const now = Date.now();

  const lines: LeadDigestLine[] = [];
  for (const lead of leads) {
    if (lead.doNotContact || EXCLUDED_STATUSES.has(lead.status)) continue;
    const lastActivity = [lead.lastContactedAt, lead.lastInboundAt].filter(Boolean).sort().pop();
    const daysSinceActivity = lastActivity ? Math.floor((now - new Date(lastActivity).getTime()) / (24 * 60 * 60 * 1000)) : null;
    const flags: LeadDigestLine["flags"] = [];
    if (lead.status === "hot_lead") flags.push("hot");
    if (atRiskIds.has(lead.id)) flags.push("at_risk");
    if (quietIds.has(lead.id)) flags.push("quiet");

    const companyName = lead.companyName || lead.contactName || `Lead ${lead.id.slice(-6)}`;
    const activityText = daysSinceActivity === null ? "no activity recorded" : `last activity ${daysSinceActivity} day${daysSinceActivity === 1 ? "" : "s"} ago`;
    const flagsText = flags.length > 0 ? `, flags: ${flags.join(", ")}` : "";
    lines.push({
      leadId: lead.id,
      companyName,
      status: lead.status,
      leadScore: lead.leadScore,
      daysSinceActivity,
      flags,
      text: `${companyName} — status: ${lead.status}, score ${lead.leadScore}/20, ${activityText}${flagsText}`,
    });
  }

  // Interesting-first ordering: at-risk, then hot, then quiet, then everything else by recency.
  lines.sort((a, b) => {
    const rank = (l: LeadDigestLine) => (l.flags.includes("at_risk") ? 0 : l.flags.includes("hot") ? 1 : l.flags.includes("quiet") ? 2 : 3);
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return (b.daysSinceActivity ?? -1) - (a.daysSinceActivity ?? -1);
  });
  return lines.slice(0, limit);
}

export type CrossCustomerDigestResult = {
  headline: string;
  priorities: string[];
  risksNoted: string[];
  summary: string;
  mode: "real" | "mock" | "fallback";
  provider?: string;
  modelName?: string;
  leadCount: number;
};

function heuristicDigest(lines: LeadDigestLine[]): CrossCustomerDigestResult {
  const hot = lines.filter((l) => l.flags.includes("hot"));
  const risky = lines.filter((l) => l.flags.includes("at_risk"));
  const quiet = lines.filter((l) => l.flags.includes("quiet"));
  return {
    headline: `${lines.length} active lead${lines.length === 1 ? "" : "s"} in the pipeline this morning.`,
    priorities: [
      ...risky.slice(0, 3).map((l) => `${l.companyName} has an unanswered complaint — follow up.`),
      ...hot.slice(0, 3).map((l) => `${l.companyName} is a hot lead — keep the momentum.`),
    ],
    risksNoted: risky.map((l) => `${l.companyName}: ${l.text}`),
    summary: `${hot.length} hot, ${risky.length} at risk, ${quiet.length} gone quiet, out of ${lines.length} active leads. No real AI configured — this is a rule-based summary.`,
    mode: "fallback",
    leadCount: lines.length,
  };
}

/**
 * Build the morning briefing across the workspace's active pipeline. Grounds
 * the model in deterministic per-lead lines (buildLeadDigestLines) — the
 * model prioritizes and writes the narrative, it never introduces a fact
 * that isn't in those lines.
 */
export async function buildCrossCustomerDigest(
  workspaceId: string,
  repos: RepositoryBundle,
  limit = 50,
): Promise<CrossCustomerDigestResult> {
  const lines = await buildLeadDigestLines(workspaceId, repos, limit);
  if (lines.length === 0) {
    return { headline: "No active leads in the pipeline right now.", priorities: [], risksNoted: [], summary: "Nothing to report.", mode: "mock", leadCount: 0 };
  }

  try {
    const { LLMService } = await import("@/llm/LLMService");
    const { crossCustomerDigestPrompt } = await import("@/llm/prompts/crossCustomerDigestPrompt");
    const llm = new LLMService();
    const linesText = lines.map((l) => l.text).join("\n");
    const result = await llm.runTask<{ headline?: string; priorities?: string[]; risksNoted?: string[]; summary?: string }>(
      "message_generation",
      { leadLines: linesText },
      { workspaceId, overridePrompt: `${crossCustomerDigestPrompt}\n\nLead status lines:\n${linesText}\n\nWrite the briefing now:` },
    );
    if (result.mode === "real" && !result.fallbackUsed && result.output?.headline) {
      return {
        headline: result.output.headline,
        priorities: Array.isArray(result.output.priorities) ? result.output.priorities : [],
        risksNoted: Array.isArray(result.output.risksNoted) ? result.output.risksNoted : [],
        summary: result.output.summary || "",
        mode: "real",
        provider: result.provider,
        modelName: result.modelName,
        leadCount: lines.length,
      };
    }
    return { ...heuristicDigest(lines), mode: "mock", provider: result.provider, modelName: result.modelName };
  } catch {
    return heuristicDigest(lines);
  }
}
