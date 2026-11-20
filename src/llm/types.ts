import type { ProviderFailureReason } from "./provider-failure";
import type { LLMProviderId } from "./provider-types";
import type { ModelCapability, ModelSlotId, ModelTier } from "./model-capabilities";

export type { LLMProviderId, ModelCapability, ModelSlotId, ModelTier };

// NOTE (GAP-11 honesty fix, 2026-07-31): not every name below is invoked via
// LLMService.runTask. The ones that ARE invoked (proven by golden:copilot-tasks):
//   icp_generation, campaign_planning, lead_scoring, message_generation,
//   whatsapp_reply, reply_classification, document_extraction_mapping,
//   lead_review_decision, campaign_learning, manual_answer_mapping,
//   prospect_research, market_research (now executes via MarketResearchService),
//   quality_review (used by InboundMediaService vision).
// These names are NOT invoked as LLM tasks today (they're kept as routing
// intent-labels + audit action strings; the underlying capability works via a
// different path): business_extraction, lead_enrichment, knowledge_answer,
//   policy_answer.
// These are catalog/plumbing placeholders, not wired for output:
//   image_generation (no /images/generations adapter), embedding (the LLM
//   task is metadata-only; real embeddings come from src/llm/embedding.ts via
//   the KB chunk path), web_search (real search is SerpApi in
//   MarketResearchService/Prospecting, not this task), creative_generation.
// Deleting any of them is a high-ripple refactor (intent maps + audit strings
// + prompt registry reference them) deferred to a focused cleanup milestone.
export type LLMTaskName =
  | "business_extraction"
  | "icp_generation"
  | "campaign_planning"
  | "prospect_research"
  | "lead_enrichment"
  | "lead_scoring"
  | "message_generation"
  | "reply_classification"
  | "whatsapp_reply"
  | "knowledge_answer"
  | "document_extraction_mapping"
  | "lead_review_decision"
  | "product_application_research"
  | "market_research"
  | "creative_generation"
  | "embedding"
  | "campaign_learning"
  | "policy_answer"
  | "quality_review"
  | "image_generation"
  | "web_search"
  | "manual_answer_mapping";

export type LLMTaskOptions = {
  workspaceId: string;
  entityType?: string;
  entityId?: string;
  modelTier?: ModelTier;
  provider?: string;
  modelName?: string;
  slotId?: ModelSlotId;
  overridePrompt?: string;
  disableFallback?: boolean;
};

export type LLMTaskResult<T = unknown> = {
  output: T;
  provider: string;
  modelTier: ModelTier;
  modelName?: string;
  slotId?: ModelSlotId;
  fallbackUsed?: boolean;
  fallbackProvider?: string;
  fallbackModelName?: string;
  /**
   * Why the real provider failed, when it did. `warning` carries the provider's
   * own scrubbed text, which is for a developer; this is the machine-readable
   * cause the owner-facing health lamp reads. See llm/provider-failure.ts.
   */
  failureReason?: ProviderFailureReason;
  warning?: string;
  rawText?: string;
  latencyMs?: number;
  credentialUsed?: boolean;
  baseUrl?: string;
  mode?: "real" | "mock" | "fallback";
  testPrompt?: string;
  routeSource?: string;
  runId?: string;
  agentName?: string;
};

export type ModelCatalogEntry = {
  id: string;
  provider: LLMProviderId;
  modelName: string;
  displayName: string;
  family: string;
  tier: ModelTier;
  capabilities: ModelCapability[];
  recommendedSlots: ModelSlotId[];
  recommendedTasks: LLMTaskName[];
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  supportsVision: boolean;
  notes: string;
  deprecated: boolean;
  enabledByDefault: boolean;
};

export type ModelSelection = {
  slotId: ModelSlotId;
  provider: LLMProviderId;
  modelName: string;
  modelId?: string;
  credentialId?: string;
  modelTier: ModelTier;
  fallbackProvider: LLMProviderId;
  fallbackModelName?: string;
  enableMockFallback: boolean;
};
