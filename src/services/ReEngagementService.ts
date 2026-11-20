/**
 * 2026-08-08 — Re-engagement nudge service.
 *
 * Closes coverage-map row #53 ("AI notices the customer went quiet + nudges")
 * — previously ⚫ DARK, no handler existed at all.
 *
 * Two-step design, same division of labor as every other AI feature in this
 * codebase: a DETERMINISTIC pre-filter decides WHICH leads qualify (auditable,
 * no model judgment call on who gets contacted), then the model only drafts
 * the message text for a lead the code already selected.
 *
 *   1. findQuietLeads() — pure-ish repo scan: leads the owner contacted
 *      (lastContactedAt set) who haven't replied since AND it's been at
 *      least `quietDays` since that outreach. Excludes DNC / terminal
 *      statuses (nothing to re-engage there).
 *   2. generateReEngagementNudge() — for ONE lead, gathers the real
 *      conversation history (same gatherHistoryText used by the proven
 *      conversation-summary feature, #6) and asks the model to draft a
 *      short, specific check-in. Heuristic fallback keeps the box non-empty
 *      when no real AI is connected, matching ConversationSummaryService.
 *
 * Never auto-sends — this returns a draft only, same no-auto-outreach rule
 * as every other message draft in the app.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Lead } from "@/lib/types";
import { gatherHistoryText } from "./ConversationSummaryService";
import { isContactBlocked } from "@/lib/dnc-registry";
import { NeedsActionError } from "@/lib/user-errors";

const TERMINAL_STATUSES = new Set<Lead["status"]>([
  "do_not_contact", "not_interested", "lost", "closed_lost", "invalid", "duplicate", "won", "closed_won",
]);

export type QuietLead = {
  lead: Lead;
  daysQuiet: number;
  lastContactedAt: string;
};

/**
 * Find leads the owner reached out to that have gone quiet for at least
 * `quietDays` with no reply since. "Quiet" = lastContactedAt is set AND
 * (no lastInboundAt at all, OR lastInboundAt is older than lastContactedAt —
 * i.e. we spoke last, they haven't answered) AND that silence has lasted
 * quietDays or more.
 */
export async function findQuietLeads(
  workspaceId: string,
  repos: RepositoryBundle,
  quietDays = 4,
): Promise<QuietLead[]> {
  const leads = await repos.lead.listLeads(workspaceId);
  const now = Date.now();
  const results: QuietLead[] = [];
  for (const lead of leads) {
    if (lead.doNotContact) continue;
    if (TERMINAL_STATUSES.has(lead.status)) continue;
    if (!lead.lastContactedAt) continue;
    const weSpokeLast = !lead.lastInboundAt || lead.lastInboundAt < lead.lastContactedAt;
    if (!weSpokeLast) continue;
    const daysQuiet = Math.floor((now - new Date(lead.lastContactedAt).getTime()) / (24 * 60 * 60 * 1000));
    if (daysQuiet >= quietDays) {
      results.push({ lead, daysQuiet, lastContactedAt: lead.lastContactedAt });
    }
  }
  return results.sort((a, b) => b.daysQuiet - a.daysQuiet);
}

export type ReEngagementNudgeResult = {
  message: string;
  reasonForNudge: string;
  mode: "real" | "mock" | "fallback";
  provider?: string;
  modelName?: string;
  daysQuiet: number;
};

function heuristicNudge(leadName: string, daysQuiet: number): ReEngagementNudgeResult {
  return {
    message: `Hi, just checking in — wanted to see if you had any questions on what we discussed. Happy to help whenever you're ready.`,
    reasonForNudge: `No reply for ${daysQuiet} day${daysQuiet === 1 ? "" : "s"} since we last reached out to ${leadName}; no real AI configured so this is a generic fallback.`,
    mode: "fallback",
    daysQuiet,
  };
}

/**
 * Draft a re-engagement nudge for a single lead. The caller is responsible
 * for having already confirmed the lead qualifies (e.g. via findQuietLeads) —
 * this function does not re-check quietness so it can also be used ad hoc by
 * the owner for a lead they want to nudge sooner than the threshold.
 */
export async function generateReEngagementNudge(
  workspaceId: string,
  leadId: string,
  repos: RepositoryBundle,
): Promise<ReEngagementNudgeResult> {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new NeedsActionError("This customer record no longer exists.", 404);
  // 2026-09-26 (break test): a nudge was drafted — "just checking in" — for a
  // customer who had asked not to be contacted. Opt-out is permanent; the
  // registry is checked too, because the lead flag alone can be cleared.
  const blocked = await isContactBlocked(workspaceId, lead, repos);
  if (blocked.blocked) {
    throw new NeedsActionError("This customer asked not to be contacted, so no follow-up message is drafted.");
  }
  const leadName = lead?.companyName || lead?.contactName || "this customer";
  const daysQuiet = lead?.lastContactedAt
    ? Math.floor((Date.now() - new Date(lead.lastContactedAt).getTime()) / (24 * 60 * 60 * 1000))
    : 0;
  const { text, events } = await gatherHistoryText(workspaceId, leadId, repos);

  if (events.length === 0) {
    return heuristicNudge(leadName, daysQuiet);
  }

  try {
    const { LLMService } = await import("@/llm/LLMService");
    const { reEngagementNudgePrompt } = await import("@/llm/prompts/reEngagementNudgePrompt");
    const llm = new LLMService();
    const result = await llm.runTask<{ message?: string; reasonForNudge?: string }>(
      "message_generation",
      { leadId, history: text, daysQuiet },
      {
        workspaceId,
        overridePrompt: `${reEngagementNudgePrompt}\n\nConversation history:\n${text}\n\nDays since the owner's last message with no reply: ${daysQuiet}\n\nDraft the nudge now:`,
      },
    );
    if (result.mode === "real" && !result.fallbackUsed) {
      const message = result.output?.message?.trim();
      if (message && message.length > 5) {
        return {
          message,
          reasonForNudge: result.output?.reasonForNudge || `No reply for ${daysQuiet} days.`,
          mode: "real",
          provider: result.provider,
          modelName: result.modelName,
          daysQuiet,
        };
      }
    }
    return { ...heuristicNudge(leadName, daysQuiet), mode: "mock", provider: result.provider, modelName: result.modelName };
  } catch {
    return heuristicNudge(leadName, daysQuiet);
  }
}
