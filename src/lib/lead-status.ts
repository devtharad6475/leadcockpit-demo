/**
 * lead-status.ts — one name per lead stage (2026-09-28, review L10).
 *
 * Three stages had two names each: won / closed_won, lost / closed_lost,
 * discovered / prospected. Different code wrote different ones, so a filter
 * on "won" missed the "closed_won" leads and counts disagreed.
 *
 * THE RULE: the short name is the one stored. Every write through a lead
 * repository maps the other name to it; every status filter matches both, so
 * rows written before this change are still found. Old rows are NOT rewritten
 * (no migration touches them); they read as their stage everywhere already
 * (display labels and pipeline columns treat the pair as one stage).
 */
import type { LeadStatus } from "@/lib/types";

const SYNONYMS: Partial<Record<LeadStatus, LeadStatus>> = {
  closed_won: "won",
  closed_lost: "lost",
  prospected: "discovered",
};

/** The stored name for a status (the input when it has no other name). */
export function canonicalLeadStatus<T extends string | undefined | null>(status: T): T {
  if (!status) return status;
  return ((SYNONYMS as Record<string, string>)[status] ?? status) as T;
}

/** Every name a stored row may carry for this status: ["won", "closed_won"] for either. */
export function leadStatusNames(status: string): string[] {
  const canonical = canonicalLeadStatus(status);
  const names = new Set<string>([canonical]);
  for (const [alias, target] of Object.entries(SYNONYMS)) if (target === canonical) names.add(alias);
  return [...names];
}
