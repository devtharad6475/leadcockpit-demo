/**
 * golden-orchestrator.ts — a master agent plans, subordinates do the work,
 * the master reports (N8, 2026-09-23, session 58).
 *
 * The owner's example: "find Surat manufacturers, check who we already
 * contacted, then draft outreach for the rest." Three jobs, two of them
 * dependent, handed to three different helpers.
 *
 *   CASE A — a plan naming a helper that does not exist is refused WHOLE.
 *   CASE B — plans that can never finish are refused: circles, self-waits,
 *            missing inputs, empty, too big.
 *   CASE C — independent tasks really run at the same time.
 *   CASE D — a task receives the results it depends on.
 *   CASE E — a failure upstream skips what depended on it, keeps what did not,
 *            and the status lines tell the truth whatever the summary says.
 *   CASE F — the budget is checked once per wave, BEFORE it, and a refusal
 *            stops later waves without losing earlier results.
 *   CASE G — confirming twice runs the plan once.
 *   CASE H — a subordinate stopped for approval is "waiting for you", never done.
 *   CASE I — a refused plan cannot be run.
 *   CASE J — a planner that honestly declines is quoted, not overruled.
 *   CASE K — the Copilot sends multi-part requests to the master, and does not
 *            steal ordinary "draft a reply" requests.
 *   CASE L — the new tools skip do-not-contact leads and are bounded.
 *   CASE M — running out of time skips what is left and says so.
 *   CASE N — a failed summary still leaves the owner a report.
 *   CASE O — end to end: planned, confirmed, run, reported, saved.
 *   CASE P — a valid plan in the chat comes with a button that runs it.
 *   CASE Q — (Command Center) progress is saved while the job runs: each helper
 *            shows as working, then finished, before the job ends.
 *   CASE R — (Command Center) the recent-jobs list holds only master-AI jobs,
 *            newest first, with the goal and step count.
 *   CASE S — (Command Center) discarding a plan works once, and a discarded
 *            plan can never be run; a finished job cannot be discarded.
 *
 * No case spends money: the planner, subordinates and merger are injected.
 *
 * Run: npx tsx scripts/golden/golden-orchestrator.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import {
  MAX_INSTRUCTION_CHARS,
  MAX_SUBTASKS,
  mergeReport,
  planWaves,
  runPlan,
  statusLines,
  validatePlan,
  type ChildRunner,
  type Plan,
} from "@/agents/Orchestrator";
import { cancelJob, listJobs, proposeJob, runJob } from "@/services/OrchestrationService";
import { classifyCopilotIntent, handleOwnerCopilotTurn } from "@/services/OwnerCopilotService";
import { getTool, DRAFT_BATCH_LIMIT } from "@/agents/tool-registry";
import type { AgentLoopResult } from "@/agents/AgentLoop";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let seq = 0;
const freshWorkspace = () => `ws_n8_${Date.now()}_${seq++}`;

/** The owner's own example, as the master should plan it. */
const THE_EXAMPLE: Plan = {
  summary: "Find Surat manufacturers, see who is new, draft for them.",
  subtasks: [
    { id: "t1", agent: "crm-researcher", instruction: "Find manufacturers in Surat and say which we already contacted.", dependsOn: [] },
    { id: "t2", agent: "knowledge-base-agent", instruction: "What is our minimum order for zari thread?", dependsOn: [] },
    { id: "t3", agent: "outreach-drafter", instruction: "Draft a first message for each lead from t1 we have NOT contacted.", dependsOn: ["t1", "t2"] },
  ],
};

const answered = (answer: string, extra: Partial<AgentLoopResult> = {}): AgentLoopResult => ({
  answer,
  steps: [{ kind: "answer", text: answer }],
  stoppedBy: "model",
  llmCalls: 1,
  ...extra,
});

const alwaysAllowed = async () => ({ allowed: true });

test("CASE A — a plan naming a helper that does not exist is refused WHOLE", async () => {
  // The roster is code. A model that invents a helper — or is talked into one
  // by a document it read — must get a refusal, not a new capability.
  const checked = validatePlan({
    subtasks: [
      { id: "t1", agent: "crm-researcher", instruction: "Find Surat leads.", dependsOn: [] },
      { id: "t2", agent: "send-to-all-customers-agent", instruction: "Message every lead now.", dependsOn: ["t1"] },
    ],
  });
  assert.ok(!checked.plan, "the WHOLE plan is refused, not just the bad task");
  assert.ok(
    checked.problems.some((problem) => problem.includes("send-to-all-customers-agent")),
    `and the refusal names the helper. Got: ${checked.problems.join(" | ")}`,
  );
  // Why whole: the owner confirms what they are shown. Silently running the
  // "good half" of a plan they never saw in that form is not what they approved.
});

