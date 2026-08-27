import type { AntFrontend, FrontendOptions } from "../app/frontend.js";
import type { AntApplicationApi } from "../app/application-client.js";
import type { CommandRegistry } from "./command-registry.js";
import type {
  GitPresentationService,
  ProcessControl,
  TerminalPort,
  TerminalRenderer,
  TurnExecutor,
  TurnExecutorOptions,
  UpdateService,
} from "./presentation-ports.js";
import { runRepl } from "./repl.js";

export type TerminalFrontendOptions = FrontendOptions;

export interface TerminalFrontendDependencies {
  createTerminal(): TerminalPort;
  process: ProcessControl;
  updates: UpdateService;
  git: GitPresentationService;
  commands: CommandRegistry;
  initialize(color: boolean): Promise<void> | void;
  createRenderer(): TerminalRenderer;
  createTurnRunner(options: TurnExecutorOptions): TurnExecutor;
}

/** Terminal composition for one-shot and interactive presentation. */
export class TerminalFrontend implements AntFrontend {
  readonly #options: TerminalFrontendOptions;
  readonly #dependencies: TerminalFrontendDependencies;

  constructor(options: TerminalFrontendOptions, dependencies: TerminalFrontendDependencies) {
    this.#options = options;
    this.#dependencies = dependencies;
  }

  async run(client: AntApplicationApi): Promise<void> {
    await this.#dependencies.initialize(this.#options.color);
    const terminal = this.#dependencies.createTerminal();

    if (this.#options.task === "") {
      await runRepl(
        { ...this.#options, client },
        {
          ...this.#dependencies,
          terminal,
          createRenderer: this.#dependencies.createRenderer,
          createTurnRunner: this.#dependencies.createTurnRunner,
        },
      );
      return;
    }

    try {
      if (this.#options.resume) await client.resumeSession(this.#options.resume);
      const result = await this.#dependencies
        .createTurnRunner({
          workspace: this.#options.workspace,
          client,
          renderer: this.#dependencies.createRenderer(),
          process: this.#dependencies.process,
          git: this.#dependencies.git,
          showChanges: this.#options.showChanges ?? false,
        })
        .run(this.#options.task, (session) => terminal.log(`Сессия: ${session.id}`));
      if (result.result.status === "cancelled") this.#dependencies.process.setExitCode(2);
    } finally {
      terminal.close();
    }
  }
}
