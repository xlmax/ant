import type { VerificationCheck, VerificationSettings } from "../core/verification.js";
import type { ModelConfiguration } from "./model-provider.js";

export type { VerificationCheck, VerificationSettings };
export type ReasoningDisplayMode = "off" | "compact" | "full";

export interface RuntimeLimits {
  turnTimeoutSeconds: number;
  modelRequestTimeoutSeconds: number;
  modelMaxAttempts: number;
}

export interface AppSettings {
  model: ModelConfiguration;
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
  saveModelId(id: string): Promise<void>;
  saveModelProviderOptions(providerId: string, update: unknown): Promise<void>;
  saveReasoningMode(mode: ReasoningDisplayMode): Promise<void>;
}
