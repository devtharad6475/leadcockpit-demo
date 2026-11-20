import { createRepositories } from "@/repositories";
import { routeModelSelection } from "./ModelRouter";
import { getPromptForTask } from "./prompts";
import { MockLLMProvider } from "./providers/MockLLMProvider";
import type { LLMProvider, LLMUsage } from "./providers/LLMProvider";
import type { LLMTaskName, LLMTaskOptions, LLMTaskResult } from "./types";
import { checkCanRunTask, recordUsage } from "@/services/AIUsageService";
import { isLLMProviderId } from "./provider-types";
import { OpenAIProvider } from "./providers/OpenAIProvider";
import { AnthropicProvider } from "./providers/AnthropicProvider";
import { GeminiProvider } from "./providers/GeminiProvider";
import { DeepSeekProvider, KimiProvider, MiniMaxProvider, OpenAICompatibleProvider } from "./providers/OpenAICompatibleProvider";
import { AnthropicCompatibleProvider } from "./providers/AnthropicCompatibleProvider";
import { GeminiCompatibleProvider } from "./providers/GeminiCompatibleProvider";
import { OllamaProvider } from "./providers/OllamaProvider";
import type { LLMProviderCredential } from "@/lib/types";
import { decryptSecret } from "@/lib/credential-security";
import { buildAgentRuntimePrompt } from "@/agents/AgentRuntime";
import { platformApiKey } from "./platform-defaults";
import { classifyProviderFailure } from "./provider-failure";

export class LLMService {
  constructor(
    private readonly provider: LLMProvider = new MockLLMProvider(),
    private readonly repos = createRepositories(),
  ) {}

