import type { ConfigurationSection } from "@ant/app";
import { MODEL_CONFIGURATION } from "@ant/app";
import type { ModelConfiguration } from "@ant/app";

type ModelPartial = Partial<Omit<ModelConfiguration, "providerOptions">> & {
  providerOptions?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyModel(value: unknown): unknown {
  if (!isRecord(value)) throw new Error("Настройка model должна быть объектом");
  const options = isRecord(value.options) ? { ...value.options } : {};
  if (value.baseUrl !== undefined) options.baseUrl = value.baseUrl;
  if (value.contextWindow !== undefined) options.contextWindow = value.contextWindow;
  if (value.vision !== undefined) options.vision = value.vision;
  if (value.thinking !== undefined) options.thinking = value.thinking;
  return {
    ...(value.provider === undefined ? {} : { providerId: value.provider }),
    ...(value.id === undefined ? {} : { modelId: value.id }),
    ...(Object.keys(options).length === 0 ? {} : { providerOptions: options }),
    ...(value.vision === undefined ? {} : { legacyVision: true }),
  };
}

function nonEmptyString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Настройка ${path} должна быть непустой строкой`);
  }
  return value;
}

function validateDeepSeekOptions(value: unknown): void {
  if (!isRecord(value)) throw new Error("Настройка model.providerOptions должна быть объектом");
  nonEmptyString(value.baseUrl, "model.baseUrl");
  if (
    value.contextWindow !== undefined &&
    (typeof value.contextWindow !== "number" ||
      !Number.isInteger(value.contextWindow) ||
      value.contextWindow <= 0)
  ) {
    throw new Error("Настройка model.contextWindow должна быть положительным целым числом");
  }
  if (value.vision !== undefined && typeof value.vision !== "boolean") {
    throw new Error("Настройка model.vision должна быть true или false");
  }
  if (value.thinking !== undefined) {
    if (!isRecord(value.thinking)) throw new Error("Настройка model.thinking должна быть объектом");
    if (value.thinking.enabled !== undefined && typeof value.thinking.enabled !== "boolean") {
      throw new Error("Настройка model.thinking.enabled должна быть true или false");
    }
    if (
      value.thinking.effort !== undefined &&
      value.thinking.effort !== "low" &&
      value.thinking.effort !== "high" &&
      value.thinking.effort !== "max"
    ) {
      throw new Error("Настройка model.thinking.effort должна быть low, high или max");
    }
  }
}

export const deepSeekConfigurationSection: ConfigurationSection<ModelConfiguration, ModelPartial> =
  {
    key: MODEL_CONFIGURATION,
    version: 1,
    defaults: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      providerOptions: {
        baseUrl: "https://api.deepseek.com",
        contextWindow: 1_000_000,
        thinking: { enabled: true, effort: "high" },
      },
    },
    migrations: { 0: legacyModel },
    sensitivePaths: ["providerId", "providerOptions.baseUrl"],
    secretPaths: ["providerOptions.apiKey"],
    parse(value, context) {
      if (!isRecord(value)) throw new Error("Настройка model должна быть объектом");
      const providerId = nonEmptyString(value.providerId, "model.providerId");
      const modelId = nonEmptyString(value.modelId, "model.modelId");
      let providerOptions = value.providerOptions;
      if (providerOptions !== undefined && (providerId ?? "deepseek") === "deepseek") {
        validateDeepSeekOptions(providerOptions);
        if (
          value.legacyVision === true &&
          context.layer === "user" &&
          isRecord(providerOptions) &&
          typeof providerOptions.vision === "boolean" &&
          providerOptions.vision === /vision/iu.test(modelId ?? "")
        ) {
          const migratedOptions = { ...providerOptions };
          delete migratedOptions.vision;
          providerOptions = migratedOptions;
        }
      }
      return {
        ...(providerId === undefined ? {} : { providerId }),
        ...(modelId === undefined ? {} : { modelId }),
        ...(providerOptions === undefined ? {} : { providerOptions }),
      };
    },
    merge(current, partial) {
      const providerId = partial.providerId ?? current.providerId;
      const currentOptions = isRecord(current.providerOptions) ? current.providerOptions : {};
      const partialOptions = isRecord(partial.providerOptions) ? partial.providerOptions : {};
      return {
        providerId,
        modelId: partial.modelId ?? current.modelId,
        providerOptions:
          providerId === current.providerId
            ? {
                ...currentOptions,
                ...partialOptions,
                ...(isRecord(currentOptions.thinking) && isRecord(partialOptions.thinking)
                  ? { thinking: { ...currentOptions.thinking, ...partialOptions.thinking } }
                  : {}),
              }
            : (partial.providerOptions ?? {}),
      };
    },
    serialize: (value) => value,
  };
