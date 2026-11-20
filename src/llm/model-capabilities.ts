export const MODEL_CAPABILITIES = [
  "text_generation",
  "structured_output",
  "function_calling",
  "tool_calling",
  "json_mode",
  "image_input",
  "image_generation",
  "audio_input",
  "audio_output",
  "video_input",
  "embeddings",
  "reranking",
  "web_search",
  "search_grounding",
  "long_context",
  "reasoning",
  "fast_low_latency",
  "local_runtime",
  "openai_compatible",
  "anthropic_compatible",
  "gemini_compatible",
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const MODEL_TIERS = [
  "nano",
  "mini",
  "fast",
  "balanced",
  "strong",
  "reasoning",
  "search",
  "image",
  "embedding",
  "audio",
  "local",
  "mock",
] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

export const SLOT_IDS = [
  "fast_customer_reply",
  "daily_workhorse",
  "deep_reasoning",
  "research_search",
  "creative_image",
  "embedding_advanced",
] as const;

export type ModelSlotId = (typeof SLOT_IDS)[number];

export const SLOT_LABELS: Record<ModelSlotId, string> = {
  fast_customer_reply: "Fast Customer Reply Model",
  daily_workhorse: "Daily Workhorse Model",
  deep_reasoning: "Deep Reasoning Model",
  research_search: "Research / Search Model",
  creative_image: "Creative / Image Model",
  embedding_advanced: "Embedding / Knowledge Search Model",
};

export const SLOT_REQUIRED_CAPABILITIES: Record<ModelSlotId, ModelCapability[]> = {
  fast_customer_reply: ["text_generation"],
  daily_workhorse: ["text_generation", "structured_output"],
  deep_reasoning: ["text_generation", "reasoning"],
  research_search: ["web_search"],
  creative_image: ["image_generation"],
  embedding_advanced: ["embeddings"],
};
