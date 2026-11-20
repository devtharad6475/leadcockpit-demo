import { defaultWorkspaceId } from "@/lib/db";
import { nextIstMidnight } from "@/lib/time";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";

export type AIUsageRecordInput = {
  tokens?: number;
  cost?: number;
};

/**
 * Audit 2026-07-27 S6 R-4 — sensible default AI spend caps for a fresh workspace.
 * Generous enough for normal B2B prospecting/reply work, tight enough to stop a
 * runaway LLM loop from burning the budget overnight. The owner can edit these
 * per-workspace in Workspace Settings. Cost is in INR rupees.
 *
 *   Daily:   500,000 tokens (~$5–10/day at typical Sonnet/GPT-4o pricing)
 *   Monthly: 10,000,000 tokens (~$100–200/month)
 *   Daily cost cap:   $25/day   (hard stop regardless of token count)
 *   Monthly cost cap: $180/month
 *
 * ── THE UNIT IS US DOLLARS, AND IT USED TO SAY OTHERWISE (N-AI-8, 2026-08-26) ─
 * These two cost caps were written as ₹2,000/day and ₹15,000/month, and the
 * refusal message printed a ₹ sign. Nothing ever converted anything: the only
 * place in the product that COMPUTES a cost is `COST_PER_1K_TOKENS_USD` in
 * LLMService, which is dollars, and every script and seed that sets a cap uses
 * dollar-sized numbers ($5/$100, $50/$500). So the caps were dollars wearing a
 * rupee label — the daily "hard stop" was really $2,000, about 80x looser than
 * the figure it claimed to be.
 *
 * It had never bitten because the TOKEN cap always bound first: 500,000 tokens
 * is $5–10, nowhere near $2,000. Voice transcription (N-AI-7) changed that.
 * Whisper is priced per MINUTE and consumes no tokens, so for a voice note the
 * token caps are all zero and this cost cap is the ONLY brake there is. A
 * dormant labelling mistake became the load-bearing one.
 *
 * The fix is to say dollars and mean dollars, rather than to convert at some
 * exchange rate: an FX rate is a number that drifts, needs a source, and would
 * have to be right at both the write and the read. Stored caps are untouched
 * (they were already dollar-sized); only the DEFAULTS for a workspace that has
 * never set one, and the currency symbol in the message, change.
 */
/**
 * 2026-09-18 (session 57) — raised from 500,000 to 2,000,000 by the operator,
 * after a MEASURED run hit the old cap and silently lost work.
 *
 * Extracting the 424-question framework from one 23-page document set is 25
 * requests, and each one carries the document. That run reached 501,499 tokens
 * and 7 of the 25 question groups — including every pricing question — were
 * refused with "daily tokens exceeded". Nothing was wrong with those questions;
 * the customer simply uploaded their documents.
 *
 * 2,000,000 tokens of deepseek-flash is roughly $0.60 of real spend (most of a
 * re-sent document is a cache hit at $0.006/1M), and the DOLLAR caps below stay
 * as the real backstop.
 */
export const DEFAULT_DAILY_TOKEN_LIMIT = 2_000_000;
/** 20 days of the daily cap; a workspace that runs at the ceiling every day is an anomaly worth stopping. */
export const DEFAULT_MONTHLY_TOKEN_LIMIT = 40_000_000;
/** USD. Deliberately above the token caps, so it is a backstop and not the brake. */
export const DEFAULT_DAILY_COST_LIMIT = 25;
/** USD. */
export const DEFAULT_MONTHLY_COST_LIMIT = 180;

/** Whether the daily/monthly token and cost caps are enforced. Off unless AI_USAGE_CAPS=on (see checkCanRunTask). */
export function usageCapsEnforced(): boolean {
  return (process.env.AI_USAGE_CAPS || "").trim().toLowerCase() === "on";
}

export async function getUsage(workspaceId = defaultWorkspaceId, repos = createRepositories()) {
  return resetUsageIfNeeded(workspaceId, repos);
}

