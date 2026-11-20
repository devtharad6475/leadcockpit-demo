import { findModel } from "./model-catalog";
import { isLLMProviderId } from "./provider-types";
import type { LLMModelRouting } from "@/lib/types";
import type { LLMTaskName, ModelSlotId, ModelTier } from "./types";
import { platformSlotDefaults, type PlatformSlotDefault } from "./platform-defaults";

export const TASK_SLOT_MAP: Record<LLMTaskName, ModelSlotId> = {
  reply_classification: "fast_customer_reply",
  whatsapp_reply: "fast_customer_reply",
  knowledge_answer: "fast_customer_reply",
  policy_answer: "fast_customer_reply",
  message_generation: "daily_workhorse",
  lead_scoring: "daily_workhorse",
  document_extraction_mapping: "daily_workhorse",
  business_extraction: "daily_workhorse",
  lead_review_decision: "daily_workhorse",
  lead_enrichment: "daily_workhorse",
  product_application_research: "deep_reasoning",
  icp_generation: "deep_reasoning",
  campaign_planning: "deep_reasoning",
  campaign_learning: "deep_reasoning",
  quality_review: "deep_reasoning",
  web_search: "research_search",
  prospect_research: "research_search",
  market_research: "research_search",
  image_generation: "creative_image",
  creative_generation: "creative_image",
  embedding: "embedding_advanced",
  manual_answer_mapping: "daily_workhorse",
};

// N-AI-2 (2026-08-20): this was a frozen table of six `mock` entries, so a fresh
// install answered real customers with MockLLMProvider output even when the
// operator's key was sitting right there in the environment. It is now resolved
// from the environment on every call — see src/llm/platform-defaults.ts for why
// creative_image and (for most providers) embedding_advanced stay on mock.
function slotDefaultsNow(): Record<ModelSlotId, PlatformSlotDefault> {
  return platformSlotDefaults();
}

export type RoutedModel = {
  taskName: LLMTaskName;
  slotId: ModelSlotId;
  provider: string;
  modelName: string;
  modelTier: ModelTier;
  routeSource: "task_override" | "slot_setting" | "platform_default" | "mock_fallback";
  fallbackProvider: string;
  fallbackModelName?: string;
  enableMockFallback: boolean;
  baseUrl?: string;
  credentialId?: string;
  fallbackBaseUrl?: string;
  fallbackCredentialId?: string;
};

export function routeModel(taskName: LLMTaskName, override?: ModelTier): ModelTier {
  return override || slotDefaultsNow()[TASK_SLOT_MAP[taskName] || "daily_workhorse"].modelTier;
}

export function getSlotForTask(taskName: LLMTaskName): ModelSlotId {
  return TASK_SLOT_MAP[taskName] || "daily_workhorse";
}

export function resolveEffectiveModelName(selectedModelName: string | undefined, customModelName: string | undefined): string {
  if (!selectedModelName) return customModelName || "";
  if (
    selectedModelName.endsWith("-custom") ||
    selectedModelName.includes("-compatible") ||
    selectedModelName === "custom-local-http"
  ) {
    if (!customModelName || !customModelName.trim()) {
      throw new Error(`Custom model name is required for selection: ${selectedModelName}`);
    }
    return customModelName.trim();
  }
  return selectedModelName;
}

// UA-7 fix (2026-08-14): this used to also check for a task-level override
// row (`route.taskName === taskName`) and let it silently win over the
// slot-level setting the AI Settings UI actually shows/edits — a seeded demo
// row (`llm_route_whatsapp_demo`) pinned WhatsApp replies to mock forever
// with zero UI visibility that anything was overriding the configured slot.
// Removed per product decision: only the slot-level row (the one the 6-slot
// AI Settings screen controls) is consulted now, so what you see there is
// always what actually runs — no hidden second tier.
export function routeModelSelection(taskName: LLMTaskName, routes: LLMModelRouting[] = []): RoutedModel {
  const slotId = getSlotForTask(taskName);
  const slotRoute = routes.find((route) => route.taskName === slotId && route.isEnabled);
  const selected = slotRoute;
  const defaults = slotDefaultsNow()[slotId];
  const provider = selected?.provider || defaults.provider;
  const rawModelName = selected?.modelName || defaults.modelName;
  const modelName = resolveEffectiveModelName(rawModelName, typeof selected?.config?.customModelName === "string" ? selected.config.customModelName : undefined);

  const rawFallbackModelName = selected?.fallbackModelName || defaults.modelName;
  let fallbackModelName: string | undefined;
  try {
    fallbackModelName = resolveEffectiveModelName(rawFallbackModelName, typeof selected?.config?.fallbackCustomModelName === "string" ? selected.config.fallbackCustomModelName : undefined);
  } catch {
    fallbackModelName = rawFallbackModelName; // Ignore error for fallback if it's not being used, but LLMService might catch it later if needed. Actually it's better to just resolve it.
  }

  const catalogModel = isLLMProviderId(provider) ? findModel(provider, modelName) : undefined;
  return {
    taskName,
    slotId,
    provider,
    modelName,
    modelTier: (selected?.modelTier as ModelTier | undefined) || catalogModel?.tier || defaults.modelTier,
    routeSource: slotRoute ? "slot_setting" : "platform_default",
    fallbackProvider: selected?.fallbackProvider || (defaults.enableMockFallback ? "mock" : defaults.provider),
    fallbackModelName: fallbackModelName,
    // No slot row = platform default. A real-provider default must NOT silently
    // answer with mock text when the model fails (see PlatformSlotDefault).
    enableMockFallback: selected ? selected.config?.enableMockFallback !== false : defaults.enableMockFallback,
    baseUrl: typeof selected?.config?.baseUrl === "string" ? selected.config.baseUrl : undefined,
    credentialId: typeof selected?.config?.credentialId === "string" ? selected.config.credentialId : undefined,
    fallbackBaseUrl: typeof selected?.config?.fallbackBaseUrl === "string" ? selected.config.fallbackBaseUrl : undefined,
    fallbackCredentialId: typeof selected?.config?.fallbackCredentialId === "string" ? selected.config.fallbackCredentialId : undefined,
  };
}

export function defaultSlotRoutes(workspaceId: string): Partial<LLMModelRouting>[] {
  return Object.entries(slotDefaultsNow()).map(([slotId, defaults]) => ({
    workspaceId,
    taskName: slotId,
    provider: defaults.provider,
    modelName: defaults.modelName,
    modelTier: defaults.modelTier,
    isEnabled: true,
    fallbackProvider: defaults.enableMockFallback ? "mock" : defaults.provider,
    fallbackModelName: defaults.modelName,
    config: { enableMockFallback: defaults.enableMockFallback },
  }));
}
