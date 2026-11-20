/**
 * platform-defaults.ts — what a BRAND-NEW workspace runs on. (N-AI-2, 2026-08-20)
 *
 * THE BUG THIS FIXES
 * ------------------
 * Every one of the six model slots defaulted to the `mock` provider, and nothing
 * anywhere ever pointed a fresh install at the operator's real key. The key could
 * be sitting in the environment, correct and paid for, and the product would
 * still answer customers with `MockLLMProvider` output until somebody opened AI
 * Settings and changed all six slots by hand.
 *
 * That is a day-one customer bug, not a config nicety: mock replies look like
 * real replies to an operator who has never seen the real thing.
 *
 * WHAT IT DOES NOW
 * ----------------
 * If a platform API key is present in the environment, the slot defaults resolve
 * to that provider's real models. If no key is present, they stay on mock —
 * which is the honest answer, because there is nothing else to run on.
 *
 * WHY THE ENV-NAME TABLE LIVES HERE
 * ---------------------------------
 * `platformApiKey()` used to be a hand-written if-chain inside LLMService, and
 * the routing layer had no way to ask "is there a key?" without importing the
 * service that imports the router. That split is exactly how the default routes
 * drifted away from the keys. One table, one reader, both layers.
 */
import type { ModelSlotId, ModelTier } from "./model-capabilities";

/** Every provider the platform can hold a key for, and the env var that holds it. */
export const PLATFORM_KEY_ENV = {
  deepseek: "PLATFORM_DEEPSEEK_API_KEY",
  openai: "PLATFORM_OPENAI_API_KEY",
  anthropic: "PLATFORM_ANTHROPIC_API_KEY",
  gemini: "PLATFORM_GEMINI_API_KEY",
  kimi: "PLATFORM_KIMI_API_KEY",
  minimax: "PLATFORM_MINIMAX_API_KEY",
} as const;

export type PlatformProviderId = keyof typeof PLATFORM_KEY_ENV;

/**
 * The same keys under their UNPREFIXED names (2026-09-08).
 *
 * WHY THIS EXISTS. The demo deployment was given a DeepSeek key named
 * `DEEPSEEK_API_KEY`. Nothing read it. Every AI call fell back to canned text
 * and the AI Settings screen reported "No API key is set for this model", which
 * is indistinguishable from a revoked or mistyped key — the operator had done
 * the work, paid for the key, and had no way to see that only the NAME was
 * wrong.
 *
 * What made it worse is that the product was already inconsistent about this:
 * the SerpApi lookup has always been `PLATFORM_SERPAPI_API_KEY || SERPAPI_API_KEY`,
 * so on the same service, saved in the same sitting, the search key worked and
 * the model key did not. `DEEPSEEK_API_KEY` is also the name DeepSeek's own
 * documentation uses, so it is the name an operator will reach for first.
 *
 * The prefixed name still WINS when both are set: `PLATFORM_*` is the
 * deliberate, platform-level choice, and an operator who sets both means the
 * one they had to learn about from this product.
 */
export const PLATFORM_KEY_ENV_FALLBACK = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  kimi: "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
} as const;

/**
 * Order used to pick a default when several keys are configured. DeepSeek is
 * first because it is the only provider this product has been measured on end
 * to end (the ten-company acceptance run). An operator can override the choice
 * with PLATFORM_DEFAULT_PROVIDER.
 */
export const PLATFORM_PROVIDER_PREFERENCE: readonly PlatformProviderId[] = [
  "deepseek",
  "openai",
  "anthropic",
  "gemini",
  "kimi",
  "minimax",
];

/**
 * Resolve a platform-level key. Blank and whitespace-only values count as
 * ABSENT — a half-filled `.env` line must not be mistaken for a working key,
 * because that turns a clear "no AI configured" state into a runtime 401.
 */
