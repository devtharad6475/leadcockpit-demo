import type { LLMProvider } from "./LLMProvider";
import { parseModelJson } from "./tolerant-json";
import type { ProviderConfig } from "../ModelDiscoveryService";
import { fetchProviderModels } from "../ModelDiscoveryService";

export class OllamaProvider implements LLMProvider {
  name = "ollama";
  constructor(private readonly config: ProviderConfig = { provider: "ollama", baseUrl: "http://localhost:11434" }) {}

  async testConnection() {
    const result = await fetchProviderModels("ollama", { config: { baseUrl: this.config.baseUrl || "http://localhost:11434" } });
    return { ok: result.ok, message: result.warning || "Ollama model list fetched." };
  }

  async listModels() {
    return (await fetchProviderModels("ollama", { config: { baseUrl: this.config.baseUrl || "http://localhost:11434" } })).models;
  }

  supportsCapability(capability: string) {
    // GAP-9 (2026-07-31): removed "embeddings" — runJsonTask only calls
    // /api/chat; there is no /api/embeddings path here. Claiming embeddings was
    // misleading (a user selecting an Ollama embedding model got nothing). Text
    // generation + local runtime are the real capabilities.
    return ["text_generation", "local_runtime"].includes(capability);
  }

  async runJsonTask<T>({ modelName, prompt, input }: Parameters<LLMProvider["runJsonTask"]>[0]): Promise<{ output: T; rawText?: string }> {
    const baseUrl = (this.config.baseUrl || "http://localhost:11434").replace(/\/$/, "");
    const selectedModel = modelName || this.config.modelName || "ollama-custom";
    if (!selectedModel || selectedModel === "ollama-custom") throw new Error("Please fetch and select an installed Ollama model first.");
    // Session 4 audit fix: add a timeout so a hung Ollama process can't hang
    // the whole server. (Ollama runs on localhost by design, so the SSRF guard
    // is intentionally NOT applied here.)
    const timeoutMs = Number(process.env.LLM_PROVIDER_TIMEOUT_MS || 300000);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: "system", content: `${prompt}\nReturn valid JSON only.` },
            { role: "user", content: JSON.stringify(input) },
          ],
          stream: false,
        }),
      });
    } catch {
      throw new Error(`Could not reach Ollama at ${baseUrl}. Open Ollama or run ollama serve.`);
    }
    
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 404 || body.toLowerCase().includes("not found")) throw new Error(`Model not found. Run: ollama pull ${selectedModel}`);
      throw new Error(`Ollama request failed with status ${response.status}. ${body}`);
    }
    const payload = await response.json() as { message?: { content?: string } };
    const rawText = payload.message?.content || "{}";
    try {
      return { output: parseModelJson(extractJson(rawText)) as T, rawText };
    } catch {
      throw new Error("Ollama responded, but response was not valid JSON.");
    }
  }
}

export function extractJson(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}
