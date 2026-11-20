import type { LLMTaskName, ModelCatalogEntry, ModelTier } from "../types";

/**
 * M3.5 / O3 audit fix: optional usage stats returned by the provider. When
 * present (OpenAI-compatible APIs return this by default), LLMService records
 * the real token count and an estimated cost instead of the previous fake
 * `tokens: 1000, cost: 0.001` constant. Providers that don't return usage
 * (Ollama, mock, Anthropic-stub) leave it undefined and LLMService falls
 * back to a length-based estimate that is clearly labelled as estimated.
 */
export type LLMUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /**
   * 2026-09-18 (session 57): input tokens the provider served from ITS prompt
   * cache. DeepSeek charges $0.006 per 1M for these against $0.30 per 1M for a
   * cache miss — fifty times cheaper — and OpenAI charges a tenth. Document
   * extraction re-sends the same document to 25 question groups, so most of its
   * input is a cache hit; pricing those at the full rate overstated the bill by
   * about 7x on a measured run, which is also what made the token cap bite.
   * DeepSeek reports it as `prompt_cache_hit_tokens`, OpenAI as
   * `prompt_tokens_details.cached_tokens`. These tokens are INCLUDED in
   * promptTokens, never added on top.
   */
  cachedPromptTokens?: number;
};

export interface LLMProvider {
  name: string;
  testConnection?(): Promise<{ ok: boolean; message: string }>;
  listModels?(): Promise<ModelCatalogEntry[]>;
  supportsCapability?(capability: string): boolean;
  runJsonTask<T>(input: {
    taskName: LLMTaskName;
    modelTier: ModelTier;
    modelName?: string;
    prompt: string;
    input: unknown;
  }): Promise<{ output: T; rawText?: string; usage?: LLMUsage }>;
}
