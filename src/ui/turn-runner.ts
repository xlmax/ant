import type { AntApplicationApi, SubmittedTurn } from "../app/application-client.js";
import type { AgentSession } from "../app/session.js";
import type { ConsoleRenderer } from "./console-renderer.js";
import { TurnChangeTracker } from "./turn-change-summary.js";

export interface TurnRunnerOptions {
  workspace: string;
  client: AntApplicationApi;
  renderer: ConsoleRenderer;
  showChanges?: boolean;
}

export class TurnRunner {
  readonly #options: TurnRunnerOptions;

  constructor(options: TurnRunnerOptions) {
    this.#options = options;
  }

  async run(
    content: string,
    onSessionPrepared?: (session: AgentSession, created: boolean) => void | Promise<void>,
  ): Promise<SubmittedTurn> {
    const { client, renderer, workspace, showChanges } = this.#options;
    renderer.beginTurn();

    // The change tracker takes a Git snapshot and hashes every dirty file, so
    // it is only attached when the summary will actually be shown.
    const changes = showChanges ? new TurnChangeTracker(workspace) : undefined;
    await changes?.begin();

    const cancelTurn = new AbortController();
    const onSigint = (): void => {
      if (!cancelTurn.signal.aborted) {
        renderer.printCancellationPending();
        cancelTurn.abort();
      }
    };
    process.on("SIGINT", onSigint);

    try {
      const submitted = await client.submitTurn(content, {
        observers: [renderer, ...(changes ? [changes] : [])],
        onTextDelta: renderer.onTextDelta,
        onReasoningDelta: renderer.onReasoningDelta,
        signal: cancelTurn.signal,
        ...(onSessionPrepared === undefined ? {} : { onSessionPrepared }),
      });

      await renderer.printResult(submitted.result);
      if (changes) {
        await renderer.printChangeSummary(await changes.finish());
      }
      return submitted;
    } finally {
      process.removeListener("SIGINT", onSigint);
      renderer.dispose();
    }
  }
}
