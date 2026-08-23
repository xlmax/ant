import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    color: boolean;
  };
  prompts: {
    additionalPaths: string[];
  };
  tools: {
    bashPath?: string;
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
    color?: boolean;
  };
  prompts?: {
    additionalPaths?: string[];
  };
  tools?: {
    bashPath?: string;
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
    color: true,
  },
  prompts: {
    additionalPaths: [],
  },
  tools: {},
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

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Настройка ${path} должна быть непустой строкой`);
  }

  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
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

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error(`Настройка ${path} должна быть массивом непустых строк`);
  }

  return [...value];
}

function parseSettings(value: unknown, source: string): PartialSettings {
  if (!isRecord(value)) {
    throw new Error(`Файл настроек ${source} должен содержать JSON-объект`);
  }

  assertKnownKeys(value, ["model", "ui", "prompts", "tools"], "");
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

    assertKnownKeys(value.ui, ["showReasoning", "color"], "ui.");
    const showReasoning = optionalBoolean(value.ui.showReasoning, "ui.showReasoning");
    const color = optionalBoolean(value.ui.color, "ui.color");
    result.ui = {
      ...(showReasoning === undefined ? {} : { showReasoning }),
      ...(color === undefined ? {} : { color }),
    };
  }

  if (value.prompts !== undefined) {
    if (!isRecord(value.prompts)) {
      throw new Error("Настройка prompts должна быть объектом");
    }

    assertKnownKeys(value.prompts, ["additionalPaths"], "prompts.");
    const additionalPaths = optionalStringArray(
      value.prompts.additionalPaths,
      "prompts.additionalPaths",
    );
    result.prompts = additionalPaths === undefined ? {} : { additionalPaths };
  }

  if (value.tools !== undefined) {
    if (!isRecord(value.tools)) {
      throw new Error("Настройка tools должна быть объектом");
    }

    assertKnownKeys(value.tools, ["bashPath"], "tools.");
    const bashPath = optionalString(value.tools.bashPath, "tools.bashPath");
    result.tools = bashPath === undefined ? {} : { bashPath };
  }

  return result;
}

function mergeSettings(base: AppSettings, partial: PartialSettings): AppSettings {
  const bashPath = partial.tools?.bashPath ?? base.tools.bashPath;

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
      color: partial.ui?.color ?? base.ui.color,
    },
    prompts: {
      additionalPaths: partial.prompts?.additionalPaths ?? base.prompts.additionalPaths,
    },
    tools: bashPath === undefined ? {} : { bashPath },
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

function userSettingsPath(homeDirectory: string): string {
  return resolve(homeDirectory, ".ant", "settings.json");
}

export async function loadSettings(
  workspace: string,
  homeDirectory: string = homedir(),
): Promise<LoadedSettings> {
  const sources: string[] = [];
  let settings = defaults;
  const paths = [
    userSettingsPath(homeDirectory),
    resolve(workspace, ".ant", "settings.json"),
  ];

  for (const path of paths) {
    const partial = await readSettingsFile(path);
    if (partial) {
      settings = mergeSettings(settings, partial);
      sources.push(path);
    }
  }

  return { settings, sources };
}

export async function saveUserModelId(
  id: string,
  homeDirectory: string = homedir(),
): Promise<void> {
  const normalizedId = id.trim();
  if (normalizedId === "") {
    throw new Error("Настройка model.id должна быть непустой строкой");
  }
  const path = userSettingsPath(homeDirectory);
  const current = await readSettingsFile(path);
  const next: PartialSettings = {
    ...current,
    model: {
      ...current?.model,
      id: normalizedId,
    },
  };

  await mkdir(resolve(homeDirectory, ".ant"), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
