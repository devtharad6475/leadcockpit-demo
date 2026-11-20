import type { CompanyCommunicationSettings, WhatsAppAgentSettings } from "@/lib/types";
import { loadPolicyMarkdown } from "@/policies/PolicyLoader";

export async function buildAgentInstructions(input: {
  policyKey?: string;
  companySettings?: CompanyCommunicationSettings;
  whatsAppSettings?: WhatsAppAgentSettings;
  knowledgeContext?: string;
  conversationContext?: string;
  taskPrompt?: string;
}) {
  const globalPolicy = await loadPolicyMarkdown(input.policyKey || "global");
  return [
    "Authority order: global platform safety rules, reviewed company knowledge, company communication settings, conversation context, then creative wording.",
    globalPolicy,
    input.knowledgeContext ? `Reviewed company knowledge:\n${input.knowledgeContext}` : "No reviewed company knowledge provided. Do not guess missing facts.",
    input.companySettings ? `Company tone: ${input.companySettings.tone}; language: ${input.companySettings.language}; length: ${input.companySettings.messageLength}.` : "",
    input.whatsAppSettings ? `WhatsApp mode: ${input.whatsAppSettings.mode}; unknown answer behavior: ${input.whatsAppSettings.unknownAnswerBehavior}.` : "",
    input.conversationContext ? `Conversation context:\n${input.conversationContext}` : "",
    input.taskPrompt || "",
  ].filter(Boolean).join("\n\n");
}
