/**
 * AgentLoop.ts — call the model until it stops asking for tools
 * (2026-09-18, session 57).
 *
 * ── WHY A LOOP AT ALL ───────────────────────────────────────────────────────
 * One API call returns one reply. When the model asks for a tool, that reply is
 * FINISHED — it has not answered anyone, it has asked for something. The only
 * way to continue is to call again with the result appended. So the loop is not
 * cleverness; it is what the shape of the API forces.
 *
 * It earns its place only when the number and order of steps depend on what is
 * found. Where the product already knows the sequence — search, then write a
 * reply — straight-line code is cheaper and more predictable, and that is what
 * the WhatsApp path does today. Do not put a loop around a task you can spell.
 *
 * ── WHO DECIDES WHAT ────────────────────────────────────────────────────────
 * The model decides WHETHER to ask and WITH WHAT ARGUMENTS. This code decides
 * whether to allow it. Both are needed: a model can ask for any name at all,
 * including one a poisoned document suggested to it, so a request is never
 * permission. The tool has to be in the agent's own list (tool-registry) and
 * pass the checks below.
 *
 * ── THE BRAKES, AND WHY EACH ONE EXISTS ─────────────────────────────────────
 *   maxSteps   a model that misreads a result can ask for the same tool
 *              forever. Without a ceiling that is an overnight bill.
 *   budget     the workspace's own spend cap, re-checked between steps rather
 *              than once at the start: a loop can cross the cap halfway.
 *   timeout    a customer waiting on WhatsApp will not wait ninety seconds,
 *              and neither should a request thread.
 * Hitting a brake ends the loop and SAYS SO in the result. A loop that quietly
 * gives up looks identical to one that finished.
 *
 * Every step is recorded (`AgentLoopStep`) so the owner can see what the agent
 * did, in order, rather than being handed an answer with no account of where it
 * came from.
 */
import { LLMService } from "@/llm/LLMService";
import type { LLMTaskName } from "@/llm/types";
import { checkCanRunTask } from "@/services/AIUsageService";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { getTool, toolsForAgent, approvalMatches, type ToolDefinition, type ToolApproval } from "./tool-registry";

export type AgentLoopStep =
  | { kind: "tool_call"; tool: string; args: Record<string, unknown>; result: unknown; ms: number }
  | { kind: "refused"; tool: string; reason: string }
  /** Held for a person. The tool was NOT run — see `pending` on the result. */
  | { kind: "awaiting_approval"; tool: string; args: Record<string, unknown> }
  | { kind: "answer"; text: string };

export type AgentLoopResult = {
  answer: string;
  steps: AgentLoopStep[];
  /** Why the loop ended: the model finished, a brake stopped it, or it is waiting on a person. */
  stoppedBy: "model" | "max_steps" | "budget" | "timeout" | "awaiting_approval";
  llmCalls: number;
  /**
   * The exact call the loop stopped in front of, when `stoppedBy` is
   * "awaiting_approval". This is what gets shown to the owner, so it carries
   * the arguments too — approving a tool without seeing what it will do with it
   * is not approval, it is a rubber stamp.
   */
  pending?: { tool: string; input: Record<string, unknown>; description: string };
};

export type AgentLoopOptions = {
  agentName: string;
  workspaceId: string;
  taskName?: LLMTaskName;
  /** The agent's own instructions — its policy, not its tool list. */
  instructions: string;
  question: string;
  repos?: RepositoryBundle;
  maxSteps?: number;
  timeoutMs?: number;
  /** Test seam: replaces the model call, so the loop can be proven without spend. */
  callModel?: ModelCaller;
  /**
   * How many agents deep this run already is. An agent can be reached through a
   * tool, so a question can become a chain: copilot asks the scorer, which asks
   * the knowledge agent. Without a ceiling one question becomes forty model
   * calls, each of them billed.
   */
  depth?: number;
  /**
   * The agents already on this call chain. A asks B, B asks A is a loop that no
   * step limit inside either agent can see, because each one thinks it is on its
   * first step.
   */
  callStack?: string[];
  /** Tools run together per wave. Bounded so a wide fan-out cannot flood a provider. */
  maxParallel?: number;
  /**
   * N6 — approvals a PERSON has already granted, for tools marked
   * `requiresApproval`.
   *
   * It is an OPTION, not something the model can produce. That placement is the
   * whole security property: the transcript, the customer's message and any
   * document the model has read all flow through `question` and tool results,
   * and none of them can reach this field. A poisoned document that writes
   * "approved by the owner" is text in a result, and text in a result is not an
   * entry in this array.
   */
  approvals?: ToolApproval[];
  /**
   * Test seam: the tool list, replacing the agent's own.
   *
   * The registry holds no write-capable tool yet — that is the point of `N6`
   * shipping BEFORE one exists. Without this seam the gate could only be tested
   * on the day the first dangerous tool arrived, which is the one day nobody
   * should be discovering that the gate does not work.
   */
  tools?: ToolDefinition[];
  /**
   * 2026-09-25 — paid web searches this run may make, in total. Counted by the
   * search tool itself, so it holds however many steps the loop takes and
   * however many searches the model asks for in one turn. Default 0: an agent
   * searches the web only when its caller grants it.
   */
  maxWebSearches?: number;
};

