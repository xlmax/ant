import type { AntFrontend, FrontendOptions } from "../app/frontend.js";
import type { AntApplicationApi } from "../app/application-client.js";
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

  async run(client: AntApplicationApi): Promise<void> {
    configureAnsi(this.#options.color);
    await initConsoleSize();

    if (this.#options.task === "") {
      await runRepl({ ...this.#options, client });
      return;
    }

    if (this.#options.resume) await client.resumeSession(this.#options.resume);

    const renderer = new ConsoleRenderer({
      reasoningMode: this.#options.reasoningMode,
      reasoningMaxLines: this.#options.reasoningMaxLines,
    });
    const result = await new TurnRunner({
      workspace: this.#options.workspace,
      client,
      renderer,
      showChanges: this.#options.showChanges ?? false,
    }).run(this.#options.task, (session) => console.log(`Сессия: ${session.id}`));

    if (result.result.status === "cancelled") {
      process.exitCode = 2;
    }
  }
}
