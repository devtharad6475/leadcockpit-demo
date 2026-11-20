/**
 * The daily routine — one routine, two doors (2026-09-27, CEO: "the daily
 * routine runs by itself"). Plan: docs/planning/DAILY-ROUTINE-AND-REMINDERS-PLAN.md.
 *
 * Doors: `scripts/scheduler-entrypoint.ts` (a server with its own scheduler)
 * and `POST /api/internal/daily-run` (a free outside schedule wakes the site —
 * on Render the scheduler service is a paid feature and the web service sleeps).
 *
 * Per company, in this order:
 *   1. find new buyers (once per company per IST day — the claim lives in
 *      runDailyDiscoveryForAllWorkspaces, break test L7);
 *   2. AI-score leads still waiting for a score;
 *   3. auto-approve safe high-confidence leads (manual-mode companies: no-op);
 *   4. build and save the morning summary — AFTER 2 and 3 (review M11: it was
 *      built first, so the owner never saw the night's scoring and approvals).
 *
 * Never sends anything to a customer. Every step's failure is recorded and the
 * next step still runs.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import { createRepositories } from "@/repositories";
import { runDailyDiscoveryForAllWorkspaces, digestRunFromSummary, type DailyRunSummary } from "@/services/DailyProspectingScheduler";
import { buildDigestSummary, type DailyDigestSummary } from "@/services/DailyDigestService";
import { autoApproveBatch } from "@/services/LeadReviewBatchService";
import { scoreLeadsAwaitingAi } from "@/services/ProspectingService";
import { captureException } from "@/lib/monitoring";
import { todayIstIsoDate } from "@/lib/time";

export type DailyRoutineWorkspaceReport = {
  workspaceId: string;
  skipped?: string;
  leadsCreated: number;
  aiScored: number;
  autoApproved: number;
  followUpsDue: number;
  /** 2026-09-28 — the learning steps (see LearningStepResult). */
  learning?: LearningStepResult;
  warnings: string[];
  errors: string[];
  digest?: DailyDigestSummary;
  /** 2026-09-28 — what happened to the owner's morning WhatsApp. */
  ownerSummary?: { status: string; reason: string; text: string; count: number; newBuyers?: number };
};

export type DailyRoutineDeps = {
  discover: (repos: RepositoryBundle) => Promise<DailyRunSummary[]>;
  score: (repos: RepositoryBundle, workspaceId: string) => Promise<{ aiScored: number; stillWaiting: number; stoppedReason?: string }>;
  autoApprove: (workspaceId: string, repos: RepositoryBundle) => Promise<{ approvedCount: number; errors: Array<{ leadId: string; error: string }> }>;
  followUpsDue: (repos: RepositoryBundle, workspaceId: string, day: string) => Promise<number>;
  learn: (repos: RepositoryBundle, workspaceId: string, now: Date) => Promise<LearningStepResult>;
  /** 2026-09-30 — re-apply the company's festival rules (next year's dates appear by themselves). */
  festivals: (repos: RepositoryBundle, workspaceId: string) => Promise<boolean>;
  /** 2026-09-28 — the owner's morning WhatsApp (or kept in the app). Built from the same Needs-you list. */
  /** "New buyers found" is counted inside, with the same rule as the "Today's new buyers" card. */
  ownerSummary: (repos: RepositoryBundle, workspaceId: string, input: { remindersDue: number }) => Promise<{ status: string; reason: string; text: string; count: number; newBuyers?: number }>;
  /** 2026-09-28 — the time-based owner alerts (customer waiting, urgent ticket due). */
  ownerAlerts: (repos: RepositoryBundle, workspaceId: string) => Promise<unknown>;
};

/**
 * 2026-09-28 — learning from what actually happened. Never sends anything and
 * never changes a setting: it records "no reply in 14 days", proposes reorder /
 * dormant reminders, and once a week proposes outcome patterns to the owner.
 */
export type LearningStepResult = { noReplySignals: number; reorderProposed: number; learningProposals: number; learningRan: boolean };

async function defaultLearn(repos: RepositoryBundle, workspaceId: string, now: Date): Promise<LearningStepResult> {
  const { recordNoReplyOutcomes } = await import("@/services/OutcomeSignalService");
  const { proposeReorderReminders } = await import("@/services/ReorderReminderService");
  const { runWeeklyOutcomeLearning } = await import("@/services/OutcomeLearningService");
  const noReplySignals = await recordNoReplyOutcomes(workspaceId, repos, now);
  const reorder = await proposeReorderReminders(workspaceId, repos, now);
  const weekly = await runWeeklyOutcomeLearning(workspaceId, repos, now);
  return { noReplySignals, reorderProposed: reorder.proposed + reorder.upgraded, learningProposals: weekly.proposed.length, learningRan: weekly.ran };
}

