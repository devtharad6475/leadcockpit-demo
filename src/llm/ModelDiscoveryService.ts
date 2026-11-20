import { maskSecret } from "@/lib/secret-redaction";
import { decryptSecret } from "@/lib/credential-security";
import { LLM_PROVIDERS, type LLMProviderId, isLLMProviderId } from "./provider-types";
import { DEFAULT_MODEL_CATALOG, listCatalog } from "./model-catalog";
import { SLOT_REQUIRED_CAPABILITIES, type ModelSlotId } from "./model-capabilities";
import type { LLMProviderCredential, LLMModelRouting } from "@/lib/types";
import type { ModelCatalogEntry } from "./types";

export type ProviderConfig = {
  provider: LLMProviderId;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
  extraConfig?: Record<string, unknown>;
};

export type ModelDiscoveryResult = {
  ok: boolean;
  provider: LLMProviderId;
  models: ModelCatalogEntry[];
  warning?: string;
  keyPreview?: string;
};

export function listStaticCatalog(provider?: string) {
  return isLLMProviderId(String(provider || "")) ? listCatalog(provider as LLMProviderId) : DEFAULT_MODEL_CATALOG;
}

export function listProviders() {
  return LLM_PROVIDERS.map((id) => ({
    id,
    requiresApiKey: id !== "mock" && id !== "ollama",
    requiresBaseUrl: ["ollama", "openai_compatible", "anthropic_compatible", "gemini_compatible"].includes(id),
  }));
}

export async function listModelsForProvider(provider: LLMProviderId, credential?: Partial<LLMProviderCredential>) {
  return fetchProviderModels(provider, credential);
}

export async function fetchProviderModels(provider: LLMProviderId, credential?: Partial<LLMProviderCredential>): Promise<ModelDiscoveryResult> {
  const config = credentialToConfig(provider, credential);
  if (provider === "mock") return { ok: true, provider, models: listCatalog("mock") };
  if (provider === "ollama") return fetchOllamaModels(config);
  if (!config.apiKey) {
    return {
      ok: false,
      provider,
      models: listCatalog(provider),
      warning: "No API key is configured. Showing static catalog and keeping mock fallback available.",
    };
  }
  if (["openai", "deepseek", "kimi", "minimax", "openai_compatible"].includes(provider)) {
    return fetchOpenAICompatibleModels(config);
  }
  if (provider === "gemini" || provider === "gemini_compatible") return fetchGeminiModels(config);
  if (provider === "anthropic" || provider === "anthropic_compatible") return fetchAnthropicModels(config);
  return { ok: true, provider, models: listCatalog(provider) };
}

export function mergeStaticAndFetchedModels(staticModels: ModelCatalogEntry[], fetchedModels: ModelCatalogEntry[]) {
  const byId = new Map(staticModels.map((item) => [item.id, item]));
  for (const item of fetchedModels) byId.set(item.id, item);
  return Array.from(byId.values());
}

export function normalizeProviderModel(provider: LLMProviderId, rawModel: unknown): ModelCatalogEntry {
  const record = rawModel as Record<string, unknown>;
  const modelName = String(record.id || record.name || record.model || "custom-model");
  const staticMatch = listCatalog(provider).find((item) => item.modelName === modelName);
  if (staticMatch) return staticMatch;
  return {
    id: `${provider}:${modelName}`,
    provider,
    modelName,
    displayName: modelName,
    family: provider,
    tier: provider === "ollama" ? "local" : "balanced",
    capabilities: provider === "ollama" ? ["text_generation", "local_runtime"] : ["text_generation", "structured_output"],
    recommendedSlots: provider === "ollama" ? ["fast_customer_reply", "daily_workhorse"] : ["daily_workhorse"],
    recommendedTasks: ["message_generation", "whatsapp_reply"],
    requiresApiKey: provider !== "mock" && provider !== "ollama",
    requiresBaseUrl: ["ollama", "openai_compatible", "anthropic_compatible", "gemini_compatible"].includes(provider),
    supportsStreaming: true,
    supportsStructuredOutput: true,
    supportsVision: false,
    notes: "Fetched from provider or custom endpoint. Capabilities may need manual review.",
    deprecated: false,
    enabledByDefault: false,
  };
}