export function platformApiKey(providerName: string): string | undefined {
  const envName = (PLATFORM_KEY_ENV as Record<string, string | undefined>)[providerName];
  if (!envName) return undefined;
  const primary = process.env[envName];
  if (primary && primary.trim()) return primary;
  // Fall back to the unprefixed name. A blank primary must NOT stop the
  // fallback being read: an operator who left `PLATFORM_DEEPSEEK_API_KEY=` in a
  // file and put the real key in `DEEPSEEK_API_KEY` has configured a working
  // key, and refusing to see it is the failure this fallback exists to end.
  const fallbackName = (PLATFORM_KEY_ENV_FALLBACK as Record<string, string | undefined>)[providerName];
  const fallback = fallbackName ? process.env[fallbackName] : undefined;
  return fallback && fallback.trim() ? fallback : undefined;
}

/** Which providers currently have a usable platform key, in preference order. */
export function availablePlatformProviders(): PlatformProviderId[] {
  return PLATFORM_PROVIDER_PREFERENCE.filter((provider) => Boolean(platformApiKey(provider)));
}

/**
 * The provider a fresh workspace should run on, or undefined when the operator
 * has configured no key at all.
 */
export function resolvePlatformDefaultProvider(): PlatformProviderId | undefined {
  const pinned = process.env.PLATFORM_DEFAULT_PROVIDER?.trim();
  if (pinned) {
    // An explicit pin that has no key is an operator mistake worth ignoring
    // loudly rather than silently honouring — fall through to the normal order.
    if ((PLATFORM_PROVIDER_PREFERENCE as readonly string[]).includes(pinned) && platformApiKey(pinned)) {
      return pinned as PlatformProviderId;
    }
    console.warn(
      `[platform-defaults] PLATFORM_DEFAULT_PROVIDER="${pinned}" ignored: ` +
        `${(PLATFORM_PROVIDER_PREFERENCE as readonly string[]).includes(pinned) ? "no API key is set for it" : "not a known provider"}.`,
    );
  }
  return availablePlatformProviders()[0];
}

type SlotModel = { modelName: string; modelTier: ModelTier };

/**
 * Real model per slot per provider. Every name here must exist in
 * DEFAULT_MODEL_CATALOG with this exact tier — `golden-platform-ai-defaults`
 * asserts that, so a typo fails the suite instead of failing a customer.
 *
 * TWO SLOTS ARE DELIBERATELY LEFT ON MOCK for every provider:
 *   creative_image     — image GENERATION is catalog-only in LeadCockpit today
 *                        (no provider adapter calls an images endpoint), so
 *                        pointing this slot at a real model would buy a 404,
 *                        not a picture.
 *   embedding_advanced — unless the provider actually has an embedding model.
 *                        Embeddings do NOT go through the slot router at all
 *                        (src/llm/embedding.ts resolves Ollama, then OpenAI),
 *                        so this entry is display truth for the AI Settings
 *                        screen, not a call path.
 *
 * ONLY DEEPSEEK IS PROVEN LIVE. The other five tables are catalog-correct and
 * unproven — no run has exercised them. Stated here rather than implied.
 */
