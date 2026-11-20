import type { LLMProviderId } from "./provider-types";
import type { ModelCapability, ModelSlotId, ModelTier } from "./model-capabilities";
import type { LLMTaskName, ModelCatalogEntry } from "./types";

const textCaps: ModelCapability[] = ["text_generation", "structured_output", "json_mode"];
const reasoningCaps: ModelCapability[] = [...textCaps, "reasoning", "long_context"];
const imageCaps: ModelCapability[] = ["image_generation"];
const embeddingCaps: ModelCapability[] = ["embeddings"];
const searchCaps: ModelCapability[] = ["text_generation", "web_search", "search_grounding"];

function model(input: {
  provider: LLMProviderId;
  modelName: string;
  displayName?: string;
  family?: string;
  tier: ModelTier;
  capabilities?: ModelCapability[];
  recommendedSlots?: ModelSlotId[];
  recommendedTasks?: LLMTaskName[];
  requiresApiKey?: boolean;
  requiresBaseUrl?: boolean;
  deprecated?: boolean;
  notes?: string;
  enabledByDefault?: boolean;
}): ModelCatalogEntry {
  const capabilities = input.capabilities || textCaps;
  return {
    id: `${input.provider}:${input.modelName}`,
    provider: input.provider,
    modelName: input.modelName,
    displayName: input.displayName || input.modelName,
    family: input.family || input.provider,
    tier: input.tier,
    capabilities,
    recommendedSlots: input.recommendedSlots || slotsForTier(input.tier),
    recommendedTasks: input.recommendedTasks || tasksForTier(input.tier),
    requiresApiKey: input.requiresApiKey ?? (input.provider !== "mock" && input.provider !== "ollama"),
    requiresBaseUrl: input.requiresBaseUrl ?? ["ollama", "openai_compatible", "anthropic_compatible", "gemini_compatible"].includes(input.provider),
    supportsStreaming: capabilities.includes("text_generation"),
    supportsStructuredOutput: capabilities.includes("structured_output") || capabilities.includes("json_mode"),
    supportsVision: capabilities.includes("image_input"),
    notes: input.notes || "",
    deprecated: Boolean(input.deprecated),
    enabledByDefault: input.enabledByDefault ?? (input.provider === "mock"),
  };
}

