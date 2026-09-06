import type { SubmittedTurn } from "@ant/app";
import type { AgentSession } from "@ant/app";
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
    this.#options.presence.setState("working");

    // The change tracker takes a Git snapshot and hashes every dirty file, so
    // it is only attached when the summary will actually be shown.
    const changes = showChanges ? git.createChangeTracker(workspace) : undefined;
    const cancelTurn = new AbortController();
    const onSigint = (): void => {
      if (!cancelTurn.signal.aborted) {
        renderer.printCancellationPending();
        cancelTurn.abort();
      }
    };
    const removeInterrupt = process.onInterrupt(onSigint);

    try {
      await changes?.begin();
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
      this.#options.presence.setState("idle");
      return submitted;
    } catch (error) {
      this.#options.presence.setState("error");
      throw error;
    } finally {
      removeInterrupt();
      renderer.dispose();
    }
  }
}
