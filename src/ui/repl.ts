import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { ModelSettings, ProjectSettingsOverrides, RuntimeLimits } from "../config/settings.js";
import { createAgentState, runAgent, type AgentModel, type AgentState } from "../core/agent.js";
import { estimateContextBudget } from "../core/context-budget.js";
import { createCompactionPlan, type ContextSummarizer } from "../core/context-events.js";
import type { ToolEnvironment } from "../core/environment.js";
import { JsonlSessionStore, type AgentSession } from "../core/session-store.js";
import { checkForUpdates, isRunningUnderNpm, runGlobalUpdate } from "../updates/updates.js";
import { VERSION } from "../version.js";
import { ansi } from "./ansi.js";
import { getReplCommands, parseReplCommand } from "./commands.js";
import { ConsoleRenderer } from "./console-renderer.js";
import { InputHistory } from "./input-history.js";
import { readTerminalInput } from "./terminal-input.js";
import { formatModelStatus, selectEffort, selectModel } from "./runtime-model.js";
import { closeUserInputFrame, openUserInputFrame, userInputPrompt } from "./input-frame.js";
import { formatContextStatus } from "./context-status.js";
import { formatStartScreen, resolveGitBranch } from "./start-screen.js";
import { formatUpdateNotice } from "./update-notice.js";
import { TurnChangeTracker } from "./turn-change-summary.js";

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
  let summarizer = options.summarizer;
  let modelSettings = options.modelSettings;
  let state: AgentState | undefined;
  let session: AgentSession | undefined;

  const branch = await resolveGitBranch(options.workspace);
  console.log(
    formatStartScreen({
      workspace: options.workspace,
      branch,
      modelSettings,
    }),
  );

  if (options.resume) {
    const resumed = await options.store.resume(options.resume);
    state = resumed.state;
    session = resumed.session;
    console.log(ansi.dim(`Продолжена сессия: ${session.id}`));
  }

  const updateInfo = isRunningUnderNpm()
    ? undefined
    : await checkForUpdates(VERSION, AbortSignal.timeout(2_000));
  if (updateInfo) {
    console.log(formatUpdateNotice(updateInfo, VERSION));
  }

  try {
    while (true) {
      openUserInputFrame();
      const input = await readTerminalInput(inputHistory, terminal, userInputPrompt());
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

          case "context":
            console.log(
              formatContextStatus(
                estimateContextBudget({
                  systemPrompt: options.systemPrompt,
                  events: state?.events ?? [],
                  tools: options.environment.tools(),
                  contextWindow: modelSettings.contextWindow,
                  includeImages: modelSettings.vision,
                  includeReasoning: modelSettings.thinking.enabled,
                }),
              ),
            );
            continue;

          case "compact": {
            if (!state || !session) {
              console.log(ansi.dim("Сессия ещё не создана."));
              continue;
            }
            const plan = createCompactionPlan(state.events);
            if (!plan) {
              console.log(
                ansi.dim(
                  "Для сжатия нужно больше двух пользовательских ходов в активном контексте.",
                ),
              );
              continue;
            }

            const before = estimateContextBudget({
              systemPrompt: options.systemPrompt,
              events: state.events,
              tools: options.environment.tools(),
              contextWindow: modelSettings.contextWindow,
              includeImages: modelSettings.vision,
              includeReasoning: modelSettings.thinking.enabled,
            });
            console.log(ansi.dim("Сжимаю старую часть контекста…"));
            const cancelCompaction = new AbortController();
            const onCompactionSigint = (): void => cancelCompaction.abort();
            process.on("SIGINT", onCompactionSigint);

            try {
              const signal = AbortSignal.any([
                cancelCompaction.signal,
                AbortSignal.timeout(options.limits.turnTimeoutSeconds * 1_000),
              ]);
              const summary = await summarizer.summarize(plan.eventsToSummarize, signal);
              const event = {
                type: "compaction" as const,
                summary,
                retainedEvents: plan.retainedEvents,
              };
              const after = estimateContextBudget({
                systemPrompt: options.systemPrompt,
                events: [...state.events, event],
                tools: options.environment.tools(),
                contextWindow: modelSettings.contextWindow,
                includeImages: modelSettings.vision,
                includeReasoning: modelSettings.thinking.enabled,
              });
              if (after.estimatedTokens >= before.estimatedTokens) {
                console.warn(
                  ansi.yellow(
                    `Резюме не уменьшило контекст (~${before.estimatedTokens.toLocaleString("ru-RU")} → ~${after.estimatedTokens.toLocaleString("ru-RU")} токенов), поэтому сессия не изменена.`,
                  ),
                );
                continue;
              }
              state.events.push(event);
              await session.observer.onEvent(event);

              console.log(
                ansi.green(
                  `Контекст сжат: ~${before.estimatedTokens.toLocaleString("ru-RU")} → ~${after.estimatedTokens.toLocaleString("ru-RU")} токенов. Последние ${plan.retainedUserTurns} хода сохранены дословно.`,
                ),
              );
            } catch (error) {
              console.error(
                cancelCompaction.signal.aborted
                  ? ansi.yellow("Сжатие контекста отменено.")
                  : ansi.red(
                      `Не удалось сжать контекст: ${error instanceof Error ? error.message : String(error)}`,
                    ),
              );
            } finally {
              process.removeListener("SIGINT", onCompactionSigint);
            }
            continue;
          }

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
                if (options.projectOverrides.showReasoning) {
                  console.warn(
                    ansi.yellow(
                      "⚠ Проектная настройка ui.showReasoning перекроет это значение после перезапуска.",
                    ),
                  );
                }
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
                summarizer = options.createContextSummarizer(modelSettings);
                console.log(
                  ansi.dim(`Модель переключена и сохранена: ${formatModelStatus(modelSettings)}`),
                );
                if (options.projectOverrides.modelId) {
                  console.warn(
                    ansi.yellow(
                      "⚠ Проектная настройка model.id перекроет это значение после перезапуска.",
                    ),
                  );
                }
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
                summarizer = options.createContextSummarizer(modelSettings);
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
                if (options.projectOverrides.modelThinking) {
                  console.warn(
                    ansi.yellow(
                      "⚠ Проектная настройка model.thinking перекроет это значение после перезапуска.",
                    ),
                  );
                }
              } catch (error) {
                console.error(
                  ansi.red(
                    `Не удалось сохранить настройки размышлений: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
              }
            }
            continue;

          case "update": {
            const info = updateInfo ?? (await checkForUpdates(VERSION, AbortSignal.timeout(5_000)));

            if (!info) {
              console.log(ansi.dim("Вы используете актуальную версию ant."));
              continue;
            }

            if (!info.url) {
              console.error(ansi.red("Не удалось найти установочный файл для обновления."));
              continue;
            }

            console.log(ansi.dim(`Обновляю ant до ${info.version}…`));
            try {
              await runGlobalUpdate(info.url);
              console.log(
                ansi.green(`Обновлено до ${info.version}. Перезапустите: /exit, затем ant -c.`),
              );
            } catch (error) {
              console.error(
                ansi.red(
                  `Не удалось обновиться: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
            }
            continue;
          }

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
      const changes = new TurnChangeTracker(options.workspace);
      await changes.begin();
      const cancelTurn = new AbortController();
      const onSigint = (): void => {
        if (!cancelTurn.signal.aborted) {
          console.log(ansi.yellow("\nОтмена текущего хода…"));
          cancelTurn.abort();
        }
      };
      process.on("SIGINT", onSigint);

      try {
        const result = await runAgent(state, {
          model,
          environment: options.environment,
          observers: [session.observer, renderer, changes],
          onTextDelta: renderer.onTextDelta,
          onReasoningDelta: renderer.onReasoningDelta,
          signal: AbortSignal.any([
            cancelTurn.signal,
            AbortSignal.timeout(options.limits.turnTimeoutSeconds * 1_000),
          ]),
          modelRequestTimeoutMs: options.limits.modelRequestTimeoutSeconds * 1_000,
          modelMaxAttempts: options.limits.modelMaxAttempts,
        });

        renderer.printResult(result);
        renderer.printChangeSummary(await changes.finish());
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
    }
  } finally {
    terminal?.close();
  }
}
