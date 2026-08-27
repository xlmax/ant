import type { SubmittedTurn } from "../app/application-client.js";
import type { AgentSession } from "../app/session.js";
import type { TurnExecutorOptions } from "./presentation-ports.js";

export type TurnRunnerOptions = TurnExecutorOptions;

export class TurnRunner {
  readonly #options: TurnRunnerOptions;

  constructor(options: TurnRunnerOptions) {
    this.#options = options;
  }

  async run(
    content: string,
    onSessionPrepared?: (session: AgentSession, created: boolean) => void | Promise<void>,
  ): Promise<SubmittedTurn> {
    const { client, renderer, workspace, showChanges, process, git } = this.#options;
    renderer.beginTurn();

    // The change tracker takes a Git snapshot and hashes every dirty file, so
    // it is only attached when the summary will actually be shown.
    const changes = showChanges ? git.createChangeTracker(workspace) : undefined;
    await changes?.begin();

    const cancelTurn = new AbortController();
    const onSigint = (): void => {
      if (!cancelTurn.signal.aborted) {
        renderer.printCancellationPending();
        cancelTurn.abort();
      }
    };
    const removeInterrupt = process.onInterrupt(onSigint);

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
      removeInterrupt();
      renderer.dispose();
    }
  }
}
