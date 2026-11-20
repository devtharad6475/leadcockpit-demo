import { AnthropicCompatibleProvider } from "./AnthropicCompatibleProvider";

export class AnthropicProvider extends AnthropicCompatibleProvider {
  constructor(config: { apiKey?: string; baseUrl?: string; modelName?: string } = {}) {
    super({ provider: "anthropic", ...config });
  }
}
