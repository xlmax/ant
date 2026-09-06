import type { AntApplicationApi, AntFrontend, FrontendOptions } from "@ant/app";
import type { AgentPresence } from "./agent-presence.js";
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
  createPresence(): AgentPresence;
  createTerminal(presence: AgentPresence): TerminalPort;
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
    const presence = this.#dependencies.createPresence();
    const terminal = this.#dependencies.createTerminal(presence);

    try {
      if (this.#options.task === "") {
        await runRepl(
          { ...this.#options, client, presence, closeOnExit: false },
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
        presence.setSession(resumed.session.id);
      }

      const result = await this.#dependencies
        .createTurnRunner({
          workspace: this.#options.workspace,
          client,
          renderer: this.#dependencies.createRenderer(),
          presence,
          process: this.#dependencies.process,
          git: this.#dependencies.git,
          showChanges: this.#options.showChanges ?? false,
        })
        .run(this.#options.task, (session) => {
          presence.setSession(session.id);
          terminal.log(`Сессия: ${session.id}`);
        });
      if (result.result.status === "cancelled") this.#dependencies.process.setExitCode(2);
    } finally {
      presence.setState("stopped");
      presence.dispose();
      terminal.close();
    }
  }
}
