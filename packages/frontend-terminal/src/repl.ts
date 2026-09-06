import type { ProjectSettingsOverrides, ReasoningDisplayMode } from "@ant/app";
import type { FrontendSettingsCommands } from "@ant/app";
import type { AntApplicationApi } from "@ant/app";
import { VERSION } from "@ant/contracts";
import type { AgentPresence } from "./agent-presence.js";
import { ansi } from "./ansi.js";
import type { CommandRegistry } from "./command-registry.js";
import { InputHistory } from "./input-history.js";
import { userInputPrompt } from "./input-frame.js";
import { formatResumeReplay } from "./resume-replay.js";
import type {
  GitPresentationService,
  ProcessControl,
  TerminalPort,
  TerminalRenderer,
  TurnExecutor,
  TurnExecutorOptions,
  UpdateService,
} from "./presentation-ports.js";
import { formatStartScreen } from "./start-screen.js";
import { formatUpdateNotice } from "./update-notice.js";

export interface ReplOptions {
  workspace: string;
  client: AntApplicationApi;
  settings: FrontendSettingsCommands;
  projectOverrides: ProjectSettingsOverrides;
  reasoningMode: ReasoningDisplayMode;
  reasoningMaxLines: number;
  presence: AgentPresence;
  closeOnExit?: boolean;
  showChanges?: boolean;
  resume?: string;
}

export interface ReplDependencies {
  terminal: TerminalPort;
  process: ProcessControl;
  updates: UpdateService;
  git: GitPresentationService;
  commands: CommandRegistry;
  createRenderer(): TerminalRenderer;
  createTurnRunner(options: TurnExecutorOptions): TurnExecutor;
}

export async function runRepl(options: ReplOptions, dependencies: ReplDependencies): Promise<void> {
  const { terminal, process, updates, git, commands } = dependencies;
  const renderer = dependencies.createRenderer();
  const inputHistory = new InputHistory();
  options.presence.setState("idle");
  terminal.log(
    formatStartScreen({
      workspace: options.workspace,
      branch: await git.branch(options.workspace),
      modelDescriptor: options.client.modelDescriptor,
    }),
  );

  if (options.resume) {
    const resumed = await options.client.resumeSession(options.resume);
    options.presence.setSession(resumed.session.id);
    terminal.log(ansi.dim(`Продолжена сессия: ${resumed.session.id}`));
    terminal.write(
      formatResumeReplay(options.client.getLastTurnEvents(), {
        reasoningMode: options.reasoningMode,
        reasoningMaxLines: options.reasoningMaxLines,
      }),
    );
  }

  const updateInfo = updates.managedByNpm
    ? undefined
    : await updates.check(VERSION, process.timeout(20_000));
  if (updateInfo) terminal.log(formatUpdateNotice(updateInfo, VERSION));

  try {
    while (true) {
      const input = await terminal.read(inputHistory, userInputPrompt());
      if (input === undefined) return;
      if (input.trim() === "") continue;

      const command = commands.parse(input.trim());
      if (command) {
        try {
          const result = await commands.dispatch(command, {
            options,
            renderer,
            terminal,
            process,
            updates,
          });
          if (result === "exit") return;
        } catch (error) {
          options.presence.setState("error");
          terminal.error(
            ansi.red(
              `Не удалось выполнить команду: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
        continue;
      }

      inputHistory.add(input);
      try {
        await dependencies
          .createTurnRunner({
            workspace: options.workspace,
            client: options.client,
            renderer,
            presence: options.presence,
            process,
            git,
            showChanges: options.showChanges ?? false,
          })
          .run(input, (session, created) => {
            options.presence.setSession(session.id);
            if (created) terminal.log(ansi.dim(`Сессия: ${session.id}`));
          });
      } catch (error) {
        options.presence.setState("error");
        terminal.error(
          ansi.red(
            `Не удалось выполнить ход: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
  } finally {
    if (options.closeOnExit ?? true) {
      terminal.close();
    }
  }
}
