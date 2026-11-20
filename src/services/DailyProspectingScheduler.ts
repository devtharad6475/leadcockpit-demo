/**
 * Stage 4 / 2026-07-20 — Daily prospecting scheduler.
 * Updated 2026-07-21 (M-R10) — also drafts first-outreach messages per
 * operator Batch 5 Q2: "Yes — discovery + draft together." The owner
 * wakes to a queue of ready-to-review drafts. Auto-SEND stays LOCKED OUT.
 *
 * Per operator decisions (docs/LOGIC.md 2026-07-20 + 2026-07-21 Batch 5):
 *   - Runs at 09:00 IST every weekday (Mon–Fri).
 *   - For each approved campaign with discovery enabled, runs ProspectingService.
 *   - Each discovered candidate is enriched, scored, ICP-matched, de-duplicated,
 *     DNC-checked. Above-threshold candidates become Leads in the Review queue.
 *   - M-R10: for each NEW lead created this run, draft a first-outreach
 *     WhatsApp message into the review queue (status="draft",
 *     humanReviewRequired=true). UPDATED leads are NOT re-drafted — they
 *     already have (or had) a draft. Draft failures are recorded in the
 *     run summary; one failure does NOT abort the loop.
 *   - Auto-send is a SEPARATE step gated by the 11-condition gate (default OFF).
 *     This scheduler does NOT auto-send; it discovers + drafts + queues for
 *     review.
 *
 * The actual cron trigger is registered by `scripts/scheduler-entrypoint.ts`
 * — this module is the orchestrator that the entrypoint (or a manual test)
 * invokes. Keeping them separate so the orchestrator is unit-testable.
 *
 * Pinned by scripts/golden/golden-scheduler-drafts.ts (M-R10 drafting loop).
 */
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { ProspectingService } from "@/services/ProspectingService";
import { AuditLogService } from "@/services/AuditLogService";
import { createReviewedOutreachDraft } from "@/services/MessageGenerationService";
import type { Lead } from "@/lib/types";
import type { DigestCampaignRun } from "@/services/DailyDigestService";
import { timestamp } from "@/lib/db";
import { todayIstIsoDate } from "@/lib/time";

export type DailyRunSummary = {
  workspaceId: string;
  campaignsRun: number;
  candidatesDiscovered: number;
  leadsCreated: number;
  leadsUpdated: number;
  /**
   * 2026-07-21 (M-R10) — number of first-outreach drafts the scheduler
   * generated this run. Equals the number of NEW leads whose draft call
   * succeeded. Updated leads are NOT re-drafted.
   */
  draftsGenerated: number;
  errors: string[];
  /**
   * 2026-09-27 (break test L1): what discovery warned about (no search
   * connected, a failed search, a website that could not be read). These used
   * to stop at the prospecting result and never reach the morning numbers.
   */
  warnings?: string[];
  /**
   * 2026-09-27 (break test L7): set when the daily run had already run for this
   * workspace today, so this call did nothing. The message says so plainly.
   */
  skipped?: string;
};

/** The one job id a workspace's daily run claims for an IST day. */
export function dailyRoutineJobId(workspaceId: string, day: string): string {
  return `daily_routine:${workspaceId}:${day}`;
}

/**
 * 2026-09-27 (break test L7): claim today's daily run for a workspace, once.
 * Two cron firings, a retry, or a manual run on top of the scheduled one used
 * to run discovery twice — twice the search cost, and a second set of numbers.
 * The claim is a job row with a fixed id; the second create fails (primary key
 * on Postgres, an id check on JSON). A run that FAILED may be claimed again.
 * Returns the job id when this caller owns the run, undefined when it does not.
 */
export async function claimDailyRoutine(workspaceId: string, day: string, repos: RepositoryBundle): Promise<string | undefined> {
  const id = dailyRoutineJobId(workspaceId, day);
  try {
    await repos.jobRun.create({ id, workspaceId, jobType: "daily_routine", status: "running", payload: { day }, startedAt: timestamp() });
    return id;
  } catch (error) {
    const existing = await repos.jobRun.getById(workspaceId, id);
    if (!existing) throw error;
    if (existing.status === "failed" && await repos.jobRun.claim(workspaceId, id, "failed", "running")) return id;
    return undefined;
  }
}

