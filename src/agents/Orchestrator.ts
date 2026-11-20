/**
 * Orchestrator.ts — a master agent that plans, hands work to subordinates,
 * and merges what comes back (N8, 2026-09-23, session 58).
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────
 *   1. PLAN     The master reads the owner's request and writes a plan: a few
 *               tasks, each for a named subordinate, each saying which other
 *               tasks' results it needs.
 *   2. CHECK    CODE checks the plan, not the model: only subordinates on the
 *               roster, no task waiting on itself in a circle, a hard cap on how
 *               many. A plan that fails is refused whole — the owner confirms
 *               exactly what will run, never a quietly edited version of it.
 *   3. RUN      Tasks run in waves. Everything in a wave is independent, so it
 *               runs at the same time. The budget is checked once per wave,
 *               before the wave, because N tasks started together spend N times
 *               in the same instant.
 *   4. MERGE    The master writes the owner one report.
 *
 * ── HONESTY BY CONSTRUCTION ─────────────────────────────────────────────────
 * The report has two parts, and only one of them is written by a model. The
 * status of every task — done, failed, skipped, waiting for you — is built by
 * code from what actually happened. The master's summary sits above it. So a
 * model that writes "all done!" over a failed task is contradicted on the same
 * screen by a line it could not edit.
 *
 * A task whose input failed does not run on nothing. It is skipped, and says
 * which task it was waiting on. Running it anyway is how a drafter ends up
 * writing to "the leads above" when there were no leads above.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 * Send, save or spend on its own. No subordinate has such a tool today. When one
 * does, the N6 gate stops that subordinate in front of it, and this file
 * reports the task as waiting for the owner — never as done.
 */
import { runAgentLoop, type AgentLoopResult } from "./AgentLoop";
import { SUBORDINATES, getSubordinate, type Subordinate } from "./subordinates";
import { checkCanRunTask } from "@/services/AIUsageService";
import { LLMService } from "@/llm/LLMService";
import type { RepositoryBundle } from "@/repositories/interfaces";

export const MASTER_AGENT = "master-orchestrator";
/** Tasks per plan. Past this a plan is a project, and it deserves to be broken up by a person. */
export const MAX_SUBTASKS = 6;
/**
 * Per task instruction. Was 600: the first real plan (2026-09-23, DeepSeek)
 * wrote two instructions past it and the whole plan was refused. A detailed
 * instruction is not dangerous, so the ceiling only has to stop a runaway — and
 * the planner is now TOLD the limit, which it was not before.
 */
export const MAX_INSTRUCTION_CHARS = 1500;
const DEFAULT_MAX_PARALLEL = 3;
/** The whole job. Longer than this and the owner is staring at a spinner. */
export const DEFAULT_DEADLINE_MS = 150_000;
/** Why a task did not run after the owner pressed Stop. */
export const STOPPED_BY_OWNER = "You stopped the job before this task could start.";
/** Handed from one task to the next. Enough for 50 leads with ids; not a whole transcript. */
const HANDOFF_CHARS = 3500;

export type Subtask = { id: string; agent: string; instruction: string; dependsOn: string[] };
export type Plan = { summary: string; subtasks: Subtask[] };

export type TaskOutcome = {
  id: string;
  agent: string;
  instruction: string;
  status: "done" | "incomplete" | "failed" | "skipped" | "waiting_for_you";
  /** What the subordinate said, or why it did not run. */
  detail: string;
  /** Tool results, passed on to tasks that depend on this one. */
  data?: string;
  llmCalls: number;
  pending?: AgentLoopResult["pending"];
};