export async function checkCanRunTask(workspaceId: string, _taskName: string, estimatedTokens = 0, estimatedCost = 0, repos = createRepositories()) {
  // Stage 5 re-audit fix (F-P1-3, 2026-07-28) — global kill-switch. The
  // operator can flip ai_usage_enabled=false during an AI cost runaway; this
  // gate refuses ALL LLM calls before the caps are even checked. Pre-fix the
  // flag was write-only. Pinned by golden:feature-flag-wiring CASE B.
  const { isFeatureEnabled } = await import("@/services/FeatureFlagService");
  if (!(await isFeatureEnabled("ai_usage_enabled"))) {
    const usage = await resetUsageIfNeeded(workspaceId, repos);
    return {
      allowed: false,
      reason: "AI usage is disabled (kill-switch ai_usage_enabled is OFF).",
      usage,
    };
  }
  const usage = await resetUsageIfNeeded(workspaceId, repos);
  // 2026-09-27 (CEO): "make it unlimited till the time we are making it; when
  // we give it to customers, then we will actually make it." While the product
  // is being built the caps below are not enforced — usage is still recorded,
  // and the ai_usage_enabled kill-switch above still stops everything. Set
  // AI_USAGE_CAPS=on to enforce them again (required before customer launch).
  if (!usageCapsEnforced()) {
    return { allowed: true, reason: "Usage caps are off while the product is being built (AI_USAGE_CAPS=on turns them on).", usage };
  }
  // Audit 2026-07-27 S6 R-4: previously only dailyTokenLimit was checked, and
  // the default was Infinity (no cap at all) — a runaway LLM loop could burn
  // the budget overnight with no brake. Now ALL FOUR limits are enforced, and
  // any one exceeded blocks the task.
  //
  // T-4 (Session 7, 2026-07-28) tightening: the limit fields are optional in
  // the type, so an anomalous record (e.g. created before defaults existed, or
  // manually edited) could have them undefined. Previously that fell back to
  // Infinity (uncapped) — the exact budget-burn risk R-4 was meant to close.
  // Now a missing limit falls back to the SAFE DEFAULT (never Infinity), so no
  // record can ever be uncapped by accident. resetUsageIfNeeded already writes
  // all 4 defaults on a fresh workspace, so this is belt-and-suspenders.
  const dailyTokenLimit = usage.dailyTokenLimit ?? DEFAULT_DAILY_TOKEN_LIMIT;
  const monthlyTokenLimit = usage.monthlyTokenLimit ?? DEFAULT_MONTHLY_TOKEN_LIMIT;
  const dailyCostLimit = usage.dailyCostLimit ?? DEFAULT_DAILY_COST_LIMIT;
  const monthlyCostLimit = usage.monthlyCostLimit ?? DEFAULT_MONTHLY_COST_LIMIT;

  const wouldExceed: string[] = [];
  if (usage.currentDailyTokens + estimatedTokens > dailyTokenLimit) wouldExceed.push(`daily tokens (${usage.currentDailyTokens + estimatedTokens} > ${dailyTokenLimit})`);
  if (usage.currentMonthlyTokens + estimatedTokens > monthlyTokenLimit) wouldExceed.push(`monthly tokens (${usage.currentMonthlyTokens + estimatedTokens} > ${monthlyTokenLimit})`);
  if (usage.currentDailyCost + estimatedCost > dailyCostLimit) wouldExceed.push(`daily cost ($${(usage.currentDailyCost + estimatedCost).toFixed(4)} > $${dailyCostLimit})`);
  if (usage.currentMonthlyCost + estimatedCost > monthlyCostLimit) wouldExceed.push(`monthly cost ($${(usage.currentMonthlyCost + estimatedCost).toFixed(4)} > $${monthlyCostLimit})`);

  const allowed = wouldExceed.length === 0;
  return {
    allowed,
    reason: allowed ? "Within usage limits." : `Usage limit would be exceeded: ${wouldExceed.join("; ")}.`,
    usage,
  };
}

export async function recordUsage(workspaceId: string, usageInput: AIUsageRecordInput, repos = createRepositories()) {
  const usage = await resetUsageIfNeeded(workspaceId, repos);
  return repos.aiUsageLimit.upsertForWorkspace(workspaceId, {
    ...usage,
    currentDailyTokens: usage.currentDailyTokens + Math.max(0, usageInput.tokens || 0),
    currentMonthlyTokens: usage.currentMonthlyTokens + Math.max(0, usageInput.tokens || 0),
    currentDailyCost: usage.currentDailyCost + Math.max(0, usageInput.cost || 0),
    currentMonthlyCost: usage.currentMonthlyCost + Math.max(0, usageInput.cost || 0),
  });
}