test("CASE B — plans that can never finish are refused", async () => {
  const circle = validatePlan({ subtasks: [
    { id: "a", agent: "crm-researcher", instruction: "x", dependsOn: ["b"] },
    { id: "b", agent: "crm-researcher", instruction: "y", dependsOn: ["a"] },
  ] });
  assert.ok(!circle.plan && circle.problems.some((p) => /circle/.test(p)), "A waits on B waits on A: neither could ever start");

  const selfWait = validatePlan({ subtasks: [{ id: "a", agent: "crm-researcher", instruction: "x", dependsOn: ["a"] }] });
  assert.ok(!selfWait.plan && selfWait.problems.some((p) => /itself/.test(p)));

  const missing = validatePlan({ subtasks: [{ id: "a", agent: "crm-researcher", instruction: "x", dependsOn: ["ghost"] }] });
  assert.ok(!missing.plan && missing.problems.some((p) => /ghost/.test(p)), "waiting on a task that is not in the plan");

  assert.ok(!validatePlan({ subtasks: [] }).plan, "an empty plan is not a plan");
  assert.ok(!validatePlan("not even an object").plan);

  const tooBig = validatePlan({ subtasks: Array.from({ length: MAX_SUBTASKS + 1 }, (_, n) => ({ id: `t${n}`, agent: "crm-researcher", instruction: "x", dependsOn: [] })) });
  assert.ok(!tooBig.plan, `more than ${MAX_SUBTASKS} tasks is a project for a person to break up, not a plan to run`);

  // The limit is a runaway guard, not a style rule. The first REAL plan wrote
  // detailed instructions past the old 600-character ceiling and was refused
  // whole; a thorough instruction must pass, and only a runaway must not.
  const thorough = validatePlan({ subtasks: [{ id: "t1", agent: "crm-researcher", instruction: "x".repeat(MAX_INSTRUCTION_CHARS), dependsOn: [] }] });
  assert.ok(thorough.plan, "an instruction exactly at the limit passes");
  const runaway = validatePlan({ subtasks: [{ id: "t1", agent: "crm-researcher", instruction: "x".repeat(MAX_INSTRUCTION_CHARS + 1), dependsOn: [] }] });
  assert.ok(!runaway.plan && runaway.problems.some((p) => p.includes(String(MAX_INSTRUCTION_CHARS))), "one past it does not, and the refusal gives the number");
  assert.ok(MAX_INSTRUCTION_CHARS >= 1000, "and the limit leaves room for a real model's real instructions");

  const ok = validatePlan(THE_EXAMPLE);
  assert.ok(ok.plan, `the owner's own example must pass. Problems: ${ok.problems.join(" | ")}`);
  assert.deepStrictEqual(planWaves(ok.plan!.subtasks)!.map((wave) => wave.map((task) => task.id)), [["t1", "t2"], ["t3"]]);
});

test("CASE B2 — a step that uses another step's result waits for it, even when the planner forgot to say so", async () => {
  // Real planner output, 2026-09-26: every dependsOn empty, instructions
  // pointing back. Run as-is, the writer would draft for leads not yet found.
  const forgot = validatePlan({ subtasks: [
    { id: "t1", agent: "crm-researcher", instruction: "Search our own lead list for wholesalers located in Surat.", dependsOn: [] },
    { id: "t2", agent: "outreach-drafter", instruction: "Using the lead ids reported by the previous step, write one short first WhatsApp message per lead.", dependsOn: [] },
    { id: "t3", agent: "quality-review-agent", instruction: "Review each draft produced by t2 before the owner sees it.", dependsOn: [] },
  ] });
  assert.ok(forgot.plan, forgot.problems.join(" | "));
  assert.deepStrictEqual(planWaves(forgot.plan!.subtasks)!.map((wave) => wave.map((task) => task.id)), [["t1"], ["t2"], ["t3"]]);
  // Independent steps stay independent: nothing links steps that do not refer to each other.
  const apart = validatePlan({ subtasks: [
    { id: "t1", agent: "crm-researcher", instruction: "List Surat leads.", dependsOn: [] },
    { id: "t2", agent: "crm-researcher", instruction: "List Mumbai leads; t10 is not a step.", dependsOn: [] },
  ] });
  assert.deepStrictEqual(planWaves(apart.plan!.subtasks)!.map((wave) => wave.map((task) => task.id)), [["t1", "t2"]]);
});

