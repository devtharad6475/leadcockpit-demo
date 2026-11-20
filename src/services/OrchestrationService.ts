/**
 * OrchestrationService — a job for the master agent, from request to report
 * (N8, 2026-09-23, session 58).
 *
 * Two steps with the owner in between, because the second one spends money:
 *
 *   proposeJob  The master writes a plan. Code checks it. The plan and the most
 *               AI calls it could use are saved and shown. ONE model call.
 *   runJob      After the owner confirms: claim the job (once — a double-click
 *               must not run a paid plan twice), run it, save the report.
 *
 * The plan is stored as confirmed and re-checked at run time. What runs is
 * exactly what the owner saw — never a plan re-drawn after they said yes.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import { createRepositories } from "@/repositories";
import { checkCanRunTask } from "@/services/AIUsageService";
import {
  DEFAULT_DEADLINE_MS,
  maxCallsFor,
  maxSearchesFor,
  mergeReport,
  overallStatus,
  realMerger,
  realPlanner,
  runPlan,
  statusLines,
  validatePlan,
  type ChildRunner,
  type JobReport,
  type MergerCall,
  type Plan,
  type PlannerCall,
} from "@/agents/Orchestrator";
import { SUBORDINATES } from "@/agents/subordinates";
import { NeedsActionError } from "@/lib/user-errors";
import type { JobRun } from "@/lib/types";

export const ORCHESTRATION_JOB_TYPE = "orchestration";
const GOAL_MAX_CHARS = 1000;

export type OrchestrationSeams = {
  planner?: PlannerCall;
  runChild?: ChildRunner;
  merger?: MergerCall;
  checkBudget?: (estimatedCalls: number) => Promise<{ allowed: boolean; reason?: string }>;
};

export type ProposedJob = {
  jobId: string;
  goal: string;
  plan?: Plan;
  /** Why the plan was refused. Empty when it can run. */
  problems: string[];
  maxCalls: number;
  /** Paid web searches the plan can make at most. 0 when no helper searches. */
  maxSearches: number;
  status: "awaiting_confirmation" | "rejected";
};

export async function proposeJob(input: {
  workspaceId: string;
  goal: string;
  conversationId?: string;
  repos?: RepositoryBundle;
  seams?: OrchestrationSeams;
}): Promise<ProposedJob> {
  const repos = input.repos ?? createRepositories();
  const goal = String(input.goal || "").trim().slice(0, GOAL_MAX_CHARS);
  if (!goal) throw new Error("Cannot plan an empty request. Say what you want done.");

  const budget = await checkCanRunTask(input.workspaceId, "campaign_planning", 2000, 0, repos);
  if (!budget.allowed) throw new Error(`Cannot plan this now: ${budget.reason}`);

  let raw: unknown;
  let plannerFailure: string | undefined;
  try {
    raw = await (input.seams?.planner ?? realPlanner(input.workspaceId, repos))({ goal, roster: SUBORDINATES });
  } catch (error) {
    plannerFailure = `The master agent could not make a plan: ${error instanceof Error ? error.message : String(error)}`;
  }

  // A planner that says "these helpers cannot do this" has answered honestly.
  // Its reason is what the owner is shown, not a generic "invalid plan".
  const declined = raw && typeof raw === "object" && Array.isArray((raw as { subtasks?: unknown }).subtasks)
    && !(raw as { subtasks: unknown[] }).subtasks.length
    ? String((raw as { summary?: unknown }).summary || "").trim()
    : "";

  const checked = plannerFailure ? { problems: [plannerFailure] } : validatePlan(raw);
  const problems = declined ? [declined] : checked.problems;
  const plan = problems.length ? undefined : checked.plan;
  const status = plan ? "awaiting_confirmation" : "rejected";
  const maxCalls = plan ? maxCallsFor(plan) : 0;
  const maxSearches = plan ? maxSearchesFor(plan) : 0;

  const job = await repos.jobRun.create({
    workspaceId: input.workspaceId,
    jobType: ORCHESTRATION_JOB_TYPE,
    status,
    // A refused plan is kept, bounded, so "why was this refused?" can be
    // answered from the record instead of guessed at.
    payload: { goal, plan, problems, maxCalls, maxSearches, conversationId: input.conversationId, ...(plan ? {} : { refusedPlan: JSON.stringify(raw ?? null).slice(0, 6000) }) } as never,
    attempts: 0,
    maxAttempts: 1,
  });
  return { jobId: job.id, goal, plan, problems, maxCalls, maxSearches, status };
}

export type RunJobResult =
  | { ran: true; jobId: string; report: JobReport; text: string }
  | { ran: false; jobId: string; reason: string };

