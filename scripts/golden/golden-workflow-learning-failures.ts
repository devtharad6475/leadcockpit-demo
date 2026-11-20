import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { runDailyRoutine } from "@/services/DailyRoutineService";
import { runWeeklyOutcomeLearning, OUTCOME_LEARNING_JOB } from "@/services/OutcomeLearningService";

async function main() {
  const repos = createJsonRepos();
  const workspaceId = `workflow_failure_${Date.now()}`;
  await ensureWorkspace(repos, workspaceId);
  const reports = await runDailyRoutine(repos, {
    discover: async () => [{ workspaceId, campaignsRun: 1, candidatesDiscovered: 0, leadsCreated: 0, leadsUpdated: 0, draftsGenerated: 0, errors: [], warnings: [] }],
    score: async () => { throw new Error("score unavailable"); },
    autoApprove: async () => ({ approvedCount: 0, errors: [] }),
    learn: async () => ({ noReplySignals: 0, reorderProposed: 0, learningProposals: 0, learningRan: false }),
    festivals: async () => { throw new Error("calendar unavailable"); },
    followUpsDue: async () => 0,
    ownerSummary: async () => ({ status: "kept_in_app", reason: "disabled", text: "summary", count: 0 }),
    ownerAlerts: async () => { throw new Error("alerts unavailable"); },
  });
  assert.equal(reports[0].errors.length, 3, "all three failed routine steps must be retained in the report");
  assert.equal(reports[0].digest?.totalErrors, 3, "saved morning summary must not say zero errors after three steps failed");
  const digests = await repos.auditLog.listByWorkspace(workspaceId);
  const saved = digests.find(row => row.eventType === "digest_sent")?.payload as { totalErrors?: number } | undefined;
  assert.equal(saved?.totalErrors, 3, "refresh must retain failure count in the persisted summary");
  console.log("PASS A — routine failures are retained and the saved summary reports the exact count");

  const original = repos.outcomeSignal.listByWorkspace;
  repos.outcomeSignal.listByWorkspace = async () => { throw new Error("outcome store unavailable"); };
  await assert.rejects(() => runWeeklyOutcomeLearning(workspaceId, repos), /outcome store unavailable/);
  repos.outcomeSignal.listByWorkspace = original;
  const jobs = (await repos.jobRun.listByWorkspace(workspaceId)).filter(row => row.jobType === OUTCOME_LEARNING_JOB);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "failed", "a failed weekly calculation must never be logged as completed");
  assert.match(jobs[0].errorMessage || "", /outcome store unavailable/);
  // Preserve the confirmed weekly claim rule: this repair adds truthful failure
  // status, not a new automatic retry policy.
  assert.equal((await runWeeklyOutcomeLearning(workspaceId, repos)).ran, false);
  console.log("PASS B — failed weekly work is labelled failed and retains the existing weekly claim");
  console.log("workflow-learning-failures: 2 passed, 0 failed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
