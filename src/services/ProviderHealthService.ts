/**
 * ProviderHealthService.ts — is the AI actually working right now?
 *
 * ── THE DEFECT THIS EXISTS FOR (2026-09-08) ─────────────────────────────────
 * Reported by the CEO, and confirmed in the code: when an API key runs out of
 * balance, the product does not stop. LLMService.runTask catches the error and
 * swaps in the mock provider, which returns no usable answer, so the WhatsApp
 * engine falls through to a canned per-category reply. Classification drops to
 * the keyword floor. Knowledge extraction stops producing real answers.
 *
 * Every one of those degradations is invisible. The only trace was a `warning`
 * string on a single response object. Worse, the header chip on EVERY screen
 * reads "AI running 6/6" — it reports which autonomy jobs are switched on, and
 * has never known whether the key behind them works. So the owner whose
 * balance hit zero is told, on every screen, that everything is fine, and finds
 * out from a customer.
 *
 * ── WHY THIS IS DERIVED AND NOT A NEW TABLE ─────────────────────────────────
 * Every LLM call already writes an AgentRun row: provider, model, status, and
 * (as of this change) the classified failure reason. That is a complete,
 * timestamped, per-workspace history of whether the AI worked. A separate
 * health table would be a second copy of it that can disagree with the first,
 * and would need a migration to ship. Reading the runs cannot drift, because
 * it IS the record.
 *
 * ── WHY RECOVERY NEEDS NO CODE ──────────────────────────────────────────────
 * Every call still tries the real provider first; the fallback is per-call, not
 * a latch. So the moment a top-up lands, the next call succeeds on its own.
 * Because health is computed from the MOST RECENT runs, that success flips the
 * lamp back with nothing to switch and nothing for the owner to remember. This
 * is deliberate: a manual "turn the AI back on" step is the same silent-
 * degradation bug moved one step later — the owner tops up, forgets the
 * switch, and runs on canned replies for a week believing it is fixed.
 *
 * ── THE TWO WAYS TO RUN OUT ─────────────────────────────────────────────────
 * The provider's balance is one. The workspace's OWN configured cap
 * (aiUsageLimits, daily/monthly tokens and cost) is the other, and it stops
 * calls before they are ever made — a different code path with the same
 * consequence for the owner. Both light this one lamp, because "why is my AI
 * not answering properly" is one question.
 */
import { createRepositories, type RepositoryBundle } from "@/repositories";
import { describeProviderFailure, type ProviderFailureReason } from "@/llm/provider-failure";
import type { AgentRun } from "@/lib/types";

/** How many recent runs to judge on. */
const WINDOW = 25;

/**
 * ── WHY A CLOCK AS WELL AS A COUNT (2026-09-18, session 57) ─────────────────
 * The window above is 25 RUNS with no sense of time, and that shipped a lamp
 * that lies. Two extraction calls failed at 22:45 one night; the truncation bug
 * behind them was fixed and deployed the same night; nothing ran afterwards. So
 * at ten the next morning the chip still read "AI not answering", because those
 * two failures were still the top of the list. The owner opened the product an
 * hour before showing it to someone and was told the AI was down. It was not.
 *
 * A warning that cries wolf is worse than no warning: the third time it is
 * ignored, and the fourth time it is true. So the loud states now require the
 * failure to be RECENT. Older than this, the honest report is not "blocked" and
 * not "healthy" — it is that the last attempt failed, nothing has been tried
 * since, and the state right now is therefore unknown.
 *
 * Six hours: a fault from this morning still shouts through the working day; one
 * from last night does not greet the owner as today's emergency.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Milliseconds since a run's timestamp, or undefined when it cannot be read. */
function ageMs(timestamp: string | undefined, now: number): number | undefined {
  if (!timestamp) return undefined;
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? undefined : now - at;
}

/** Owner-facing, no jargon: "14 minutes ago", "yesterday", "3 days ago". */
function describeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export type ProviderHealthStatus = "healthy" | "degraded" | "blocked" | "unknown";

export type ProviderHealth = {
  status: ProviderHealthStatus;
  /** One line, owner-facing. Safe to render straight into the header. */
  headline: string;
  /** The single next action, or "" when there is nothing for them to do. */
  action: string;
  /** Machine-readable cause, for tests and for the screen to branch on. */
  reason: ProviderFailureReason | "budget_exhausted" | "none";
  /** The provider that was supposed to answer, when we know it. */
  provider?: string;
  /** True when waiting genuinely fixes it and nobody needs to act. */
  transient: boolean;
  /** Consecutive recent AI calls that did not reach the real model. */
  degradedCalls: number;
  /** When the real model last answered successfully. */
  lastRealSuccessAt?: string;
  /** When the current degradation started. */
  since?: string;
};

const HEALTHY: ProviderHealth = {
  status: "healthy",
  headline: "AI is answering normally.",
  action: "",
  reason: "none",
  transient: false,
  degradedCalls: 0,
};

/** A run that reached the real model. Mock-by-configuration is not a failure. */
function runOutput(run: AgentRun): Record<string, unknown> {
  const out = (run as unknown as { output?: unknown; outputJson?: unknown }).output
    ?? (run as unknown as { outputJson?: unknown }).outputJson;
  return (out && typeof out === "object" ? out : {}) as Record<string, unknown>;
}

function isDegraded(run: AgentRun): boolean {
  const out = runOutput(run);
  return run.status === "failed" || out.fallbackUsed === true;
}

