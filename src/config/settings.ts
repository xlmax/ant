import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type {
  AppSettings,
  LoadedSettings,
  ModelSettings,
  ProjectSettingsOverrides,
  ReasoningDisplayMode,
  ReasoningEffort,
  RuntimeLimits,
  VerificationCheck,
} from "../app/configuration.js";
import { writeFileAtomically } from "../fs/atomic-write.js";

/**
 * Vision capability is not reported by the DeepSeek API, so model ids are
 * matched by name as a fallback. An explicit `model.vision` setting always
 * takes priority over this heuristic — resolveVision is the single source of
 * truth for the capability.
 */
export function resolveVision(id: string, configured?: boolean): boolean {
  return configured ?? /vision/i.test(id);
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
    reasoningMode?: ReasoningDisplayMode;
    reasoningMaxLines?: number;
    showChanges?: boolean;
    color?: boolean;
  };
  prompts?: {
    additionalPaths?: string[];
  };
  tools?: {
    bashPath?: string | null;
  };
  limits?: Partial<RuntimeLimits>;
  verification?: {
    enabled?: boolean;
    maxRounds?: number;
    checks?: VerificationCheck[];
  };
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
    reasoningMode: "off",
    reasoningMaxLines: 6,
    showChanges: false,
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
  verification: {
    enabled: true,
    maxRounds: 2,
    checks: ["empty-answer", "echo-task", "failed-tools"],
  },
};

const VERIFICATION_CHECKS: readonly VerificationCheck[] = [
  "empty-answer",
  "echo-task",
  "failed-tools",
];