const PLATFORM_SLOT_MODELS: Record<PlatformProviderId, Partial<Record<ModelSlotId, SlotModel>>> = {
  deepseek: {
    fast_customer_reply: { modelName: "deepseek-chat", modelTier: "balanced" },
    daily_workhorse: { modelName: "deepseek-chat", modelTier: "balanced" },
    deep_reasoning: { modelName: "deepseek-reasoner", modelTier: "reasoning" },
    research_search: { modelName: "deepseek-chat", modelTier: "balanced" },
  },
  openai: {
    fast_customer_reply: { modelName: "gpt-4o-mini", modelTier: "mini" },
    daily_workhorse: { modelName: "gpt-4o", modelTier: "balanced" },
    deep_reasoning: { modelName: "gpt-4.1", modelTier: "strong" },
    research_search: { modelName: "gpt-4o", modelTier: "balanced" },
    embedding_advanced: { modelName: "text-embedding-3-small", modelTier: "embedding" },
  },
  anthropic: {
    fast_customer_reply: { modelName: "claude-haiku-4.5", modelTier: "mini" },
    daily_workhorse: { modelName: "claude-sonnet-4.5", modelTier: "strong" },
    deep_reasoning: { modelName: "claude-opus-4.5", modelTier: "reasoning" },
    research_search: { modelName: "claude-sonnet-4.5", modelTier: "strong" },
  },
  gemini: {
    fast_customer_reply: { modelName: "gemini-2.5-flash", modelTier: "fast" },
    daily_workhorse: { modelName: "gemini-2.5-flash", modelTier: "fast" },
    deep_reasoning: { modelName: "gemini-2.5-pro", modelTier: "strong" },
    research_search: { modelName: "gemini-2.5-flash", modelTier: "fast" },
    embedding_advanced: { modelName: "gemini-embedding", modelTier: "embedding" },
  },
  kimi: {
    fast_customer_reply: { modelName: "kimi-k2", modelTier: "balanced" },
    daily_workhorse: { modelName: "kimi-k2", modelTier: "balanced" },
    deep_reasoning: { modelName: "kimi-k2-thinking", modelTier: "reasoning" },
    research_search: { modelName: "kimi-k2", modelTier: "balanced" },
  },
  minimax: {
    fast_customer_reply: { modelName: "MiniMax-M2", modelTier: "balanced" },
    daily_workhorse: { modelName: "MiniMax-M2", modelTier: "balanced" },
    deep_reasoning: { modelName: "MiniMax-M2", modelTier: "balanced" },
    research_search: { modelName: "MiniMax-M2", modelTier: "balanced" },
  },
};

/** What every slot falls back to when there is no key: the honest mock. */
export const MOCK_SLOT_DEFAULTS: Record<ModelSlotId, PlatformSlotDefault> = {
  fast_customer_reply: { provider: "mock", modelName: "mock-fast", modelTier: "fast", enableMockFallback: true },
  daily_workhorse: { provider: "mock", modelName: "mock-balanced", modelTier: "balanced", enableMockFallback: true },
  deep_reasoning: { provider: "mock", modelName: "mock-strong", modelTier: "strong", enableMockFallback: true },
  research_search: { provider: "mock", modelName: "mock-search", modelTier: "search", enableMockFallback: true },
  creative_image: { provider: "mock", modelName: "mock-image", modelTier: "image", enableMockFallback: true },
  embedding_advanced: { provider: "mock", modelName: "mock-embedding", modelTier: "embedding", enableMockFallback: true },
};

export type PlatformSlotDefault = {
  provider: string;
  modelName: string;
  modelTier: ModelTier;
  /**
   * FALSE on every real-provider slot, on purpose. Mock fallback means "if the
   * real model fails, silently answer with generated placeholder text". That is
   * acceptable for a demo and unacceptable for a workspace wired to a live key:
   * the operator would be reviewing invented sentences believing they came from
   * the model. A real slot that fails must FAIL, visibly.
   */
  enableMockFallback: boolean;
};

/**
 * The slot defaults in force RIGHT NOW. Deliberately a function, not a const:
 * the answer depends on the environment, and a module-load-time snapshot would
 * make the behaviour untestable and would freeze whatever the env looked like
 * when the first import happened.
 */
export function platformSlotDefaults(): Record<ModelSlotId, PlatformSlotDefault> {
  const provider = resolvePlatformDefaultProvider();
  if (!provider) return { ...MOCK_SLOT_DEFAULTS };

  const table = PLATFORM_SLOT_MODELS[provider];
  const out = {} as Record<ModelSlotId, PlatformSlotDefault>;
  for (const slotId of Object.keys(MOCK_SLOT_DEFAULTS) as ModelSlotId[]) {
    const real = table[slotId];
    out[slotId] = real
      ? { provider, modelName: real.modelName, modelTier: real.modelTier, enableMockFallback: false }
      : MOCK_SLOT_DEFAULTS[slotId];
  }
  return out;
}

/** Only for diagnostics/UI: the per-provider table, without env lookups. */
export function platformSlotModelTable(): Record<PlatformProviderId, Partial<Record<ModelSlotId, SlotModel>>> {
  return PLATFORM_SLOT_MODELS;
}
