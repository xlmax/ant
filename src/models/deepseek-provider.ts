import type { ModelProvider } from "../app/model-provider.js";
import type { ModelSettings } from "../config/settings.js";
import { DeepSeekModel } from "./deepseek-model.js";

export interface DeepSeekProviderOptions {
  apiKey: string;
  systemPrompt: string;
}

export function createDeepSeekProviderFromEnvironment(options: {
  systemPrompt: string;
}): DeepSeekProvider {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("Для DeepSeek необходимо задать переменную DEEPSEEK_API_KEY");
  return new DeepSeekProvider({ apiKey, systemPrompt: options.systemPrompt });
}

/** Provider module responsible for constructing configured DeepSeek clients. */
export class DeepSeekProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #systemPrompt: string;

  constructor(options: DeepSeekProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#systemPrompt = options.systemPrompt;
  }

  createAgentModel(settings: ModelSettings): DeepSeekModel {
    return this.#createModel(settings);
  }

  createContextSummarizer(settings: ModelSettings): DeepSeekModel {
    return this.#createModel(settings);
  }

  async listModels(settings: ModelSettings, signal?: AbortSignal): Promise<readonly string[]> {
    return this.#createModel(settings).listModels(signal);
  }

  #createModel(settings: ModelSettings): DeepSeekModel {
    return new DeepSeekModel({
      apiKey: this.#apiKey,
      systemPrompt: this.#systemPrompt,
      model: settings.id,
      baseUrl: settings.baseUrl,
      contextWindow: settings.contextWindow,
      supportsImages: settings.vision,
      thinkingEnabled: settings.thinking.enabled,
      reasoningEffort: settings.thinking.effort,
    });
  }
}
