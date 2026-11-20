import type { CompanyCommunicationSettings, WhatsAppAgentSettings } from "@/lib/types";

export function defaultCompanyCommunicationSettings(workspaceId: string): Omit<CompanyCommunicationSettings, "id" | "createdAt" | "updatedAt"> {
  return {
    workspaceId,
    language: "English",
    tone: "professional_friendly",
    brandVoice: "Helpful, concise, respectful",
    messageLength: "short",
    greeting: "Hello",
    closing: "Thank you",
    preferredWords: [],
    avoidedWords: [],
    formalityLevel: "balanced",
    emojiUsage: "minimal",
    allowHinglish: false,
    customInstructions: "",
  };
}

export function defaultWhatsAppAgentSettings(workspaceId: string): Omit<WhatsAppAgentSettings, "id" | "createdAt" | "updatedAt"> {
  return {
    workspaceId,
    enabled: false,
    mode: "draft_only",
    defaultLanguage: "English",
    maxAutoRepliesPerConversation: 3,
    businessHours: {},
    escalationContactName: "",
    escalationContactPhone: "",
    escalationContactEmail: "",
    unknownAnswerBehavior: "hold_for_review",
    abusiveMessageBehavior: "escalate",
    priceQuestionBehavior: "ask_quantity_or_escalate",
  };
}

