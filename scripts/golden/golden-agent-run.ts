/**
 * golden-agent-run.ts — AgentRunService lifecycle state machine (NEW, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   AgentRunService records every agent execution (start → complete/fail) as an
 *   auditable run. It had NO golden test (gap-analysis finding). This is the
 *   trail that proves "the agent ran, here's what it did". If the status
 *   transitions break, a failed run could be logged as completed (masking
 *   errors) or a completed run as failed (false alarms). Both are silent
 *   integrity bugs in the audit trail.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — startAgentRun creates a run with status="running" + startedAt set.
 *     Hand-computed: a fresh run is ALWAYS "running" until explicitly completed.
 *
 *   CASE B — completeAgentRun flips status → "completed" + stores output +
 *     sets completedAt. The output payload round-trips exactly.
 *
 *   CASE C — failAgentRun flips status → "failed" + captures errorMessage +
 *     sets completedAt. An Error's .message is used; a non-Error is stringified.
 *
 *   CASE D — logAgentRun wraps a handler: success path → run completed with the
 *     handler's result in output; the SAME result is returned to the caller.
 *
 *   CASE E — logAgentRun on a THROWING handler → run status="failed" with the
 *     error message captured AND the error is RE-THROWN (never swallowed).
 *     This is the no-silent-failure rule: a failing agent run must surface.
 *
 * REAL PIPELINE: imports the REAL AgentRunService + the REAL JSON repo. Unique
 * timestamped workspace per case.
 *
 * Run: `npm run golden:agent-run`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { AgentRunService } from "@/services/AgentRunService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_agentrun_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

test("CASE A — startAgentRun creates a run with status=running + startedAt set", async () => {
  const repos = createJsonRepos();
  const svc = new AgentRunService(repos);
  const WS = caseWorkspace("A");
  const run = await svc.startAgentRun({ workspaceId: WS, agentName: "whatsapp_reply", entityType: "lead", entityId: "lead1" });
  assert.strictEqual(run.status, "running", "a freshly started run is running");
  assert.ok(run.startedAt, "startedAt is set");
  assert.strictEqual(run.workspaceId, WS, "workspaceId is scoped to the caller");
});

test("CASE B — completeAgentRun flips status → completed + stores output round-trip", async () => {
  const repos = createJsonRepos();
  const svc = new AgentRunService(repos);
  const WS = caseWorkspace("B");
  const run = await svc.startAgentRun({ workspaceId: WS, agentName: "whatsapp_reply", entityType: "lead", entityId: "lead1" });
  const output = { reply: "Hello, thanks for your enquiry.", tokensUsed: 42 };
  const completed = await svc.completeAgentRun(WS, run.id, output);
  assert.strictEqual(completed.status, "completed", "status flipped to completed");
  assert.ok(completed.completedAt, "completedAt is set");
  // Output round-trips exactly (no mutation, no truncation).
  assert.deepStrictEqual(completed.output, output, "the exact output payload is stored");
});

test("CASE C — failAgentRun flips status → failed + captures errorMessage (Error + non-Error)", async () => {
  const repos = createJsonRepos();
  const svc = new AgentRunService(repos);
  const WS = caseWorkspace("C");

  // Subcase 1: a real Error → its .message is captured.
  const run1 = await svc.startAgentRun({ workspaceId: WS, agentName: "whatsapp_reply", entityType: "lead", entityId: "lead1" });
  const failed1 = await svc.failAgentRun(WS, run1.id, new Error("LLM provider timed out"));
  assert.strictEqual(failed1.status, "failed", "status flipped to failed");
  assert.strictEqual(failed1.errorMessage, "LLM provider timed out", "Error.message captured verbatim");
  assert.ok(failed1.completedAt, "completedAt set even on failure (run ended)");

  // Subcase 2: a non-Error throw → stringified, not lost.
  const run2 = await svc.startAgentRun({ workspaceId: WS, agentName: "whatsapp_reply", entityType: "lead", entityId: "lead2" });
  const failed2 = await svc.failAgentRun(WS, run2.id, "string error thrown");
  assert.strictEqual(failed2.status, "failed", "non-Error path also marks failed");
  assert.ok(typeof failed2.errorMessage === "string" && failed2.errorMessage.length > 0, "non-Error is stringified into errorMessage (never lost)");
});

test("CASE D — logAgentRun success path → run completed + handler result returned", async () => {
  const repos = createJsonRepos();
  const svc = new AgentRunService(repos);
  const WS = caseWorkspace("D");
  const handlerResult = { ok: true, value: 7 };
  // logAgentRun wraps the handler; on success the run completes AND the result
  // is returned to the caller (so callers don't lose the return value).
  const returned = await svc.logAgentRun(
    { workspaceId: WS, agentName: "whatsapp_reply", entityType: "lead", entityId: "lead1" },
    async () => handlerResult,
  );
  assert.deepStrictEqual(returned, handlerResult, "logAgentRun returns the handler's result to the caller");
  // Verify the run was recorded as completed.
  const runs = await repos.agentRun.listRecent(WS, 10);
  assert.ok(runs.length >= 1, "a run record was created");
  const last = runs[runs.length - 1];
  assert.strictEqual(last.status, "completed", "the wrapping run ended completed");
});

test("CASE E — logAgentRun on a THROWING handler → run failed + error RE-THROWN (no silent swallow)", async () => {
  const repos = createJsonRepos();
  const svc = new AgentRunService(repos);
  const WS = caseWorkspace("E");
  // The no-silent-failure rule: a throwing handler must mark the run failed
  // AND re-throw so the caller sees the error (never swallowed).
  let caught: unknown = null;
  try {
    await svc.logAgentRun(
      { workspaceId: WS, agentName: "whatsapp_reply", entityType: "lead", entityId: "lead1" },
      async () => { throw new Error("handler exploded"); },
    );
  } catch (e) { caught = e; }
  assert.ok(caught instanceof Error, "the error was RE-THROWN to the caller (not swallowed)");
  assert.strictEqual((caught as Error).message, "handler exploded", "the original error message is preserved");

  // And the run was recorded as failed with the message.
  const runs = await repos.agentRun.listRecent(WS, 10);
  const last = runs[runs.length - 1];
  assert.strictEqual(last.status, "failed", "the wrapping run ended failed");
  assert.strictEqual(last.errorMessage, "handler exploded", "errorMessage captured in the run record");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`agent-run: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