export async function resetUsageIfNeeded(workspaceId = defaultWorkspaceId, repos: RepositoryBundle = createRepositories()) {
  const usage = await repos.aiUsageLimit.getByWorkspace(workspaceId);
  const now = new Date();
  if (!usage) {
    // Audit 2026-07-27 S6 R-4: a fresh workspace previously got NO limits
    // (undefined → Infinity in checkCanRunTask), so a runaway LLM loop could
    // burn the budget overnight. Now we set sensible DEFAULT caps. The owner
    // can raise/lower them in Workspace Settings (UI to be added). These
    // defaults are generous for normal B2B use but stop budget-burn.
    return repos.aiUsageLimit.upsertForWorkspace(workspaceId, {
      dailyTokenLimit: DEFAULT_DAILY_TOKEN_LIMIT,
      monthlyTokenLimit: DEFAULT_MONTHLY_TOKEN_LIMIT,
      dailyCostLimit: DEFAULT_DAILY_COST_LIMIT,
      monthlyCostLimit: DEFAULT_MONTHLY_COST_LIMIT,
      currentDailyTokens: 0,
      currentMonthlyTokens: 0,
      currentDailyCost: 0,
      currentMonthlyCost: 0,
      resetAt: nextReset(now).toISOString(),
    });
  }
  // N-BUG (2026-09-07) — heal a row that carries no usable caps.
  //
  // A zero or missing cap is never a choice anybody made: nothing in the
  // product writes one, and a zero cap does not throttle AI, it DISABLES it —
  // checkCanRunTask refuses every call before dispatch and `?? DEFAULT` never
  // fires, because 0 is not nullish. Rows like that were created by
  // AISettingsService.getOrCreateUsage writing the four limits as `undefined`
  // (NULL columns), which the Prisma mapper read back as 0, which the next
  // daily reset then wrote back as a literal 0. Both of those are fixed at
  // source, but rows already written that way exist on live deployments, so
  // repair in place on the next read instead of needing a manual UPDATE.
  const unusable = (value?: number) => value === undefined || !Number.isFinite(value) || value <= 0;
  const healed = {
    dailyTokenLimit: unusable(usage.dailyTokenLimit) ? DEFAULT_DAILY_TOKEN_LIMIT : usage.dailyTokenLimit,
    monthlyTokenLimit: unusable(usage.monthlyTokenLimit) ? DEFAULT_MONTHLY_TOKEN_LIMIT : usage.monthlyTokenLimit,
    dailyCostLimit: unusable(usage.dailyCostLimit) ? DEFAULT_DAILY_COST_LIMIT : usage.dailyCostLimit,
    monthlyCostLimit: unusable(usage.monthlyCostLimit) ? DEFAULT_MONTHLY_COST_LIMIT : usage.monthlyCostLimit,
  };
  const needsHeal = healed.dailyTokenLimit !== usage.dailyTokenLimit
    || healed.monthlyTokenLimit !== usage.monthlyTokenLimit
    || healed.dailyCostLimit !== usage.dailyCostLimit
    || healed.monthlyCostLimit !== usage.monthlyCostLimit;

  const windowStillOpen = Boolean(usage.resetAt) && new Date(String(usage.resetAt)) > now;
  if (windowStillOpen && !needsHeal) return usage;
  return repos.aiUsageLimit.upsertForWorkspace(workspaceId, {
    ...usage,
    ...healed,
    // Only the daily counters roll over. When the window is still open and we
    // are here purely to heal the caps, the day's spend must survive untouched.
    currentDailyTokens: windowStillOpen ? usage.currentDailyTokens : 0,
    currentDailyCost: windowStillOpen ? usage.currentDailyCost : 0,
    resetAt: windowStillOpen ? usage.resetAt : nextReset(now).toISOString(),
  });
}

function nextReset(from: Date) {
  // S6 D-7: was server-local midnight (setHours) — 5.5h off IST on a UTC box.
  // Now uses the IST chokepoint so the daily reset fires at 00:00 IST.
  return nextIstMidnight(from);
}
