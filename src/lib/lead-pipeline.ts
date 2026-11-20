import type { LeadStatus } from "./types";

/**
 * The single definition of the lead funnel, shared by the dashboard's
 * "Pipeline at a glance" bars and the CRM's status filter chips.
 *
 * 2026-08-20 (N-UX-7). The dashboard used to carry its own private stage
 * table. It matched 15 status strings, SIX of which (`new_lead`, `new`,
 * `pending`, `qualified`, `hot`) are not values `LeadStatus` can ever hold —
 * so the "New" bar was structurally dead — and it covered only 9 of the 26
 * real statuses, hiding two thirds of the leads. Its percentages were then
 * computed against the sum of the bars, not the lead count, while the card
 * header printed the lead count right above them: "15 leads" over "SQL 40%"
 * when SQL was 2 of 15.
 *
 * Two properties are required of this table, and both are enforced rather
 * than trusted:
 *   - EXHAUSTIVE: every LeadStatus appears in exactly one stage. Checked by
 *     scripts/golden/golden-pipeline-stage-coverage.ts.
 *   - MUTUALLY EXCLUSIVE: no status appears twice, so the bars sum to the
 *     lead total and a percentage of that total is meaningful.
 *
 * Typing `statuses` as LeadStatus[] means the compiler rejects an invented
 * status outright — the exact class of mistake that produced the dead bar.
 */
export type PipelineStage = { key: string; label: string; statuses: LeadStatus[] };

export const PIPELINE_STAGES: PipelineStage[] = [
  { key: "new", label: "New", statuses: ["discovered", "prospected", "needs_review", "enriching", "enriched", "approved", "message_ready"] },
  { key: "contacted", label: "Contacted", statuses: ["contacted", "contacted_cold", "replied"] },
  { key: "qualified", label: "Qualified", statuses: ["mql", "sql", "talking", "sample_phase", "interested"] },
  { key: "hot", label: "Hot", statuses: ["hot_lead", "opportunity"] },
  { key: "won", label: "Won", statuses: ["won", "closed_won"] },
  { key: "lost", label: "Lost", statuses: ["lost", "closed_lost", "not_interested", "rejected"] },
  { key: "excluded", label: "Excluded", statuses: ["do_not_contact", "invalid", "duplicate"] },
];

export function statusesForStage(key: string): string[] {
  return PIPELINE_STAGES.find((s) => s.key === key)?.statuses ?? [];
}

export function stageKeyForStatus(status: string): string | undefined {
  return PIPELINE_STAGES.find((s) => (s.statuses as string[]).includes(status))?.key;
}
