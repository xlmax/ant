import type {
  ModelConfiguration,
  ModelConfigurationChange,
  ModelDescriptor,
  ModelProvider,
} from "../app/model-provider.js";
import { DeepSeekModel } from "./deepseek-model.js";

export interface DeepSeekProviderOptions {
  apiKey: string;
  systemPrompt: string;
  fetch?: typeof globalThis.fetch;
}

interface DeepSeekOptions {
  baseUrl: string;
  contextWindow: number;
  vision?: boolean;
  thinking: {
    enabled: boolean;
    effort: "low" | "high" | "max";
  };
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepSeekOptions(configuration: ModelConfiguration): DeepSeekOptions {
  if (configuration.providerId !== "deepseek") {
    throw new Error(
      `DeepSeekProvider cannot use configuration for provider ${configuration.providerId}`,
    );
  }
  if (configuration.modelId.trim() === "") throw new Error("DeepSeek modelId must not be empty");
  if (!isRecord(configuration.providerOptions)) {
    throw new Error("DeepSeek providerOptions must be an object");
  }
  const source = configuration.providerOptions;
  const baseUrl = source.baseUrl ?? DEFAULT_BASE_URL;
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new Error("DeepSeek baseUrl must be a non-empty string");
  }
  const contextWindow = source.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (typeof contextWindow !== "number" || !Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("DeepSeek contextWindow must be a positive integer");
  }
  if (source.vision !== undefined && typeof source.vision !== "boolean") {
    throw new Error("DeepSeek vision must be a boolean");
  }
  const thinkingSource = source.thinking;
  if (thinkingSource !== undefined && !isRecord(thinkingSource)) {
    throw new Error("DeepSeek thinking must be an object");
  }
  const enabled = thinkingSource?.enabled ?? true;
  const effort = thinkingSource?.effort ?? "high";
  if (typeof enabled !== "boolean") throw new Error("DeepSeek thinking.enabled must be boolean");
  if (effort !== "low" && effort !== "high" && effort !== "max") {
    throw new Error("DeepSeek reasoning effort must be low, high, or max");
  }
  return {
    baseUrl,
    contextWindow,
    ...(source.vision === undefined ? {} : { vision: source.vision }),
    thinking: { enabled, effort },
  };
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
  readonly id = "deepseek";
  readonly #apiKey: string;
  readonly #systemPrompt: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: DeepSeekProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#systemPrompt = options.systemPrompt;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  describe(configuration: ModelConfiguration): ModelDescriptor {
    const options = deepSeekOptions(configuration);
    return {
      providerId: this.id,
      modelId: configuration.modelId,
      contextWindow: options.contextWindow,
      capabilities: {
        vision: options.vision ?? /vision/iu.test(configuration.modelId),
        reasoning: {
          supported: true,
          enabled: options.thinking.enabled,
          ...(options.thinking.enabled ? { effort: options.thinking.effort } : {}),
          availableEfforts: ["low", "high", "max"],
        },
      },
    };
  }

  createAgentModel(configuration: ModelConfiguration): DeepSeekModel {
    return this.#createModel(configuration);
  }

  createContextSummarizer(configuration: ModelConfiguration): DeepSeekModel {
    return this.#createModel(configuration);
  }

  async listModels(
    configuration: ModelConfiguration,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    return this.#createModel(configuration).listModels(signal);
  }

  selectModel(configuration: ModelConfiguration, modelId: string): ModelConfiguration {
    deepSeekOptions(configuration);
    const normalized = modelId.trim();
    if (normalized === "") throw new Error("DeepSeek modelId must not be empty");
    return { ...configuration, modelId: normalized };
  }

  selectReasoning(configuration: ModelConfiguration, selection: string): ModelConfigurationChange {
    const options = deepSeekOptions(configuration);
    if (selection !== "off" && selection !== "low" && selection !== "high" && selection !== "max") {
      throw new Error(`Unsupported DeepSeek reasoning effort: ${selection}`);
    }
    const thinking = {
      enabled: selection !== "off",
      effort: selection === "off" ? options.thinking.effort : selection,
    };
    return {
      configuration: {
        ...configuration,
        providerOptions: { ...options, thinking },
      },
      settingsUpdate: { thinking },
    };
  }

  #createModel(configuration: ModelConfiguration): DeepSeekModel {
    const options = deepSeekOptions(configuration);
    return new DeepSeekModel({
      apiKey: this.#apiKey,
      systemPrompt: this.#systemPrompt,
      model: configuration.modelId,
      baseUrl: options.baseUrl,
      contextWindow: options.contextWindow,
      supportsImages: this.describe(configuration).capabilities.vision,
      thinkingEnabled: options.thinking.enabled,
      reasoningEffort: options.thinking.effort,
      fetch: this.#fetch,
    });
  }
}
