import type { AntFrontend, FrontendOptions } from "@ant/app";
import type { AntApplicationApi } from "@ant/app";
import type { AgentLifecycle } from "./agent-presence.js";
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
  lifecycle: AgentLifecycle;
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
    const { lifecycle } = this.#dependencies;
    lifecycle.start();

    try {
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

      if (this.#options.resume) {
        const resumed = await client.resumeSession(this.#options.resume);
        lifecycle.setSession(resumed.session.id);
      }
      const result = await this.#dependencies
        .createTurnRunner({
          workspace: this.#options.workspace,
          client,
          renderer: this.#dependencies.createRenderer(),
          lifecycle,
          process: this.#dependencies.process,
          git: this.#dependencies.git,
          showChanges: this.#options.showChanges ?? false,
        })
        .run(this.#options.task, (session) => {
          lifecycle.setSession(session.id);
          terminal.log(`Сессия: ${session.id}`);
        });
      if (result.result.status === "cancelled") this.#dependencies.process.setExitCode(2);
    } catch (error) {
      lifecycle.markFatalError();
      throw error;
    } finally {
      lifecycle.stop();
      terminal.close();
    }
  }
}