const defaultDeps: DailyRoutineDeps = {
  discover: (repos) => runDailyDiscoveryForAllWorkspaces(repos),
  score: (repos, workspaceId) => scoreLeadsAwaitingAi(repos, workspaceId, { limit: 20 }),
  autoApprove: (workspaceId, repos) => autoApproveBatch(workspaceId, repos),
  followUpsDue: async (repos, workspaceId, day) => {
    const { countFollowUpsDue } = await import("@/services/FollowUpService");
    return countFollowUpsDue(workspaceId, day, repos);
  },
  learn: defaultLearn,
  festivals: async (repos, workspaceId) => {
    const { refreshFestivalClosedDays } = await import("@/services/FestivalCalendarService");
    return refreshFestivalClosedDays(workspaceId, repos);
  },
  ownerSummary: async (repos, workspaceId, input) => {
    const { sendOwnerMorningSummary } = await import("@/services/OwnerNotifyService");
    return sendOwnerMorningSummary(workspaceId, input, repos);
  },
  ownerAlerts: async (repos, workspaceId) => {
    const { checkTimedOwnerAlerts } = await import("@/services/OwnerNotifyService");
    return checkTimedOwnerAlerts(workspaceId, repos);
  },
};

export async function runDailyRoutine(
  repos: RepositoryBundle = createRepositories(),
  deps: Partial<DailyRoutineDeps> = {},
): Promise<DailyRoutineWorkspaceReport[]> {
  const d = { ...defaultDeps, ...deps };
  const day = todayIstIsoDate();
  const reports: DailyRoutineWorkspaceReport[] = [];
  for (const s of await d.discover(repos)) {
    if (s.skipped) {
      reports.push({ workspaceId: s.workspaceId, skipped: s.skipped, leadsCreated: 0, aiScored: 0, autoApproved: 0, followUpsDue: 0, warnings: [], errors: [] });
      continue;
    }
    const report: DailyRoutineWorkspaceReport = {
      workspaceId: s.workspaceId,
      leadsCreated: s.leadsCreated,
      aiScored: 0,
      autoApproved: 0,
      followUpsDue: 0,
      warnings: [...(s.warnings || [])],
      errors: [...s.errors],
    };
    try {
      const scoring = await d.score(repos, s.workspaceId);
      report.aiScored = scoring.aiScored;
      if (scoring.stoppedReason) report.warnings.push(`AI scoring stopped: ${scoring.stoppedReason}`);
    } catch (err) {
      captureException(err, { workspaceId: s.workspaceId, source: "dailyRoutine.score" });
      report.errors.push(`AI scoring failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const approved = await d.autoApprove(s.workspaceId, repos);
      report.autoApproved = approved.approvedCount;
      for (const e of approved.errors) report.errors.push(`Auto-approve failed for a lead: ${e.error}`);
    } catch (err) {
      captureException(err, { workspaceId: s.workspaceId, source: "dailyRoutine.autoApprove" });
      report.errors.push(`Auto-approve failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 2026-09-28 — before the reminders count, so today's reorder proposals
    // are in the morning summary.
    try {
      report.learning = await d.learn(repos, s.workspaceId, new Date());
    } catch (err) {
      captureException(err, { workspaceId: s.workspaceId, source: "dailyRoutine.learn" });
      report.errors.push(`Learning from results failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await d.festivals(repos, s.workspaceId);
    } catch (err) {
      captureException(err, { workspaceId: s.workspaceId, source: "dailyRoutine.festivals" });
      report.errors.push(`Refreshing closed days failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      report.followUpsDue = await d.followUpsDue(repos, s.workspaceId, day);
    } catch (err) {
      captureException(err, { workspaceId: s.workspaceId, source: "dailyRoutine.followUps" });
      report.errors.push(`Reading today's reminders failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 2026-09-28 — the owner's morning message, from the same Needs-you list
    // the screen shows. Sent to the owner's own WhatsApp only when switched on,
    // connected and a Meta-approved template is chosen; otherwise kept here.
    try {
      report.ownerSummary = await d.ownerSummary(repos, s.workspaceId, { remindersDue: report.followUpsDue });
    } catch (err) {
      captureException(err, { workspaceId: s.workspaceId, source: "dailyRoutine.ownerSummary" });
      report.errors.push(`The owner's morning message failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await d.ownerAlerts(repos, s.workspaceId);
    } catch (err) {
      captureException(err, { workspaceId: s.workspaceId, source: "dailyRoutine.ownerAlerts" });
      report.errors.push(`Checking the owner's alerts failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Include every failed routine step, not only discovery: this persisted
    // summary is what the owner reads after the scheduler process has ended.
    const campaignRun = digestRunFromSummary(s);
    campaignRun.errors = report.errors.map(message => ({ campaignId: campaignRun.campaignId, message }));
    const digest = {
      ...buildDigestSummary({ workspaceId: s.workspaceId, day, campaignRuns: [campaignRun] }),
      aiScored: report.aiScored,
      autoApproved: report.autoApproved,
      followUpsDue: report.followUpsDue,
      reorderProposed: report.learning?.reorderProposed ?? 0,
      learningProposals: report.learning?.learningProposals ?? 0,
      warnings: report.warnings,
      needsYouCount: report.ownerSummary?.count,
      newBuyersToday: report.ownerSummary?.newBuyers,
      ownerMessage: report.ownerSummary?.text,
      ownerMessageStatus: report.ownerSummary?.reason,
    };
    report.digest = digest;
    try {
      await repos.auditLog.create({
        workspaceId: s.workspaceId,
        eventType: "digest_sent",
        actorUserId: "system",
        entityType: "digest",
        entityId: day,
        payload: digest as unknown as Record<string, unknown>,
      });
    } catch (err) {
      captureException(err, { workspaceId: s.workspaceId, source: "dailyRoutine.persistDigest" });
      report.errors.push(`Saving the morning summary failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    reports.push(report);
  }
  return reports;
}
