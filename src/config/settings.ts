import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { writeFileAtomically } from "../fs/atomic-write.js";

export type ReasoningEffort = "low" | "high" | "max";

export interface ModelSettings {
  provider: "deepseek";
  id: string;
  baseUrl: string;
  contextWindow: number;
  vision: boolean;
  thinking: {
    enabled: boolean;
    effort: ReasoningEffort;
  };
}

export interface RuntimeLimits {
  turnTimeoutSeconds: number;
  modelRequestTimeoutSeconds: number;
  modelMaxAttempts: number;
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
  limits: RuntimeLimits;
}

export interface ProjectSettingsOverrides {
  modelId: boolean;
  modelThinking: boolean;
  showReasoning: boolean;
}

export interface LoadedSettings {
  settings: AppSettings;
  sources: string[];
  projectOverrides: ProjectSettingsOverrides;
}

type PartialSettings = {
  model?: {
    provider?: "deepseek";
    id?: string;
    baseUrl?: string;
    contextWindow?: number;
    vision?: boolean;
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
    bashPath?: string | null;
  };
  limits?: Partial<RuntimeLimits>;
};

const defaults: AppSettings = {
  model: {
    provider: "deepseek",
    id: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    contextWindow: 1_000_000,
    vision: false,
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
  limits: {
    turnTimeoutSeconds: 900,
    modelRequestTimeoutSeconds: 90,
    modelMaxAttempts: 3,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Настройка model.contextWindow должна быть положительным целым числом");
  }

  return value;
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Настройка ${path} должна быть положительным целым числом`);
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

  const result: PartialSettings = {};

  if (value.model !== undefined) {
    if (!isRecord(value.model)) {
      throw new Error("Настройка model должна быть объектом");
    }

    const provider = optionalString(value.model.provider, "model.provider");

    if (provider !== undefined && provider !== "deepseek") {
      throw new Error(`Неподдерживаемый provider: ${provider}`);
    }

    const id = optionalString(value.model.id, "model.id");
    const baseUrl = optionalString(value.model.baseUrl, "model.baseUrl");
    const contextWindow = optionalContextWindow(value.model.contextWindow);
    const vision = optionalBoolean(value.model.vision, "model.vision");
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
    if (vision !== undefined) {
      model.vision = vision;
    }

    if (value.model.thinking !== undefined) {
      if (!isRecord(value.model.thinking)) {
        throw new Error("Настройка model.thinking должна быть объектом");
      }

      const enabled = optionalBoolean(value.model.thinking.enabled, "model.thinking.enabled");
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

    if (value.tools.bashPath === null) {
      result.tools = { bashPath: null };
    } else {
      const bashPath = optionalString(value.tools.bashPath, "tools.bashPath");
      result.tools = bashPath === undefined ? {} : { bashPath };
    }
  }

  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) {
      throw new Error("Настройка limits должна быть объектом");
    }

    const turnTimeoutSeconds = optionalPositiveInteger(
      value.limits.turnTimeoutSeconds,
      "limits.turnTimeoutSeconds",
    );
    const modelRequestTimeoutSeconds = optionalPositiveInteger(
      value.limits.modelRequestTimeoutSeconds,
      "limits.modelRequestTimeoutSeconds",
    );
    const modelMaxAttempts = optionalPositiveInteger(
      value.limits.modelMaxAttempts,
      "limits.modelMaxAttempts",
    );
    result.limits = {
      ...(turnTimeoutSeconds === undefined ? {} : { turnTimeoutSeconds }),
      ...(modelRequestTimeoutSeconds === undefined ? {} : { modelRequestTimeoutSeconds }),
      ...(modelMaxAttempts === undefined ? {} : { modelMaxAttempts }),
    };
  }

  return result;
}

function mergeSettings(base: AppSettings, partial: PartialSettings): AppSettings {
  const bashPath =
    partial.tools?.bashPath === null ? undefined : (partial.tools?.bashPath ?? base.tools.bashPath);

  return {
    model: {
      provider: partial.model?.provider ?? base.model.provider,
      id: partial.model?.id ?? base.model.id,
      baseUrl: partial.model?.baseUrl ?? base.model.baseUrl,
      contextWindow: partial.model?.contextWindow ?? base.model.contextWindow,
      vision: partial.model?.vision ?? base.model.vision,
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
    limits: {
      turnTimeoutSeconds: partial.limits?.turnTimeoutSeconds ?? base.limits.turnTimeoutSeconds,
      modelRequestTimeoutSeconds:
        partial.limits?.modelRequestTimeoutSeconds ?? base.limits.modelRequestTimeoutSeconds,
      modelMaxAttempts: partial.limits?.modelMaxAttempts ?? base.limits.modelMaxAttempts,
    },
  };
}

async function readSettingsValue(path: string): Promise<Record<string, unknown> | undefined> {
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

  if (!isRecord(value)) {
    throw new Error(`Файл настроек ${path} должен содержать JSON-объект`);
  }

  return value;
}

async function readSettingsFile(path: string): Promise<PartialSettings | undefined> {
  const value = await readSettingsValue(path);
  return value === undefined ? undefined : parseSettings(value, path);
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
  const paths = [userSettingsPath(homeDirectory), resolve(workspace, ".ant", "settings.json")];
  const projectOverrides: ProjectSettingsOverrides = {
    modelId: false,
    modelThinking: false,
    showReasoning: false,
  };

  for (const [index, path] of paths.entries()) {
    const partial = await readSettingsFile(path);
    if (partial) {
      settings = mergeSettings(settings, partial);
      sources.push(path);

      if (index === 1) {
        projectOverrides.modelId = partial.model?.id !== undefined;
        projectOverrides.modelThinking =
          partial.model?.thinking?.enabled !== undefined ||
          partial.model?.thinking?.effort !== undefined;
        projectOverrides.showReasoning = partial.ui?.showReasoning !== undefined;
      }
    }
  }

  return { settings, sources, projectOverrides };
}

export interface UserSettingsUpdate {
  model?: {
    id?: string;
    thinking?: {
      enabled?: boolean;
      effort?: ReasoningEffort;
    };
  };
  ui?: {
    showReasoning?: boolean;
  };
}

export async function saveUserSettings(
  update: UserSettingsUpdate,
  homeDirectory: string = homedir(),
): Promise<void> {
  const path = userSettingsPath(homeDirectory);
  const current = await readSettingsValue(path);
  const next: Record<string, unknown> = { ...current };

  if (update.model !== undefined) {
    const currentModel = current?.model;
    if (currentModel !== undefined && !isRecord(currentModel)) {
      throw new Error("Настройка model должна быть объектом");
    }
    const { thinking: thinkingUpdate, ...modelUpdate } = update.model;
    let currentThinking: Record<string, unknown> | undefined;
    if (thinkingUpdate !== undefined) {
      const savedThinking = currentModel?.thinking;
      if (savedThinking !== undefined) {
        if (!isRecord(savedThinking)) {
          throw new Error("Настройка model.thinking должна быть объектом");
        }
        currentThinking = savedThinking;
      }
    }

    next.model = {
      ...currentModel,
      ...modelUpdate,
      ...(thinkingUpdate === undefined
        ? {}
        : { thinking: { ...currentThinking, ...thinkingUpdate } }),
    };
  }

  if (update.ui !== undefined) {
    const currentUi = current?.ui;
    if (currentUi !== undefined && !isRecord(currentUi)) {
      throw new Error("Настройка ui должна быть объектом");
    }
    next.ui = { ...currentUi, ...update.ui };
  }

  await mkdir(resolve(homeDirectory, ".ant"), { recursive: true });
  await writeFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
}

export async function saveUserModelId(
  id: string,
  homeDirectory: string = homedir(),
): Promise<void> {
  const normalizedId = id.trim();
  if (normalizedId === "") {
    throw new Error("Настройка model.id должна быть непустой строкой");
  }

  await saveUserSettings({ model: { id: normalizedId } }, homeDirectory);
}

export async function saveUserShowReasoning(
  showReasoning: boolean,
  homeDirectory: string = homedir(),
): Promise<void> {
  await saveUserSettings({ ui: { showReasoning } }, homeDirectory);
}

export async function saveUserModelThinking(
  thinking: ModelSettings["thinking"],
  homeDirectory: string = homedir(),
): Promise<void> {
  await saveUserSettings({ model: { thinking } }, homeDirectory);
}
