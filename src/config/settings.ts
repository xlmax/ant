import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type ReasoningEffort = "low" | "high" | "max";

export interface ModelSettings {
  provider: "deepseek";
  id: string;
  baseUrl: string;
  contextWindow: number;
  thinking: {
    enabled: boolean;
    effort: ReasoningEffort;
  };
}

export interface AppSettings {
  model: ModelSettings;
  ui: {
    showReasoning: boolean;
  };
}

export interface LoadedSettings {
  settings: AppSettings;
  sources: string[];
}

type PartialSettings = {
  model?: {
    provider?: "deepseek";
    id?: string;
    baseUrl?: string;
    contextWindow?: number;
    thinking?: {
      enabled?: boolean;
      effort?: ReasoningEffort;
    };
  };
  ui?: {
    showReasoning?: boolean;
  };
};

const defaults: AppSettings = {
  model: {
    provider: "deepseek",
    id: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    contextWindow: 1_000_000,
    thinking: {
      enabled: true,
      effort: "high",
    },
  },
  ui: {
    showReasoning: false,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(`Неизвестная настройка: ${path}${key}`);
    }
  }
}

function optionalString(
  value: unknown,
  path: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Настройка ${path} должна быть непустой строкой`);
  }

  return value;
}

function optionalBoolean(
  value: unknown,
  path: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Настройка ${path} должна быть true или false`);
  }

  return value;
}

function optionalContextWindow(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error("Настройка model.contextWindow должна быть положительным целым числом");
  }

  return value;
}

function optionalEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== "low" && value !== "high" && value !== "max") {
    throw new Error("Настройка model.thinking.effort должна быть low, high или max");
  }

  return value;
}

function parseSettings(value: unknown, source: string): PartialSettings {
  if (!isRecord(value)) {
    throw new Error(`Файл настроек ${source} должен содержать JSON-объект`);
  }

  assertKnownKeys(value, ["model", "ui"], "");
  const result: PartialSettings = {};

  if (value.model !== undefined) {
    if (!isRecord(value.model)) {
      throw new Error("Настройка model должна быть объектом");
    }

    assertKnownKeys(
      value.model,
      ["provider", "id", "baseUrl", "contextWindow", "thinking"],
      "model.",
    );
    const provider = optionalString(value.model.provider, "model.provider");

    if (provider !== undefined && provider !== "deepseek") {
      throw new Error(`Неподдерживаемый provider: ${provider}`);
    }

    const id = optionalString(value.model.id, "model.id");
    const baseUrl = optionalString(value.model.baseUrl, "model.baseUrl");
    const contextWindow = optionalContextWindow(value.model.contextWindow);
    const model: NonNullable<PartialSettings["model"]> = {};

    if (provider !== undefined) {
      model.provider = provider;
    }
    if (id !== undefined) {
      model.id = id;
    }
    if (baseUrl !== undefined) {
      model.baseUrl = baseUrl;
    }
    if (contextWindow !== undefined) {
      model.contextWindow = contextWindow;
    }

    if (value.model.thinking !== undefined) {
      if (!isRecord(value.model.thinking)) {
        throw new Error("Настройка model.thinking должна быть объектом");
      }

      assertKnownKeys(value.model.thinking, ["enabled", "effort"], "model.thinking.");
      const enabled = optionalBoolean(
        value.model.thinking.enabled,
        "model.thinking.enabled",
      );
      const effort = optionalEffort(value.model.thinking.effort);
      const thinking: NonNullable<NonNullable<PartialSettings["model"]>["thinking"]> = {};
      if (enabled !== undefined) {
        thinking.enabled = enabled;
      }
      if (effort !== undefined) {
        thinking.effort = effort;
      }
      model.thinking = thinking;
    }

    result.model = model;
  }

  if (value.ui !== undefined) {
    if (!isRecord(value.ui)) {
      throw new Error("Настройка ui должна быть объектом");
    }

    assertKnownKeys(value.ui, ["showReasoning"], "ui.");
    const showReasoning = optionalBoolean(value.ui.showReasoning, "ui.showReasoning");
    result.ui = showReasoning === undefined ? {} : { showReasoning };
  }

  return result;
}

function mergeSettings(base: AppSettings, partial: PartialSettings): AppSettings {
  return {
    model: {
      provider: partial.model?.provider ?? base.model.provider,
      id: partial.model?.id ?? base.model.id,
      baseUrl: partial.model?.baseUrl ?? base.model.baseUrl,
      contextWindow: partial.model?.contextWindow ?? base.model.contextWindow,
      thinking: {
        enabled: partial.model?.thinking?.enabled ?? base.model.thinking.enabled,
        effort: partial.model?.thinking?.effort ?? base.model.thinking.effort,
      },
    },
    ui: {
      showReasoning: partial.ui?.showReasoning ?? base.ui.showReasoning,
    },
  };
}

async function readSettingsFile(path: string): Promise<PartialSettings | undefined> {
  let content: string;

  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`Файл настроек ${path} содержит некорректный JSON`);
  }

  return parseSettings(value, path);
}

function parseEnvironmentBoolean(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  if (value === "1" || value === "true") {
    return true;
  }

  if (value === "0" || value === "false") {
    return false;
  }

  throw new Error(`Переменная ${name} должна быть 1, 0, true или false`);
}

function environmentSettings(environment: NodeJS.ProcessEnv): PartialSettings {
  const model: NonNullable<PartialSettings["model"]> = {};
  const thinking: NonNullable<NonNullable<PartialSettings["model"]>["thinking"]> = {};
  const id = environment.DEEPSEEK_MODEL?.trim();
  const baseUrl = environment.DEEPSEEK_BASE_URL?.trim();
  const contextWindow = environment.DEEPSEEK_CONTEXT_WINDOW?.trim();
  const effort = environment.DEEPSEEK_REASONING_EFFORT?.trim();
  const thinkingEnabled = parseEnvironmentBoolean(
    environment.DEEPSEEK_THINKING,
    "DEEPSEEK_THINKING",
  );
  const showReasoning = parseEnvironmentBoolean(
    environment.AGENT_SHOW_REASONING,
    "AGENT_SHOW_REASONING",
  );

  if (id) {
    model.id = id;
  }
  if (baseUrl) {
    model.baseUrl = baseUrl;
  }
  if (contextWindow) {
    model.contextWindow = optionalContextWindow(Number(contextWindow)) as number;
  }
  if (thinkingEnabled !== undefined) {
    thinking.enabled = thinkingEnabled;
  }
  if (effort) {
    thinking.effort = optionalEffort(effort) as ReasoningEffort;
  }
  if (Object.keys(thinking).length > 0) {
    model.thinking = thinking;
  }

  return {
    ...(Object.keys(model).length > 0 ? { model } : {}),
    ...(showReasoning === undefined ? {} : { ui: { showReasoning } }),
  };
}

export async function loadSettings(
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): Promise<LoadedSettings> {
  const sources: string[] = [];
  let settings = defaults;
  const paths = [
    resolve(homeDirectory, ".minimal-ai-agent", "settings.json"),
    resolve(workspace, ".agent", "settings.json"),
  ];

  for (const path of paths) {
    const partial = await readSettingsFile(path);
    if (partial) {
      settings = mergeSettings(settings, partial);
      sources.push(path);
    }
  }

  return {
    settings: mergeSettings(settings, environmentSettings(environment)),
    sources,
  };
}
