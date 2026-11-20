import type { LLMProvider, LLMUsage } from "./LLMProvider";
import { parseModelJson } from "./tolerant-json";
import type { LLMProviderId } from "../provider-types";
import { fetchProviderModels, type ProviderConfig } from "../ModelDiscoveryService";
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";

/**
 * The opening words of the "ran out of output room" error.
 *
 * Shared rather than duplicated because a caller has to RECOGNISE this failure
 * to react to it usefully — retrying the identical oversized request just pays
 * for the same truncation again, whereas splitting it in half succeeds. Two
 * copies of this string would drift, and the day they drifted the recovery
 * would silently stop happening while the tests still passed.
 */
export const TRUNCATED_OUTPUT_MARKER = "Provider's answer was cut off";

export class OpenAICompatibleProvider implements LLMProvider {
  name: string;
  constructor(private readonly config: ProviderConfig) {
    this.name = config.provider;
  }

  async testConnection() {
    if (!this.config.apiKey && this.config.provider !== "ollama") {
      return { ok: false, message: "Missing API key. Mock fallback should remain enabled." };
    }
    const result = await fetchProviderModels(this.config.provider, {
      provider: this.config.provider,
      encryptedApiKey: this.config.apiKey,
      config: { baseUrl: this.config.baseUrl },
    });
    return { ok: result.ok, message: result.warning || "Connection/model list check completed." };
  }

  async listModels() {
    return (await fetchProviderModels(this.config.provider, {
      provider: this.config.provider,
      encryptedApiKey: this.config.apiKey,
      config: { baseUrl: this.config.baseUrl },
    })).models;
  }

  supportsCapability(capability: string) {
    return ["text_generation", "structured_output", "json_mode", "openai_compatible"].includes(capability);
  }

