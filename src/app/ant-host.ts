import type { Environment } from "../core/agent.js";
import type { AgentRuntime } from "../core/runtime.js";
import type { SessionStore } from "../core/session.js";
import type { AntFrontend } from "./frontend.js";
import type { AntHostContext } from "./host-context.js";
import type { ModelProvider } from "./model-provider.js";

/**
 * Minimal microkernel host. It owns no agent policy: it only exposes the
 * selected modules to a frontend through stable ports.
 */
export class AntHost implements AntHostContext {
  readonly runtime: AgentRuntime;
  readonly provider: ModelProvider;
  readonly sessions: SessionStore;
  readonly environment: Environment;

  constructor(modules: AntHostContext) {
    this.runtime = modules.runtime;
    this.provider = modules.provider;
    this.sessions = modules.sessions;
    this.environment = modules.environment;
  }

  run(frontend: AntFrontend): Promise<void> {
    return frontend.run(this);
  }
}
