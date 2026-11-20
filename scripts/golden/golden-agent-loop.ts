/**
 * golden-agent-loop.ts — the model asks, the code decides (2026-09-18, session 57).
 *
 * ── WHAT A LOOP CHANGES ─────────────────────────────────────────────────────
 * Everywhere else in this product, the code picks the steps. Here the MODEL
 * picks them, one at a time, and the code's job stops being "do the work" and
 * becomes "decide whether that is allowed, and make sure this ends".
 *
 * Both halves of that are load-bearing, and neither is obvious from reading the
 * happy path:
 *
 *   - A request is NOT permission. A model can ask for any name at all,
 *     including one a poisoned document suggested to it. If asking were enough,
 *     the agent's tool list would be decoration.
 *   - A loop the model steers can fail to end. Left alone, a model that
 *     misreads a result asks for the same tool again, and again, overnight.
 *
 *   CASE A — a 2-tool answer: the model asks, the tool runs, the result goes
 *            back, and the whole conversation is re-sent every single call
 *            (which is what "the model has no memory" actually means).
 *   CASE B — a tool the agent is not allowed is refused, and the refusal is
 *            handed BACK to the model so it can answer without it.
 *   CASE C — an invented tool name is refused the same way, and the refusal
 *            names what IS available.
 *   CASE D — the step limit ends a model that never stops asking, and says so.
 *   CASE E — the spend cap ends it mid-loop, and says so.
 *   CASE F — a tool that fails is reported to the model, not to the customer,
 *            and the loop keeps its head.
 *   CASE G — two independent lookups asked for in ONE turn run together, not
 *            one after the other, and the gate is applied to each of them.
 *   CASE H — an agent reached through a tool cannot go deeper than the cap, and
 *            cannot re-enter an agent already waiting on the chain.
 *
 * Run: npx tsx scripts/golden/golden-agent-loop.ts
 */
