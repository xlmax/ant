import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { ModelSettings, RuntimeLimits } from "../config/settings.js";
import { createAgentState, runAgent, type AgentModel, type AgentState } from "../core/agent.js";
import type { ToolEnvironment } from "../core/environment.js";
import { JsonlSessionStore, type AgentSession } from "../core/session-store.js";
import { ansi } from "./ansi.js";
import { getReplCommands, parseReplCommand } from "./commands.js";
import { ConsoleRenderer } from "./console-renderer.js";
import { InputHistory } from "./input-history.js";
import { readTerminalInput } from "./terminal-input.js";
import { formatModelStatus, selectEffort, selectModel } from "./runtime-model.js";
import { closeUserInputFrame, openUserInputFrame, userInputPrompt } from "./input-frame.js";

export interface ReplOptions {
  model: AgentModel;
  modelSettings: ModelSettings;
  createAgentModel(settings: ModelSettings): AgentModel;
  listModels(): Promise<readonly string[]>;
  saveModelId(id: string): Promise<void>;
  saveThinking(thinking: ModelSettings["thinking"]): Promise<void>;
  saveShowReasoning(enabled: boolean): Promise<void>;
  environment: ToolEnvironment;
  store: JsonlSessionStore;
  showReasoning?: boolean;
  limits: RuntimeLimits;
  resume?: string;
}

async function appendUserMessage(
  state: AgentState,
  session: AgentSession,
  content: string,
): Promise<void> {
  const event = { type: "user" as const, content };
  state.events.push(event);
  await session.observer.onEvent(event);
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
  let model = options.model;
  let modelSettings = options.modelSettings;
  let state: AgentState | undefined;
  let session: AgentSession | undefined;

  if (options.resume) {
    const resumed = await options.store.resume(options.resume);
    state = resumed.state;
    session = resumed.session;
    console.log(ansi.dim(`Продолжена сессия: ${session.id}`));
  } else {
    console.log(ansi.dim("Интерактивный режим. Введите /help, чтобы увидеть команды."));
  }

  try {
    while (true) {
      openUserInputFrame();
      stdout.write(userInputPrompt());
      const input = await readTerminalInput(inputHistory, terminal);
      closeUserInputFrame();

      if (input.trim() === "") {
        continue;
      }

      const command = parseReplCommand(input.trim());

      if (command) {
        switch (command.type) {
          case "exit":
            return;

          case "new":
            state = undefined;
            session = undefined;
            console.log(ansi.dim("Новая сессия будет создана следующим сообщением."));
            continue;

          case "session":
            console.log(
              session
                ? ansi.dim(`Сессия: ${session.id}\nФайл: ${session.filePath}`)
                : ansi.dim("Сессия ещё не создана."),
            );
            continue;

          case "clear":
            process.stdout.write("\u001B[2J\u001B[H");
            continue;

          case "reasoning":
            if (command.enabled === undefined) {
              console.log(
                ansi.dim(`Рассуждения: ${renderer.showReasoning ? "включены" : "выключены"}.`),
              );
            } else {
              renderer.setShowReasoning(command.enabled);
              try {
                await options.saveShowReasoning(command.enabled);
                console.log(
                  ansi.dim(
                    `Рассуждения ${command.enabled ? "включены" : "выключены"} и сохранены.`,
                  ),
                );
              } catch (error) {
                console.error(
                  ansi.red(
                    `Не удалось сохранить настройку рассуждений: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
              }
            }
            continue;

          case "model":
            if (command.list) {
              try {
                const models = await options.listModels();
                console.log(ansi.bold("Доступные модели DeepSeek:"));
                if (models.length === 0) {
                  console.log(ansi.dim("Provider не вернул доступные модели."));
                }
                for (const id of models) {
                  console.log(`${id === modelSettings.id ? ansi.green("●") : ansi.dim("○")} ${id}`);
                }
              } catch (error) {
                console.error(
                  ansi.red(
                    `Не удалось получить список моделей: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
              }
            } else if (command.id === undefined) {
              console.log(ansi.dim(`Модель: ${formatModelStatus(modelSettings)}`));
            } else if (command.id === modelSettings.id) {
              console.log(ansi.dim(`Модель уже активна: ${formatModelStatus(modelSettings)}`));
            } else {
              try {
                await options.saveModelId(command.id);
                modelSettings = selectModel(modelSettings, command.id);
                model = options.createAgentModel(modelSettings);
                console.log(
                  ansi.dim(`Модель переключена и сохранена: ${formatModelStatus(modelSettings)}`),
                );
              } catch (error) {
                console.error(
                  ansi.red(
                    `Не удалось сохранить модель: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
              }
            }
            continue;

          case "think":
            if (command.selection === undefined) {
              console.log(ansi.dim(`Режим размышлений: ${formatModelStatus(modelSettings)}`));
            } else {
              const nextSettings = selectEffort(modelSettings, command.selection);
              const changed =
                nextSettings.thinking.enabled !== modelSettings.thinking.enabled ||
                nextSettings.thinking.effort !== modelSettings.thinking.effort;

              if (changed) {
                modelSettings = nextSettings;
                model = options.createAgentModel(modelSettings);
              }

              try {
                await options.saveThinking(nextSettings.thinking);
                console.log(
                  ansi.dim(
                    changed
                      ? `Рассуждения модели переключены и сохранены: ${formatModelStatus(modelSettings)}`
                      : `Рассуждения модели уже настроены и сохранены: ${formatModelStatus(modelSettings)}`,
                  ),
                );
              } catch (error) {
                console.error(
                  ansi.red(
                    `Не удалось сохранить настройки размышлений: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
              }
            }
            continue;

          case "help":
            if (command.command) {
              console.log(`${ansi.bold(command.command.usage)}\n${command.command.description}`);
            } else {
              console.log(ansi.bold("Доступные команды:"));
              for (const available of getReplCommands()) {
                console.log(`  ${ansi.cyan(available.usage.padEnd(20))} ${available.description}`);
              }
            }
            continue;

          case "error":
            console.error(ansi.red(command.message));
            continue;
        }
      }

      inputHistory.add(input);

      if (!state || !session) {
        state = createAgentState(input);
        session = await options.store.create(state);
        console.log(ansi.dim(`Сессия: ${session.id}`));
      } else {
        await appendUserMessage(state, session, input);
      }

      renderer.beginTurn();
      const result = await runAgent(state, {
        model,
        environment: options.environment,
        observers: [session.observer, renderer],
        onTextDelta: renderer.onTextDelta,
        onReasoningDelta: renderer.onReasoningDelta,
        signal: AbortSignal.timeout(options.limits.turnTimeoutSeconds * 1_000),
        modelRequestTimeoutMs: options.limits.modelRequestTimeoutSeconds * 1_000,
        modelMaxAttempts: options.limits.modelMaxAttempts,
      });

      renderer.printResult(result);
    }
  } finally {
    terminal?.close();
  }
}
