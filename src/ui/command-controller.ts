import type { AgentModel } from "../core/agent.js";
import { estimateContextBudget } from "../core/context-budget.js";
import { createCompactionPlan, type ContextSummarizer } from "../core/context-events.js";
import { SessionController } from "../app/session-controller.js";
import { checkForUpdates, runGlobalUpdate } from "../updates/updates.js";
import { VERSION } from "../version.js";
import { ansi } from "./ansi.js";
import { getReplCommands, type CommandAction } from "./commands.js";
import { ConsoleRenderer } from "./console-renderer.js";
import { formatContextStatus } from "./context-status.js";
import { formatModelStatus, selectEffort } from "./runtime-model.js";
import type { ReplOptions } from "./repl.js";

export interface ReplCommandState {
  model: AgentModel;
  modelSettings: ReplOptions["modelSettings"];
  summarizer: ContextSummarizer;
}

export interface ReplCommandContext {
  options: ReplOptions;
  renderer: ConsoleRenderer;
  sessions: SessionController;
  state: ReplCommandState;
}

export type CommandResult = "continue" | "exit";

export async function handleReplCommand(
  command: CommandAction,
  context: ReplCommandContext,
): Promise<CommandResult> {
  const { options, renderer, sessions, state } = context;

  switch (command.type) {
    case "exit":
      if (sessions.active) {
        console.log(ansi.dim(`Для продолжения сессии: ant -s ${sessions.active.session.id}`));
      }
      return "exit";

    case "new":
      sessions.reset();
      console.log(ansi.dim("Новая сессия будет создана следующим сообщением."));
      return "continue";

    case "session":
      console.log(
        sessions.active
          ? ansi.dim(
              `Сессия: ${sessions.active.session.id}${
                sessions.active.session.location
                  ? `\nХранилище: ${sessions.active.session.location}`
                  : ""
              }`,
            )
          : ansi.dim("Сессия ещё не создана."),
      );
      return "continue";

    case "clear":
      process.stdout.write("\u001B[2J\u001B[H");
      return "continue";

    case "context":
      console.log(
        formatContextStatus(
          estimateContextBudget({
            systemPrompt: options.systemPrompt,
            events: sessions.active?.state.events ?? [],
            tools: options.host.environment.tools(),
            contextWindow: state.modelSettings.contextWindow,
            includeImages: state.modelSettings.vision,
            includeReasoning: state.modelSettings.thinking.enabled,
          }),
        ),
      );
      return "continue";

    case "compact": {
      if (!sessions.active) {
        console.log(ansi.dim("Сессия ещё не создана."));
        return "continue";
      }
      const plan = createCompactionPlan(sessions.active.state.events);
      if (!plan) {
        console.log(
          ansi.dim("Для сжатия нужно больше двух пользовательских ходов в активном контексте."),
        );
        return "continue";
      }

      const before = estimateContextBudget({
        systemPrompt: options.systemPrompt,
        events: sessions.active.state.events,
        tools: options.host.environment.tools(),
        contextWindow: state.modelSettings.contextWindow,
        includeImages: state.modelSettings.vision,
        includeReasoning: state.modelSettings.thinking.enabled,
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
        const summary = await state.summarizer.summarize(plan.eventsToSummarize, signal);
        const event = {
          type: "compaction" as const,
          summary,
          retainedEvents: plan.retainedEvents,
        };
        const after = estimateContextBudget({
          systemPrompt: options.systemPrompt,
          events: [...sessions.active.state.events, event],
          tools: options.host.environment.tools(),
          contextWindow: state.modelSettings.contextWindow,
          includeImages: state.modelSettings.vision,
          includeReasoning: state.modelSettings.thinking.enabled,
        });
        if (after.estimatedTokens >= before.estimatedTokens) {
          console.warn(
            ansi.yellow(
              `Резюме не уменьшило контекст (~${before.estimatedTokens.toLocaleString("ru-RU")} → ~${after.estimatedTokens.toLocaleString("ru-RU")} токенов), поэтому сессия не изменена.`,
            ),
          );
          return "continue";
        }
        await sessions.appendPersistentEvent(event);
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
      return "continue";
    }

    case "reasoning":
      if (command.mode === undefined) {
        console.log(
          ansi.dim(
            `Рассуждения: ${renderer.reasoningMode}${renderer.reasoningMode === "compact" ? `, ${renderer.reasoningMaxLines} строк` : ""}.`,
          ),
        );
      } else {
        renderer.setReasoningMode(command.mode);
        try {
          await options.settings.saveReasoningMode(command.mode);
          console.log(ansi.dim(`Режим рассуждений ${command.mode} сохранён.`));
          if (options.projectOverrides.reasoningMode) {
            console.warn(
              ansi.yellow(
                "⚠ Проектная настройка ui.reasoningMode перекроет это значение после перезапуска.",
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
      return "continue";

    case "model":
      if (command.list) {
        try {
          const models = await options.host.provider.listModels(state.modelSettings);
          console.log(ansi.bold("Доступные модели DeepSeek:"));
          if (models.length === 0) console.log(ansi.dim("Provider не вернул доступные модели."));
          for (const id of models)
            console.log(`${id === state.modelSettings.id ? ansi.green("●") : ansi.dim("○")} ${id}`);
        } catch (error) {
          console.error(
            ansi.red(
              `Не удалось получить список моделей: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      } else if (command.id === undefined) {
        console.log(ansi.dim(`Модель: ${formatModelStatus(state.modelSettings)}`));
      } else if (command.id === state.modelSettings.id) {
        console.log(ansi.dim(`Модель уже активна: ${formatModelStatus(state.modelSettings)}`));
      } else {
        try {
          const vision = await options.settings.saveModelId(command.id);
          state.modelSettings = { ...state.modelSettings, id: command.id, vision };
          state.model = options.host.provider.createAgentModel(state.modelSettings);
          state.summarizer = options.host.provider.createContextSummarizer(state.modelSettings);
          console.log(
            ansi.dim(`Модель переключена и сохранена: ${formatModelStatus(state.modelSettings)}`),
          );
          if (options.projectOverrides.modelId)
            console.warn(
              ansi.yellow(
                "⚠ Проектная настройка model.id перекроет это значение после перезапуска.",
              ),
            );
        } catch (error) {
          console.error(
            ansi.red(
              `Не удалось сохранить модель: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      }
      return "continue";

    case "think":
      if (command.selection === undefined) {
        console.log(ansi.dim(`Режим размышлений: ${formatModelStatus(state.modelSettings)}`));
      } else {
        const nextSettings = selectEffort(state.modelSettings, command.selection);
        const changed =
          nextSettings.thinking.enabled !== state.modelSettings.thinking.enabled ||
          nextSettings.thinking.effort !== state.modelSettings.thinking.effort;
        if (changed) {
          state.modelSettings = nextSettings;
          state.model = options.host.provider.createAgentModel(state.modelSettings);
          state.summarizer = options.host.provider.createContextSummarizer(state.modelSettings);
        }
        try {
          await options.settings.saveThinking(nextSettings.thinking);
          console.log(
            ansi.dim(
              changed
                ? `Рассуждения модели переключены и сохранены: ${formatModelStatus(state.modelSettings)}`
                : `Рассуждения модели уже настроены и сохранены: ${formatModelStatus(state.modelSettings)}`,
            ),
          );
          if (options.projectOverrides.modelThinking)
            console.warn(
              ansi.yellow(
                "⚠ Проектная настройка model.thinking перекроет это значение после перезапуска.",
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
      return "continue";

    case "update": {
      const info = await checkForUpdates(VERSION, AbortSignal.timeout(5_000));
      if (!info) {
        console.log(ansi.dim("Вы используете актуальную версию ant."));
        return "continue";
      }
      if (!info.url) {
        console.error(ansi.red("Не удалось найти установочный файл для обновления."));
        return "continue";
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
      return "continue";
    }

    case "help":
      if (command.command)
        console.log(`${ansi.bold(command.command.usage)}\n${command.command.description}`);
      else {
        console.log(ansi.bold("Доступные команды:"));
        for (const available of getReplCommands())
          console.log(`  ${ansi.cyan(available.usage.padEnd(20))} ${available.description}`);
      }
      return "continue";

    case "error":
      console.error(ansi.red(command.message));
      return "continue";
  }
}
