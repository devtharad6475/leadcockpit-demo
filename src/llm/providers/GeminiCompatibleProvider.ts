import type { LLMProvider, LLMUsage } from "./LLMProvider";
import { parseModelJson } from "./tolerant-json";
import type { ProviderConfig } from "../ModelDiscoveryService";
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";

/**
 * Stage A.3 (2026-07-26) — REAL Google Gemini generateContent adapter.
 *
 * Replaces the previous stub. Mirrors the OpenAICompatibleProvider pattern.
 * Gemini uses an API-key-as-query-param auth model (not a header), so the
 * SSRF guard still runs on the base URL (the guard blocks internal hosts
 * before we ever attach the key).
 *
 *   POST {baseUrl}/v1beta/models/{model}:generateContent?key=apiKey
 *   body: { systemInstruction: {parts:[{text}]}, contents: [{role:"user", parts:[{text}]}] }
 *   response: { candidates: [{content:{parts:[{text}]}}], usageMetadata:
 *              {promptTokenCount, candidatesTokenCount, totalTokenCount} }
 */
export class GeminiCompatibleProvider implements LLMProvider {
  name: string;
  constructor(private readonly config: ProviderConfig) {
    this.name = config.provider;
  }

  async testConnection() {
    if (!this.config.apiKey) {
      return { ok: false, message: "Missing API key. Add a key and mock fallback will keep the demo working." };
    }
    try {
      const baseUrl = (this.config.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
      const model = this.config.modelName || "gemini-2.0-flash";
      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`;
      const baseUrlSafety = await assertSafeFetchUrl(url);
      if (!baseUrlSafety.safe) {
        return { ok: false, message: `Provider base URL is not allowed: ${baseUrlSafety.reason}` };
      }
      const response = await fetch(baseUrlSafety.url.toString(), {
        method: "POST",
        signal: AbortSignal.timeout(Number(process.env.LLM_PROVIDER_TIMEOUT_MS || 30000)),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { ok: false, message: `Gemini API returned ${response.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true, message: "Gemini connection OK." };
    } catch (error) {
      return { ok: false, message: `Gemini connection failed: ${error instanceof Error ? error.message : "unknown error"}` };
    }
  }

  supportsCapability(capability: string) {
    return ["text_generation", "structured_output", "gemini_compatible"].includes(capability);
  }

  async runJsonTask<T>({ modelName, prompt, input }: Parameters<LLMProvider["runJsonTask"]>[0]): Promise<{ output: T; rawText?: string; usage?: LLMUsage }> {
    if (!this.config.apiKey) throw new Error("Missing API key for Gemini provider.");
    const baseUrl = (this.config.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    const model = modelName || this.config.modelName || "gemini-2.0-flash";
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`;
    // SSRF guard: blocks internal baseUrls before the key is sent.
    const baseUrlSafety = await assertSafeFetchUrl(url);
    if (!baseUrlSafety.safe) {
      throw new Error(`Provider base URL is not allowed: ${baseUrlSafety.reason}`);
    }
    const timeoutMs = Number(process.env.LLM_PROVIDER_TIMEOUT_MS || 300000);
    const response = await fetch(baseUrlSafety.url.toString(), {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${prompt}\nReturn valid JSON only.` }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 8192 },
      }),
    });
    // 2026-07-26 Session 4 audit fix (P2-LLM-1 + P2-LLM-2): on non-OK or non-JSON
    // responses, include the body excerpt in the error so the operator has an
    // actionable hint. Same pattern as Anthropic + OpenAI.
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Gemini request failed with ${response.status}: ${errText.slice(0, 200)}`);
    }
    // Read the body ONCE as text. If it parses as JSON, use it; otherwise throw
    // a clear "non-JSON response" error with the body excerpt (audit P2-LLM-2).
    // Reading once avoids the "body already consumed" issue when json() then
    // text() are both called on the same Response.
    const bodyText = await response.text().catch(() => "");
    let payload: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    try {
      payload = JSON.parse(bodyText) as typeof payload;
    } catch {
      throw new Error(`Gemini returned a non-JSON response (likely an HTML error page from a proxy). Status: ${response.status}. Body (truncated): ${bodyText.slice(0, 200)}`);
    }
    const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const usage = payload.usageMetadata
      ? { promptTokens: payload.usageMetadata.promptTokenCount, completionTokens: payload.usageMetadata.candidatesTokenCount, totalTokens: payload.usageMetadata.totalTokenCount }
      : undefined;
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