export type JobReport = {
  summary: string;
  outcomes: TaskOutcome[];
  llmCalls: number;
  status: "completed" | "partial" | "failed";
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. CHECK — pure, no model, no database.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a plan the master wrote. Returns the problems in plain words; a plan
 * with any problem is not run at all.
 */
export function validatePlan(raw: unknown, roster: Subordinate[] = SUBORDINATES): { plan?: Plan; problems: string[] } {
  const problems: string[] = [];
  const source = (raw && typeof raw === "object" ? raw : {}) as { summary?: unknown; subtasks?: unknown };
  const list = Array.isArray(source.subtasks) ? source.subtasks : [];
  const allowed = new Set(roster.map((agent) => agent.name));

  if (!list.length) problems.push("The plan has no tasks in it.");
  if (list.length > MAX_SUBTASKS) problems.push(`The plan has ${list.length} tasks; the limit is ${MAX_SUBTASKS}.`);

  const subtasks: Subtask[] = [];
  const ids = new Set<string>();
  list.slice(0, MAX_SUBTASKS).forEach((item, index) => {
    const task = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const id = String(task.id || `t${index + 1}`).trim().slice(0, 20);
    const agent = String(task.agent || "").trim();
    const instruction = String(task.instruction || "").trim();
    if (ids.has(id)) problems.push(`Two tasks are both called "${id}".`);
    ids.add(id);
    // THE CHECK THAT MATTERS: only helpers on the roster. The roster is code;
    // a name the model invented, or was talked into, is not a capability.
    if (!allowed.has(agent)) problems.push(`Task ${id} is given to "${agent || "nobody"}", which is not one of the helpers.`);
    if (!instruction) problems.push(`Task ${id} has no instruction.`);
    if (instruction.length > MAX_INSTRUCTION_CHARS) problems.push(`Task ${id}'s instruction is ${instruction.length} characters; the limit is ${MAX_INSTRUCTION_CHARS}.`);
    const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn.map((dep) => String(dep).trim()).filter(Boolean) : [];
    subtasks.push({ id, agent, instruction, dependsOn: [...new Set(dependsOn)] });
  });

  // A step whose instruction uses another step's result must wait for it.
  // The planner sometimes writes "the lead ids reported by the previous step"
  // but leaves dependsOn empty (seen 2026-09-26): the step would then run at
  // the same time, blind, and could draft messages for leads nobody found.
  // Only EARLIER steps are added, so this can never create a circle.
  subtasks.forEach((task, index) => {
    const earlier = subtasks.slice(0, index);
    for (const other of earlier) {
      const named = new RegExp(`\\b${other.id.replace(/[^\w-]/g, "")}\\b`, "i").test(task.instruction);
      if (named && !task.dependsOn.includes(other.id)) task.dependsOn.push(other.id);
    }
    if (index > 0 && /\b(previous|prior|earlier|above|last) (step|task)\b|\bstep before\b/i.test(task.instruction) && !task.dependsOn.length) {
      task.dependsOn.push(subtasks[index - 1].id);
    }
  });

  for (const task of subtasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) problems.push(`Task ${task.id} waits on itself.`);
      else if (!ids.has(dep)) problems.push(`Task ${task.id} waits on "${dep}", which is not in the plan.`);
    }
  }
  if (!problems.length && planWaves(subtasks) === null) {
    problems.push("Some tasks wait on each other in a circle, so none of them could ever start.");
  }

  if (problems.length) return { problems };
  return { plan: { summary: String(source.summary || "").trim().slice(0, 400), subtasks }, problems };
}

/**
 * Group tasks into waves: everything in a wave has all its inputs from earlier
 * waves, so the wave can run at once. Null when some tasks can never start.
 */
export function planWaves(subtasks: Subtask[]): Subtask[][] | null {
  const placed = new Set<string>();
  const remaining = [...subtasks];
  const waves: Subtask[][] = [];
  while (remaining.length) {
    const ready = remaining.filter((task) => task.dependsOn.every((dep) => placed.has(dep)));
    if (!ready.length) return null;
    waves.push(ready);
    for (const task of ready) {
      placed.add(task.id);
      remaining.splice(remaining.indexOf(task), 1);
    }
  }
  return waves;
}

/** The most model calls a plan can cause — shown to the owner before it runs. */
/** The most paid web searches a plan can make — shown to the owner beside the AI calls. */
export function maxSearchesFor(plan: Plan): number {
  return plan.subtasks.reduce((sum, task) => sum + (getSubordinate(task.agent)?.webSearchesPerRun ?? 0), 0);
}