test("CASE C — independent tasks really run at the same time", async () => {
  let inFlight = 0;
  let peak = 0;
  const runChild: ChildRunner = async ({ subordinate }) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 30));
    inFlight -= 1;
    return answered(`${subordinate.name} finished`);
  };
  await runPlan(validatePlan(THE_EXAMPLE).plan!, { workspaceId: freshWorkspace(), repos, runChild, checkBudget: alwaysAllowed });
  assert.strictEqual(
    peak,
    2,
    "t1 and t2 need nothing from each other, so they run together. One after the other, the owner waits for the " +
      "sum of both — and t3, which needs both, must never have been running alongside them.",
  );
});

test("CASE D — a task receives the results it depends on", async () => {
  const seen: Record<string, string> = {};
  const runChild: ChildRunner = async ({ subordinate, instructions }) => {
    seen[subordinate.name] = instructions;
    if (subordinate.name === "crm-researcher") {
      return answered("Found 2 in Surat; lead_s1 is new, lead_s2 already contacted.", {
        steps: [{ kind: "tool_call", tool: "find_leads", args: {}, result: { leads: [{ leadId: "lead_s1", contacted: false }] }, ms: 1 }, { kind: "answer", text: "ok" }],
      });
    }
    if (subordinate.name === "knowledge-base-agent") return answered("Minimum order is 5 kg.");
    return answered("Drafted 1 message.");
  };
  await runPlan(validatePlan(THE_EXAMPLE).plan!, { workspaceId: freshWorkspace(), repos, runChild, checkBudget: alwaysAllowed });

  const drafterSaw = seen["outreach-drafter"];
  assert.ok(drafterSaw.includes("lead_s1 is new"), "the drafter is told what the researcher found");
  assert.ok(drafterSaw.includes("\"leadId\":\"lead_s1\""), "including the raw tool data, so it has the lead ids and not just prose");
  assert.ok(drafterSaw.includes("Minimum order is 5 kg"), "and what the knowledge agent answered");
  assert.ok(drafterSaw.includes("Draft a first message"), "under the master's instruction for this task");
  assert.ok(!seen["crm-researcher"].includes("RESULTS FROM THE TASKS BEFORE YOURS"), "a first-wave task is handed nothing");
});

test("CASE E — a failure upstream skips what depended on it, keeps what did not", async () => {
  let drafterRan = false;
  const runChild: ChildRunner = async ({ subordinate }) => {
    if (subordinate.name === "crm-researcher") throw new Error("database unreachable");
    if (subordinate.name === "outreach-drafter") drafterRan = true;
    return answered("Minimum order is 5 kg.");
  };
  const { outcomes } = await runPlan(validatePlan(THE_EXAMPLE).plan!, { workspaceId: freshWorkspace(), repos, runChild, checkBudget: alwaysAllowed });
  const byId = Object.fromEntries(outcomes.map((outcome) => [outcome.id, outcome]));

  assert.strictEqual(byId.t1.status, "failed");
  assert.strictEqual(byId.t2.status, "done", "the knowledge answer did not need the researcher, so it is kept");
  assert.strictEqual(byId.t3.status, "skipped");
  assert.ok(byId.t3.detail.includes("t1"), "and it says which task it was waiting on");
  assert.strictEqual(
    drafterRan,
    false,
    "THE RULE: a task whose input failed does not run on nothing. A drafter handed no leads writes to 'the leads " +
      "above' when there were none — and costs money doing it.",
  );

  // The summary is a model's; the status lines are code's. A summary that
  // claims success is contradicted on the same screen by lines it cannot edit.
  const lying = await mergeReport("goal", outcomes, async () => "Everything went perfectly, all drafts are ready!");
  const lines = statusLines(outcomes);
  assert.ok(lying.summary.includes("perfectly"), "fixture: the summary lies");
  assert.ok(lines.includes("t1 · crm-researcher — Failed"), "the code-built line says Failed anyway");
  assert.ok(lines.includes("t3 · outreach-drafter — Not run"), "and Not run for the drafter");
});