export async function runJob(input: {
  workspaceId: string;
  jobId: string;
  repos?: RepositoryBundle;
  seams?: OrchestrationSeams;
  deadlineMs?: number;
}): Promise<RunJobResult> {
  const repos = input.repos ?? createRepositories();
  const job = await repos.jobRun.getById(input.workspaceId, input.jobId);
  if (!job || job.jobType !== ORCHESTRATION_JOB_TYPE) throw new Error("Job not found");

  // ONCE. The atomic claim is the only thing standing between a double-click
  // and paying for the same plan twice.
  const runDeadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const claimed = await repos.jobRun.claim(input.workspaceId, input.jobId, "awaiting_confirmation", "running", {
    startedAt: new Date().toISOString(),
    payload: { ...(job.payload || {}), runDeadlineMs } as never,
  });
  if (!claimed) {
    const current = await repos.jobRun.getById(input.workspaceId, input.jobId);
    return { ran: false, jobId: input.jobId, reason: `This job cannot start: it is ${describeStatus(current?.status)}.` };
  }
  // The deadline is saved with the start so the stale-job check knows how long
  // THIS run was allowed. Nothing else writes the payload while a job runs:
  // Stop is a status change, not a payload flag, so this cannot lose it.

  const payload = (job.payload || {}) as { goal?: string; plan?: unknown };
  // Re-checked, not trusted: the roster can change between yes and run.
  const checked = validatePlan(payload.plan);
  if (!checked.plan) {
    const reason = `The saved plan no longer passes the checks: ${checked.problems.join(" ")}`;
    const settlement = { errorMessage: reason, completedAt: new Date().toISOString() };
    await repos.jobRun.claim(input.workspaceId, input.jobId, "running", "failed", settlement)
      || await repos.jobRun.claim(input.workspaceId, input.jobId, STOPPING, "failed", settlement);
    return { ran: false, jobId: input.jobId, reason };
  }

  const stopWasRequested = async () => (await repos.jobRun.getById(input.workspaceId, input.jobId))?.status === STOPPING;

  try {
    const goal = String(payload.goal || "");
    const { outcomes, llmCalls } = await runPlan(checked.plan, {
      workspaceId: input.workspaceId,
      repos,
      runChild: input.seams?.runChild,
      checkBudget: input.seams?.checkBudget,
      deadlineMs: runDeadlineMs,
      shouldStop: stopWasRequested,
      // Saved as it goes, so the Command Center can show each helper finishing.
      // The status stays "running"; only the final write below changes it.
      onProgress: async (snapshot) => {
        await repos.jobRun.update(input.workspaceId, input.jobId, { result: { progress: snapshot } as never });
      },
    });
    // Stopped by the owner: no merge. They said stop; a summary is one more
    // paid call they did not ask for, and what each helper did is shown anyway.
    const stoppedByOwner = await stopWasRequested();
    const anyDone = outcomes.some((outcome) => outcome.status === "done");
    // Nothing to merge is not worth paying to merge.
    const merged = stoppedByOwner
      ? { summary: "You stopped this job. What finished before you stopped it is listed below.", mergeCalls: 0 }
      : anyDone
        ? await mergeReport(goal, outcomes, input.seams?.merger ?? realMerger(input.workspaceId, repos))
        : { summary: "None of the tasks finished, so there is nothing to report yet.", mergeCalls: 0 };
    const report: JobReport = {
      summary: merged.summary,
      outcomes,
      llmCalls: llmCalls + merged.mergeCalls,
      status: overallStatus(outcomes),
    };
    const text = `${report.summary}\n\nWhat each helper did:\n${statusLines(outcomes)}\n\nNothing was sent to any customer.`;
    const finalStatus = stoppedByOwner ? "cancelled" : report.status;
    // Through the claim, not a blind write: a Stop that arrived during the
    // merge, or a stale-job check that already gave up on this run, is not
    // silently overwritten. A Stop that came too late to stop anything leaves
    // the job with its real outcome.
    // Terminal status and its evidence must become visible in the same write.
    // Otherwise a reader can see "failed/completed" without the explanation,
    // stop polling, and retain a permanently incomplete card.
    const settlement = { result: { ...report, text } as never, completedAt: new Date().toISOString() };
    await repos.jobRun.claim(input.workspaceId, input.jobId, "running", finalStatus, settlement)
      || await repos.jobRun.claim(input.workspaceId, input.jobId, STOPPING, finalStatus, settlement);
    return { ran: true, jobId: input.jobId, report, text };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const settlement = { errorMessage: reason, completedAt: new Date().toISOString() };
    await repos.jobRun.claim(input.workspaceId, input.jobId, "running", "failed", settlement)
      || await repos.jobRun.claim(input.workspaceId, input.jobId, STOPPING, "failed", settlement);
    return { ran: false, jobId: input.jobId, reason: `The job failed: ${reason}` };
  }
}

