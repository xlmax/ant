import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { ModelSettings, ProjectSettingsOverrides, RuntimeLimits } from "../config/settings.js";
import type { AgentModel } from "../core/agent.js";
import type { ContextSummarizer } from "../core/context-events.js";
import type { ToolEnvironment } from "../core/environment.js";
import { JsonlSessionStore } from "../core/session-store.js";
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
  model: AgentModel;
  summarizer: ContextSummarizer;
  modelSettings: ModelSettings;
  createAgentModel(settings: ModelSettings): AgentModel;
  createContextSummarizer(settings: ModelSettings): ContextSummarizer;
  listModels(): Promise<readonly string[]>;
  saveModelId(id: string): Promise<void>;
  saveThinking(thinking: ModelSettings["thinking"]): Promise<void>;
  saveShowReasoning(enabled: boolean): Promise<void>;
  projectOverrides: ProjectSettingsOverrides;
  environment: ToolEnvironment;
  store: JsonlSessionStore;
  showReasoning?: boolean;
  limits: RuntimeLimits;
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
  const sessions = new SessionController(options.store);

  const branch = await resolveGitBranch(options.workspace);
  console.log(
    formatStartScreen({ workspace: options.workspace, branch, modelSettings: state.modelSettings }),
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
          model: state.model,
          environment: options.environment,
          renderer,
          session,
          limits: options.limits,
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
