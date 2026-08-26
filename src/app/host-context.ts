import type { Environment } from "../core/agent.js";
import type { AgentRuntime } from "../core/runtime.js";
import type { SessionStore } from "../core/session.js";
import type { ModelProvider } from "./model-provider.js";

/** Services exposed by the microkernel to a presentation adapter. */
export interface AntHostContext {
  readonly runtime: AgentRuntime;
  readonly provider: ModelProvider;
  readonly sessions: SessionStore;
  readonly environment: Environment;
}