function isRealSuccess(run: AgentRun): boolean {
  if (run.status !== "completed") return false;
  const out = runOutput(run);
  if (out.fallbackUsed === true) return false;
  const provider = String(out.provider || "");
  // A workspace deliberately configured onto the mock provider is not
  // "degraded" — it is doing what it was told. It is also not proof the AI
  // works, so it counts as neither.
  return Boolean(provider) && provider !== "mock";
}

export async function getProviderHealth(
  workspaceId: string,
  repos = createRepositories(),
  /** Injected so the staleness rule can be proven without waiting six hours. */
  now: number = Date.now(),
): Promise<ProviderHealth> {
  // The workspace's own cap is checked first: it stops calls BEFORE the
  // provider is ever contacted, so there would be no failed run to read, and
  // the lamp would sit on "healthy" while nothing ran at all.
  const budget = await budgetHealth(workspaceId, repos);
  if (budget) return budget;

  const runs = await repos.agentRun.listRecent(workspaceId, WINDOW).catch(() => [] as AgentRun[]);
  if (!runs.length) return { ...HEALTHY, status: "unknown", headline: "The AI has not run yet." };

  // listRecent is newest-first everywhere in this codebase; sort defensively so
  // a repository that ever changed its mind cannot invert the whole reading.
  const ordered = [...runs].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const lastRealSuccess = ordered.find(isRealSuccess);

  // Count the unbroken run of degraded calls at the top. One failed call is a
  // blip and must not shout at the owner; a run of them is a condition.
  let degradedCalls = 0;
  let firstDegraded: AgentRun | undefined;
  // The NEWEST failure in the streak — the one that says whether this is
  // happening now. `firstDegraded` is the oldest, which says when it started.
  let latestDegraded: AgentRun | undefined;
  for (const run of ordered) {
    if (isRealSuccess(run)) break;
    if (isDegraded(run)) {
      degradedCalls++;
      firstDegraded = run;
      latestDegraded ??= run;
      continue;
    }
    // Anything else (still running, deliberately mock) neither confirms nor
    // denies — skip it rather than let it end the streak.
  }

  if (!degradedCalls) {
    return { ...HEALTHY, lastRealSuccessAt: lastRealSuccess?.createdAt };
  }

  const out = runOutput(firstDegraded!);
  const detail = describeProviderFailure(String(out.failureReason || "unknown"));
  const provider = String(out.attemptedProvider || out.provider || "") || undefined;
  const providerLabel = provider && provider !== "mock" ? provider : "your AI provider";

  // Nothing has been attempted for hours, so there is no evidence about NOW —
  // only about the last time it was tried. Report that, and leave the lamp calm.
  // An unreadable timestamp is not proof of age, so it keeps the loud state:
  // the failure mode to avoid is silence about a real outage.
  const sinceLastAttempt = ageMs(latestDegraded?.createdAt, now);
  if (sinceLastAttempt !== undefined && sinceLastAttempt > STALE_AFTER_MS) {
    return {
      status: "unknown",
      headline: `The last AI call failed ${describeAge(sinceLastAttempt)} (${providerLabel}). Nothing has run since, so the AI's state right now is unknown.`,
      action: detail.action,
      reason: detail.reason,
      provider,
      transient: detail.transient,
      degradedCalls,
      lastRealSuccessAt: lastRealSuccess?.createdAt,
      since: firstDegraded?.createdAt,
    };
  }

  return {
    // A transient fault that has not cleared after several calls is no longer
    // transient from the owner's point of view, so it stops being whispered.
    status: detail.transient && degradedCalls < 3 ? "degraded" : detail.reason === "rate_limited" ? "degraded" : "blocked",
    headline: `${detail.summary} (${providerLabel})`,
    action: detail.action,
    reason: detail.reason,
    provider,
    transient: detail.transient,
    degradedCalls,
    lastRealSuccessAt: lastRealSuccess?.createdAt,
    since: firstDegraded?.createdAt,
  };
}

/** The workspace's own spend cap, which blocks calls before they are made. */
async function budgetHealth(workspaceId: string, repos: RepositoryBundle): Promise<ProviderHealth | undefined> {
  const usage = await repos.aiUsageLimit.getByWorkspace(workspaceId).catch(() => undefined);
  if (!usage) return undefined;

  const over = (used: number | undefined, cap: number | undefined) =>
    typeof cap === "number" && cap > 0 && typeof used === "number" && used >= cap;

  if (over(usage.currentDailyTokens, usage.dailyTokenLimit) || over(usage.currentMonthlyTokens, usage.monthlyTokenLimit)) {
    return {
      status: "blocked",
      headline: "Your own AI usage cap has been reached, so no model calls are being made.",
      action: "Raise the token cap in AI Settings, or wait for the daily reset.",
      reason: "budget_exhausted",
      transient: false,
      degradedCalls: 0,
    };
  }
  if (over(usage.currentDailyCost, usage.dailyCostLimit) || over(usage.currentMonthlyCost, usage.monthlyCostLimit)) {
    return {
      status: "blocked",
      headline: "Your own AI spend cap has been reached, so no model calls are being made.",
      action: "Raise the spend cap in AI Settings, or wait for the daily reset.",
      reason: "budget_exhausted",
      transient: false,
      degradedCalls: 0,
    };
  }
  return undefined;
}