export function validateModelCapability(model: ModelCatalogEntry | undefined, slotId: ModelSlotId) {
  if (!model) return { ok: false, warnings: ["No model selected. Mock fallback will be used."] };
  const required = SLOT_REQUIRED_CAPABILITIES[slotId];
  const warnings: string[] = [];
  for (const capability of required) {
    if (!model.capabilities.includes(capability)) warnings.push(`${model.displayName} may not support ${capability.replaceAll("_", " ")} for this slot.`);
  }
  if (model.deprecated) warnings.push(`${model.displayName} is marked deprecated in the static catalog.`);
  if (model.provider === "mock") warnings.push("Mock model selected. Good for demos, not real AI output.");
  if (model.provider === "ollama") warnings.push("Ollama must be reachable from the server environment, not just the browser.");
  return { ok: warnings.length === 0, warnings };
}

export function routingToSelection(route: LLMModelRouting): ProviderConfig {
  return {
    provider: isLLMProviderId(route.provider) ? route.provider : "mock",
    modelName: route.modelName,
    baseUrl: typeof route.config?.baseUrl === "string" ? route.config.baseUrl : undefined,
  };
}

function credentialToConfig(provider: LLMProviderId, credential?: Partial<LLMProviderCredential>): ProviderConfig {
  const config = (credential?.config || {}) as Record<string, unknown>;
  return {
    provider,
    apiKey: decryptSecret(credential?.encryptedApiKey, credential?.workspaceId) || undefined,
    baseUrl: normalizeBaseUrl(String(config.baseUrl || defaultBaseUrl(provider) || "")),
    extraConfig: config,
  };
}

function defaultBaseUrl(provider: LLMProviderId) {
  if (provider === "openai") return "https://api.openai.com/v1";
  if (provider === "deepseek") return "https://api.deepseek.com/v1";
  if (provider === "kimi") return "https://api.moonshot.ai/v1";
  if (provider === "minimax") return "https://api.minimax.io/v1";
  if (provider === "ollama") return "http://localhost:11434";
  return "";
}

async function fetchOpenAICompatibleModels(config: ProviderConfig): Promise<ModelDiscoveryResult> {
  try {
    // Session 4 audit fix: add a short timeout for discovery calls so a slow
    // or unreachable provider doesn't hang the model-listing UI.
    const response = await fetch(`${config.baseUrl || defaultBaseUrl(config.provider)}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey || ""}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Model fetch failed with ${response.status}`);
    const payload = await response.json() as { data?: unknown[] };
    const fetched = (payload.data || []).map((item) => normalizeProviderModel(config.provider, item));
    return { ok: true, provider: config.provider, models: mergeStaticAndFetchedModels(listCatalog(config.provider), fetched), keyPreview: maskSecret(config.apiKey) };
  } catch (error) {
    return { ok: false, provider: config.provider, models: listCatalog(config.provider), warning: normalizeError(error) };
  }
}

/**
 * Stage A.3 (2026-07-26) — REAL Anthropic model listing.
 * GET {baseUrl}/v1/models with x-api-key + anthropic-version headers.
 * Response: {data: [{id, display_name, ...}]}. Falls back to the static
 * catalog on any error (so a bad key doesn't block slot configuration).
 */
async function fetchAnthropicModels(config: ProviderConfig): Promise<ModelDiscoveryResult> {
  if (!config.apiKey) {
    return {
      ok: false,
      provider: config.provider,
      models: listCatalog(config.provider),
      warning: "No API key configured. Static catalog is shown. Add a key to fetch the live model list.",
      keyPreview: maskSecret(config.apiKey),
    };
  }
  try {
    const baseUrl = normalizeBaseUrl(config.baseUrl || "https://api.anthropic.com");
    const response = await fetch(`${baseUrl}/v1/models?limit=100`, {
      signal: AbortSignal.timeout(Number(process.env.LLM_PROVIDER_TIMEOUT_MS || 30000)),
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        provider: config.provider,
        models: listCatalog(config.provider),
        warning: `Anthropic model list returned ${response.status}: ${text.slice(0, 200)}. Static catalog shown.`,
        keyPreview: maskSecret(config.apiKey),
      };
    }
    const payload = await response.json() as { data?: Array<{ id?: string; display_name?: string }> };
    const fetched = (payload.data || [])
      .filter((m) => typeof m.id === "string")
      .map((m) => {
        // Map Anthropic's {id, display_name} to the shape normalizeProviderModel
        // reads (it expects id || name || model). displayName carries through.
        const entry = normalizeProviderModel(config.provider, { id: m.id, name: m.id });
        if (m.display_name) entry.displayName = m.display_name;
        return entry;
      });
    if (fetched.length === 0) {
      return {
        ok: true,
        provider: config.provider,
        models: listCatalog(config.provider),
        warning: "Anthropic API returned an empty model list. Static catalog shown.",
        keyPreview: maskSecret(config.apiKey),
      };
    }
    return { ok: true, provider: config.provider, models: mergeStaticAndFetchedModels(listCatalog(config.provider), fetched), keyPreview: maskSecret(config.apiKey) };
  } catch (error) {
    return {
      ok: false,
      provider: config.provider,
      models: listCatalog(config.provider),
      warning: `Anthropic model list failed: ${error instanceof Error ? error.message : "unknown error"}. Static catalog shown.`,
      keyPreview: maskSecret(config.apiKey),
    };
  }
}

