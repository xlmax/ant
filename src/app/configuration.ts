import type { VerificationCheck, VerificationSettings } from "../core/verification.js";
import type { ModelConfiguration } from "./model-provider.js";
import { configurationKey, type ConfigurationSnapshot } from "./configuration-section.js";

export type { VerificationCheck, VerificationSettings };
export type ReasoningDisplayMode = "off" | "compact" | "full";

export interface RuntimeLimits {
  turnTimeoutSeconds: number;
  modelRequestTimeoutSeconds: number;
  modelMaxAttempts: number;
}

export interface UiSettings {
  reasoningMode: ReasoningDisplayMode;
  reasoningMaxLines: number;
  showChanges: boolean;
  color: boolean;
}

export interface PromptSettings {
  additionalPaths: string[];
}

export interface ToolSettings {
  bashPath?: string;
}

export const MODEL_CONFIGURATION = configurationKey<ModelConfiguration>("model");
export const UI_CONFIGURATION = configurationKey<UiSettings>("ui");
export const PROMPT_CONFIGURATION = configurationKey<PromptSettings>("prompts");
export const TOOL_CONFIGURATION = configurationKey<ToolSettings>("tools");
export const LIMIT_CONFIGURATION = configurationKey<RuntimeLimits>("limits");
export const VERIFICATION_CONFIGURATION = configurationKey<VerificationSettings>("verification");

export interface LoadedConfiguration {
  configuration: ConfigurationSnapshot;
}

export interface ProjectSettingsOverrides {
  modelId: boolean;
  modelThinking: boolean;
  reasoningMode: boolean;
  showChanges: boolean;
}

/** Application-owned configuration port implemented by a persistence adapter. */
export interface SettingsModule {
  load(workspace: string): Promise<LoadedConfiguration>;
  saveModelId(id: string): Promise<void>;
  saveModelProviderOptions(providerId: string, update: unknown): Promise<void>;
  saveReasoningMode(mode: ReasoningDisplayMode): Promise<void>;
}
