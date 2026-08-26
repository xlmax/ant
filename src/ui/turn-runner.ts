import type { RuntimeLimits, VerificationSettings } from "../app/configuration.js";
import type { AgentModel, AgentResult, AgentState, Environment } from "../core/agent.js";
import type { AgentRuntime } from "../core/runtime.js";
import type { AgentSession } from "../app/session.js";
import { ansi } from "./ansi.js";
import type { ConsoleRenderer } from "./console-renderer.js";
import { TurnChangeTracker } from "./turn-change-summary.js";

export interface TurnRunnerOptions {
  workspace: string;
  runtime: AgentRuntime;
  model: AgentModel;
  environment: Environment;
  renderer: ConsoleRenderer;
  session: AgentSession;
  limits: RuntimeLimits;
  verification?: VerificationSettings;
  showChanges?: boolean;
}

export class TurnRunner {
  readonly #options: TurnRunnerOptions;

  constructor(options: TurnRunnerOptions) {
    this.#options = options;
  }

  async run(state: AgentState): Promise<AgentResult> {
    const {
      runtime,
      model,
      environment,
      renderer,
      session,
      limits,
      workspace,
      showChanges,
      verification,
    } = this.#options;
    renderer.beginTurn();

    // The change tracker takes a Git snapshot and hashes every dirty file, so
    // it is only attached when the summary will actually be shown.
    const changes = showChanges ? new TurnChangeTracker(workspace) : undefined;
    await changes?.begin();

    const cancelTurn = new AbortController();
    const onSigint = (): void => {
      if (!cancelTurn.signal.aborted) {
        console.log(ansi.yellow("\nОтмена текущего хода…"));
        cancelTurn.abort();
      }
    };
    process.on("SIGINT", onSigint);

    try {
      const result = await runtime.run(state, {
        model,
        environment,
        historyObserver: session.observer,
        observers: [renderer, ...(changes ? [changes] : [])],
        onTextDelta: renderer.onTextDelta,
        onReasoningDelta: renderer.onReasoningDelta,
        signal: AbortSignal.any([
          cancelTurn.signal,
          AbortSignal.timeout(limits.turnTimeoutSeconds * 1_000),
        ]),
        modelRequestTimeoutMs: limits.modelRequestTimeoutSeconds * 1_000,
        modelMaxAttempts: limits.modelMaxAttempts,
        ...(verification === undefined ? {} : { verification }),
      });

      renderer.printResult(result);
      if (changes) {
        renderer.printChangeSummary(await changes.finish());
      }
      return result;
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  }
}