/**
 * Stage A.3 (2026-07-26) — REAL Gemini model listing.
 * GET {baseUrl}/v1beta/models?key=apiKey. Response: {models: [{name, displayName}]}.
 * The `name` field arrives as "models/gemini-2.0-flash" — we strip the prefix.
 */
async function fetchGeminiModels(config: ProviderConfig): Promise<ModelDiscoveryResult> {
  if (!config.apiKey) {
    return {
      ok: false,
      provider: config.provider,
      models: listCatalog(config.provider),
      warning: "No API key configured. Static catalog is shown. Add a key to fetch the live model list.",
      keyPreview: maskSecret(config.apiKey),
    };
  }
  try {
    const baseUrl = normalizeBaseUrl(config.baseUrl || "https://generativelanguage.googleapis.com");
    const response = await fetch(`${baseUrl}/v1beta/models?pageSize=100&key=${encodeURIComponent(config.apiKey)}`, {
      signal: AbortSignal.timeout(Number(process.env.LLM_PROVIDER_TIMEOUT_MS || 30000)),
      headers: { "content-type": "application/json" },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        provider: config.provider,
        models: listCatalog(config.provider),
        warning: `Gemini model list returned ${response.status}: ${text.slice(0, 200)}. Static catalog shown.`,
        keyPreview: maskSecret(config.apiKey),
      };
    }
    const payload = await response.json() as { models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    // Only list models that support generateContent (some Gemini models are
    // embedding-only or image-only — they'd fail at runJsonTask time).
    const fetched = (payload.models || [])
      .filter((m) => typeof m.name === "string" && (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => {
        // Gemini's name arrives as "models/gemini-2.0-flash"; strip the prefix
        // before normalizeProviderModel uses it as the modelName.
        const cleanName = String(m.name).replace(/^models\//, "");
        const entry = normalizeProviderModel(config.provider, { id: cleanName, name: cleanName });
        if (m.displayName) entry.displayName = m.displayName;
        return entry;
      });
    if (fetched.length === 0) {
      return {
        ok: true,
        provider: config.provider,
        models: listCatalog(config.provider),
        warning: "Gemini API returned an empty model list. Static catalog shown.",
        keyPreview: maskSecret(config.apiKey),
      };
    }
    return { ok: true, provider: config.provider, models: mergeStaticAndFetchedModels(listCatalog(config.provider), fetched), keyPreview: maskSecret(config.apiKey) };
  } catch (error) {
    return {
      ok: false,
      provider: config.provider,
      models: listCatalog(config.provider),
      warning: `Gemini model list failed: ${error instanceof Error ? error.message : "unknown error"}. Static catalog shown.`,
      keyPreview: maskSecret(config.apiKey),
    };
  }
}

async function fetchOllamaModels(config: ProviderConfig): Promise<ModelDiscoveryResult> {
  try {
    const baseUrl = normalizeBaseUrl(config.baseUrl || "http://localhost:11434");
    // Session 4 audit fix: short timeout for Ollama discovery (localhost).
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const payload = await response.json() as { models?: Array<{ name?: string }> };
    const fetched = (payload.models || []).map((item) => normalizeProviderModel("ollama", { id: item.name }));
    if (!fetched.length) {
      return {
        ok: false,
        provider: "ollama",
        models: listCatalog("ollama"),
        warning: "No Ollama models found. Run: ollama pull gemma2:2b",
      };
    }
    return { ok: true, provider: "ollama", models: fetched };
  } catch {
    const baseUrl = normalizeBaseUrl(config.baseUrl || "http://localhost:11434");
    return {
      ok: false,
      provider: "ollama",
      models: listCatalog("ollama"),
      warning: `Could not reach Ollama at ${baseUrl}. Open Ollama or run ollama serve.`,
    };
  }
}

function normalizeBaseUrl(value: string) {
  return (value || "").trim().replace(/\/+$/, "");
}

function normalizeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Model discovery failed.";
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ****");
}