export type ToolRequest = { name: string; input: Record<string, unknown> };

/**
 * What one model call returns: tool requests, or the final answer.
 *
 * `calls` is a LIST because a turn may ask for several tools at once. "What is
 * the minimum order and how long to Surat" is two lookups that do not depend on
 * each other, and running them one after the other makes the customer wait for
 * the sum of both. Asked for together, they run together.
 *
 * A single `name`/`input` is still accepted, because most turns ask for one
 * thing and a list of one reads worse everywhere it is written.
 */
export type ModelReply =
  | { type: "tool_use"; name: string; input: Record<string, unknown>; calls?: never }
  | { type: "tool_use"; calls: ToolRequest[]; name?: never; input?: never }
  | { type: "answer"; text: string };

export type ModelCaller = (input: {
  instructions: string;
  tools: ToolDefinition[];
  /** The whole conversation so far, re-sent every time — the model remembers nothing. */
  transcript: TranscriptEntry[];
}) => Promise<ModelReply>;

export type TranscriptEntry =
  | { role: "user"; content: string }
  | { role: "assistant_tool_request"; name: string; input: Record<string, unknown> }
  | { role: "tool_result"; name: string; content: string };

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Agents deep. Three is enough for copilot → specialist → knowledge, and stops a chain becoming a bill. */
export const MAX_AGENT_DEPTH = 3;
const DEFAULT_MAX_PARALLEL = 4;

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const repos = options.repos ?? createRepositories();
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tools = options.tools ?? toolsForAgent(options.agentName);
  const callModel = options.callModel ?? realModelCaller(options, repos);
  const maxParallel = Math.max(1, options.maxParallel ?? DEFAULT_MAX_PARALLEL);
  const depth = options.depth ?? 0;
  // This agent is on the chain from here down, so a tool that reaches back to it
  // can be recognised as the cycle it is.
  const callStack = [...(options.callStack ?? []), options.agentName];

  const steps: AgentLoopStep[] = [];
  // THE MEMORY. The model keeps none; this list is re-sent in full on every
  // call, and it is the only reason the second call knows about the first.
  const transcript: TranscriptEntry[] = [{ role: "user", content: options.question }];
  const startedAt = Date.now();
  let llmCalls = 0;
  // One ledger for the whole run, shared by every tool call in it.
  const webSearches = { limit: Math.max(0, options.maxWebSearches ?? 0), used: 0 };

  for (let step = 0; step <= maxSteps; step++) {
    if (step > 0) {
      // Between steps, not only at the start: a loop can cross the cap halfway,
      // and the half it already spent is real money.
      const allowed = await checkCanRunTask(options.workspaceId, options.taskName || "message_generation", 1000, 0, repos);
      if (!allowed.allowed) {
        return finish("budget", `I had to stop early: ${allowed.reason}`);
      }
      if (Date.now() - startedAt > timeoutMs) {
        return finish("timeout", "I had to stop early: this was taking too long to answer.");
      }
    }

    llmCalls += 1;
    const reply = await callModel({ instructions: options.instructions, tools, transcript });

    if (reply.type === "answer") {
      steps.push({ kind: "answer", text: reply.text });
      return { answer: reply.text, steps, stoppedBy: "model", llmCalls };
    }

    // One turn, one or several requests. A model that asks for two independent
    // lookups should not be served them one after the other.
    const requested: ToolRequest[] = reply.calls?.length
      ? reply.calls
      : [{ name: reply.name as string, input: (reply.input || {}) as Record<string, unknown> }];

    // ── The gate, applied to every request before ANY of them runs. ──
    // A request is not permission: a model can name any tool at all, including
    // one a poisoned customer message suggested to it.
    const runnable: Array<{ request: ToolRequest; tool: ToolDefinition }> = [];
    for (const request of requested) {
      const allowedHere = tools.find((tool) => tool.name === request.name);
      if (allowedHere) {
        // ── N6: THE APPROVAL GATE ──
        // Before the tool runs, not after, and before ANY tool in this wave
        // runs — a send that happens while the owner is still reading the
        // question has already happened.
        //
        // It stops the whole loop rather than skipping the one call. A model
        // that asked to send a message and was quietly refused would carry on
        // and answer as though it had sent it, and the owner would be told a
        // thing that did not happen.
        if (allowedHere.requiresApproval && !(options.approvals || []).some((approval) => approvalMatches(approval, request))) {
          steps.push({ kind: "awaiting_approval", tool: request.name, args: request.input || {} });
          return {
            answer: "I need your approval before I can do that.",
            steps,
            stoppedBy: "awaiting_approval",
            llmCalls,
            pending: { tool: request.name, input: request.input || {}, description: allowedHere.description },
          };
        }
        runnable.push({ request, tool: allowedHere });
        continue;
      }
      // Told plainly, and handed BACK to the model rather than thrown: it can
      // then answer without that tool, or pick one it does have. A thrown error
      // here would lose a conversation over a wrong guess.
      const reason = getTool(request.name)
        ? `The tool "${request.name}" exists but ${options.agentName} is not allowed to use it.`
        : `There is no tool called "${request.name}". Available: ${tools.map((tool) => tool.name).join(", ") || "none"}.`;
      steps.push({ kind: "refused", tool: request.name, reason });
      transcript.push({ role: "assistant_tool_request", name: request.name, input: request.input });
      transcript.push({ role: "tool_result", name: request.name, content: reason });
    }

    // Run the allowed ones together, bounded. The budget was checked once above
    // for this whole wave, which is the point: N tools dispatched at once is N
    // lots of spend in the same instant, and checking after the fact checks
    // nothing.
    for (let offset = 0; offset < runnable.length; offset += maxParallel) {
      const wave = runnable.slice(offset, offset + maxParallel);
      const settled = await Promise.all(
        wave.map(async ({ request, tool }) => {
          const toolStartedAt = Date.now();
          try {
            const result = await tool.run(request.input || {}, {
              workspaceId: options.workspaceId,
              repos,
              depth,
              callStack,
              webSearches,
            });
            return { request, result, ms: Date.now() - toolStartedAt };
          } catch (error) {
            // A tool that fails is a fact the model needs, not a crash. One
            // failure in a wave must not discard the results beside it.
            return {
              request,
              result: { error: error instanceof Error ? error.message : String(error) },
              ms: Date.now() - toolStartedAt,
            };
          }
        }),
      );
      for (const { request, result, ms } of settled) {
        steps.push({ kind: "tool_call", tool: request.name, args: request.input || {}, result, ms });
        transcript.push({ role: "assistant_tool_request", name: request.name, input: request.input });
        transcript.push({ role: "tool_result", name: request.name, content: JSON.stringify(result).slice(0, 4000) });
      }
    }
  }

  return finish("max_steps", "I had to stop early: too many steps without reaching an answer.");

  function finish(stoppedBy: AgentLoopResult["stoppedBy"], answer: string): AgentLoopResult {
    steps.push({ kind: "answer", text: answer });
    return { answer, steps, stoppedBy, llmCalls };
  }
}

