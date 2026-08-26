import type { AgentDependencies, AgentResult, AgentState } from "./agent.js";

/** Contract implemented by an interchangeable agent-loop core. */
export interface AgentRuntime {
  run(state: AgentState, dependencies: AgentDependencies): Promise<AgentResult>;
}