test("CASE F — the budget is checked once per wave, BEFORE it", async () => {
  const checks: number[] = [];
  let calls = 0;
  const checkBudget = async (estimate: number) => {
    checks.push(estimate);
    return checks.length === 1 ? { allowed: true } : { allowed: false, reason: "monthly AI limit reached" };
  };
  const runChild: ChildRunner = async () => {
    calls += 1;
    return answered("fine");
  };
  const { outcomes } = await runPlan(validatePlan(THE_EXAMPLE).plan!, { workspaceId: freshWorkspace(), repos, runChild, checkBudget });

  assert.strictEqual(checks.length, 2, "one check per wave — not per task, and not once for the whole job");
  assert.ok(checks[0] > 0, "with an estimate of what the wave can spend");
  assert.strictEqual(calls, 2, "the refused wave's task never started: checked after, the check would have checked nothing");
  assert.strictEqual(outcomes.find((o) => o.id === "t3")!.status, "skipped");
  assert.match(outcomes.find((o) => o.id === "t3")!.detail, /spending limit/);
  assert.ok(outcomes.filter((o) => o.status === "done").length === 2, "and the first wave's results are kept, not thrown away");
});

test("CASE G — confirming twice runs the plan once", async () => {
  const workspaceId = freshWorkspace();
  let childRuns = 0;
  const seams = {
    planner: async () => THE_EXAMPLE,
    runChild: (async () => {
      childRuns += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return answered("done");
    }) as ChildRunner,
    merger: async () => "Report.",
    checkBudget: alwaysAllowed,
  };
  const proposed = await proposeJob({ workspaceId, goal: "find Surat manufacturers then draft for the rest", repos, seams });
  assert.strictEqual(proposed.status, "awaiting_confirmation");

  // A double-click: two confirms at once.
  const [first, second] = await Promise.all([
    runJob({ workspaceId, jobId: proposed.jobId, repos, seams }),
    runJob({ workspaceId, jobId: proposed.jobId, repos, seams }),
  ]);
  assert.strictEqual([first, second].filter((result) => result.ran).length, 1, "exactly one of them runs");
  assert.strictEqual(childRuns, THE_EXAMPLE.subtasks.length, "every task ran ONCE — the second click paid for nothing");
  const loser = first.ran ? second : first;
  assert.ok(!loser.ran && /already/.test(loser.reason), `and the second is told why. Got: ${!loser.ran ? loser.reason : ""}`);
});

test("CASE H — a subordinate stopped for approval is 'waiting for you', never done", async () => {
  const runChild: ChildRunner = async ({ subordinate }) =>
    subordinate.name === "crm-researcher"
      ? {
          answer: "I need your approval before I can do that.",
          steps: [{ kind: "awaiting_approval", tool: "send_whatsapp", args: { to: "all" } }],
          stoppedBy: "awaiting_approval",
          llmCalls: 1,
          pending: { tool: "send_whatsapp", input: { to: "all" }, description: "Send a WhatsApp message" },
        }
      : answered("fine");
  const { outcomes } = await runPlan(validatePlan(THE_EXAMPLE).plan!, { workspaceId: freshWorkspace(), repos, runChild, checkBudget: alwaysAllowed });
  const t1 = outcomes.find((o) => o.id === "t1")!;
  assert.strictEqual(t1.status, "waiting_for_you");
  assert.strictEqual(t1.pending?.tool, "send_whatsapp", "the exact held call is carried up for the owner to judge");
  assert.strictEqual(outcomes.find((o) => o.id === "t3")!.status, "skipped", "and nothing built on an action that has not happened runs");
});

