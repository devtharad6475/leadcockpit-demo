export const AGENT_NAMES = [
  "business_profile_agent",
  "document_extraction_agent",
  "product_application_research_agent",
  "icp_generation_agent",
  "campaign_planning_agent",
  "prospect_discovery_agent",
  "lead_enrichment_agent",
  "lead_review_agent",
  "lead_scoring_agent",
  "message_generation_agent",
  "reply_classification_agent",
  "whatsapp_conversation_agent",
  "knowledge_base_agent",
  "unknown_question_agent",
  "campaign_learning_agent",
  "quality_review_agent",
] as const;

export type AgentNameValue = (typeof AGENT_NAMES)[number];
