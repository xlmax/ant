import type { AntFrontend, FrontendOptions } from "../app/frontend.js";
import type { AntHostContext } from "../app/host-context.js";
import { SessionController } from "../app/session-controller.js";
import { configureAnsi } from "./ansi.js";
import { ConsoleRenderer } from "./console-renderer.js";
import { initConsoleSize } from "./console-size.js";
import { runRepl } from "./repl.js";
import { TurnRunner } from "./turn-runner.js";

export type TerminalFrontendOptions = FrontendOptions;

/** Terminal presentation module for one-shot and interactive operation. */
export class TerminalFrontend implements AntFrontend {
  readonly #options: TerminalFrontendOptions;

  constructor(options: TerminalFrontendOptions) {
    this.#options = options;
  }

  async run(host: AntHostContext): Promise<void> {
    configureAnsi(this.#options.color);
    await initConsoleSize();

    const model = host.provider.createAgentModel(this.#options.modelSettings);
    const summarizer = host.provider.createContextSummarizer(this.#options.modelSettings);

    if (this.#options.task === "") {
      await runRepl({ ...this.#options, host, model, summarizer });
      return;
    }

    const sessions = new SessionController(host.sessions);
    if (this.#options.resume) await sessions.resume(this.#options.resume);
    const prepared = await sessions.prepareUserMessage(this.#options.task);
    const { state, session } = prepared;

    const renderer = new ConsoleRenderer({
      showReasoning: this.#options.showReasoning ?? false,
    });
    console.log(`Сессия: ${session.id}`);

    const result = await new TurnRunner({
      workspace: this.#options.workspace,
      runtime: host.runtime,
      model,
      environment: host.environment,
      renderer,
      session,
      limits: this.#options.limits,
      ...(this.#options.verification === undefined
        ? {}
        : { verification: this.#options.verification }),
      showChanges: this.#options.showChanges ?? false,
    }).run(state);

    if (result.status === "cancelled") {
      process.exitCode = 2;
    }
  }
}
