import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config: { apiKey?: string; baseUrl?: string; modelName?: string } = {}) {
    super({ provider: "openai", baseUrl: config.baseUrl || "https://api.openai.com/v1", ...config });
  }
}