/**
 * The drafting seam — pure helper that iterates the new leads from a run
 * and calls the provided draftFn for each. Returns the success count and
 * the list of per-lead errors. Exported so the golden test can pin the
 * counting + failure-handling logic without a real LLM.
 *
 * Per docs/LOGIC.md 2026-07-21 (M-R10):
 *   - A draft failure for one lead is recorded; the loop continues.
 *   - No silent failures — every failure is in the returned errors list.
 */
export async function draftNewLeadsForRun(input: {
  workspaceId: string;
  newLeads: Lead[];
  draftFn: (lead: Lead) => Promise<{ ok: true } | { ok: false; error: string }>;
}): Promise<{ draftsGenerated: number; errors: string[] }> {
  let draftsGenerated = 0;
  const errors: string[] = [];
  for (const lead of input.newLeads) {
    try {
      const result = await input.draftFn(lead);
      if (result.ok) {
        draftsGenerated += 1;
      } else {
        errors.push(`Draft failed for lead ${lead.id} (${lead.companyName || lead.contactName || "unknown"}): ${result.error}`);
      }
    } catch (error) {
      // Per skill v2 "no silent failures" — surface the error and continue.
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Draft threw for lead ${lead.id} (${lead.companyName || lead.contactName || "unknown"}): ${message}`);
    }
  }
  return { draftsGenerated, errors };
}

/**
 * Run the daily discovery loop for a single workspace. Iterates the
 * workspace's approved campaigns, runs prospecting for each, drafts
 * first-outreach messages for new leads, and produces a summary.
 *
 * Auto-send is intentionally NOT performed here. Even if the workspace's
 * auto-send toggle is ON, sends happen in a separate, more carefully-
 * gated step (see AutoSendGate) so the discovery loop can never
 * accidentally bypass the gate.
 *
 * Per docs/LOGIC.md 2026-07-21 (M-R10): drafts are generated only for
 * NEW leads (result.created), not updated ones. Draft failures are
 * recorded in summary.errors but do not abort the run.
 */
export async function runDailyDiscoveryForWorkspace(
  workspaceId: string,
  repos: RepositoryBundle = createRepositories(),
  options: { day?: string } = {},
): Promise<DailyRunSummary> {
  const summary: DailyRunSummary = {
    workspaceId,
    campaignsRun: 0,
    candidatesDiscovered: 0,
    leadsCreated: 0,
    leadsUpdated: 0,
    draftsGenerated: 0,
    errors: [],
    warnings: [],
  };

  const day = options.day || todayIstIsoDate();
  const jobId = await claimDailyRoutine(workspaceId, day, repos);
  if (!jobId) {
    summary.skipped = `The daily run already ran for this company today (${day}). Nothing was run again.`;
    return summary;
  }

  const campaigns = await repos.campaign.listByWorkspace(workspaceId);
  const activeCampaigns = campaigns.filter((c) => c.status === "active" && c.approvalStatus === "approved");
  for (const campaign of activeCampaigns) {
    summary.campaignsRun += 1;
    try {
      const prospecting = new ProspectingService(repos);
      const result = await prospecting.prospectForWorkspace({
        workspaceId,
        campaignId: campaign.id,
      });
      // 2026-09-26 (break test): duplicatesAvoided IS updated, so adding both
      // counted every found-again company twice.
      summary.candidatesDiscovered += result.created + result.updated;
      summary.leadsCreated += result.created;
      summary.leadsUpdated += result.updated;
      for (const warning of result.warnings || []) {
        if (!summary.warnings!.includes(warning)) summary.warnings!.push(warning);
      }
      // 2026-09-27 (break test L1): no working search is a failure of the
      // run, not a quiet zero. It goes into errors so the digest shows it.
      if (result.mode === "search_unavailable") {
        const message = result.warnings.find((warning) => /no new buyers found today/i.test(warning)) || "Search is not connected — no new buyers found today.";
        if (!summary.errors.includes(message)) summary.errors.push(message);
      }

      // M-R10 — draft first-outreach messages for NEW leads only.
      // Only the leads this run created (see newLeadsOfRun).
      const newLeads = newLeadsOfRun(result);
      if (newLeads.length > 0) {
        const profile = await repos.businessProfile.getByWorkspace(workspaceId);
        const draftResult = await draftNewLeadsForRun({
          workspaceId,
          newLeads,
          draftFn: async (lead) => {
            if (!profile) {
              return { ok: false, error: "Business profile not configured; cannot draft." };
            }
            await createReviewedOutreachDraft({
              workspaceId, lead, campaign, profile, channel: "WhatsApp", repos,
            });
            return { ok: true as const };
          },
        });
        summary.draftsGenerated += draftResult.draftsGenerated;
        summary.errors.push(...draftResult.errors);
      }
    } catch (error) {
      // Per skill v2 "no silent failures": record the error and surface in
      // the summary; the caller (cron) can alert the owner.
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`Campaign ${campaign.id} (${campaign.name}): ${message}`);
    }
  }

  await new AuditLogService(repos).logAuditEvent({
    workspaceId,
    userId: "system",
    action: "prospecting.daily_run",
    entityType: "workspace",
    entityId: workspaceId,
    newValuesJson: summary,
  });

  try {
    await repos.jobRun.complete(workspaceId, jobId, { leadsCreated: summary.leadsCreated, leadsUpdated: summary.leadsUpdated, errors: summary.errors.length });
  } catch {
    // The run itself finished; a failed bookkeeping write leaves the claim as
    // "running", which still stops a second run today — the safe side.
  }

  return summary;
}

/**
 * Run the daily discovery for ALL active workspaces. Used by the cron
 * entrypoint. Each workspace is independent — one workspace's error does
 * NOT block the others.
 */
export async function runDailyDiscoveryForAllWorkspaces(
  repos: RepositoryBundle = createRepositories(),
): Promise<DailyRunSummary[]> {
  const data = await repos.readAll?.();
  const workspaces = data?.workspaces || [];
  const summaries: DailyRunSummary[] = [];
  for (const workspace of workspaces) {
    if (workspace.status !== "active") continue;
    try {
      summaries.push(await runDailyDiscoveryForWorkspace(workspace.id, repos));
    } catch (error) {
      summaries.push({
        workspaceId: workspace.id,
        campaignsRun: 0,
        candidatesDiscovered: 0,
        leadsCreated: 0,
        leadsUpdated: 0,
        draftsGenerated: 0,
        errors: [`Workspace run failed: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }
  return summaries;
}

/**
 * 2026-09-26 (break test): the leads a run CREATED. This was
 * `result.leads.slice(0, result.created)`, but found-again and new leads come
 * back interleaved in discovery order, so a run that re-found one company and
 * found one new one drafted a first message to the company it already had
 * (even one marked do-not-contact) and none to the new one.
 */
export function newLeadsOfRun(result: { leads: Lead[]; newLeadIds: string[] }): Lead[] {
  const ids = new Set(result.newLeadIds);
  return result.leads.filter((lead) => ids.has(lead.id));
}

/**
 * The morning digest's line for one workspace's daily run.
 *
 * 2026-09-27 (break test L7): "new leads discovered" was created + updated, so
 * every company found AGAIN (already a lead) was reported as new, and the
 * number grew each morning while nothing new arrived. Only created leads count.
 */
export function digestRunFromSummary(s: DailyRunSummary): DigestCampaignRun {
  return {
    campaignId: "(all active campaigns)",
    campaignName: `${s.campaignsRun} campaign${s.campaignsRun === 1 ? "" : "s"}`,
    leadsDiscovered: s.leadsCreated,
    draftsGenerated: s.draftsGenerated,
    errors: s.errors.map((msg) => ({ campaignId: "(unknown)", message: msg })),
  };
}
