/**
 * golden-agent-memory-fixes.ts — what the AI reads and remembers stays true,
 * and a master-AI job can always be ended (review fixes, 2026-09-27).
 *
 *   CASE A1  — a draft the owner REJECTED never reaches the model's history;
 *              what was actually sent (approved, or sent on its own) does.
 *   CASE A2a — the owner can edit the note: saved as theirs, audited,
 *              workspace-scoped, plain errors.
 *   CASE A2b — the owner takes the note over WHILE the AI is writing: the AI's
 *              write is skipped, the owner's words stand.
 *   CASE A2c — clearing the note hands it back as "ai" (not undefined, which
 *              Prisma reads as "leave it owner").
 *   CASE A7  — two refreshes of one lead finish in order: the newer note wins.
 *   CASE A3  — adding a note to old corrections does not send them to the
 *              paid model again; three NEW corrections still do.
 *   CASE A4a — a job left "running" by a restart is settled as failed with a
 *              plain reason when read, and can be run again as a fresh copy.
 *   CASE A4b — a job running NOW is not touched by that check.
 *   CASE A4c — Stop on a running job: nothing new starts, no merge is paid
 *              for, the job ends "cancelled".
 *
 * No case spends money: summarisers, proposers, helpers and mergers are injected.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-agent-memory-fixes.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createJsonRepos } from "./_helpers/provider";
import { gatherHistoryText } from "@/services/ConversationSummaryService";
import * as LeadMemory from "@/services/LeadMemoryService";
import { considerLearning } from "@/services/LearnedRuleService";
import * as Orchestration from "@/services/OrchestrationService";
import { ORCHESTRATION_JOB_TYPE, getJob, listJobs, runJob, cancelJob } from "@/services/OrchestrationService";
import type { Plan } from "@/agents/Orchestrator";
import type { AgentLoopResult } from "@/agents/AgentLoop";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let seq = 0;
const freshWorkspace = () => `ws_amf_${Date.now()}_${seq++}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function leadWithReply(workspaceId: string, extra: Record<string, unknown> = {}) {
  const lead = await repos.lead.createLead({ workspaceId, companyName: "Ambica Textiles", whatsappNumber: "+919800000001", status: "replied" });
  const reply = await repos.reply.create({
    workspaceId, leadId: lead.id, channel: "whatsapp", direction: "inbound",
    rawText: "What is your delivery time to Surat?", ...extra,
  } as never);
  return { lead, reply };
}

// ── A1 ─────────────────────────────────────────────────────────────────────
test("CASE A1 — only what the customer said and what was actually sent reaches the model", async () => {
  const ws = freshWorkspace();
  const REJECTED = "We deliver to Surat in 2 days with free shipping.";
  const { lead, reply } = await leadWithReply(ws, { suggestedResponse: REJECTED });
  const log = await repos.autoReplyLog.create(ws, { leadId: lead.id, replyId: reply.id, channel: "whatsapp", incomingMessage: "What is your delivery time to Surat?", generatedReply: REJECTED, status: "held_for_review" });
  await repos.autoReplyLog.reject(ws, log.id);

  const AUTO = "Hello! Our catalogue is attached.";
  await repos.autoReplyLog.create(ws, { leadId: lead.id, channel: "whatsapp", incomingMessage: "hi, catalogue?", generatedReply: AUTO, status: "auto_sent", sendStatus: "sent" });
  const APPROVED = "Delivery to Surat is 5 working days.";
  await repos.outreachActivity.create({ workspaceId: ws, leadId: lead.id, channel: "whatsapp", direction: "outbound", status: "sent_api", body: APPROVED, activityAt: new Date().toISOString() } as never);

  const { text } = await gatherHistoryText(ws, lead.id, repos);
  assert.ok(!text.includes("2 days with free shipping"),
    `THE BUG: a draft the owner rejected was fed to reply drafting and the customer memory as if the customer had been told it. History:\n${text}`);
  assert.ok(text.includes("What is your delivery time to Surat?"), "what the customer said stays");
  assert.ok(text.includes(APPROVED), "what the owner approved and sent stays");
  assert.ok(text.includes(AUTO), `a reply the AI sent on its own was actually sent, so the model must know it. History:\n${text}`);

  // And end to end: the memory summariser never sees the rejected draft.
  let seen = "";
  await LeadMemory.rememberConversation(ws, lead.id, repos, { summarise: async (history) => { seen = history; return "NOTHING YET"; } });
  assert.ok(seen && !seen.includes("2 days with free shipping"), "the customer memory is not built from a rejected draft");
});

// ── A2 ─────────────────────────────────────────────────────────────────────
test("CASE A2a — the owner edits the note: theirs, audited, scoped, plain errors", async () => {
  const edit = (LeadMemory as Record<string, unknown>).editLeadMemoryAsOwner as
    | ((ws: string, leadId: string, memory: unknown, actor: string, r: typeof repos) => Promise<{ conversationMemory?: string; conversationMemorySource?: string }>)
    | undefined;
  assert.ok(typeof edit === "function", "THE BUG: setOwnerLeadMemory had no caller — the owner could not correct the AI's note at all");
  const ws = freshWorkspace();
  const { lead } = await leadWithReply(ws);
  await LeadMemory.rememberConversation(ws, lead.id, repos, { summarise: async () => "Buys 200 kg a month." });

  const saved = await edit!(ws, lead.id, "Buys 50 kg a month, not 200.", "user_owner_1", repos);
  assert.strictEqual(saved.conversationMemory, "Buys 50 kg a month, not 200.");
  assert.strictEqual(saved.conversationMemorySource, "owner", "marked as the owner's, so the AI stops rewriting it");
  const audit = (await repos.auditLog.listByWorkspace(ws)).find((row) => row.eventType === "lead.memory_edited" && row.entityId === lead.id);
  assert.ok(audit, "the edit is audited — this note is read before every reply");
  assert.strictEqual(audit!.actorUserId, "user_owner_1");

  await assert.rejects(() => edit!(ws, lead.id, 42, "user_owner_1", repos), (error: Error & { statusCode?: number }) => error.name === "NeedsActionError" && error.statusCode === 400);
  await assert.rejects(() => edit!(ws, lead.id, "x".repeat(LeadMemory.LEAD_MEMORY_MAX_CHARS + 1), "user_owner_1", repos), (error: Error & { statusCode?: number }) => error.statusCode === 400 && /700/.test(error.message));
  await assert.rejects(() => edit!(freshWorkspace(), lead.id, "note", "user_owner_1", repos), (error: Error & { statusCode?: number }) => error.statusCode === 404,
    "another company cannot edit this lead's note");

  // The route exists, and sits under the sales-member "leads" prefix.
  const route = readFileSync(path.resolve(process.cwd(), "src/app/api/[[...path]]/route.ts"), "utf8");
  assert.ok(route.includes('match(path, ["leads", ":id", "memory"])') && route.includes("editLeadMemoryAsOwner"), "PUT /api/leads/:id/memory is wired");
  const panel = readFileSync(path.resolve(process.cwd(), "src/app/sections/BuyerFacts.tsx"), "utf8");
  assert.ok(panel.includes("/memory`") && panel.includes("Textarea"), "the customer panel has an edit box for the note");
});

test("CASE A2b — the owner takes over while the AI is writing: the owner's words stand", async () => {
  const ws = freshWorkspace();
  const { lead } = await leadWithReply(ws);
  const OWNER = "Owner: buys from Surat, 500 kg.";
  const result = await LeadMemory.rememberConversation(ws, lead.id, repos, {
    summarise: async () => {
      // The owner saves while the model call is in flight.
      await LeadMemory.setOwnerLeadMemory(ws, lead.id, OWNER, repos);
      return "AI: buys from Kolkata, 200 kg.";
    },
  });
  const after = await repos.lead.getLeadById(ws, lead.id);
  assert.strictEqual(after?.conversationMemory, OWNER,
    "THE BUG: the owner flag was checked before the model call and the write came after it, so the AI overwrote the owner's correction");
  assert.strictEqual(after?.conversationMemorySource, "owner");
  assert.strictEqual(result.updated, false);
  assert.strictEqual(result.reason, "owner_edited");
});

test("CASE A2c — clearing the note hands it back as \"ai\", on every database", async () => {
  const ws = freshWorkspace();
  const { lead } = await leadWithReply(ws);
  await LeadMemory.setOwnerLeadMemory(ws, lead.id, "owner text", repos);
  const cleared = await LeadMemory.setOwnerLeadMemory(ws, lead.id, "", repos);
  assert.strictEqual(cleared.conversationMemorySource, "ai",
    "undefined is 'leave unchanged' to Prisma, so clearing left the lead marked owner and the AI locked out for good");
});

test("CASE A7 — two refreshes of one lead finish in order", async () => {
  const ws = freshWorkspace();
  const { lead } = await leadWithReply(ws);
  // The first refresh is slow (older history), the second fast (newer history).
  const first = LeadMemory.rememberConversation(ws, lead.id, repos, { summarise: async () => { await sleep(60); return "OLD note from the earlier message."; } });
  await sleep(5);
  const second = LeadMemory.rememberConversation(ws, lead.id, repos, { summarise: async () => "NEW note from the latest message." });
  await Promise.all([first, second]);
  const after = await repos.lead.getLeadById(ws, lead.id);
  assert.strictEqual(after?.conversationMemory, "NEW note from the latest message.",
    "unserialised, the slow older refresh finished last and put the stale note on top");
});

// ── A3 ─────────────────────────────────────────────────────────────────────
test("CASE A3 — a note on old corrections does not pay for them again", async () => {
  const ws = freshWorkspace();
  const correct = async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const log = await repos.autoReplyLog.create(ws, { leadId: `l${seq}_${i}`, channel: "whatsapp", incomingMessage: "moq?", generatedReply: "Our MOQ is 10 kg for all items.", status: "held_for_review", classification: "moq_request" });
      await repos.autoReplyLog.approve(ws, log.id, { generatedReply: "Minimum order is 25 kg per shade, mixed shades allowed.", aiDraft: "Our MOQ is 10 kg for all items.", ownerEdited: true });
      ids.push(log.id);
    }
    return ids;
  };
  let calls = 0;
  const propose = async () => { calls++; return { found: false }; };

  const ids = await correct();
  await considerLearning(ws, "moq_request", repos, { propose });
  assert.strictEqual(calls, 1, "fixture: three corrections are looked at once");
  await sleep(15);
  for (const id of ids) await repos.autoReplyLog.updateNote(ws, id, "checked with the customer");
  const again = await considerLearning(ws, "moq_request", repos, { propose });
  assert.strictEqual(calls, 1,
    `THE BUG: a note bumps updatedAt, and the same three corrections were sent to the paid model again (reason ${again.reason}, corrections ${again.corrections})`);
  assert.strictEqual(again.reason, "not_enough_corrections");

  await correct();
  await considerLearning(ws, "moq_request", repos, { propose });
  assert.strictEqual(calls, 2, "three NEW corrections are still looked at — the fix must not blind the check");
});

// ── A4 ─────────────────────────────────────────────────────────────────────
const TWO_WAVES: Plan = {
  summary: "Find leads, then draft.",
  subtasks: [
    { id: "t1", agent: "crm-researcher", instruction: "Find manufacturers in Surat.", dependsOn: [] },
    { id: "t2", agent: "outreach-drafter", instruction: "Draft a first message for each lead from t1.", dependsOn: ["t1"] },
  ],
};
const answered = (answer: string): AgentLoopResult => ({ answer, steps: [{ kind: "answer", text: answer }], stoppedBy: "model", llmCalls: 1 });
const alwaysAllowed = async () => ({ allowed: true });

async function job(ws: string, status: string, startedAgoMs: number) {
  const created = await repos.jobRun.create({
    workspaceId: ws, jobType: ORCHESTRATION_JOB_TYPE, status,
    payload: { goal: "find buyers in Surat", plan: TWO_WAVES, problems: [], maxCalls: 10, maxSearches: 0 } as never,
    attempts: 0, maxAttempts: 1,
  });
  await repos.jobRun.update(ws, created.id, { startedAt: new Date(Date.now() - startedAgoMs).toISOString() });
  return created;
}

test("CASE A4a — a job left running by a restart is settled, and can be run again", async () => {
  const ws = freshWorkspace();
  const stuck = await job(ws, "running", 3 * 86_400_000);
  const read = await getJob(ws, stuck.id, repos);
  assert.strictEqual(read.status, "failed", "THE BUG: a job left 'running' by a restart stayed running forever");
  assert.match(String(read.errorMessage), /interrupted/i);
  assert.match(String(read.errorMessage), /run it again/i, "the reason tells the owner what to do");
  const listed = (await listJobs(ws, repos)).find((row) => row.jobId === stuck.id);
  assert.strictEqual(listed?.status, "failed", "the list shows it too");

  const again = (Orchestration as Record<string, unknown>).copyJobToRunAgain as
    | ((ws: string, id: string, r: typeof repos) => Promise<{ jobId: string; status: string }>)
    | undefined;
  assert.ok(typeof again === "function", "the owner can run a fresh copy");
  const copy = await again!(ws, stuck.id, repos);
  assert.notStrictEqual(copy.jobId, stuck.id, "a NEW job; the old one keeps its record");
  assert.strictEqual(copy.status, "awaiting_confirmation", "and it waits for the owner's go-ahead like any plan");
  const ran = await runJob({ workspaceId: ws, jobId: copy.jobId, repos, seams: { runChild: async () => answered("done"), checkBudget: alwaysAllowed, merger: async () => "Report." } });
  assert.ok(ran.ran, "the copy runs");
  assert.strictEqual((await getJob(ws, stuck.id, repos)).status, "failed", "the old one stays failed");
});

test("CASE A4b — a job that is running right now is left alone", async () => {
  const ws = freshWorkspace();
  const live = await job(ws, "running", 5_000);
  assert.strictEqual((await getJob(ws, live.id, repos)).status, "running");
});

test("CASE A4c — Stop on a running job: nothing new starts, no merge is paid for", async () => {
  const ws = freshWorkspace();
  const created = await job(ws, "awaiting_confirmation", 0);
  const started: string[] = [];
  let merges = 0;
  let stopAnswer: { cancelled: boolean; stopping?: boolean } | undefined;
  const result = await runJob({
    workspaceId: ws, jobId: created.id, repos,
    seams: {
      checkBudget: alwaysAllowed,
      merger: async () => { merges++; return "Report."; },
      runChild: async ({ subordinate }) => {
        started.push(subordinate.name);
        // The owner presses Stop while the first helper works.
        stopAnswer = await cancelJob(ws, created.id, repos);
        return answered("found 3 leads");
      },
    },
  });
  assert.ok(stopAnswer?.cancelled && stopAnswer.stopping, `THE BUG: a running job could not be stopped. Got ${JSON.stringify(stopAnswer)}`);
  assert.deepStrictEqual(started, ["crm-researcher"], "the second step never started");
  assert.strictEqual(merges, 0, "the owner said stop: no paid summary afterwards");
  const after = await getJob(ws, created.id, repos);
  assert.strictEqual(after.status, "cancelled");
  assert.ok(result.ran && result.report.outcomes.find((o) => o.id === "t2")?.status === "skipped", "and the report says step 2 was skipped");
});

(async () => {
  console.log("\n=== GOLDEN: agent memory, learned-rule and job fixes (2026-09-27) ===\n");
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
    console.log("❌ GOLDEN FAILED: agent-memory-fixes");
    process.exit(1);
  }
})();
