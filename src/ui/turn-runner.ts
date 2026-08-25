import type { RuntimeLimits } from "../config/settings.js";
import { runAgent, type AgentModel, type AgentResult, type AgentState } from "../core/agent.js";
import type { ToolEnvironment } from "../core/environment.js";
import type { AgentSession } from "../core/session-store.js";
import { ansi } from "./ansi.js";
import type { ConsoleRenderer } from "./console-renderer.js";
import { TurnChangeTracker } from "./turn-change-summary.js";

export interface TurnRunnerOptions {
  workspace: string;
  model: AgentModel;
  environment: ToolEnvironment;
  renderer: ConsoleRenderer;
  session: AgentSession;
  limits: RuntimeLimits;
  showChanges?: boolean;
}

export class TurnRunner {
  readonly #options: TurnRunnerOptions;

  constructor(options: TurnRunnerOptions) {
    this.#options = options;
  }

  async run(state: AgentState): Promise<AgentResult> {
    const { model, environment, renderer, session, limits, workspace } = this.#options;
    renderer.beginTurn();

    const changes = new TurnChangeTracker(workspace);
    await changes.begin();

    const cancelTurn = new AbortController();
    const onSigint = (): void => {
      if (!cancelTurn.signal.aborted) {
        console.log(ansi.yellow("\nОтмена текущего хода…"));
        cancelTurn.abort();
      }
    };
    process.on("SIGINT", onSigint);

    try {
      const result = await runAgent(state, {
        model,
        environment,
        observers: [session.observer, renderer, changes],
        onTextDelta: renderer.onTextDelta,
        onReasoningDelta: renderer.onReasoningDelta,
        signal: AbortSignal.any([
          cancelTurn.signal,
          AbortSignal.timeout(limits.turnTimeoutSeconds * 1_000),
        ]),
        modelRequestTimeoutMs: limits.modelRequestTimeoutSeconds * 1_000,
        modelMaxAttempts: limits.modelMaxAttempts,
      });

      renderer.printResult(result);
      if (this.#options.showChanges) {
        renderer.printChangeSummary(await changes.finish());
      }
      return result;
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  }
}