function optionalVerificationChecks(value: unknown, path: string): VerificationCheck[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Настройка ${path} должна быть массивом`);
  }

  const checks = value.filter(
    (item): item is VerificationCheck =>
      typeof item === "string" && VERIFICATION_CHECKS.includes(item as VerificationCheck),
  );
  if (checks.length !== value.length) {
    throw new Error(
      `Настройка ${path} содержит неизвестную проверку; допустимы: ${VERIFICATION_CHECKS.join(", ")}`,
    );
  }
  if (checks.length === 0) {
    throw new Error(`Настройка ${path} должна содержать хотя бы одну проверку`);
  }

  return checks;
}

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

function optionalReasoningMode(value: unknown): ReasoningDisplayMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "off" && value !== "compact" && value !== "full") {
    throw new Error("Настройка ui.reasoningMode должна быть off, compact или full");
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

    const configuredMode = optionalReasoningMode(value.ui.reasoningMode);
    const legacyShowReasoning = optionalBoolean(value.ui.showReasoning, "ui.showReasoning");
    const reasoningMode =
      configuredMode ??
      (legacyShowReasoning === undefined ? undefined : legacyShowReasoning ? "compact" : "off");
    const reasoningMaxLines = optionalPositiveInteger(
      value.ui.reasoningMaxLines,
      "ui.reasoningMaxLines",
    );
    if (reasoningMaxLines !== undefined && reasoningMaxLines > 20) {
      throw new Error("Настройка ui.reasoningMaxLines должна быть от 1 до 20");
    }
    const showChanges = optionalBoolean(value.ui.showChanges, "ui.showChanges");
    const color = optionalBoolean(value.ui.color, "ui.color");
    result.ui = {
      ...(reasoningMode === undefined ? {} : { reasoningMode }),
      ...(reasoningMaxLines === undefined ? {} : { reasoningMaxLines }),
      ...(showChanges === undefined ? {} : { showChanges }),
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

  if (value.verification !== undefined) {
    if (!isRecord(value.verification)) {
      throw new Error("Настройка verification должна быть объектом");
    }

    const enabled = optionalBoolean(value.verification.enabled, "verification.enabled");
    const maxRounds = optionalPositiveInteger(
      value.verification.maxRounds,
      "verification.maxRounds",
    );
    const checks = optionalVerificationChecks(value.verification.checks, "verification.checks");
    result.verification = {
      ...(enabled === undefined ? {} : { enabled }),
      ...(maxRounds === undefined ? {} : { maxRounds }),
      ...(checks === undefined ? {} : { checks }),
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
      // Raw vision is carried through layers without resolving; the heuristic
      // is applied once, after every layer is merged, so an explicit value is
      // never clobbered by a later layer that only changes unrelated keys.
      vision: partial.model?.vision ?? base.model.vision,
      thinking: {
        enabled: partial.model?.thinking?.enabled ?? base.model.thinking.enabled,
        effort: partial.model?.thinking?.effort ?? base.model.thinking.effort,
      },
    },
    ui: {
      reasoningMode: partial.ui?.reasoningMode ?? base.ui.reasoningMode,
      reasoningMaxLines: partial.ui?.reasoningMaxLines ?? base.ui.reasoningMaxLines,
      showChanges: partial.ui?.showChanges ?? base.ui.showChanges,
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
    verification: {
      enabled: partial.verification?.enabled ?? base.verification.enabled,
      maxRounds: partial.verification?.maxRounds ?? base.verification.maxRounds,
      checks: partial.verification?.checks ?? base.verification.checks,
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
    reasoningMode: false,
    showChanges: false,
  };

  // Track whether any layer set `model.vision` explicitly. Resolution is
  // deferred until all raw layers are merged so an explicit value survives
  // a later layer that only overrides unrelated settings.
  let explicitVision: boolean | undefined;
  for (const [index, path] of paths.entries()) {
    const partial = await readSettingsFile(path);
    if (partial) {
      const layerVision = partial.model?.vision;
      if (layerVision !== undefined) {
        // Only the user layer can carry a stale auto-written `model.vision`
        // (old versions wrote it there); if it matches the heuristic for its
        // id, treat it as legacy so the heuristic can reapply. Project vision
        // is always a genuine explicit override.
        const layerId = partial.model?.id ?? settings.model.id;
        const staleUserVision = index === 0 && layerVision === resolveVision(layerId);
        if (!staleUserVision) explicitVision = layerVision;
      }

      if (index === 1 && partial.model?.baseUrl !== undefined) {
        // `model.baseUrl` decides where the API key is sent, so it is
        // credential-adjacent. A project settings file (potentially from an
        // untrusted repository) must not be able to redirect the endpoint; the
        // value may only come from the user layer. Drop it silently.
        delete partial.model.baseUrl;
      }

      settings = mergeSettings(settings, partial);
      sources.push(path);

      if (index === 1) {
        projectOverrides.modelId = partial.model?.id !== undefined;
        projectOverrides.modelThinking =
          partial.model?.thinking?.enabled !== undefined ||
          partial.model?.thinking?.effort !== undefined;
        projectOverrides.reasoningMode = partial.ui?.reasoningMode !== undefined;
        projectOverrides.showChanges = partial.ui?.showChanges !== undefined;
      }
    }
  }

  // Single point of truth: explicit `model.vision` wins, heuristic is the
  // fallback applied only when no layer configured the capability explicitly.
  settings.model.vision = resolveVision(settings.model.id, explicitVision);

  return { settings, sources, projectOverrides };
}

/**
 * Returns the explicitly configured `model.vision` across the user and project
 * layers (project wins), or `undefined` when no layer set it. This lets a
 * runtime model switch resolve vision without re-applying a project `model.id`
 * override to the selected id.
 */
export async function readExplicitVision(
  workspace: string,
  homeDirectory: string = homedir(),
): Promise<boolean | undefined> {
  let explicit: boolean | undefined;
  const paths = [userSettingsPath(homeDirectory), resolve(workspace, ".ant", "settings.json")];
  for (const [index, path] of paths.entries()) {
    const partial = await readSettingsFile(path);
    const vision = partial?.model?.vision;
    if (vision === undefined) continue;
    // Skip a stale auto-written user-layer vision (equals the heuristic for its
    // id); project vision is always treated as explicit.
    if (index === 0) {
      const layerId = partial?.model?.id;
      if (layerId !== undefined && vision === resolveVision(layerId)) continue;
    }
    explicit = vision;
  }
  return explicit;
}

export interface UserSettingsUpdate {
  model?: {
    id?: string;
    vision?: boolean;
    thinking?: {
      enabled?: boolean;
      effort?: ReasoningEffort;
    };
  };
  ui?: {
    reasoningMode?: ReasoningDisplayMode;
    reasoningMaxLines?: number;
    showChanges?: boolean;
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

  // Vision is preserved across a model switch only when it is genuinely
  // explicit. A stale auto-written `model.vision` (which always equalled the
  // heuristic for its id) is dropped so the heuristic can reapply to the new
  // model; otherwise it would become a permanent override. This cleanup is
  // intentionally limited to the user layer (old versions wrote it there).
  // Known ambiguity: a manually set user vision that happens to equal the
  // heuristic for its id is treated as legacy and removed on the next switch —
  // accepted as a one-time migration rule for personal settings.
  const current = await readSettingsValue(userSettingsPath(homeDirectory));
  const currentModel = isRecord(current?.model) ? current.model : undefined;
  const currentId = typeof currentModel?.id === "string" ? currentModel.id : undefined;
  const currentVision = currentModel?.vision;
  const visionIsStale =
    currentId !== undefined &&
    typeof currentVision === "boolean" &&
    currentVision === resolveVision(currentId);

  const modelUpdate: Record<string, unknown> = { id: normalizedId };
  if (visionIsStale) {
    modelUpdate.vision = undefined; // spread drops the key when serializing
  }
  await saveUserSettings({ model: modelUpdate } as UserSettingsUpdate, homeDirectory);
}

export async function saveUserReasoningMode(
  reasoningMode: ReasoningDisplayMode,
  homeDirectory: string = homedir(),
): Promise<void> {
  await saveUserSettings({ ui: { reasoningMode } }, homeDirectory);
}

export async function saveUserModelThinking(
  thinking: ModelSettings["thinking"],
  homeDirectory: string = homedir(),
): Promise<void> {
  await saveUserSettings({ model: { thinking } }, homeDirectory);
}