import "./_helpers/isolate-standalone";
// 2026-09-27: usage caps are off while the product is being built; this test
// checks the caps themselves, so it switches them on (as launch will).
process.env.AI_USAGE_CAPS = "on";
import assert from "node:assert";
import { runAgentLoop, MAX_AGENT_DEPTH, type ModelCaller, type ModelReply } from "@/agents/AgentLoop";
import { toolsForAgent, getTool } from "@/agents/tool-registry";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const AGENT = "whatsapp-conversation-agent";
let WS = "";
const freshWorkspace = () => (WS = `ws_golden_loop_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);

/** A model that replies with a scripted sequence, and records what it was sent. */
function scriptedModel(replies: ModelReply[]) {
  const seen: Array<{ transcriptLength: number; toolNames: string[]; lastToolResult?: string }> = [];
  let index = 0;
  const caller: ModelCaller = async ({ tools, transcript }) => {
    const last = [...transcript].reverse().find((entry) => entry.role === "tool_result");
    seen.push({
      transcriptLength: transcript.length,
      toolNames: tools.map((tool) => tool.name),
      lastToolResult: last && "content" in last ? last.content : undefined,
    });
    return replies[Math.min(index++, replies.length - 1)];
  };
  return { caller, seen };
}

async function seedKnowledge(repos: RepositoryBundle) {
  const doc = await repos.knowledgeBaseDocument.create(WS, {
    title: "Approved answers",
    documentType: "question_answer_extraction",
    source: "knowledge_question_answers",
    status: "active",
    contentText: "Minimum order quantity is 100 kg per order for stocked shades.",
    metadata: {},
  });
  await repos.knowledgeBaseChunk.replaceForDocument(WS, doc.id, [
    { chunkIndex: 0, chunkText: "Minimum order quantity is 100 kg per order for stocked shades.", metadata: { source: "knowledge_question_answers" } },
  ]);
}

test("CASE A — two tools, in order, with the whole conversation re-sent each time", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seedKnowledge(repos);
  const lead = await repos.lead.createLead({ workspaceId: WS, companyName: "Surat Sarees", city: "Surat", status: "prospected" });

  const { caller, seen } = scriptedModel([
    { type: "tool_use", name: "search_knowledge_base", input: { query: "minimum order quantity" } },
    { type: "tool_use", name: "get_lead_history", input: { leadId: lead.id } },
    { type: "answer", text: "Minimum 100 kg per order. You have ordered from us before." },
  ]);

  const result = await runAgentLoop({
    agentName: AGENT,
    workspaceId: WS,
    instructions: "Answer the customer.",
    question: "kitna minimum order lena padega?",
    repos,
    callModel: caller,
  });

  assert.strictEqual(result.stoppedBy, "model", "the loop must end because the model stopped asking, not because a brake fired");
  assert.strictEqual(result.llmCalls, 3, "2 tools = 3 model calls: ask, ask, answer");
  const toolCalls = result.steps.filter((step) => step.kind === "tool_call");
  assert.deepStrictEqual(toolCalls.map((step) => "tool" in step && step.tool), ["search_knowledge_base", "get_lead_history"], "in the order the model asked");

  // The tools really ran — these are the product's own functions, not stubs.
  const searchResult = JSON.stringify(toolCalls[0] && "result" in toolCalls[0] ? toolCalls[0].result : {});
  assert.match(searchResult, /100 kg per order/, `the knowledge search must return real stored text. Got: ${searchResult}`);
  const historyResult = JSON.stringify(toolCalls[1] && "result" in toolCalls[1] ? toolCalls[1].result : {});
  assert.match(historyResult, /Surat Sarees/, "the lead lookup must return the real lead");

  // THE POINT ABOUT MEMORY: every call carries more than the one before, because
  // the model keeps nothing and the transcript IS the memory.
  assert.strictEqual(seen[0].transcriptLength, 1, "first call: just the question");
  assert.strictEqual(seen[1].transcriptLength, 3, "second call: question + the request + its result");
  assert.strictEqual(seen[2].transcriptLength, 5, "third call: everything again, plus the second result");
  assert.match(String(seen[2].lastToolResult), /Surat Sarees/, "the model is shown the tool's result, or it is answering blind");
  assert.deepStrictEqual(seen[0].toolNames, ["search_knowledge_base", "get_lead_history"], "and the tool list is re-sent every time too");
});

test("CASE B — a tool this agent may not use is refused, and the model is told why", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seedKnowledge(repos);
  // knowledge-base-agent has search only — get_lead_history exists, but not for it.
  assert.deepStrictEqual(toolsForAgent("knowledge-base-agent").map((tool) => tool.name), ["search_knowledge_base"], "fixture");
  assert.ok(getTool("get_lead_history"), "fixture: the tool exists globally");

  const { caller, seen } = scriptedModel([
    { type: "tool_use", name: "get_lead_history", input: { leadId: "lead_1" } },
    { type: "answer", text: "I cannot see order history, but the minimum is 100 kg." },
  ]);
  const result = await runAgentLoop({
    agentName: "knowledge-base-agent",
    workspaceId: WS,
    instructions: "Answer the customer.",
    question: "have I ordered before?",
    repos,
    callModel: caller,
  });

  const refusal = result.steps.find((step) => step.kind === "refused");
  assert.ok(refusal, "asking for a tool outside the agent's list must be REFUSED — a request is not permission");
  assert.match("reason" in refusal! ? refusal.reason : "", /not allowed/i, "and the refusal must say it is a permission decision");
  assert.ok(
    !result.steps.some((step) => step.kind === "tool_call"),
    "THE POINT: the refused tool must not have RUN. If a model can reach a tool by naming it, the agent's list is decoration " +
      "and a poisoned document is an instruction.",
  );
  assert.match(String(seen[1].lastToolResult), /not allowed/i, "the refusal goes back to the MODEL, so it can answer without it");
  assert.strictEqual(result.stoppedBy, "model");
  assert.match(result.answer, /100 kg/, "and it did answer, rather than the conversation dying on a wrong guess");
});

test("CASE C — an invented tool name is refused, and the refusal lists what exists", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  const { caller, seen } = scriptedModel([
    { type: "tool_use", name: "send_slack_message", input: { channel: "#sales" } },
    { type: "answer", text: "Sorry, I cannot do that." },
  ]);
  const result = await runAgentLoop({
    agentName: AGENT,
    workspaceId: WS,
    instructions: "Answer the customer.",
    question: "post this to slack",
    repos,
    callModel: caller,
  });
  const refusal = result.steps.find((step) => step.kind === "refused");
  assert.ok(refusal, "a tool that does not exist must be refused, not attempted");
  const reason = "reason" in refusal! ? refusal.reason : "";
  assert.match(reason, /no tool called "send_slack_message"/i, "say plainly that there is no such tool");
  assert.match(reason, /search_knowledge_base/, "and name what IS available, so the next attempt can be right");
  assert.ok(String(seen[1].lastToolResult).includes("no tool called"), "handed back to the model");
});

test("CASE D — a model that never stops asking is stopped, and says so", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seedKnowledge(repos);
  // A model stuck in a rut: the same request, forever.
  const caller: ModelCaller = async () => ({ type: "tool_use", name: "search_knowledge_base", input: { query: "minimum order" } });

  const result = await runAgentLoop({
    agentName: AGENT,
    workspaceId: WS,
    instructions: "Answer the customer.",
    question: "minimum order?",
    repos,
    callModel: caller,
    maxSteps: 3,
  });

  assert.strictEqual(result.stoppedBy, "max_steps", "THE BRAKE: without a step limit this runs until someone notices the bill");
  assert.strictEqual(result.steps.filter((step) => step.kind === "tool_call").length, 4, "it stops AT the limit, not somewhere near it");
  assert.match(result.answer, /stop early/i, "and it must SAY it stopped early — a loop that quietly gives up looks identical to one that finished");
});

test("CASE E — the spend cap ends the loop mid-way", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seedKnowledge(repos);
  // Over the daily cap: the check between steps must catch it, even though the
  // loop was allowed to start.
  await repos.aiUsageLimit.upsertForWorkspace(WS, {
    dailyTokenLimit: 1,
    monthlyTokenLimit: 1_000_000,
    dailyCostLimit: 1,
    monthlyCostLimit: 100,
    currentDailyTokens: 999_999,
    currentMonthlyTokens: 0,
    currentDailyCost: 999,
    currentMonthlyCost: 0,
    resetAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  const caller: ModelCaller = async () => ({ type: "tool_use", name: "search_knowledge_base", input: { query: "minimum order" } });
  const result = await runAgentLoop({
    agentName: AGENT,
    workspaceId: WS,
    instructions: "Answer the customer.",
    question: "minimum order?",
    repos,
    callModel: caller,
    maxSteps: 10,
  });

  assert.strictEqual(result.stoppedBy, "budget", "a loop can cross the cap halfway; checking only at the start is checking too late");
  assert.ok(result.llmCalls <= 2, `it must stop as soon as the cap is seen, not run the remaining steps. Calls: ${result.llmCalls}`);
  assert.match(result.answer, /stop early/i);
});

test("CASE F — a tool that FAILS is reported to the model, not to the customer", async () => {
  const repos = createJsonRepos();
  freshWorkspace();

  // A tool that RETURNS an error: the lead does not exist.
  const missing = scriptedModel([
    { type: "tool_use", name: "get_lead_history", input: { leadId: "lead_that_does_not_exist" } },
    { type: "answer", text: "I could not find that account, let me check with a colleague." },
  ]);
  const softFail = await runAgentLoop({
    agentName: AGENT,
    workspaceId: WS,
    instructions: "Answer the customer.",
    question: "what did I order last time?",
    repos,
    callModel: missing.caller,
  });
  const call = softFail.steps.find((step) => step.kind === "tool_call");
  assert.ok(call, "the tool was allowed, so it ran");
  assert.match(JSON.stringify("result" in call! ? call.result : {}), /No lead with id/, "a miss is returned as a fact the model can use");
  assert.match(String(missing.seen[1].lastToolResult), /No lead with id/, "and it is shown to the model");
  assert.strictEqual(softFail.stoppedBy, "model", "one failing tool must not end the conversation");
  assert.match(softFail.answer, /colleague/, "the model gets to say something honest instead of inventing an order history");

  // A tool that THROWS — the database is down underneath it. This is a DIFFERENT
  // case, and an earlier version of this test missed it: it covered only the
  // miss above, so a mutation letting exceptions escape the loop went unnoticed.
  const exploding = new Proxy(repos as unknown as Record<string, unknown>, {
    get(target, prop) {
      if (prop === "knowledgeBaseChunk") {
        return new Proxy(target[prop as string] as Record<string, unknown>, {
          get(chunkTarget, chunkProp) {
            if (chunkProp === "searchByKeyword" || chunkProp === "listByWorkspace") {
              return async () => { throw new Error("connection to the database was lost"); };
            }
            const value = chunkTarget[chunkProp as string];
            return typeof value === "function" ? value.bind(chunkTarget) : value;
          },
        });
      }
      const value = target[prop as string];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as RepositoryBundle;

  const crashing = scriptedModel([
    { type: "tool_use", name: "search_knowledge_base", input: { query: "minimum order" } },
    { type: "answer", text: "I could not check that just now — let me confirm and come back to you." },
  ]);
  const hardFail = await runAgentLoop({
    agentName: AGENT,
    workspaceId: WS,
    instructions: "Answer the customer.",
    question: "minimum order?",
    repos: exploding,
    callModel: crashing.caller,
  });
  assert.strictEqual(hardFail.stoppedBy, "model", "an exception inside a tool must NOT escape the loop and kill the request");
  assert.match(
    String(crashing.seen[1].lastToolResult),
    /connection to the database was lost/,
    "the failure must be handed to the model as a result, so it can be honest rather than invent the answer it wanted",
  );
  assert.match(hardFail.answer, /come back to you/);
});

test("CASE G — two tools asked for in one turn run together, and each is still gated", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seedKnowledge(repos);

  // One turn, four requests: two this agent may use, and two it may not — one
  // that does not exist at all, and one that DOES exist but belongs to another
  // agent. The second kind is the dangerous one: a gate that only checks the
  // first request, or only rejects unknown names, lets a real tool through by
  // letting it travel beside allowed ones.
  assert.ok(getTool("ask_lead_scorer"), "fixture: ask_lead_scorer exists globally");
  assert.ok(
    !toolsForAgent(AGENT).some((tool) => tool.name === "ask_lead_scorer"),
    "fixture: but this agent may not use it",
  );
  const { caller, seen } = scriptedModel([
    {
      type: "tool_use",
      calls: [
        { name: "search_knowledge_base", input: { query: "minimum order quantity" } },
        { name: "search_knowledge_base", input: { query: "delivery time surat" } },
        { name: "ask_lead_scorer", input: { leadId: "lead_1" } },
        { name: "send_slack_message", input: { channel: "#sales" } },
      ],
    },
    { type: "answer", text: "Minimum 100 kg. Delivery I will confirm." },
  ]);

  const started = Date.now();
  const result = await runAgentLoop({
    agentName: AGENT,
    workspaceId: WS,
    instructions: "Answer the customer.",
    question: "minimum order aur surat delivery?",
    repos,
    callModel: caller,
  });
  const elapsed = Date.now() - started;

  assert.strictEqual(result.llmCalls, 2, "THE POINT OF A WAVE: two lookups in one turn cost ONE extra model call, not two");
  const ran = result.steps.filter((step) => step.kind === "tool_call");
  assert.strictEqual(ran.length, 2, "both allowed tools must have run");
  const refused = result.steps.filter((step) => step.kind === "refused");
  assert.strictEqual(refused.length, 2, "the gate applies to EVERY request in the wave, not just the first");
  assert.ok(
    !ran.some((step) => "tool" in step && (step.tool === "send_slack_message" || step.tool === "ask_lead_scorer")),
    "a tool that is not on the agent's list must not slip through by travelling beside allowed ones",
  );
  const scorerRefusal = refused.find((step) => "tool" in step && step.tool === "ask_lead_scorer");
  assert.match(
    scorerRefusal && "reason" in scorerRefusal ? scorerRefusal.reason : "",
    /not allowed/i,
    "an existing tool this agent may not use must be refused as a PERMISSION decision, not reported as missing",
  );

  const results = JSON.stringify(ran.map((step) => ("result" in step ? step.result : {})));
  assert.match(results, /100 kg per order/, "the wave's results must be handed back to the model");
  assert.ok(String(seen[1].lastToolResult).length > 0, "and the model's next call sees them");
  assert.ok(elapsed < 5000, `a wave must not serialise; took ${elapsed}ms`);
});

test("CASE H — an agent asked as a tool cannot go too deep, or re-enter the chain", async () => {
  const repos = createJsonRepos();
  freshWorkspace();
  await seedKnowledge(repos);

  // At the cap: one more agent is one too many.
  const atLimit = scriptedModel([
    { type: "tool_use", name: "ask_knowledge_agent", input: { question: "what is the minimum order?" } },
    { type: "answer", text: "I answered from what I had." },
  ]);
  const deep = await runAgentLoop({
    agentName: "owner-copilot",
    workspaceId: WS,
    instructions: "Help the owner.",
    question: "what is the minimum order?",
    repos,
    callModel: atLimit.caller,
    depth: MAX_AGENT_DEPTH,
    callStack: ["a", "b", "c"],
  });
  const deepCall = deep.steps.find((step) => step.kind === "tool_call");
  assert.match(
    JSON.stringify(deepCall && "result" in deepCall ? deepCall.result : {}),
    /agents deep/i,
    "THE BRAKE: without a depth cap, one question becomes a chain of agents each running its own loop, each billed",
  );
  assert.strictEqual(deep.stoppedBy, "model", "and the asking agent still gets to answer");

  // A cycle: the knowledge agent is already waiting further up the chain.
  const cyclic = scriptedModel([
    { type: "tool_use", name: "ask_knowledge_agent", input: { question: "minimum order?" } },
    { type: "answer", text: "Answered without asking again." },
  ]);
  const cycle = await runAgentLoop({
    agentName: "owner-copilot",
    workspaceId: WS,
    instructions: "Help the owner.",
    question: "minimum order?",
    repos,
    callModel: cyclic.caller,
    depth: 1,
    callStack: ["knowledge-base-agent"],
  });
  const cycleCall = cycle.steps.find((step) => step.kind === "tool_call");
  assert.match(
    JSON.stringify(cycleCall && "result" in cycleCall ? cycleCall.result : {}),
    /already waiting on this chain/i,
    "A asks B asks A is a loop no step limit inside either one can see — each thinks it is on its first step",
  );
});

(async () => {
  console.log("\n=== GOLDEN: the agent loop (model asks, code decides) ===\n");
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
    console.log("❌ GOLDEN FAILED: agent-loop");
    process.exit(1);
  }
})();