/**
 * 2026-09-27 (A4) — a job the owner has asked to stop. The run checks for it
 * before each group of helpers and ends as "cancelled".
 */
const STOPPING = "cancelling";
/**
 * How long past its own deadline a job may still say "running" before it is
 * taken to be dead. The deadline is only checked between groups of helpers, so
 * a group that started just before it, and the merge after it, run over.
 */
export const STALE_RUNNING_MARGIN_MS = 10 * 60_000;
export const INTERRUPTED_MESSAGE = "This job was interrupted before it finished (the server restarted while it was working). Nothing more will run. You can run it again.";

/**
 * A job left "running" by a restart used to stay "running" forever: nothing
 * finished it, and it could not be discarded. Checked whenever jobs are read;
 * a dead run is marked failed with a plain reason. Through the same one-way
 * claim as everything else, so a run that does finish at the last moment and
 * this check cannot both write the outcome.
 */
async function settleIfStale(job: JobRun, repos: RepositoryBundle, now: number): Promise<JobRun> {
  if (job.status !== "running" && job.status !== STOPPING) return job;
  const began = Date.parse(job.startedAt || job.updatedAt || job.createdAt || "");
  if (!Number.isFinite(began)) return job;
  const allowed = Number((job.payload as { runDeadlineMs?: unknown })?.runDeadlineMs) || DEFAULT_DEADLINE_MS;
  if (now - began <= allowed + STALE_RUNNING_MARGIN_MS) return job;
  await repos.jobRun.claim(job.workspaceId, job.id, job.status, "failed", {
    errorMessage: INTERRUPTED_MESSAGE, completedAt: new Date(now).toISOString(),
  });
  return (await repos.jobRun.getById(job.workspaceId, job.id)) ?? job;
}

/**
 * Run it again: a FRESH copy of a finished, failed or stopped job, waiting for
 * the owner's go-ahead like any new plan. The old job keeps its record; the
 * plan is re-checked, because the helpers may have changed since.
 */
export async function copyJobToRunAgain(workspaceId: string, jobId: string, repos: RepositoryBundle = createRepositories()): Promise<ProposedJob> {
  const job = await getJob(workspaceId, jobId, repos);
  if (!["failed", "cancelled", "partial", "completed"].includes(job.status)) {
    throw new NeedsActionError(`This job cannot be run again yet: it is ${describeStatus(job.status)}.`);
  }
  const payload = (job.payload || {}) as { goal?: string; plan?: unknown; conversationId?: string };
  const checked = validatePlan(payload.plan);
  if (!checked.plan) {
    throw new NeedsActionError(`This plan cannot be run again: ${checked.problems.join(" ") || "it no longer passes the checks."} Ask for the job again so a new plan is made.`);
  }
  const goal = String(payload.goal || "");
  // A retry launched from the chat must survive reopening that chat. Validate
  // its parent before creating anything; standalone jobs have no parent.
  const conversation = payload.conversationId
    ? await repos.ownerCopilotConversation.getById(workspaceId, payload.conversationId)
    : undefined;
  if (payload.conversationId && !conversation) throw new NeedsActionError("This job's conversation is no longer available. Ask for the job in a new conversation.");
  const maxCalls = maxCallsFor(checked.plan);
  const maxSearches = maxSearchesFor(checked.plan);
  const copy = await repos.jobRun.create({
    workspaceId,
    jobType: ORCHESTRATION_JOB_TYPE,
    status: "awaiting_confirmation",
    payload: { goal, plan: checked.plan, problems: [], maxCalls, maxSearches, conversationId: payload.conversationId, copiedFrom: job.id } as never,
    attempts: 0,
    maxAttempts: 1,
  });
  const proposed: ProposedJob = { jobId: copy.id, goal, plan: checked.plan, problems: [], maxCalls, maxSearches, status: "awaiting_confirmation" };
  if (conversation) {
    const messages = await repos.ownerCopilotMessage.listByConversation(workspaceId, conversation.id);
    const previous = messages.find(message => message.pendingAction?.entityId === job.id && message.role === "copilot");
    await repos.ownerCopilotMessage.create({
      workspaceId, conversationId: conversation.id, role: "copilot", kind: "copilot_confirm", tier: "T3",
      language: previous?.language === "hi" ? "hi" : "en", text: describePlan(proposed),
      pendingAction: { intent: "orchestrated_job", entityId: copy.id, entityType: "orchestration_job" },
    });
  }
  return proposed;
}

