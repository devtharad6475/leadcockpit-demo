import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadPolicyMarkdown } from "@/policies/PolicyLoader";
import { createRepositories } from "@/repositories";
import { buildAgentWorkspaceContext, formatAgentContext } from "@/services/AgentContextBuilder";
import { safeNotFound } from "@/lib/safe-not-found";
import { pickCurrentAgentInstruction } from "@/lib/agent-instruction-selection";
import { checkAgentInstruction } from "@/services/AgentInstructionConflictService";

const agentFiles: Record<string, string> = {
  business_profile: "business-profile-agent.md",
  document_extraction: "document-extraction-agent.md",
  product_application_research: "product-application-research-agent.md",
  icp_generation: "icp-generation-agent.md",
  campaign_planning: "campaign-planning-agent.md",
  prospect_discovery: "prospect-discovery-agent.md",
  lead_enrichment: "lead-enrichment-agent.md",
  lead_review: "lead-review-agent.md",
  lead_scoring: "lead-scoring-agent.md",
  message_generation: "message-generation-agent.md",
  reply_classification: "reply-classification-agent.md",
  whatsapp_conversation: "whatsapp-conversation-agent.md",
  knowledge_base: "knowledge-base-agent.md",
  unknown_question: "unknown-question-agent.md",
  campaign_learning: "campaign-learning-agent.md",
  quality_review: "quality-review-agent.md",
};

export async function loadAgentInstructions(agentName: string) {
  const normalized = agentName.toLowerCase().replace(/[\s-]+/g, "_");
  const fileName = agentFiles[normalized] || agentFiles[agentName] || `${agentName}.md`;
  try {
    return await readFile(path.join(process.cwd(), "agents", fileName), "utf8");
  } catch {
    return [
      `# ${agentName} Agent`,
      "Purpose: provide structured assistance within LeadCockpit.",
      "Rules: use reviewed company knowledge, do not invent facts, respect safety policies, and escalate uncertain decisions.",
      "Output: return structured JSON where a task schema exists.",
    ].join("\n\n");
  }
}

export async function getAgentInstructionBundle(agentName: string, workspaceId: string) {
  const repos = createRepositories();
  // R6 audit fix: load ALL 12 runtime policies, not just 3. Previously the
  // agent prompt only included global / no_hallucination / sensitive_topic,
  // while the other 9 (DNC, auto-reply safety, lead review, abusive customer,
  // document extraction, website crawler consent, product application research,
  // human escalation, WhatsApp agent behaviour) existed as files but never
  // reached the LLM. The docs and AGENTS.md describe these as runtime rules;
  // the prompt now matches.
  const [agentMarkdown, sharedAgentRules, globalPolicy, noHallucinationPolicy, sensitiveTopicPolicy, doNotContactPolicy, autoReplySafetyPolicy, leadReviewPolicy, abusiveCustomerPolicy, documentExtractionPolicy, websiteCrawlerConsentPolicy, productApplicationResearchPolicy, humanEscalationPolicy, whatsappAgentPolicy, workspaceContext] = await Promise.all([
    loadAgentInstructions(agentName),
    readFile(path.join(process.cwd(), "agents", "_shared-agent-operating-rules.md"), "utf8").catch(() => ""),
    loadPolicyMarkdown("global"),
    loadPolicyMarkdown("no_hallucination"),
    loadPolicyMarkdown("sensitive_topic").catch(() => ""),
    loadPolicyMarkdown("do_not_contact").catch(() => ""),
    loadPolicyMarkdown("auto_reply_safety").catch(() => ""),
    loadPolicyMarkdown("lead_review").catch(() => ""),
    loadPolicyMarkdown("abusive_customer").catch(() => ""),
    loadPolicyMarkdown("document_extraction").catch(() => ""),
    loadPolicyMarkdown("website_crawler_consent").catch(() => ""),
    loadPolicyMarkdown("product_application_research").catch(() => ""),
    loadPolicyMarkdown("human_escalation").catch(() => ""),
    loadPolicyMarkdown("whatsapp").catch(() => ""),
    buildAgentWorkspaceContext(workspaceId, repos),
  ]);
  // Cluster 5 P1-2: replaced `.catch(() => undefined)` on the three REPO reads
  // (policy-file reads above are different — a missing optional .md is genuinely
  // fine and returns ""). Repo errors used to silently produce an agent with no
  // communication/WhatsApp/override settings. Now only not-found is swallowed.
  const communicationSettings = await safeNotFound(
    () => repos.companyCommunicationSettings.getByWorkspace(workspaceId),
    { fallback: undefined, context: "AgentInstructionLoader companyCommunicationSettings" },
  );
  const whatsAppSettings = await safeNotFound(
    () => repos.whatsAppAgentSettings.getByWorkspace(workspaceId),
    { fallback: undefined, context: "AgentInstructionLoader whatsAppAgentSettings" },
  );
  const workspaceOverride = await safeNotFound(
    async () => {
      // N-AI-12 (2026-08-27): this used to be `documents.find(...)` — first match
      // wins over a list with no defined order. On the JSON substrate that order
      // is insertion order, so the OLDEST saved instruction won and every later
      // correction the owner typed was ignored; on Postgres the order was simply
      // undefined. pickCurrentAgentInstruction sorts newest-first, identically on
      // both substrates, and so also repairs workspaces that already accumulated
      // duplicate rows before the save path became an upsert.
      const documents = await repos.knowledgeBaseDocument.listByWorkspace(workspaceId);
      return pickCurrentAgentInstruction(documents, agentName);
    },
    { fallback: undefined, context: "AgentInstructionLoader knowledgeBaseDocument.listByWorkspace" },
  );
  // Pre-existing overrides were saved despite known conflicts. Do not give
  // them to the model after this upgrade. A failed knowledge read also fails
  // this run rather than loading unchecked guidance.
  let workspaceAgentMarkdown = workspaceOverride?.contentText || "";
  if (workspaceAgentMarkdown) {
    const { listKnowledgeQuestionAnswers } = await import("@/services/DocumentQuestionAnsweringService");
    const answers = await listKnowledgeQuestionAnswers(workspaceId, repos);
    if (checkAgentInstruction(workspaceAgentMarkdown, answers).hasFindings) workspaceAgentMarkdown = "";
  }
  return {
    agentName,
    instructionVersion: "markdown-v1",
    agentMarkdown,
    sharedAgentRules,
    workspaceAgentMarkdown,
    globalPolicy,
    noHallucinationPolicy,
    sensitiveTopicPolicy,
    doNotContactPolicy,
    autoReplySafetyPolicy,
    leadReviewPolicy,
    abusiveCustomerPolicy,
    documentExtractionPolicy,
    websiteCrawlerConsentPolicy,
    productApplicationResearchPolicy,
    humanEscalationPolicy,
    whatsappAgentPolicy,
    communicationSettings,
    whatsAppSettings,
    workspaceContext,
    workspaceContextText: formatAgentContext(workspaceContext),
  };
}
