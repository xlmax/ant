import type { ModelSettings } from "./settings.js";
import {
  loadSettings,
  readExplicitVision,
  resolveVision,
  saveUserModelId,
  saveUserModelThinking,
  saveUserShowReasoning,
  type LoadedSettings,
} from "./settings.js";

export interface SettingsModule {
  load(workspace: string): Promise<LoadedSettings>;
  readExplicitVision(workspace: string): Promise<boolean | undefined>;
  resolveVision(id: string, configured?: boolean): boolean;
  saveModelId(id: string): Promise<void>;
  saveThinking(thinking: ModelSettings["thinking"]): Promise<void>;
  saveShowReasoning(enabled: boolean): Promise<void>;
}

export const fileSettingsModule: SettingsModule = {
  load: loadSettings,
  readExplicitVision,
  resolveVision,
  saveModelId: saveUserModelId,
  saveThinking: saveUserModelThinking,
  saveShowReasoning: saveUserShowReasoning,
};
