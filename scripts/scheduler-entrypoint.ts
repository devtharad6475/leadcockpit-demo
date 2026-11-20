/**
 * Stage 4 / 2026-07-20 — Daily prospecting scheduler entrypoint.
 * Updated 2026-07-21 (R2) — persists a daily digest per workspace.
 * Updated 2026-07-26 (Cluster 7 / P1-9 / D-2026-07-26-6) — after discovery,
 * runs the auto-approve batch per workspace. Safe high-confidence leads get
 * approved overnight; the owner sees the results in the morning digest.
 *
 * Run this once per weekday (Mon–Fri) at 09:00 IST via the host OS
 * scheduler. Examples:
 *
 *   Linux cron:     `0 3 * * 1-5 cd /app && node scripts/scheduler-entrypoint.ts`
 *                   (03:00 UTC = 09:00 IST, Mon–Fri)
 *   Windows Task Scheduler: daily at 09:00, run `node scripts/scheduler-entrypoint.ts`
 *
 * Per operator decision (docs/LOGIC.md 2026-07-20): Mon–Fri, 09:00 IST.
 *
 * This script:
 *   1. Runs the discovery loop for every active workspace.
 *   2. **(Cluster 7 / P1-9)** Runs the auto-approve batch per workspace.
 *      Workspaces in mode=high_confidence_auto_approval get their safe
 *      high-confidence leads approved; manual-mode workspaces are a no-op.
 *   3. **(R2)** Builds a DailyDigestSummary per workspace (using the pure
 *      buildDigestSummary helper from DailyDigestService) and persists it
 *      to the audit log with eventType="digest_sent" — one record per
 *      workspace per day. The Today screen reads the latest entry.
 *   4. Prints a summary to stdout (the operator's log aggregator picks it up).
 *   5. Exits 0 on success, 1 if any workspace errored. (2026-09-28: a setup
 *      notice such as "search is not connected" is printed as a NEEDS SETUP
 *      warning and does not by itself fail the run — src/lib/daily-run-outcome.ts.)
 *
 * Auto-send is NOT performed here — discovery + auto-approve only. Sends
 * (when the workspace toggle is ON) are a separate step gated by the
 * 11-condition AutoSendGate.
 */
import { runDailyRoutine } from "@/services/DailyRoutineService";
import { createRepositories } from "@/repositories";
import { schedulerExitCode, splitRunProblems } from "@/lib/daily-run-outcome";
// Stage C.3: route scheduler errors to Sentry when configured.
// captureException never throws + falls back to console.error when unconfigured.
import { captureException } from "@/lib/monitoring";
import { initSentry } from "@/lib/monitoring";

// 2026-09-27: the routine itself moved to src/services/DailyRoutineService.ts so
// this script and POST /api/internal/daily-run (the free outside schedule used on
// Render) run exactly the same steps. The morning summary is now built after
// scoring and auto-approve, and includes reminders due today.
async function main() {
  // Stage C.3: init Sentry (no-op if SENTRY_DSN unset).
  await initSentry();
  console.log(`[scheduler] Daily routine starting at ${new Date().toISOString()}`);
  const reports = await runDailyRoutine(createRepositories());
  let totalCreated = 0;
  let totalErrors = 0;
  let totalSetup = 0;
  for (const r of reports) {
    if (r.skipped) {
      console.log(`[scheduler] workspace=${r.workspaceId} skipped: ${r.skipped}`);
      continue;
    }
    // 2026-09-28: "search is not connected" is a setup notice — loud in the
    // log and in the morning summary, but not a failed run (daily-run-outcome.ts).
    const { failures, setupNotices } = splitRunProblems(r.errors);
    totalCreated += r.leadsCreated;
    totalErrors += failures.length;
    totalSetup += setupNotices.length;
    console.log(`[scheduler] workspace=${r.workspaceId} created=${r.leadsCreated} ai-scored=${r.aiScored} auto-approved=${r.autoApproved} reminders-due=${r.followUpsDue} errors=${failures.length} needs-setup=${setupNotices.length}`);
    for (const notice of setupNotices) console.warn(`[scheduler]   WARNING — NEEDS SETUP: ${notice}`);
    for (const warning of r.warnings) console.warn(`[scheduler]   WARNING: ${warning}`);
    for (const error of failures) {
      captureException(new Error(error), { workspaceId: r.workspaceId, source: "scheduler.dailyRoutine" });
      console.error(`[scheduler]   ERROR: ${error}`);
    }
  }
  console.log(`[scheduler] Daily routine complete. Total: created=${totalCreated} errors=${totalErrors} needs-setup=${totalSetup}`);
  if (schedulerExitCode(reports) !== 0) process.exit(1);
}

main().catch((error) => {
  // Stage C.3: top-level fatal goes to Sentry before exiting.
  captureException(error, { source: "scheduler.main.fatal" });
  console.error(`[scheduler] FATAL:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
