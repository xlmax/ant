import type { ModelSettings } from "./configuration.js";
import type { AgentModel } from "../core/agent.js";
import type { ContextSummarizer } from "../core/context-events.js";

/** Application-owned port implemented by a model-provider adapter. */
export interface ModelProvider {
  createAgentModel(settings: ModelSettings): AgentModel;
  createContextSummarizer(settings: ModelSettings): ContextSummarizer;
  listModels(settings: ModelSettings, signal?: AbortSignal): Promise<readonly string[]>;
}
