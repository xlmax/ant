import type {
  ModelSettings,
  ProjectSettingsOverrides,
  RuntimeLimits,
  VerificationSettings,
} from "../config/settings.js";
import type { AntHostContext } from "./host-context.js";

export interface FrontendSettingsCommands {
  saveModelId(id: string): Promise<boolean>;
  saveThinking(thinking: ModelSettings["thinking"]): Promise<void>;
  saveShowReasoning(enabled: boolean): Promise<void>;
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
  showReasoning: boolean;
  showChanges: boolean;
  limits: RuntimeLimits;
  verification: VerificationSettings;
  systemPrompt: string;
  resume?: string;
}
