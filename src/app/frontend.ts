import type {
  ModelSettings,
  ProjectSettingsOverrides,
  ReasoningDisplayMode,
  RuntimeLimits,
  VerificationSettings,
} from "./configuration.js";
import type { AntHostContext } from "./host-context.js";

export interface FrontendSettingsCommands {
  saveModelId(id: string): Promise<boolean>;
  saveThinking(thinking: ModelSettings["thinking"]): Promise<void>;
  saveReasoningMode(mode: ReasoningDisplayMode): Promise<void>;
}

/** Application-owned port implemented by a presentation adapter. */
export interface AntFrontend {
  run(host: AntHostContext): Promise<void>;
}

export interface FrontendOptions {
  task: string;
  workspace: string;
  color: boolean;
  modelSettings: ModelSettings;
  settings: FrontendSettingsCommands;
  projectOverrides: ProjectSettingsOverrides;
  reasoningMode: ReasoningDisplayMode;
  reasoningMaxLines: number;
  showChanges: boolean;
  limits: RuntimeLimits;
  verification: VerificationSettings;
  systemPrompt: string;
  resume?: string;
}
