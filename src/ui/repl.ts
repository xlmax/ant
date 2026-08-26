import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { FrontendSettingsCommands } from "../app/frontend.js";
import type { AntHostContext } from "../app/host-context.js";
import type {
  ModelSettings,
  ProjectSettingsOverrides,
  RuntimeLimits,
  VerificationSettings,
} from "../config/settings.js";
import type { AgentModel } from "../core/agent.js";
import type { ContextSummarizer } from "../core/context-events.js";
import { SessionController } from "../core/session-controller.js";
import { checkForUpdates, isRunningUnderNpm } from "../updates/updates.js";
import { VERSION } from "../version.js";
import { ansi } from "./ansi.js";
import { handleReplCommand } from "./command-controller.js";
import { parseReplCommand } from "./commands.js";
import { ConsoleRenderer } from "./console-renderer.js";
import { InputHistory } from "./input-history.js";
import { closeUserInputFrame, openUserInputFrame, userInputPrompt } from "./input-frame.js";
import { readTerminalInput } from "./terminal-input.js";
import { formatStartScreen, resolveGitBranch } from "./start-screen.js";
import { formatUpdateNotice } from "./update-notice.js";
import { TurnRunner } from "./turn-runner.js";

export interface ReplOptions {
  workspace: string;
  host: AntHostContext;
  model: AgentModel;
  summarizer: ContextSummarizer;
  modelSettings: ModelSettings;
  settings: FrontendSettingsCommands;
  projectOverrides: ProjectSettingsOverrides;
  showReasoning?: boolean;
  showChanges?: boolean;
  limits: RuntimeLimits;
  verification?: VerificationSettings;
  systemPrompt: string;
  resume?: string;
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const terminal =
    process.platform === "win32" && stdin.isTTY
      ? undefined
      : createInterface({ input: stdin, output: stdout });
  const renderer = new ConsoleRenderer(
    options.showReasoning === undefined ? {} : { showReasoning: options.showReasoning },
  );
  const inputHistory = new InputHistory();
  const state = {
    model: options.model,
    modelSettings: options.modelSettings,
    summarizer: options.summarizer,
  };
  const sessions = new SessionController(options.host.sessions);

  const branch = await resolveGitBranch(options.workspace);
  console.log(
    formatStartScreen({
      workspace: options.workspace,
      branch,
      modelSettings: state.modelSettings,
    }),
  );

  if (options.resume) {
    const resumed = await sessions.resume(options.resume);
    console.log(ansi.dim(`Продолжена сессия: ${resumed.session.id}`));
  }

  const updateInfo = isRunningUnderNpm()
    ? undefined
    : await checkForUpdates(VERSION, AbortSignal.timeout(20_000));
  if (updateInfo) console.log(formatUpdateNotice(updateInfo, VERSION));

  try {
    while (true) {
      openUserInputFrame();
      const input = await readTerminalInput(inputHistory, terminal, userInputPrompt());
      closeUserInputFrame();

      if (input.trim() === "") continue;

      const command = parseReplCommand(input.trim());
      if (command) {
        const result = await handleReplCommand(command, { options, renderer, sessions, state });
        if (result === "exit") return;
        continue;
      }

      inputHistory.add(input);
      const prepared = await sessions.prepareUserMessage(input);
      const { state: sessionState, session } = prepared;
      if (prepared.created) console.log(ansi.dim(`Сессия: ${session.id}`));

      try {
        await new TurnRunner({
          workspace: options.workspace,
          runtime: options.host.runtime,
          model: state.model,
          environment: options.host.environment,
          renderer,
          session,
          limits: options.limits,
          ...(options.verification === undefined ? {} : { verification: options.verification }),
          showChanges: options.showChanges ?? false,
        }).run(sessionState);
      } catch (error) {
        console.error(
          ansi.red(
            `Не удалось выполнить ход: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
  } finally {
    terminal?.close();
  }
}
