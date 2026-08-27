import type { ProjectSettingsOverrides, ReasoningDisplayMode } from "./configuration.js";
import type { AntApplicationApi } from "./application-client.js";

export interface FrontendSettingsCommands {
  saveReasoningMode(mode: ReasoningDisplayMode): Promise<void>;
}

/** Application-owned port implemented by a presentation adapter. */
export interface AntFrontend {
  run(client: AntApplicationApi): Promise<void>;
}

export interface FrontendOptions {
  task: string;
  workspace: string;
  color: boolean;
  settings: FrontendSettingsCommands;
  projectOverrides: ProjectSettingsOverrides;
  reasoningMode: ReasoningDisplayMode;
  reasoningMaxLines: number;
  showChanges: boolean;
  resume?: string;
}
