import type { SettingsModule } from "../app/configuration.js";
import {
  loadSettings,
  readExplicitVision,
  resolveVision,
  saveUserModelId,
  saveUserModelThinking,
  saveUserShowReasoning,
} from "./settings.js";

/** Filesystem-backed adapter for the application configuration port. */
export const fileSettingsModule: SettingsModule = {
  load: loadSettings,
  readExplicitVision,
  resolveVision,
  saveModelId: saveUserModelId,
  saveThinking: saveUserModelThinking,
  saveShowReasoning: saveUserShowReasoning,
};