test("CASE I — a refused plan cannot be run", async () => {
  const workspaceId = freshWorkspace();
  let childRuns = 0;
  const seams = {
    planner: async () => ({ subtasks: [{ id: "t1", agent: "invented-agent", instruction: "x", dependsOn: [] }] }),
    runChild: (async () => { childRuns += 1; return answered("no"); }) as ChildRunner,
    checkBudget: alwaysAllowed,
  };
  const proposed = await proposeJob({ workspaceId, goal: "do something", repos, seams });
  assert.strictEqual(proposed.status, "rejected");
  const record = await (repos as RepositoryBundle).jobRun.getById(workspaceId, proposed.jobId);
  assert.ok(
    String((record?.payload as { refusedPlan?: string })?.refusedPlan || "").includes("invented-agent"),
    "the refused plan is kept on record, so 'why was this refused?' can be answered instead of guessed",
  );
  const attempt = await runJob({ workspaceId, jobId: proposed.jobId, repos, seams });
  assert.strictEqual(attempt.ran, false, "there is no path from a refused plan to a running one — not even by calling run directly");
  assert.strictEqual(childRuns, 0);
});

test("CASE J — a planner that honestly declines is quoted, not overruled", async () => {
  const proposed = await proposeJob({
    workspaceId: freshWorkspace(),
    goal: "book me a flight to Dubai",
    repos,
    seams: { planner: async () => ({ summary: "None of the helpers can book travel.", subtasks: [] }) },
  });
  assert.strictEqual(proposed.status, "rejected");
  assert.deepStrictEqual(
    proposed.problems,
    ["None of the helpers can book travel."],
    "its own reason is what the owner reads — not a generic 'invalid plan' that hides an honest no",
  );
});

test("CASE K — the Copilot sends multi-part requests to the master, and steals nothing", async () => {
  const multi = classifyCopilotIntent("Find manufacturers in Surat, check who we already contacted, then draft outreach for the rest");
  assert.strictEqual(multi.intent, "orchestrated_job");
  assert.strictEqual(multi.tier, "T3", "T3: confirm before it spends — a plan is shown first, never run from the chat line");

  assert.strictEqual(classifyCopilotIntent("draft a reply to Ramesh").intent, "draft_reply", "ordinary drafting is untouched");
  assert.strictEqual(classifyCopilotIntent("what is our moq").tier, "T1", "and so is a plain question");
  assert.strictEqual(
    classifyCopilotIntent("send our price list to all leads then draft").tier,
    "T5",
    "a dangerous phrase stays dangerous: T5 is checked first and is never downgraded to a plan",
  );
});

test("CASE L — the new tools skip do-not-contact leads and are bounded", async () => {
  const workspaceId = freshWorkspace();
  const ok = await repos.lead.createLead({ workspaceId, companyName: "Surat Weavers", city: "Surat", buyerType: "Manufacturer", whatsappNumber: "+919800000001", status: "prospected" });
  const dnc = await repos.lead.createLead({ workspaceId, companyName: "Do Not Call Mills", city: "Surat", buyerType: "Manufacturer", whatsappNumber: "+919800000002", status: "prospected", doNotContact: true });
  await repos.lead.createLead({ workspaceId, companyName: "Already Talking Ltd", city: "Surat", buyerType: "Manufacturer", whatsappNumber: "+919800000003", status: "replied" });
  const context = { workspaceId, repos };

  const found = (await getTool("find_leads")!.run({ city: "surat", kind: "manufacturer" }, context)) as { leads: Array<{ leadId: string; contacted: boolean }> };
  assert.ok(!found.leads.some((lead) => lead.leadId === dnc.id), "a do-not-contact lead is never offered to a plan as a target");
  assert.strictEqual(found.leads.length, 2);

  const fresh = (await getTool("find_leads")!.run({ city: "Surat", onlyNotContacted: "yes" }, context)) as { leads: Array<{ leadId: string }> };
  assert.deepStrictEqual(fresh.leads.map((lead) => lead.leadId), [ok.id], "'who have we not contacted' answers from what happened");

  // No model call in either of these: every id is refused before drafting.
  const drafts = (await getTool("draft_outreach_messages")!.run({ leadIds: `${dnc.id},lead_missing` }, context)) as {
    drafts: Array<{ leadId: string; draft?: string; skipped?: string }>;
    sent: number;
  };
  assert.ok(drafts.drafts.every((draft) => !draft.draft), "nothing drafted");
  assert.match(drafts.drafts.find((draft) => draft.leadId === dnc.id)!.skipped || "", /do-not-contact/, "checked in the tool, not trusted to the plan");
  assert.strictEqual(drafts.sent, 0, "and the tool says out loud that it sent nothing");

  const many = Array.from({ length: DRAFT_BATCH_LIMIT + 3 }, (_, n) => `lead_missing_${n}`).join(",");
  const capped = (await getTool("draft_outreach_messages")!.run({ leadIds: many }, context)) as { drafts: unknown[]; notDrafted?: number };
  assert.strictEqual(capped.drafts.length, DRAFT_BATCH_LIMIT, "each id is a billed call, so one request is bounded");
  assert.strictEqual(capped.notDrafted, 3, "and what was left out is reported, not dropped silently");
});

