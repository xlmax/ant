import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ConfigurationRegistry } from "../app/configuration-registry.js";
import {
  MODEL_CONFIGURATION,
  UI_CONFIGURATION,
  type SettingsModule,
} from "../app/configuration.js";
import { FileConfigurationService } from "./configuration-service.js";

export function createFileSettingsModule(
  registry: ConfigurationRegistry,
  homeDirectory: string = homedir(),
): SettingsModule {
  const service = new FileConfigurationService(
    registry,
    resolve(homeDirectory, ".ant", "settings.json"),
  );
  return {
    async load(workspace) {
      return {
        configuration: await service.load(resolve(workspace, ".ant", "settings.json")),
      };
    },
    saveModelId: (modelId) => service.updateUser(MODEL_CONFIGURATION, { modelId }),
    saveModelProviderOptions: (_providerId, providerOptions) =>
      service.updateUser(MODEL_CONFIGURATION, { providerOptions }),
    saveReasoningMode: (reasoningMode) => service.updateUser(UI_CONFIGURATION, { reasoningMode }),
  };
}
