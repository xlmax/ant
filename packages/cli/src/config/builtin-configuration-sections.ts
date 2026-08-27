import type { ConfigurationRegistry } from "@ant/app";
import type { ConfigurationSection } from "@ant/app";
import {
  LIMIT_CONFIGURATION,
  PROMPT_CONFIGURATION,
  TOOL_CONFIGURATION,
  UI_CONFIGURATION,
  VERIFICATION_CONFIGURATION,
  type PromptSettings,
  type ReasoningDisplayMode,
  type RuntimeLimits,
  type ToolSettings,
  type UiSettings,
  type VerificationCheck,
  type VerificationSettings,
} from "@ant/app";

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Настройка ${name} должна быть объектом`);
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error(`Настройка ${path} должна быть массивом непустых строк`);
  }
  return [...value];
}

function boolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Настройка ${path} должна быть true или false`);
  return value;
}

function positiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Настройка ${path} должна быть положительным целым числом`);
  }
  return value;
}

function section<T, P>(
  options: Omit<
    ConfigurationSection<T, P>,
    "version" | "migrations" | "sensitivePaths" | "secretPaths"
  >,
): ConfigurationSection<T, P> {
  return {
    ...options,
    version: 1,
    migrations: { 0: (value) => value },
    sensitivePaths: [],
    secretPaths: [],
  };
}

const uiSection: ConfigurationSection<UiSettings, Partial<UiSettings>> = {
  ...section<UiSettings, Partial<UiSettings>>({
    key: UI_CONFIGURATION,
    defaults: { reasoningMode: "off", reasoningMaxLines: 6, showChanges: false, color: true },
    parse(value) {
      const source = record(value, "ui");
      let reasoningMode = source.reasoningMode;
      if (reasoningMode === undefined && source.showReasoning !== undefined) {
        reasoningMode = boolean(source.showReasoning, "ui.showReasoning") ? "compact" : "off";
      }
      if (
        reasoningMode !== undefined &&
        reasoningMode !== "off" &&
        reasoningMode !== "compact" &&
        reasoningMode !== "full"
      ) {
        throw new Error("Настройка ui.reasoningMode должна быть off, compact или full");
      }
      const reasoningMaxLines = positiveInteger(source.reasoningMaxLines, "ui.reasoningMaxLines");
      if (reasoningMaxLines !== undefined && reasoningMaxLines > 20) {
        throw new Error("Настройка ui.reasoningMaxLines должна быть от 1 до 20");
      }
      return {
        ...(reasoningMode === undefined
          ? {}
          : { reasoningMode: reasoningMode as ReasoningDisplayMode }),
        ...(reasoningMaxLines === undefined ? {} : { reasoningMaxLines }),
        ...(boolean(source.showChanges, "ui.showChanges") === undefined
          ? {}
          : { showChanges: source.showChanges as boolean }),
        ...(boolean(source.color, "ui.color") === undefined
          ? {}
          : { color: source.color as boolean }),
      };
    },
    merge: (current, partial) => ({ ...current, ...partial }),
    serialize: (value) => value,
  }),
  migrations: {
    0: (value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      const source = value as Record<string, unknown>;
      if (source.reasoningMode !== undefined || source.showReasoning === undefined) return source;
      const { showReasoning, ...rest } = source;
      return { ...rest, reasoningMode: showReasoning === true ? "compact" : "off" };
    },
  },
};

const promptSection = section<PromptSettings, Partial<PromptSettings>>({
  key: PROMPT_CONFIGURATION,
  defaults: { additionalPaths: [] },
  parse(value) {
    const source = record(value, "prompts");
    const additionalPaths = stringArray(source.additionalPaths, "prompts.additionalPaths");
    return additionalPaths === undefined ? {} : { additionalPaths };
  },
  merge: (current, partial) => ({ ...current, ...partial }),
  serialize: (value) => value,
});

const toolSection = section<ToolSettings, { bashPath?: string | null }>({
  key: TOOL_CONFIGURATION,
  defaults: {},
  parse(value) {
    const source = record(value, "tools");
    if (source.bashPath === undefined) return {};
    if (source.bashPath === null) return { bashPath: null };
    if (typeof source.bashPath !== "string" || source.bashPath.trim() === "") {
      throw new Error("Настройка tools.bashPath должна быть непустой строкой");
    }
    return { bashPath: source.bashPath };
  },
  merge(current, partial) {
    if (partial.bashPath === null) return {};
    return partial.bashPath === undefined ? current : { bashPath: partial.bashPath };
  },
  serialize: (value) => value,
});

const limitSection = section<RuntimeLimits, Partial<RuntimeLimits>>({
  key: LIMIT_CONFIGURATION,
  defaults: { turnTimeoutSeconds: 900, modelRequestTimeoutSeconds: 90, modelMaxAttempts: 3 },
  parse(value) {
    const source = record(value, "limits");
    const fields = [
      "turnTimeoutSeconds",
      "modelRequestTimeoutSeconds",
      "modelMaxAttempts",
    ] as const;
    return Object.fromEntries(
      fields.flatMap((field) => {
        const parsed = positiveInteger(source[field], `limits.${field}`);
        return parsed === undefined ? [] : [[field, parsed]];
      }),
    );
  },
  merge: (current, partial) => ({ ...current, ...partial }),
  serialize: (value) => value,
});

const checks = ["empty-answer", "echo-task", "failed-tools"] as const;
const verificationSection = section<VerificationSettings, Partial<VerificationSettings>>({
  key: VERIFICATION_CONFIGURATION,
  defaults: { enabled: true, maxRounds: 2, checks: [...checks] },
  parse(value) {
    const source = record(value, "verification");
    let parsedChecks: VerificationCheck[] | undefined;
    if (source.checks !== undefined) {
      if (
        !Array.isArray(source.checks) ||
        source.checks.length === 0 ||
        source.checks.some((item) => !checks.includes(item as never))
      ) {
        throw new Error(
          `Настройка verification.checks содержит неизвестную проверку; допустимы: ${checks.join(", ")}`,
        );
      }
      parsedChecks = source.checks as VerificationCheck[];
    }
    return {
      ...(boolean(source.enabled, "verification.enabled") === undefined
        ? {}
        : { enabled: source.enabled as boolean }),
      ...(positiveInteger(source.maxRounds, "verification.maxRounds") === undefined
        ? {}
        : { maxRounds: source.maxRounds as number }),
      ...(parsedChecks === undefined ? {} : { checks: parsedChecks }),
    };
  },
  merge: (current, partial) => ({ ...current, ...partial }),
  serialize: (value) => value,
});

export function registerBuiltinConfigurationSections(registry: ConfigurationRegistry): void {
  registry.register(uiSection);
  registry.register(promptSection);
  registry.register(toolSection);
  registry.register(limitSection);
  registry.register(verificationSection);
}