test("CASE M — running out of time skips what is left, and says so", async () => {
  let clock = 0;
  const runChild: ChildRunner = async () => {
    clock += 200_000; // this wave took longer than the whole job may
    return answered("slow but done");
  };
  const { outcomes } = await runPlan(validatePlan(THE_EXAMPLE).plan!, {
    workspaceId: freshWorkspace(), repos, runChild, checkBudget: alwaysAllowed, now: () => clock, deadlineMs: 150_000,
  });
  const t3 = outcomes.find((o) => o.id === "t3")!;
  assert.strictEqual(t3.status, "skipped");
  assert.match(t3.detail, /ran out of time/);
});

test("CASE N — a failed summary still leaves the owner a report", async () => {
  const outcomes = [
    { id: "t1", agent: "crm-researcher", instruction: "x", status: "done" as const, detail: "Found 3 leads in Surat.", llmCalls: 1 },
  ];
  const merged = await mergeReport("goal", outcomes, async () => { throw new Error("provider down"); });
  assert.ok(merged.summary.includes("Found 3 leads in Surat."), "what each helper found is still true, and the owner still gets it");
});

test("CASE O — end to end: planned, confirmed, run, reported, saved", async () => {
  const workspaceId = freshWorkspace();
  const seams = {
    planner: async () => THE_EXAMPLE,
    runChild: (async ({ subordinate }) => answered(`${subordinate.name}: done`)) as ChildRunner,
    merger: async () => "Found the Surat leads and drafted messages for the new ones.",
    checkBudget: alwaysAllowed,
  };
  const proposed = await proposeJob({ workspaceId, goal: "find Surat manufacturers then draft for the rest", repos, seams });
  assert.ok(proposed.maxCalls > 0, "the owner is shown the most it can cost before saying yes");

  const result = await runJob({ workspaceId, jobId: proposed.jobId, repos, seams });
  assert.ok(result.ran);
  assert.strictEqual(result.report.status, "completed");
  assert.match(result.text, /Nothing was sent to any customer/);

  const saved = await (repos as RepositoryBundle).jobRun.getById(workspaceId, proposed.jobId);
  assert.strictEqual(saved?.status, "completed", "the job's outcome is on record, not only on the screen that showed it");
  assert.ok((saved?.result as { text?: string })?.text?.includes("What each helper did"), "with the report that was shown");
});

test("CASE P — a valid plan in the chat comes with a button that runs it", async () => {
  // Found in the browser, not by a test: the first version proposed a correct
  // plan and the chat drew no button, because the card is only drawn for
  // pending actions of known types and this one carried none. A plan the owner
  // cannot confirm is a plan that never runs.
  const workspaceId = freshWorkspace();
  const conversation = await (repos as RepositoryBundle).ownerCopilotConversation.create({ workspaceId, ownerUserId: "user_owner" } as never);
  const turn = await handleOwnerCopilotTurn({
    workspaceId,
    ownerUserId: "user_owner",
    conversationId: conversation.id,
    ownerText: "Find our wholesalers, check who we already contacted, then draft for the rest",
    repos,
    orchestrationSeams: { planner: async () => THE_EXAMPLE },
  });
  assert.strictEqual(turn.kind, "copilot_confirm");
  assert.strictEqual(turn.pendingAction?.entityType, "orchestration_job", "the type the chat draws a 'Yes, run it' button for");
  assert.ok(turn.pendingAction?.entityId, "pointing at the saved job");
  assert.match(turn.text, /t3 → outreach-drafter/, "and the owner reads who does what before saying yes");

  const refused = await handleOwnerCopilotTurn({
    workspaceId,
    ownerUserId: "user_owner",
    conversationId: conversation.id,
    ownerText: "plan and do something impossible",
    repos,
    orchestrationSeams: { planner: async () => ({ subtasks: [{ id: "t1", agent: "invented", instruction: "x", dependsOn: [] }] }) },
  });
  assert.ok(!refused.pendingAction, "a refused plan gets NO button — there is nothing safe to run");
});