export async function getJob(workspaceId: string, jobId: string, repos: RepositoryBundle = createRepositories(), now: number = Date.now()) {
  const job = await repos.jobRun.getById(workspaceId, jobId);
  if (!job || job.jobType !== ORCHESTRATION_JOB_TYPE) throw new Error("Job not found");
  return settleIfStale(job, repos, now);
}

export type JobSummary = {
  jobId: string;
  goal: string;
  status: string;
  steps: number;
  maxCalls: number;
  llmCalls?: number;
  createdAt?: string;
  completedAt?: string;
};

/** The owner's recent master-AI jobs, newest first, for the Command Center. */
export async function listJobs(workspaceId: string, repos: RepositoryBundle = createRepositories(), limit = 20, now: number = Date.now()): Promise<JobSummary[]> {
  const recent = (await repos.jobRun.listByWorkspace(workspaceId))
    .filter((job) => job.jobType === ORCHESTRATION_JOB_TYPE)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, Math.max(1, Math.min(limit, 50)));
  const jobs: JobRun[] = [];
  for (const job of recent) jobs.push(await settleIfStale(job, repos, now));
  return jobs.map((job) => {
    const payload = (job.payload || {}) as { goal?: string; plan?: Plan; maxCalls?: number };
    const result = (job.result || {}) as { llmCalls?: number };
    return {
      jobId: job.id,
      goal: String(payload.goal || ""),
      status: job.status,
      steps: payload.plan?.subtasks?.length ?? 0,
      maxCalls: Number(payload.maxCalls || 0),
      llmCalls: typeof result.llmCalls === "number" ? result.llmCalls : undefined,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  });
}

/**
 * Discard a plan the owner decided not to run, or stop one that is running.
 * Same one-way claim as running it, so a discard and a run racing each other
 * cannot both happen.
 *
 * 2026-09-27 (A4): a RUNNING job used to be refused ("already running"), so a
 * job stuck by a restart could never be cleared. Now Stop moves it to
 * "cancelling"; the run sees that before its next group of helpers and ends as
 * "cancelled". A job that is dead rather than slow is settled by the stale
 * check first and reported as such.
 */
export async function cancelJob(workspaceId: string, jobId: string, repos: RepositoryBundle = createRepositories(), now: number = Date.now()): Promise<{ cancelled: boolean; stopping?: boolean; reason?: string }> {
  const job = await getJob(workspaceId, jobId, repos, now);
  if (await repos.jobRun.claim(workspaceId, jobId, "awaiting_confirmation", "cancelled")) {
    await repos.jobRun.update(workspaceId, jobId, { completedAt: new Date().toISOString() });
    return { cancelled: true };
  }
  if (job.status === "running" && await repos.jobRun.claim(workspaceId, jobId, "running", STOPPING)) {
    return { cancelled: true, stopping: true, reason: "Stopping. The helpers already working will finish their step; nothing new will start." };
  }
  const current = await repos.jobRun.getById(workspaceId, jobId);
  if (current?.status === STOPPING) return { cancelled: true, stopping: true, reason: "Already stopping." };
  return { cancelled: false, reason: `This job cannot be stopped: it is ${describeStatus(current?.status)}.` };
}

function describeStatus(status: string | undefined): string {
  switch (status) {
    case "running": return "already running";
    case STOPPING: return "being stopped";
    case "completed": return "already finished";
    case "partial": return "already finished (part of it worked)";
    case "failed": return "already finished and failed";
    case "rejected": return "a plan that did not pass the checks, so it was never runnable";
    case "cancelled": return "a plan you discarded";
    default: return status ? `in state "${status}"` : "missing";
  }
}

/** The plan in words, for the confirm message. */
export function describePlan(job: ProposedJob): string {
  if (!job.plan) {
    return `I could not make a plan I can safely run:\n${job.problems.map((problem) => `• ${problem}`).join("\n")}`;
  }
  const lines = job.plan.subtasks.map((task) =>
    `• ${task.id} → ${task.agent}: ${task.instruction}${task.dependsOn.length ? ` (after ${task.dependsOn.join(", ")})` : ""}`,
  );
  return [
    job.plan.summary || "Here is how I would split this up:",
    ...lines,
    "",
    `This can use up to ${job.maxCalls} AI calls${job.maxSearches ? ` and up to ${job.maxSearches} paid web searches` : ""}. Nothing is sent to customers — any messages come back as drafts.`,
  ].join("\n");
}