export function maxCallsFor(plan: Plan): number {
  const children = plan.subtasks.reduce((sum, task) => {
    const agent = getSubordinate(task.agent);
    return sum + (agent ? agent.maxSteps + 1 + (agent.extraCallsPerRun || 0) : 0);
  }, 0);
  return children + 1; // + the merge
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PLAN
// ─────────────────────────────────────────────────────────────────────────────

export type PlannerCall = (input: { goal: string; roster: Subordinate[] }) => Promise<unknown>;

export function plannerPrompt(goal: string, roster: Subordinate[] = SUBORDINATES): string {
  return `You are the MASTER agent for a B2B sales team. You do not do the work yourself. You split the owner's request into a few tasks and give each one to a helper.

HELPERS YOU CAN GIVE WORK TO — no others exist:
${roster.map((agent) => `- ${agent.name}: ${agent.role}`).join("\n")}

RULES:
- Use as FEW tasks as the request needs. At most ${MAX_SUBTASKS}.
- A task that needs another task's result lists that task's id in "dependsOn". Tasks with no dependency run at the same time.
- Write each instruction so the helper can act on it alone: say exactly what to find or write, and what to report back. Keep each instruction under ${MAX_INSTRUCTION_CHARS} characters.
- Nobody sends, saves or buys anything. Messages are DRAFTED for the owner to review.
- If these helpers cannot do what was asked, return no tasks and explain why in "summary".
- "summary" is shown to the business owner: plain words, no helper names, task ids or system codes (say "look through your leads", not "the crm-researcher runs t1").

THE OWNER'S REQUEST:
${goal}

Reply with one JSON object only:
{"summary": "<one sentence: what you will do>", "subtasks": [{"id": "t1", "agent": "<helper name>", "instruction": "<what to do>", "dependsOn": []}]}`;
}

export function realPlanner(workspaceId: string, repos: RepositoryBundle): PlannerCall {
  return async ({ goal, roster }) => {
    const result = await new LLMService(undefined, repos).runTask<Record<string, unknown>>(
      "campaign_planning",
      { goal },
      { workspaceId, overridePrompt: plannerPrompt(goal, roster) },
    );
    return result.output || {};
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. RUN
// ─────────────────────────────────────────────────────────────────────────────

export type ChildRunner = (input: {
  subordinate: Subordinate;
  instructions: string;
  question: string;
  timeoutMs: number;
}) => Promise<AgentLoopResult>;

export type RunOptions = {
  workspaceId: string;
  repos: RepositoryBundle;
  /** Test seam: runs one subordinate. The real one is the ordinary agent loop. */
  runChild?: ChildRunner;
  /** Test seam: the per-wave budget check. */
  checkBudget?: (estimatedCalls: number) => Promise<{ allowed: boolean; reason?: string }>;
  maxParallel?: number;
  deadlineMs?: number;
  now?: () => number;
  /**
   * Called as the job moves: when a batch of helpers starts, and when it
   * finishes. The Command Center page shows it live. Never allowed to break the
   * run — a failed progress save is swallowed by the caller.
   */
  onProgress?: (snapshot: JobProgress) => void | Promise<void>;
  /**
   * 2026-09-27 (A4): asked before each wave and each batch. True means the
   * owner pressed Stop — the rest is skipped, and nothing more is paid for.
   * A batch already running finishes; a model call cannot be taken back.
   */
  shouldStop?: () => Promise<boolean>;
};

/** Where a running job is: what has finished, and what is working right now. */
export type JobProgress = { outcomes: TaskOutcome[]; running: string[]; llmCalls: number };

export async function runPlan(plan: Plan, options: RunOptions): Promise<{ outcomes: TaskOutcome[]; llmCalls: number }> {
  const waves = planWaves(plan.subtasks);
  if (!waves) throw new Error("Cannot run a plan whose tasks wait on each other in a circle.");
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const maxParallel = Math.max(1, options.maxParallel ?? DEFAULT_MAX_PARALLEL);
  const runChild = options.runChild ?? realChildRunner(options.workspaceId, options.repos);
  const checkBudget = options.checkBudget ?? (async (calls: number) => {
    const allowed = await checkCanRunTask(options.workspaceId, "message_generation", calls * 1500, 0, options.repos);
    return { allowed: allowed.allowed, reason: allowed.reason };
  });

  const byId = new Map<string, TaskOutcome>();
  let llmCalls = 0;
  let stopped = false;
  const stopRequested = async () => {
    if (stopped || !options.shouldStop) return stopped;
    try {
      stopped = await options.shouldStop();
    } catch {
      // Not knowing is not a stop: the owner confirmed this run.
    }
    return stopped;
  };
  const progress = async (running: string[]) => {
    if (!options.onProgress) return;
    try {
      await options.onProgress({ outcomes: plan.subtasks.flatMap((task) => byId.get(task.id) ?? []), running, llmCalls });
    } catch {
      // Progress is for the screen. The work does not stop for it.
    }
  };

  for (const wave of waves) {
    const runnable: Subtask[] = [];
    for (const task of wave) {
      // A task whose input did not arrive is skipped, and says which one. Run
      // on nothing, a drafter writes to "the leads above" when there were none.
      const blocked = task.dependsOn.filter((dep) => byId.get(dep)?.status !== "done");
      if (blocked.length) {
        byId.set(task.id, skipped(task, `It needed the result of ${blocked.join(", ")}, which did not finish.`));
        continue;
      }
      runnable.push(task);
    }
    if (!runnable.length) continue;

    if (await stopRequested()) {
      for (const task of runnable) byId.set(task.id, skipped(task, STOPPED_BY_OWNER));
      continue;
    }

    if (now() > deadline) {
      for (const task of runnable) byId.set(task.id, skipped(task, "The job ran out of time before this task could start."));
      continue;
    }

    // ONE budget check per wave, BEFORE the wave. Checked after, it checks
    // nothing: the wave's calls have already been made.
    const estimate = runnable.reduce((sum, task) => {
      const agent = getSubordinate(task.agent);
      return sum + (agent ? agent.maxSteps + 1 + (agent.extraCallsPerRun || 0) : 0);
    }, 0);
    const budget = await checkBudget(estimate);
    if (!budget.allowed) {
      for (const task of runnable) byId.set(task.id, skipped(task, `Stopped by the AI spending limit: ${budget.reason || "limit reached"}.`));
      continue;
    }

    for (let offset = 0; offset < runnable.length; offset += maxParallel) {
      const batch = runnable.slice(offset, offset + maxParallel);
      if (offset > 0 && (await stopRequested())) {
        for (const task of runnable.slice(offset)) byId.set(task.id, skipped(task, STOPPED_BY_OWNER));
        break;
      }
      await progress(batch.map((task) => task.id));
      const settled = await Promise.all(batch.map((task) => runOne(task)));
      for (const outcome of settled) {
        byId.set(outcome.id, outcome);
        llmCalls += outcome.llmCalls;
      }
      await progress([]);
    }
  }

  return { outcomes: plan.subtasks.map((task) => byId.get(task.id)!), llmCalls };

  async function runOne(task: Subtask): Promise<TaskOutcome> {
    const subordinate = getSubordinate(task.agent);
    // Re-checked at run time, not trusted from the plan: the roster may have
    // changed between the owner confirming and the job running.
    if (!subordinate) return { ...base(task), status: "failed", detail: `"${task.agent}" is not a helper any more.` };
    const handoff = task.dependsOn
      .map((dep) => {
        const input = byId.get(dep)!;
        return `From ${dep} (${input.agent}): ${input.detail}${input.data ? `\nData: ${input.data}` : ""}`;
      })
      .join("\n\n")
      .slice(0, HANDOFF_CHARS * Math.max(1, task.dependsOn.length));
    const instructions = [
      subordinate.instructions,
      "",
      "YOUR TASK, FROM THE MASTER AGENT:",
      task.instruction,
      "",
      // 2026-09-25: a helper answered in raw JSON, which the owner then saw in
      // its findings panel. The owner reads these; they are not for a parser.
      "Write your answer as plain sentences and short '- ' lists. Never as JSON or code.",
      ...(handoff ? ["", "RESULTS FROM THE TASKS BEFORE YOURS:", handoff] : []),
    ].join("\n");
    try {
      const result = await runChild({
        subordinate,
        instructions,
        question: task.instruction,
        timeoutMs: Math.max(5_000, Math.min(60_000, deadline - now())),
      });
      const data = result.steps
        .filter((step): step is Extract<typeof step, { kind: "tool_call" }> => step.kind === "tool_call")
        .map((step) => JSON.stringify(step.result))
        .join("\n")
        .slice(0, HANDOFF_CHARS);
      if (result.stoppedBy === "awaiting_approval") {
        return { ...base(task), status: "waiting_for_you", detail: result.answer, data, llmCalls: result.llmCalls, pending: result.pending };
      }
      if (result.stoppedBy !== "model") {
        // Stopped by a brake — steps, budget, time. It may have a half answer;
        // it is still not "done", and a task depending on it must not run.
        return { ...base(task), status: "incomplete", detail: result.answer, data, llmCalls: result.llmCalls };
      }
      return { ...base(task), status: "done", detail: result.answer, data, llmCalls: result.llmCalls };
    } catch (error) {
      // One subordinate failing must not take the others' results with it.
      return { ...base(task), status: "failed", detail: `It failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

function base(task: Subtask): Pick<TaskOutcome, "id" | "agent" | "instruction" | "llmCalls"> {
  return { id: task.id, agent: task.agent, instruction: task.instruction, llmCalls: 0 };
}

function skipped(task: Subtask, why: string): TaskOutcome {
  return { ...base(task), status: "skipped", detail: why };
}

export function realChildRunner(workspaceId: string, repos: RepositoryBundle): ChildRunner {
  return ({ subordinate, instructions, question, timeoutMs }) =>
    runAgentLoop({
      agentName: subordinate.name,
      workspaceId,
      instructions,
      question,
      repos,
      maxSteps: subordinate.maxSteps,
      maxWebSearches: subordinate.webSearchesPerRun ?? 0,
      timeoutMs,
      // The master is on the chain, so a subordinate that asks another agent
      // counts from depth 1, and none of them can ask the master back.
      depth: 1,
      callStack: [MASTER_AGENT],
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. MERGE
// ─────────────────────────────────────────────────────────────────────────────

export type MergerCall = (input: { goal: string; outcomes: TaskOutcome[] }) => Promise<string>;

export function realMerger(workspaceId: string, repos: RepositoryBundle): MergerCall {
  return async ({ goal, outcomes }) => {
    const prompt = `You are the MASTER agent reporting back to the business owner.

The owner asked: ${goal}

What each helper reported:
${outcomes.map((outcome) => `- ${outcome.id} (${outcome.agent}) — ${outcome.status.toUpperCase()}: ${outcome.detail}`).join("\n")}

Write the owner a short report in plain words: what was found, what was drafted, and what still needs them.
RULES: If a task is FAILED, SKIPPED, INCOMPLETE or WAITING_FOR_YOU, say so — never describe it as done. Write for a business owner: never use system codes or ids (hot_lead, closed_won, do_not_contact, lead_won_1, t1) — say \"a hot lead\", \"a past customer\", \"asked not to be contacted\", and name leads by company. Nothing was sent to any customer; never say it was. Include the drafts themselves if there are any.

Return JSON: {"text": "<the report>"}`;
    const result = await new LLMService(undefined, repos).runTask<{ text?: string }>(
      "message_generation",
      { goal },
      { workspaceId, overridePrompt: prompt },
    );
    return String(result.output?.text || "").trim();
  };
}

const STATUS_WORDS: Record<TaskOutcome["status"], string> = {
  done: "Done",
  incomplete: "Stopped part-way",
  failed: "Failed",
  skipped: "Not run",
  waiting_for_you: "Waiting for your approval",
};

/** The part of the report no model writes: what actually happened to each task. */
export function statusLines(outcomes: TaskOutcome[]): string {
  return outcomes.map((outcome) => `• ${outcome.id} · ${outcome.agent} — ${STATUS_WORDS[outcome.status]}${outcome.status === "done" ? "" : `: ${outcome.detail}`}`).join("\n");
}

export function overallStatus(outcomes: TaskOutcome[]): JobReport["status"] {
  const done = outcomes.filter((outcome) => outcome.status === "done").length;
  if (done === outcomes.length) return "completed";
  return done ? "partial" : "failed";
}

export async function mergeReport(
  goal: string,
  outcomes: TaskOutcome[],
  merger: MergerCall,
): Promise<{ summary: string; mergeCalls: number }> {
  let summary = "";
  try {
    summary = await merger({ goal, outcomes });
  } catch (error) {
    console.warn(`[orchestrator] merge failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!summary) {
    // No model summary is not no report. What each helper said is still true,
    // and the owner still gets it.
    summary = outcomes
      .filter((outcome) => outcome.status === "done")
      .map((outcome) => `${outcome.agent}: ${outcome.detail}`)
      .join("\n\n") || "None of the tasks finished, so there is nothing to report yet.";
  }
  return { summary, mergeCalls: 1 };
}
