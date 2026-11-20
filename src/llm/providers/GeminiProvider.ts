import { GeminiCompatibleProvider } from "./GeminiCompatibleProvider";

export class GeminiProvider extends GeminiCompatibleProvider {
  constructor(config: { apiKey?: string; baseUrl?: string; modelName?: string } = {}) {
    super({ provider: "gemini", ...config });
  }
}