test("CASE Q — progress is saved while the job runs", async () => {
  const workspaceId = freshWorkspace();
  const seen: Array<{ running: string[]; finished: string[] }> = [];
  const seams = {
    planner: async () => THE_EXAMPLE,
    runChild: (async ({ subordinate }) => {
      // Looked at from INSIDE a helper's work, the way the page polls.
      const job = (await (repos as RepositoryBundle).jobRun.listByWorkspace(workspaceId)).find((row) => row.status === "running");
      const progress = (job?.result as { progress?: { running: string[]; outcomes: Array<{ id: string }> } })?.progress;
      seen.push({ running: progress?.running || [], finished: (progress?.outcomes || []).map((o) => o.id) });
      return answered(`${subordinate.name}: done`);
    }) as ChildRunner,
    merger: async () => "ok",
    checkBudget: alwaysAllowed,
  };
  const proposed = await proposeJob({ workspaceId, goal: "the example", repos, seams });
  await runJob({ workspaceId, jobId: proposed.jobId, repos, seams });
  const first = seen.find((snap) => snap.running.includes("t1"));
  assert.ok(first, "while t1 works, the saved job says t1 is working");
  assert.deepStrictEqual([...first!.running].sort(), ["t1", "t2"], "the first wave is shown working together");
  const third = seen.find((snap) => snap.running.includes("t3"));
  assert.ok(third, "while t3 works, the saved job says so");
  assert.deepStrictEqual([...third!.finished].sort(), ["t1", "t2"], "and shows the first wave already finished");
  const saved = await (repos as RepositoryBundle).jobRun.getById(workspaceId, proposed.jobId);
  assert.strictEqual(saved?.status, "completed", "progress saves never change the job's status on their own");
});

test("CASE R — the recent-jobs list", async () => {
  const workspaceId = freshWorkspace();
  const seams = { planner: async () => THE_EXAMPLE };
  const older = await proposeJob({ workspaceId, goal: "older job", repos, seams });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = await proposeJob({ workspaceId, goal: "newer job", repos, seams });
  await (repos as RepositoryBundle).jobRun.create({ workspaceId, jobType: "something_else", status: "completed", attempts: 0, maxAttempts: 1 });
  const list = await listJobs(workspaceId, repos);
  assert.deepStrictEqual(list.map((job) => job.jobId), [newer.jobId, older.jobId], "only master-AI jobs, newest first");
  assert.strictEqual(list[0].goal, "newer job");
  assert.strictEqual(list[0].steps, 3);
  assert.strictEqual(list[0].status, "awaiting_confirmation");
  assert.ok(list[0].maxCalls > 0);
});

test("CASE S — discard works once, and a discarded plan never runs", async () => {
  const workspaceId = freshWorkspace();
  let ran = 0;
  const seams = {
    planner: async () => THE_EXAMPLE,
    runChild: (async () => { ran += 1; return answered("done"); }) as ChildRunner,
    merger: async () => "ok",
    checkBudget: alwaysAllowed,
  };
  const proposed = await proposeJob({ workspaceId, goal: "discard me", repos, seams });
  assert.deepStrictEqual(await cancelJob(workspaceId, proposed.jobId, repos), { cancelled: true });
  const again = await cancelJob(workspaceId, proposed.jobId, repos);
  assert.strictEqual(again.cancelled, false);
  const run = await runJob({ workspaceId, jobId: proposed.jobId, repos, seams });
  assert.strictEqual(run.ran, false, "a discarded plan cannot be run");
  assert.strictEqual(ran, 0, "and no helper was called");

  const finished = await proposeJob({ workspaceId, goal: "run me", repos, seams });
  await runJob({ workspaceId, jobId: finished.jobId, repos, seams });
  const late = await cancelJob(workspaceId, finished.jobId, repos);
  assert.strictEqual(late.cancelled, false, "a finished job cannot be discarded");
  assert.strictEqual((await (repos as RepositoryBundle).jobRun.getById(workspaceId, finished.jobId))?.status, "completed");
});

(async () => {
  console.log("\n=== GOLDEN: master agent and subordinates (N8) ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: orchestrator");
    process.exit(1);
  }
})();