  async runJsonTask<T>({ taskName, modelName, prompt, input }: Parameters<LLMProvider["runJsonTask"]>[0]): Promise<{ output: T; rawText?: string; usage?: LLMUsage }> {
    if (!this.config.apiKey) throw new Error("Missing API key for configured provider.");
    const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.config.provider)).replace(/\/$/, "");
    // Session 4 audit fix: block SSRF on user-controlled baseUrl. An attacker
    // could otherwise set baseUrl to an internal host and exfiltrate the API
    // key sent in the Authorization header.
    const baseUrlSafety = await assertSafeFetchUrl(`${baseUrl}/chat/completions`);
    if (!baseUrlSafety.safe) {
      throw new Error(`Provider base URL is not allowed: ${baseUrlSafety.reason}`);
    }
    const timeoutMs = Number(process.env.LLM_PROVIDER_TIMEOUT_MS || 300000);
    const response = await fetch(baseUrlSafety.url.toString(), {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: modelName || this.config.modelName,
        // Current DeepSeek Flash thinks by default. A short customer reply
        // can spend its entire output allowance on reasoning and return no
        // answer. Use its documented non-thinking mode for this fast task;
        // preserve the selected mode for reasoning jobs and other providers.
        ...(this.config.provider === "deepseek" && taskName === "whatsapp_reply"
          && /^deepseek-(?:flash|v4-flash(?:-vision-exp)?)$/.test(modelName || this.config.modelName || "")
          ? { thinking: { type: "disabled" } } : {}),
        messages: [
          { role: "system", content: `${prompt}\nReturn valid JSON only.` },
          { role: "user", content: JSON.stringify(input) },
        ],
        temperature: 0,
        top_p: 1,
        // 2026-09-18 (session 57): ASK FOR ENOUGH ROOM TO FINISH THE ANSWER.
        //
        // Nothing set this, so each provider used its own default — 4,096 tokens
        // on deepseek-chat. A document-extraction batch answers up to 17
        // questions in one JSON array, and on the largest group the array ran
        // past that ceiling: the model stopped mid-element, the text was valid
        // JSON right up to where it was cut, and the parser rejected the whole
        // thing. Seen on production (2026-09-18) and in the lab on the same
        // group: "Expected ',' or ']' after array element". All 17 answers were
        // lost, and the error blamed the model for "malformed JSON" when it had
        // simply run out of room.
        max_tokens: Number(process.env.LLM_MAX_OUTPUT_TOKENS || 8192),
      }),
    });
    // 2026-07-26 Session 4 audit fix (P2-LLM-1 + P2-LLM-2): on non-OK or non-JSON
    // responses, include the body excerpt in the error so the operator has an
    // actionable hint.
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Provider request failed with ${response.status}: ${errText.slice(0, 200)}`);
    }
    // Read body ONCE as text, then JSON.parse — same pattern as Anthropic +
    // Gemini (audit P2-LLM-2): a clean "non-JSON response" error instead of an
    // opaque "Unexpected token" SyntaxError from response.json().
    const bodyText = await response.text().catch(() => "");
    let payload: {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        // DeepSeek's spelling of "how much of the input came from your cache".
        prompt_cache_hit_tokens?: number;
        // OpenAI's spelling of the same thing.
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    try {
      payload = JSON.parse(bodyText) as typeof payload;
    } catch {
      throw new Error(`Provider returned a non-JSON response (likely an HTML error page from a proxy). Status: ${response.status}. Body (truncated): ${bodyText.slice(0, 200)}`);
    }
    const rawText = payload.choices?.[0]?.message?.content || "{}";
    // The model stopped because it hit the output ceiling, not because it had
    // finished. Whatever came back is a sentence cut in half, so say THAT —
    // "malformed JSON" sends the reader hunting for a model bug when the fix is
    // a bigger ceiling or a smaller batch of questions (session 57).
    if (payload.choices?.[0]?.finish_reason === "length") {
      throw new Error(
        `${TRUNCATED_OUTPUT_MARKER} after ${payload.usage?.completion_tokens ?? "the maximum number of"} tokens — it ran out of output room, ` +
          `so the JSON is incomplete. Ask for fewer items in one request, or raise LLM_MAX_OUTPUT_TOKENS (currently ` +
          `${Number(process.env.LLM_MAX_OUTPUT_TOKENS || 8192)}).`,
      );
    }
    const usage = payload.usage
      ? {
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
          totalTokens: payload.usage.total_tokens,
          // Cache hits are priced 10x to 50x lower than fresh input; passing the
          // count through is what lets the bill reflect that (session 57).
          cachedPromptTokens: payload.usage.prompt_cache_hit_tokens ?? payload.usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined;
    // Phase 2.8 audit fix: wrap JSON.parse in try/catch so a malformed LLM
    // response (which happens often with real models) produces a typed error
    // instead of an unhandled crash. Use the balanced-brace extractor first,
    // then validate the result is non-null.
    const jsonText = extractJson(rawText);
    try {
      const parsed = parseModelJson(jsonText);
      if (parsed == null || (typeof parsed === "object" && Object.keys(parsed as object).length === 0)) {
        throw new Error("Provider returned empty or null JSON output.");
      }
      return { output: parsed as T, rawText, usage };
    } catch (parseError) {
      throw new Error(`Provider returned malformed JSON that could not be parsed: ${parseError instanceof Error ? parseError.message : "unknown parse error"}. Raw text (truncated): ${rawText.slice(0, 200)}`);
    }
  }
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(config: Partial<ProviderConfig> = {}) {
    // 2026-07-26 Session 4 audit fix (P3-MINIMAX-CTOR): subclass defaults come
    // AFTER the spread so a caller passing `{ baseUrl: undefined }` doesn't
    // clobber the default. Pre-fix: `{ provider, baseUrl: "default", ...config }`
    // would spread `baseUrl: undefined` over the default. Post-fix: defaults win
    // when the caller omits OR explicitly passes undefined.
    super({ ...config, provider: "deepseek", baseUrl: config.baseUrl || "https://api.deepseek.com/v1" } as ProviderConfig);
  }
}

export class MiniMaxProvider extends OpenAICompatibleProvider {
  constructor(config: Partial<ProviderConfig> = {}) {
    // Same P3-MINIMAX-CTOR fix as DeepSeek. Stage A.3 (2026-07-26) — REAL
    // MiniMax adapter. The previous overrides (testConnection + runJsonTask)
    // threw "not implemented" on every call. The MiniMax ChatCompletion API is
    // OpenAI-compatible-shaped (POST /v1/chat/completions with Bearer auth), so
    // the parent OpenAICompatibleProvider implementation is correct as-is.
    super({ ...config, provider: "minimax", baseUrl: config.baseUrl || "https://api.minimax.io/v1" } as ProviderConfig);
  }
}

export class KimiProvider extends OpenAICompatibleProvider {
  constructor(config: Partial<ProviderConfig> = {}) {
    super({ ...config, provider: "kimi", baseUrl: config.baseUrl || "https://api.moonshot.ai/v1" } as ProviderConfig);
  }
}

function defaultBaseUrl(provider: LLMProviderId) {
  if (provider === "openai") return "https://api.openai.com/v1";
  if (provider === "deepseek") return "https://api.deepseek.com/v1";
  if (provider === "kimi") return "https://api.moonshot.ai/v1";
  if (provider === "minimax") return "https://api.minimax.io/v1";
  return "";
}

function extractJson(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}