  /**
   * ── WHY `options` IS REQUIRED AND workspaceId HAS NO DEFAULT (2026-08-26) ──
   * This read `options.workspaceId || "workspace_demo"`. Everything downstream
   * is keyed off that value: which model routing applies, WHOSE PROVIDER
   * CREDENTIALS are loaded, whose spend cap is checked, and whose workspace the
   * agent-run audit row is written into. A caller that forgot to pass a
   * workspace therefore ran a real customer's AI work on the demo tenant's key,
   * against the demo tenant's budget, and recorded it in the demo tenant's
   * audit trail -- silently, because a default that is always valid never
   * complains.
   *
   * Two callers were doing exactly that (the WhatsApp photo-vision path and the
   * market-research planner). Making the field required moved that from a thing
   * you have to remember to a thing the compiler will not let you forget; those
   * two were found by making this change and reading the errors.
   */
  async runTask<T>(taskName: LLMTaskName, input: unknown, options: LLMTaskOptions): Promise<LLMTaskResult<T>> {
    const workspaceId = options.workspaceId;
    const workspaceRoutes = await this.repos.llmModelRouting.listByWorkspace(workspaceId);
    const selectedRoute = routeModelSelection(taskName, workspaceRoutes);
    const credentials = await this.repos.llmProviderCredential.listByWorkspace(workspaceId);
    const modelTier = options.modelTier || selectedRoute.modelTier;
    const modelName = options.modelName || selectedRoute.modelName;
    // S6 R-4: pre-flight usage gate. estimatedTokens=1000 is a conservative
    // pre-call estimate; the real cost is recorded via recordUsage AFTER the
    // call returns. estimatedCost=0 here because we don't know the output size
    // yet — the monthly cost cap still catches runaway accumulation post-call.
    const usageCheck = await checkCanRunTask(workspaceId, taskName, 1000, 0, this.repos);
    if (!usageCheck.allowed) throw new Error(usageCheck.reason);
    const basePromptText = options.overridePrompt || getPromptForTask(taskName);
    const runtime = await buildAgentRuntimePrompt({ taskName, workspaceId, taskPrompt: basePromptText });
    const run = await this.repos.agentRun.create({
      workspaceId,
      agentName: runtime.agentName,
      input: { taskName, agentName: runtime.agentName, instructionVersion: runtime.instructionVersion, slotId: selectedRoute.slotId, modelTier, provider: selectedRoute.provider, modelName, routeSource: selectedRoute.routeSource, input: scrub(input) },
      status: "running",
      startedAt: new Date().toISOString(),
    });
    let provider: LLMProvider | undefined;
    const startTime = Date.now();
    const promptText = runtime.prompt;
    try {
      provider = options.provider
        ? this.providerFor(options.provider, options.modelName, credentials)
        : this.providerFor(selectedRoute.provider, selectedRoute.modelName, credentials, { baseUrl: selectedRoute.baseUrl, credentialId: selectedRoute.credentialId });
      const result = await provider.runJsonTask<T>({ taskName, modelTier, modelName, prompt: promptText, input: withoutDuplicatedDocument(input, promptText, provider.name) });
      await this.repos.agentRun.update(workspaceId, run.id, {
        status: "completed",
        output: { taskName, agentName: runtime.agentName, slotId: selectedRoute.slotId, modelTier, provider: provider.name, modelName, output: result.output },
        completedAt: new Date().toISOString(),
      });
      await recordUsage(workspaceId, resolveUsage(provider.name, result.usage, promptText, result.rawText), this.repos);
      return {
        output: result.output,
        provider: provider.name,
        modelTier,
        modelName,
        slotId: selectedRoute.slotId,
        fallbackUsed: false,
        rawText: result.rawText,
        latencyMs: Date.now() - startTime,
        credentialUsed: Boolean(selectedRoute.credentialId) || (provider.name !== "mock" && provider.name !== "ollama"),
        baseUrl: selectedRoute.baseUrl,
        // Phase 2.7 audit fix: mode:"real" requires a non-mock provider. The
        // JSON.parse safety fix (2.8) ensures that if a real provider returns
        // malformed/empty output, runJsonTask throws (caught by the fallback
        // path below), so this success path only runs with a valid output.
        mode: provider.name === "mock" ? "mock" : "real",
        testPrompt: promptText,
        routeSource: selectedRoute.routeSource,
        runId: run.id,
        agentName: runtime.agentName
      };
    } catch (error) {
      // N-BUG (2026-09-08): this catch is where the product silently gets
      // worse. Every provider error — balance exhausted, key revoked, provider
      // down — was swapped to the mock provider and the reason was kept only
      // in a `warning` string on the returned object, which nothing stored.
      // The owner's header chip went on saying "AI running". Classify it and
      // WRITE IT DOWN, so ProviderHealthService can tell them which of those
      // it is and what to do about it.
      const failure = classifyProviderFailure(error);
      if (!options.disableFallback && selectedRoute.enableMockFallback && (provider?.name !== "mock" || selectedRoute.provider !== "mock")) {
        const fallbackProviderName = selectedRoute.fallbackProvider || "mock";
        const fallbackModelName = selectedRoute.fallbackModelName || "mock-balanced";
        const fallback = this.providerFor(fallbackProviderName, fallbackModelName, credentials, { baseUrl: selectedRoute.fallbackBaseUrl || selectedRoute.baseUrl, credentialId: selectedRoute.fallbackCredentialId });
        
        try {
          const result = await fallback.runJsonTask<T>({ taskName, modelTier: "mock", modelName: fallbackModelName, prompt: promptText, input });
          await this.repos.agentRun.update(workspaceId, run.id, {
            status: "completed",
            output: { taskName, agentName: runtime.agentName, slotId: selectedRoute.slotId, provider: fallbackProviderName, modelName: fallbackModelName, fallbackUsed: true,
              // The health lamp reads these two off past runs.
              attemptedProvider: selectedRoute.provider, failureReason: failure.reason, failureSummary: failure.summary,
              output: result.output },
            completedAt: new Date().toISOString(),
          });
          await recordUsage(workspaceId, resolveUsage(fallback.name, result.usage, promptText, result.rawText), this.repos);
          return { 
            output: result.output, 
            provider: fallbackProviderName, 
            modelTier: "mock", 
            modelName: fallbackModelName, 
            slotId: selectedRoute.slotId, 
            fallbackUsed: true, 
            fallbackProvider: fallbackProviderName,
            fallbackModelName,
            failureReason: failure.reason,
            warning: scrubError(error), 
            rawText: result.rawText,
            latencyMs: Date.now() - startTime,
            credentialUsed: Boolean(selectedRoute.fallbackCredentialId) || (fallback.name !== "mock" && fallback.name !== "ollama"),
            baseUrl: selectedRoute.fallbackBaseUrl || selectedRoute.baseUrl,
            mode: fallback.name === "mock" ? "mock" : "fallback",
            testPrompt: promptText,
            agentName: runtime.agentName,
            routeSource: selectedRoute.routeSource,
            runId: run.id
          };
        } catch (fallbackError) {
          const message = scrubError(error) + " | Fallback also failed: " + scrubError(fallbackError);
          await this.repos.agentRun.update(workspaceId, run.id, {
            status: "failed",
            errorMessage: message,
            // Both providers down is the worst case for the owner and must not
            // be the one run the health lamp cannot read a reason off.
            output: { taskName, agentName: runtime.agentName, slotId: selectedRoute.slotId, attemptedProvider: selectedRoute.provider, failureReason: failure.reason, failureSummary: failure.summary },
            completedAt: new Date().toISOString(),
          });
          throw new Error(message);
        }
      }
      const message = scrubError(error);
      await this.repos.agentRun.update(workspaceId, run.id, {
        status: "failed",
        errorMessage: message,
        // Same reason, recorded on the hard-failure path too — a slot with the
        // fallback switched off must not be the one case the owner is not told
        // about.
        output: { taskName, agentName: runtime.agentName, slotId: selectedRoute.slotId, attemptedProvider: selectedRoute.provider, failureReason: failure.reason, failureSummary: failure.summary },
        completedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private providerFor(providerName: string, modelName: string | undefined, credentials: LLMProviderCredential[], routeConfig: { baseUrl?: string; credentialId?: string } = {}): LLMProvider {
    if (!isLLMProviderId(providerName)) return this.provider;
    const credential = routeConfig.credentialId
      ? credentials.find((item) => item.id === routeConfig.credentialId && item.provider === providerName)
      : undefined;
    const config = credential?.config || {};
    const apiKey = decryptSecret(credential?.encryptedApiKey, credential?.workspaceId) || (routeConfig.credentialId ? undefined : platformApiKey(providerName));
    const baseUrl = routeConfig.baseUrl || (typeof config.baseUrl === "string" ? config.baseUrl : undefined);
    if (!apiKey && providerName !== "ollama" && providerName !== "mock") throw new Error("Missing API key for this slot");
    if (providerName === "openai") return new OpenAIProvider({ apiKey, baseUrl, modelName });
    if (providerName === "anthropic") return new AnthropicProvider({ apiKey, baseUrl, modelName });
    if (providerName === "gemini") return new GeminiProvider({ apiKey, baseUrl, modelName });
    if (providerName === "deepseek") return new DeepSeekProvider({ apiKey, baseUrl, modelName });
    if (providerName === "minimax") return new MiniMaxProvider({ apiKey, baseUrl, modelName });
    if (providerName === "kimi") return new KimiProvider({ apiKey, baseUrl, modelName });
    if (providerName === "ollama") return new OllamaProvider({ provider: "ollama", baseUrl: baseUrl || process.env.PLATFORM_OLLAMA_BASE_URL || "http://localhost:11434", modelName });
    if (providerName === "openai_compatible") return new OpenAICompatibleProvider({ provider: providerName, apiKey, baseUrl, modelName });
    if (providerName === "anthropic_compatible") return new AnthropicCompatibleProvider({ provider: providerName, apiKey, baseUrl, modelName });
    if (providerName === "gemini_compatible") return new GeminiCompatibleProvider({ provider: providerName, apiKey, baseUrl, modelName });
    return new MockLLMProvider();
  }
}

// N-AI-2 (2026-08-20): the env-name table moved to platform-defaults.ts so the
// ROUTING layer can ask "is there a key?" without importing this service (which
// imports the router). Two copies of that list is how the default routes drifted
// away from the keys in the first place. Re-exported here so every existing
// `import { platformApiKey } from "@/llm/LLMService"` keeps working.
export { platformApiKey } from "./platform-defaults";

/**
 * 2026-09-17 (session 56): do not pay for the same document twice.
 *
 * Every real provider sends `prompt` as the system message and
 * `JSON.stringify(input)` as the user message. Document extraction builds a
 * prompt that already CONTAINS the document text and then passes the same text
 * again as `input.documentText`, so each of the 25 extraction calls billed the
 * document twice — and, with whole-document extraction, that is the largest
 * input in the product.
 *
 * Only real providers are affected: the mock provider has no prompt parser and
 * builds its demo answers from `input.documentText`, so it keeps the field.
 */
export function withoutDuplicatedDocument(input: unknown, promptText: string, providerName: string): unknown {
  if (providerName === "mock" || !input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const text = record.documentText;
  if (typeof text !== "string" || text.length < 200 || !promptText.includes(text)) return input;
  return { ...record, documentText: `[the document text (${text.length} characters) is in the instructions above]` };
}

function scrub(input: unknown) {
  const text = JSON.stringify(input);
  if (text.length > 4000) return { truncated: true, preview: text.slice(0, 4000) };
  return input as Record<string, unknown>;
}

function scrubError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown LLM task failure";
  // 2026-07-26 Session 4 audit fix (P3-LLM-SCRUB-1): also scrub URL query-param
  // keys. Gemini puts the API key in the URL as `?key=...` (per Google's API
  // contract). Node's native fetch errors today don't echo the URL (verified
  // empirically), but a future Node upgrade, an Edge runtime, or a debug log
  // could surface it. Defense-in-depth: scrub now so it can never leak.
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ****")
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s]+/g, "$1****");
}

/**
 * M3.5 / O3 audit fix: resolve honest token/cost numbers from a provider
 * response. Replaces the previous fake `tokens: 1000, cost: 0.001` constant.
 *
 *   - Mock provider: tokens 0, cost 0 (mock = no real usage).
 *   - Real provider that returned a usage block: use its real token count
 *     and compute cost from the per-provider rate table.
 *   - Real provider that omitted usage (Ollama, some stubs): fall back to a
 *     length-based estimate (~4 chars per token). The estimate is honest
 *     about being approximate; the daily quota counter still moves.
 */
const COST_PER_1K_TOKENS_USD: Record<string, number> = {
  openai: 0.002,
  openai_compatible: 0.002,
  deepseek: 0.0014,
  kimi: 0.002,
  anthropic: 0.003,
  anthropic_compatible: 0.003,
  gemini: 0.001,
  gemini_compatible: 0.001,
  minimax: 0.002,
  ollama: 0,
  mock: 0,
};

/**
 * 2026-09-18 (session 57) — what a provider ACTUALLY charges, per 1,000 tokens.
 *
 * The flat table above prices every token the same. Real providers charge three
 * different rates, and the gaps are not small: on deepseek-flash, output costs
 * 4x fresh input, and input served from the provider's prompt cache costs
 * 1/50th of fresh input (checked against api-docs.deepseek.com on 2026-09-18:
 * peak $0.30 / $0.006 / $1.20 per 1M; off-peak is half, so peak is the safe
 * number to bill at).
 *
 * This mattered the moment document extraction started re-sending the same
 * document to all 25 question groups: nearly all of that input is a cache hit.
 * A measured run recorded $0.70 of "spend" that really cost about $0.10 — and
 * the inflated figure is what pushed the workspace over its cap and lost 7
 * groups of answers.
 *
 * A provider without an entry here keeps the flat rate above; nothing silently
 * becomes free.
 */
type TokenRates = { input: number; cachedInput: number; output: number };
const RATES_PER_1K_TOKENS_USD: Record<string, TokenRates> = {
  // deepseek-flash at peak rates. deepseek-chat / deepseek-reasoner are legacy
  // names served by the same model and billed at the same price.
  deepseek: { input: 0.0003, cachedInput: 0.000006, output: 0.0012 },
  ollama: { input: 0, cachedInput: 0, output: 0 },
  mock: { input: 0, cachedInput: 0, output: 0 },
};

/**
 * Cost from the provider's own split of input / cached input / output, when we
 * know that provider's three rates AND it told us the split. Returns null when
 * either is missing, so the caller falls back to the flat rate rather than
 * inventing a cheaper number.
 */
function ratedCost(providerName: string, usage: LLMUsage): number | null {
  const rates = RATES_PER_1K_TOKENS_USD[providerName];
  if (!rates) return null;
  const promptTokens = usage.promptTokens;
  const completionTokens = usage.completionTokens;
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return null;
  // Cached tokens are part of promptTokens, so the fresh input is the remainder.
  const cached = Math.max(0, Math.min(usage.cachedPromptTokens ?? 0, promptTokens));
  const fresh = promptTokens - cached;
  return (fresh / 1000) * rates.input + (cached / 1000) * rates.cachedInput + (completionTokens / 1000) * rates.output;
}

export function resolveUsage(providerName: string, usage: LLMUsage | undefined, promptText: string, rawText?: string): { tokens: number; cost: number } {
  if (providerName === "mock") return { tokens: 0, cost: 0 };
  // Real provider that returned a usage block.
  if (usage && typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
    const rated = ratedCost(providerName, usage);
    if (rated !== null) return { tokens: usage.totalTokens, cost: rated };
    const rate = COST_PER_1K_TOKENS_USD[providerName] ?? 0.002;
    return { tokens: usage.totalTokens, cost: (usage.totalTokens / 1000) * rate };
  }
  if (usage && (typeof usage.promptTokens === "number" || typeof usage.completionTokens === "number")) {
    const tokens = (usage.promptTokens || 0) + (usage.completionTokens || 0);
    const rated = ratedCost(providerName, usage);
    if (rated !== null) return { tokens, cost: rated };
    const rate = COST_PER_1K_TOKENS_USD[providerName] ?? 0.002;
    return { tokens, cost: (tokens / 1000) * rate };
  }
  // Fallback: length-based estimate (~4 chars per token). Honest approximation.
  const estimatedTokens = Math.ceil((promptText.length + (rawText?.length || 0)) / 4);
  const rate = COST_PER_1K_TOKENS_USD[providerName] ?? 0.002;
  return { tokens: estimatedTokens, cost: providerName === "ollama" ? 0 : (estimatedTokens / 1000) * rate };
}
