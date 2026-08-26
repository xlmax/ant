import type { VerificationCheck, VerificationSettings } from "../core/verification.js";

export type { VerificationCheck, VerificationSettings };
export type ReasoningEffort = "low" | "high" | "max";
export type ReasoningDisplayMode = "off" | "compact" | "full";

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
    reasoningMode: ReasoningDisplayMode;
    reasoningMaxLines: number;
    showChanges: boolean;
    color: boolean;
  };
  prompts: {
    additionalPaths: string[];
  };
  tools: {
    bashPath?: string;
  };
  limits: RuntimeLimits;
  verification: VerificationSettings;
}

export interface ProjectSettingsOverrides {
  modelId: boolean;
  modelThinking: boolean;
  reasoningMode: boolean;
  showChanges: boolean;
}

export interface LoadedSettings {
  settings: AppSettings;
  sources: string[];
  projectOverrides: ProjectSettingsOverrides;
}

/** Application-owned configuration port implemented by a persistence adapter. */
export interface SettingsModule {
  load(workspace: string): Promise<LoadedSettings>;
  readExplicitVision(workspace: string): Promise<boolean | undefined>;
  resolveVision(id: string, configured?: boolean): boolean;
  saveModelId(id: string): Promise<void>;
  saveThinking(thinking: ModelSettings["thinking"]): Promise<void>;
  saveReasoningMode(mode: ReasoningDisplayMode): Promise<void>;
}
