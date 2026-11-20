import type { LLMProvider, LLMUsage } from "./LLMProvider";
import { parseModelJson } from "./tolerant-json";
import type { ProviderConfig } from "../ModelDiscoveryService";
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";

/**
 * Stage A.3 (2026-07-26) — REAL Anthropic (Claude) Messages API adapter.
 *
 * Replaces the previous stub (which threw "not implemented" on every call).
 * Mirrors the OpenAICompatibleProvider pattern: SSRF guard on the baseUrl,
 * timeout via AbortSignal, malformed-JSON try/catch, real usage-block parsing
 * for cost tracking. The request shape is Anthropic's Messages API:
 *
 *   POST {baseUrl}/v1/messages
 *   headers: x-api-key + anthropic-version: 2023-06-01 + content-type
 *   body:    { model, max_tokens, system, messages: [{role:"user", content}] }
 *   response:{ content: [{type:"text", text}], usage: {input_tokens, output_tokens} }
 *
 * The "JSON only" instruction goes in the `system` prompt (Anthropic doesn't
 * have a separate response_format field like OpenAI; the system prompt + a
 * brace-extraction fallback handles models that wrap JSON in prose).
 */
export class AnthropicCompatibleProvider implements LLMProvider {
  name: string;
  constructor(private readonly config: ProviderConfig) {
    this.name = config.provider;
  }

  async testConnection() {
    if (!this.config.apiKey) {
      return { ok: false, message: "Missing API key. Add a key and mock fallback will keep the demo working." };
    }
    // Real round-trip: a minimal 1-token message. Honest ok/false on the
    // actual API response (was always ok:false before Stage A.3).
    try {
      const baseUrl = (this.config.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
      const baseUrlSafety = await assertSafeFetchUrl(`${baseUrl}/v1/messages`);
      if (!baseUrlSafety.safe) {
        return { ok: false, message: `Provider base URL is not allowed: ${baseUrlSafety.reason}` };
      }
      const response = await fetch(baseUrlSafety.url.toString(), {
        method: "POST",
        signal: AbortSignal.timeout(Number(process.env.LLM_PROVIDER_TIMEOUT_MS || 30000)),
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.config.modelName || "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { ok: false, message: `Anthropic API returned ${response.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true, message: "Anthropic connection OK." };
    } catch (error) {
      return { ok: false, message: `Anthropic connection failed: ${error instanceof Error ? error.message : "unknown error"}` };
    }
  }

  supportsCapability(capability: string) {
    return ["text_generation", "structured_output", "anthropic_compatible"].includes(capability);
  }

  async runJsonTask<T>({ modelName, prompt, input }: Parameters<LLMProvider["runJsonTask"]>[0]): Promise<{ output: T; rawText?: string; usage?: LLMUsage }> {
    if (!this.config.apiKey) throw new Error("Missing API key for Anthropic provider.");
    const baseUrl = (this.config.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
    // SSRF guard: same protection as OpenAI — block user-supplied baseUrls
    // pointing at internal hosts (would leak the x-api-key header).
    const baseUrlSafety = await assertSafeFetchUrl(`${baseUrl}/v1/messages`);
    if (!baseUrlSafety.safe) {
      throw new Error(`Provider base URL is not allowed: ${baseUrlSafety.reason}`);
    }
    const timeoutMs = Number(process.env.LLM_PROVIDER_TIMEOUT_MS || 300000);
    const response = await fetch(baseUrlSafety.url.toString(), {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelName || this.config.modelName || "claude-haiku-4-5",
        max_tokens: 4096,
        system: `${prompt}\nReturn valid JSON only.`,
        messages: [{ role: "user", content: JSON.stringify(input) }],
      }),
    });
    // 2026-07-26 Session 4 audit fix (P2-LLM-1 + P2-LLM-2): on non-OK or non-JSON
    // responses, include the body excerpt in the error so the operator has an
    // actionable hint. Pre-fix: a 503 with "Anthropic overloaded — retry in 30s"
    // body produced an opaque "Anthropic request failed with 503"; an HTML proxy
    // error page produced an opaque "Unexpected token <" SyntaxError.
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Anthropic request failed with ${response.status}: ${errText.slice(0, 200)}`);
    }
    // Read the body ONCE as text. If it parses as JSON, use it; otherwise throw
    // a clear "non-JSON response" error with the body excerpt (audit P2-LLM-2).
    const bodyText = await response.text().catch(() => "");
    let payload: {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      payload = JSON.parse(bodyText) as typeof payload;
    } catch {
      throw new Error(`Anthropic returned a non-JSON response (likely an HTML error page from a proxy). Status: ${response.status}. Body (truncated): ${bodyText.slice(0, 200)}`);
    }
    // Anthropic returns content as an array of blocks; we want the first text block.
    const textBlock = payload.content?.find((b) => b.type === "text" || typeof b.text === "string");
    const rawText = textBlock?.text || "{}";
    const usage = payload.usage
      ? { promptTokens: payload.usage.input_tokens, completionTokens: payload.usage.output_tokens, totalTokens: (payload.usage.input_tokens || 0) + (payload.usage.output_tokens || 0) }
      : undefined;
    // Same malformed-JSON handling as OpenAI: brace-extract then strict-parse.
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

function extractJson(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}
