import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { ProjectSettingsOverrides, ReasoningDisplayMode } from "../app/configuration.js";
import type { FrontendSettingsCommands } from "../app/frontend.js";
import type { AntApplicationApi } from "../app/application-client.js";
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
  client: AntApplicationApi;
  settings: FrontendSettingsCommands;
  projectOverrides: ProjectSettingsOverrides;
  reasoningMode: ReasoningDisplayMode;
  reasoningMaxLines: number;
  showChanges?: boolean;
  resume?: string;
}

export async function runRepl(options: ReplOptions): Promise<void> {
  const terminal =
    process.platform === "win32" && stdin.isTTY
      ? undefined
      : createInterface({ input: stdin, output: stdout });
  const renderer = new ConsoleRenderer({
    reasoningMode: options.reasoningMode,
    reasoningMaxLines: options.reasoningMaxLines,
  });
  const inputHistory = new InputHistory();
  const branch = await resolveGitBranch(options.workspace);
  console.log(
    formatStartScreen({
      workspace: options.workspace,
      branch,
      modelSettings: options.client.modelSettings,
    }),
  );

  if (options.resume) {
    const resumed = await options.client.resumeSession(options.resume);
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
        const result = await handleReplCommand(command, { options, renderer });
        if (result === "exit") return;
        continue;
      }

      inputHistory.add(input);
      try {
        await new TurnRunner({
          workspace: options.workspace,
          client: options.client,
          renderer,
          showChanges: options.showChanges ?? false,
        }).run(input, (session, created) => {
          if (created) console.log(ansi.dim(`Сессия: ${session.id}`));
        });
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
