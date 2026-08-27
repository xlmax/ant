import type { SettingsModule } from "../app/configuration.js";
import {
  loadSettings,
  saveUserModelId,
  saveUserModelProviderOptions,
  saveUserReasoningMode,
} from "./settings.js";

/** Filesystem-backed adapter for the application configuration port. */
export const fileSettingsModule: SettingsModule = {
  load: loadSettings,
  saveModelId: saveUserModelId,
  saveModelProviderOptions: saveUserModelProviderOptions,
  saveReasoningMode: saveUserReasoningMode,
};
