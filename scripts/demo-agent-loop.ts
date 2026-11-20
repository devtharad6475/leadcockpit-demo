/**
 * demo-agent-loop.ts — watch an agent decide, step by step (2026-09-18, session 57).
 *
 * Prints every turn of the loop: what the model asked for, what the code
 * allowed, what the tool returned, and where the answer finally came from. The
 * point is that none of it is hidden — the thing people call "agentic AI" is
 * five lines of decision and a while loop, and this makes that legible.
 *
 *   # with a real model (costs a few paise of DeepSeek):
 *   PERSISTENCE_PROVIDER=prisma npx tsx scripts/demo-agent-loop.ts "kitna minimum order lena padega?"
 *
 *   # with no model at all — a scripted one, free, shows the same mechanics:
 *   npx tsx scripts/demo-agent-loop.ts --scripted
 *
 * It only reads. No message is sent to anyone, nothing is written to a
 * customer-facing table, and the agent's tool list is the real one from
 * src/agents/tool-registry.ts.
 */
import { defaultWorkspaceId } from "@/lib/db";
import { runAgentLoop, type ModelCaller } from "@/agents/AgentLoop";
import { toolsForAgent } from "@/agents/tool-registry";

const AGENT = "whatsapp-conversation-agent";

const INSTRUCTIONS = [
  "You answer customers of a zari and embroidery thread manufacturer in Surat, on WhatsApp.",
  "Always search the knowledge base before stating a price, a minimum order, a delivery time or a policy.",
  "If the search returns nothing useful, say you will confirm with a colleague. Never invent a number.",
  "Keep the answer short, the way a person types on WhatsApp.",
].join("\n");

/** A scripted stand-in for the model, so the mechanics can be watched for free. */
const scripted: ModelCaller = (() => {
  let step = 0;
  return async ({ transcript }) => {
    step += 1;
    if (step === 1) return { type: "tool_use", name: "search_knowledge_base", input: { query: "minimum order quantity" } };
    if (step === 2) return { type: "tool_use", name: "send_slack_message", input: { channel: "#sales" } }; // refused: not a real tool
    const found = transcript.filter((entry) => entry.role === "tool_result").map((entry) => ("content" in entry ? entry.content : "")).join(" ");
    const quoted = /100 kg/.test(found) ? "100 kg per order" : "the usual minimum";
    return { type: "answer", text: `Minimum ${quoted} hai stocked shades ke liye. Custom shade ke liye alag rehta hai.` };
  };
})();

function show(value: unknown, width = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > width ? `${text.slice(0, width)}…` : text;
}

async function main() {
  const args = process.argv.slice(2);
  const useScripted = args.includes("--scripted");
  const question = args.filter((arg) => !arg.startsWith("--")).join(" ") || "kitna minimum order lena padega?";
  const workspaceId = process.env.DEMO_WORKSPACE_ID || defaultWorkspaceId;

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(`AGENT     ${AGENT}`);
  console.log(`MODEL     ${useScripted ? "scripted (no provider called)" : "real, through LLMService"}`);
  console.log(`WORKSPACE ${workspaceId}`);
  console.log(`CUSTOMER  "${question}"`);
  console.log("────────────────────────────────────────────────────────────\n");

  console.log("TOOLS THIS AGENT CAN SEE (everything else does not exist for it):");
  for (const tool of toolsForAgent(AGENT)) {
    console.log(`  • ${tool.name}(${Object.keys(tool.input.properties).join(", ")})`);
    console.log(`      ${tool.description.slice(0, 110)}…`);
  }
  console.log("");

  const started = Date.now();
  const result = await runAgentLoop({
    agentName: AGENT,
    workspaceId,
    instructions: INSTRUCTIONS,
    question,
    callModel: useScripted ? scripted : undefined,
    maxSteps: 5,
  });

  let n = 0;
  for (const step of result.steps) {
    n += 1;
    if (step.kind === "tool_call") {
      console.log(`STEP ${n}  model asked for: ${step.tool}(${show(step.args, 120)})`);
      console.log(`         code allowed it, ran the real function (${step.ms} ms)`);
      console.log(`         result → ${show(step.result)}\n`);
    } else if (step.kind === "refused") {
      console.log(`STEP ${n}  model asked for: ${step.tool}`);
      console.log(`         code REFUSED → ${step.reason}`);
      console.log(`         (handed back to the model, which can answer without it)\n`);
    } else {
      console.log(`STEP ${n}  model answered, no tool needed\n`);
    }
  }

  console.log("────────────────────────────────────────────────────────────");
  console.log(`ANSWER    ${result.answer}`);
  console.log(`ENDED BY  ${result.stoppedBy === "model" ? "the model stopping (normal)" : `a brake: ${result.stoppedBy}`}`);
  console.log(`CALLS     ${result.llmCalls} model calls, ${result.steps.filter((s) => s.kind === "tool_call").length} tools run, ${Math.round((Date.now() - started) / 100) / 10}s`);
  console.log("────────────────────────────────────────────────────────────\n");
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