/**
 * The real model call, through the product's one metered choke point.
 *
 * Providers expose native tool calling; this asks for the same decision in JSON
 * instead, so the loop works on every provider the product routes to — including
 * the mock one — and nothing here depends on a provider-specific field. The
 * schemas are still sent verbatim: the model is choosing from the same list and
 * filling the same form either way.
 */
function realModelCaller(options: AgentLoopOptions, repos: RepositoryBundle): ModelCaller {
  return async ({ instructions, tools, transcript }) => {
    const prompt = [
      instructions,
      "",
      "TOOLS YOU MAY USE",
      "Ask for a tool when it is the honest way to answer; do not guess facts a tool can give you.",
      JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, input: tool.input })), null, 2),
      "",
      "HOW TO REPLY — always one JSON object, nothing else:",
      '  to use a tool:   {"action":"tool","name":"<tool name>","input":{...}}',
      '  to answer:       {"action":"answer","text":"<your answer to the customer>"}',
    ].join("\n");

    const result = await new LLMService(undefined, repos).runTask<{ action?: string; name?: string; input?: Record<string, unknown>; text?: string }>(
      options.taskName || "message_generation",
      { question: options.question, transcript },
      { workspaceId: options.workspaceId, overridePrompt: prompt },
    );
    const output = result.output || {};
    if (output.action === "tool" && typeof output.name === "string") {
      return { type: "tool_use", name: output.name, input: (output.input || {}) as Record<string, unknown> };
    }
    return { type: "answer", text: String(output.text || "").trim() || "I could not answer that." };
  };
}
