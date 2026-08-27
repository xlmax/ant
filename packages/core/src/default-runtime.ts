import { runAgent } from "./agent-runner.js";
import type { AgentRuntime } from "./runtime.js";

/** The built-in ReAct-style agent loop. Alternative cores implement AgentRuntime. */
export const defaultAgentRuntime: AgentRuntime = {
  run: runAgent,
};
