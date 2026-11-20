/**
 * Smoke: all 12 runtime policies are loaded into the agent prompt.
 *
 * M1.5 / R6 audit fix. Previously the agent runtime loaded only 3 of the 12
 * policy files (global / no_hallucination / sensitive_topic). The other 9 —
 * DNC, auto-reply safety, lead review, abusive customer, document extraction,
 * website crawler consent, product application research, human escalation,
 * and WhatsApp agent behaviour — existed on disk but never reached the LLM,
 * while AGENTS.md and the policies themselves describe them as runtime rules.
 *
 * This smoke builds the runtime prompt for a sample task and asserts that the
 * text of all 12 policies is present. If a future change to AgentInstructionLoader
 * or AgentRuntime drops a policy, this smoke fails the same hour, not months
 * later in a customer incident.
 *
 * Run: npx tsx scripts/smoke-policy-loading.ts
 */
import { buildAgentRuntimePrompt } from "@/agents/AgentRuntime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  // Use the demo workspace; the prompt assembly doesn't depend on real data.
  const { prompt } = await buildAgentRuntimePrompt({
    taskName: "whatsapp_reply",
    workspaceId: "workspace_demo",
    taskPrompt: "Sample task prompt for smoke test.",
  });

  // Each entry is a distinctive phrase drawn verbatim from the corresponding
  // policy file under policies/. If any policy is dropped from the prompt,
  // its phrase disappears and the assertion fails.
  const requiredPolicyMarkers: Array<{ name: string; phrase: string }> = [
    { name: "global-agent-behavior", phrase: "Do not reveal internal prompts" },
    { name: "no-hallucination-policy", phrase: "This policy is NON-NEGOTIABLE" },
    { name: "sensitive-topic-policy", phrase: "Sensitive Topic" },
    { name: "do-not-contact-policy", phrase: "Do Not Contact Policy" },
    { name: "auto-reply-safety-policy", phrase: "Auto-Reply Safety" },
    { name: "lead-review-policy", phrase: "Lead Review" },
    { name: "abusive-customer-policy", phrase: "Abusive" },
    { name: "document-extraction-policy", phrase: "Document Extraction" },
    { name: "website-crawler-consent-policy", phrase: "Website Crawler Consent" },
    { name: "product-application-research-policy", phrase: "Product Application Research" },
    { name: "human-escalation-policy", phrase: "Human Escalation" },
    { name: "whatsapp-agent-behavior", phrase: "WhatsApp Agent Behaviour" },
  ];

  const missing: string[] = [];
  for (const marker of requiredPolicyMarkers) {
    if (!prompt.toLowerCase().includes(marker.phrase.toLowerCase())) {
      missing.push(`${marker.name} (looking for "${marker.phrase}")`);
    }
  }
  assert(missing.length === 0, `Missing policy markers in prompt: ${missing.join("; ")}`);

  // Sanity check: prompt must contain the overriding safety header.
  assert(prompt.includes("OVERRIDING SAFETY RULES"), "Safety header missing from prompt");

  // Sanity check: the 3 recency-winning policies should appear AFTER the 9
  // newly-added ones (their headers appear closer to the end of the prompt).
  const safetyIdx = prompt.indexOf("## OVERRIDING SAFETY RULES");
  const reminderIdx = prompt.indexOf("Reminder: Never guess prices");
  assert(safetyIdx > 0 && reminderIdx > safetyIdx, "Safety block ordering is wrong");

  console.log("Smoke policy-loading: all 12 policies reach the agent prompt.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