export const DEFAULT_MODEL_CATALOG: ModelCatalogEntry[] = [
  ...[
    ["gpt-5.5", "strong"], ["gpt-5.5-pro", "reasoning"], ["gpt-5.4", "strong"], ["gpt-5.4-pro", "reasoning"], ["gpt-5.4-mini", "mini"], ["gpt-5.4-nano", "nano"],
    ["gpt-5-mini", "mini"], ["gpt-5-nano", "nano"], ["gpt-5", "strong"], ["gpt-4.1", "strong"], ["gpt-4.1-mini", "mini"], ["gpt-4.1-nano", "nano"],
    ["gpt-4o", "balanced"], ["gpt-4o-mini", "mini"], ["chat-latest", "balanced"],
  ].map(([name, tier]) => model({ provider: "openai", modelName: name, tier: tier as ModelTier, capabilities: tier === "reasoning" ? reasoningCaps : textCaps, family: "GPT" })),
  model({ provider: "openai", modelName: "text-embedding-3-small", tier: "embedding", capabilities: embeddingCaps, family: "OpenAI embeddings" }),
  model({ provider: "openai", modelName: "text-embedding-3-large", tier: "embedding", capabilities: embeddingCaps, family: "OpenAI embeddings" }),
  model({ provider: "openai", modelName: "text-embedding-ada-002", tier: "embedding", capabilities: embeddingCaps, family: "OpenAI embeddings", deprecated: true }),
  ...["gpt-image-2", "gpt-image-1.5", "chatgpt-image-latest", "gpt-image-1-mini"].map((name) => model({ provider: "openai", modelName: name, tier: "image", capabilities: imageCaps, family: "OpenAI image", notes: "Image GENERATION is catalog-only in LeadCockpit today — the providers only call chat-completion endpoints, not /images/generations. Listed for completeness; not yet wired for actual image output." })),
  ...["gpt-realtime", "gpt-realtime-mini", "gpt-audio", "gpt-audio-mini", "whisper", "tts-1", "tts-1-hd"].map((name) => model({ provider: "openai", modelName: name, tier: "audio", capabilities: ["audio_input", "audio_output"], family: "OpenAI audio", notes: "Audio/realtime placeholder in LeadCockpit." })),
  model({ provider: "openai", modelName: "omni-moderation", tier: "fast", capabilities: ["text_generation"], family: "OpenAI safety", notes: "Moderation placeholder." }),

  ...[
    ["claude-opus-4.7", "reasoning"], ["claude-opus-4.6", "reasoning"], ["claude-opus-4.5", "reasoning"], ["claude-opus-4.1", "reasoning"], ["claude-opus-4", "reasoning"],
    ["claude-sonnet-4.6", "strong"], ["claude-sonnet-4.5", "strong"], ["claude-sonnet-4", "strong"], ["claude-haiku-4.5", "mini"],
    ["claude-3-7-sonnet", "strong"], ["claude-3-5-sonnet", "strong"], ["claude-3-5-haiku", "mini"], ["claude-3-opus", "reasoning"], ["claude-3-sonnet", "strong"], ["claude-3-haiku", "mini"],
  ].map(([name, tier]) => model({ provider: "anthropic", modelName: name, tier: tier as ModelTier, capabilities: tier === "reasoning" ? reasoningCaps : textCaps, family: "Claude", deprecated: String(name).startsWith("claude-3-") })),

  ...[
    ["gemini-3.1-pro", "reasoning"], ["gemini-3.1-flash", "fast"], ["gemini-3.1-flash-lite", "mini"], ["gemini-2.5-pro", "strong"], ["gemini-2.5-flash", "fast"], ["gemini-2.5-flash-lite", "mini"],
  ].map(([name, tier]) => model({ provider: "gemini", modelName: name, tier: tier as ModelTier, capabilities: tier === "reasoning" ? reasoningCaps : textCaps, family: "Gemini" })),
  model({ provider: "gemini", modelName: "gemini-2.5-flash-image", tier: "image", capabilities: [...imageCaps, "image_input"], family: "Gemini image" }),
  model({ provider: "gemini", modelName: "gemini-2.5-computer-use-preview", tier: "strong", capabilities: [...textCaps, "tool_calling"], family: "Gemini tools" }),
  model({ provider: "gemini", modelName: "gemini-embedding", tier: "embedding", capabilities: embeddingCaps, family: "Gemini embeddings" }),
  model({ provider: "gemini", modelName: "gemini-embedding-2", tier: "embedding", capabilities: embeddingCaps, family: "Gemini embeddings" }),
  model({ provider: "gemini", modelName: "gemini-search-grounded", tier: "search", capabilities: searchCaps, family: "Gemini grounded search", notes: "Search-grounding is catalog-only today — the Gemini adapter does not yet send the googleSearchRetrieval tool. Real web search in LeadCockpit goes through SerpApi (prospecting + market research), not this model. Listed for completeness." }),
  model({ provider: "gemini", modelName: "gemini-tts-flash", tier: "audio", capabilities: ["audio_output"], family: "Gemini audio" }),
  model({ provider: "gemini", modelName: "gemini-tts-pro", tier: "audio", capabilities: ["audio_output"], family: "Gemini audio" }),

  ...[
    ["deepseek-v4-pro", "reasoning"], ["deepseek-v4-flash", "fast"], ["deepseek-chat", "balanced"], ["deepseek-reasoner", "reasoning"], ["deepseek-v3", "balanced"], ["deepseek-v3.1", "balanced"], ["deepseek-coder", "strong"],
  ].map(([name, tier]) => model({ provider: "deepseek", modelName: name, tier: tier as ModelTier, capabilities: [...(tier === "reasoning" ? reasoningCaps : textCaps), "openai_compatible"], family: "DeepSeek", notes: "Uses OpenAI-compatible adapter when configured." })),

  ...["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2", "M2-her", "MiniMax-Text-01"].map((name) => model({ provider: "minimax", modelName: name, tier: name.toLowerCase().includes("highspeed") ? "fast" : "balanced", capabilities: textCaps, family: "MiniMax" })),
  model({ provider: "minimax", modelName: "MiniMax-VL-01", tier: "strong", capabilities: [...textCaps, "image_input"], family: "MiniMax vision" }),

  ...["kimi-k2.6", "kimi-k2.5", "kimi-k2", "kimi-k2-thinking", "kimi-k2-thinking-turbo", "kimi-k2-turbo-preview", "kimi-k2-0905-preview", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"].map((name) => model({ provider: "kimi", modelName: name, tier: name.includes("thinking") ? "reasoning" : "balanced", capabilities: [...(name.includes("thinking") ? reasoningCaps : textCaps), "openai_compatible"], family: "Kimi / Moonshot", notes: "Usually configured through an OpenAI-compatible Moonshot endpoint." })),

  ...["ollama-custom", "gemma2:2b", "gemma2:9b", "gemma2:27b", "gemma3", "qwen2.5:0.5b", "qwen2.5:1.5b", "qwen2.5:3b", "qwen2.5:7b", "qwen2.5:14b", "qwen2.5:32b", "qwen2.5:72b", "qwen3", "llama3.1:8b", "llama3.1:70b", "llama3.2", "llama3.3", "mistral", "mixtral", "deepseek-r1", "codellama", "phi3", "phi4"].map((name) => model({ provider: "ollama", modelName: name, tier: "local", capabilities: ["text_generation", "local_runtime"], family: "Ollama local", requiresBaseUrl: true, notes: "Requires a reachable Ollama server." })),
  model({ provider: "ollama", modelName: "nomic-embed-text", tier: "embedding", capabilities: ["embeddings", "local_runtime"], family: "Ollama embeddings", requiresBaseUrl: true }),
  model({ provider: "ollama", modelName: "mxbai-embed-large", tier: "embedding", capabilities: ["embeddings", "local_runtime"], family: "Ollama embeddings", requiresBaseUrl: true }),

  model({ provider: "openai_compatible", modelName: "custom-openai-compatible", tier: "balanced", capabilities: [...textCaps, "openai_compatible"], family: "Custom provider", requiresBaseUrl: true, notes: "For OpenRouter, Together, Groq, Fireworks, Nebius, and other hosted OpenAI-compatible endpoints. NOTE: localhost/loopback base URLs (LM Studio, vLLM, local Ollama OpenAI-compat port) are blocked by the SSRF guard — use the dedicated Ollama provider for local models." }),
  model({ provider: "anthropic_compatible", modelName: "custom-anthropic-compatible", tier: "balanced", capabilities: [...textCaps, "anthropic_compatible"], family: "Custom provider", requiresBaseUrl: true }),
  model({ provider: "gemini_compatible", modelName: "custom-gemini-compatible", tier: "balanced", capabilities: [...textCaps, "gemini_compatible"], family: "Custom provider", requiresBaseUrl: true }),

  model({ provider: "mock", modelName: "mock-fast", tier: "fast", capabilities: textCaps, family: "Mock", requiresApiKey: false, requiresBaseUrl: false, enabledByDefault: true }),
  model({ provider: "mock", modelName: "mock-balanced", tier: "balanced", capabilities: textCaps, family: "Mock", requiresApiKey: false, requiresBaseUrl: false, enabledByDefault: true }),
  model({ provider: "mock", modelName: "mock-strong", tier: "strong", capabilities: reasoningCaps, family: "Mock", requiresApiKey: false, requiresBaseUrl: false, enabledByDefault: true }),
  model({ provider: "mock", modelName: "mock-search", tier: "search", capabilities: searchCaps, family: "Mock", requiresApiKey: false, requiresBaseUrl: false, enabledByDefault: true }),
  model({ provider: "mock", modelName: "mock-image", tier: "image", capabilities: imageCaps, family: "Mock", requiresApiKey: false, requiresBaseUrl: false, enabledByDefault: true }),
  model({ provider: "mock", modelName: "mock-embedding", tier: "embedding", capabilities: embeddingCaps, family: "Mock", requiresApiKey: false, requiresBaseUrl: false, enabledByDefault: true }),
];

export function listCatalog(provider?: LLMProviderId) {
  return provider ? DEFAULT_MODEL_CATALOG.filter((item) => item.provider === provider) : DEFAULT_MODEL_CATALOG;
}

export function findModel(provider: LLMProviderId, modelName: string) {
  return DEFAULT_MODEL_CATALOG.find((item) => item.provider === provider && item.modelName === modelName);
}

export function assertNoDuplicateModelIds() {
  const seen = new Set<string>();
  for (const item of DEFAULT_MODEL_CATALOG) {
    if (seen.has(item.id)) throw new Error(`Duplicate model catalog id: ${item.id}`);
    seen.add(item.id);
  }
  return true;
}

function slotsForTier(tier: ModelTier): ModelSlotId[] {
  if (tier === "embedding") return ["embedding_advanced"];
  if (tier === "image") return ["creative_image"];
  if (tier === "search") return ["research_search"];
  if (tier === "reasoning" || tier === "strong") return ["deep_reasoning"];
  if (tier === "fast" || tier === "nano" || tier === "mini") return ["fast_customer_reply", "daily_workhorse"];
  if (tier === "local") return ["fast_customer_reply", "daily_workhorse"];
  return ["daily_workhorse"];
}

function tasksForTier(tier: ModelTier): LLMTaskName[] {
  if (tier === "embedding") return ["embedding"];
  if (tier === "image") return ["image_generation", "creative_generation"];
  if (tier === "search") return ["web_search", "market_research"];
  if (tier === "reasoning" || tier === "strong") return ["product_application_research", "icp_generation", "campaign_planning", "campaign_learning", "quality_review"];
  return ["reply_classification", "whatsapp_reply", "message_generation", "lead_scoring", "document_extraction_mapping", "lead_review_decision"];
}
