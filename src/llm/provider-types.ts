export const LLM_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "minimax",
  "kimi",
  "ollama",
  "openai_compatible",
  "anthropic_compatible",
  "gemini_compatible",
  "mock",
] as const;

export type LLMProviderId = (typeof LLM_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<LLMProviderId, string> = {
  openai: "OpenAI / ChatGPT API",
  anthropic: "Anthropic Claude",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  kimi: "Moonshot / Kimi",
  ollama: "Ollama local",
  openai_compatible: "Custom OpenAI-compatible",
  anthropic_compatible: "Custom Anthropic-compatible",
  gemini_compatible: "Custom Gemini-compatible",
  mock: "Mock provider",
};

export function isLLMProviderId(value: string): value is LLMProviderId {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}
