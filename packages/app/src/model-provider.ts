import type { AgentModel } from "@ant/core";
import type { ContextSummarizer } from "@ant/core";
import type { ModelConfiguration, ModelConfigurationChange, ModelDescriptor } from "./model.js";

export type {
  ModelConfiguration,
  ModelConfigurationChange,
  ModelDescriptor,
  ReasoningCapability,
} from "./model.js";

/** Application-owned port implemented by a model-provider adapter. */
export interface ModelProvider {
  readonly id: string;
  describe(configuration: ModelConfiguration): ModelDescriptor;
  createAgentModel(configuration: ModelConfiguration): AgentModel;
  createContextSummarizer(configuration: ModelConfiguration): ContextSummarizer;
  listModels(configuration: ModelConfiguration, signal?: AbortSignal): Promise<readonly string[]>;
  selectModel(configuration: ModelConfiguration, modelId: string): ModelConfiguration;
  selectReasoning(configuration: ModelConfiguration, selection: string): ModelConfigurationChange;
}
