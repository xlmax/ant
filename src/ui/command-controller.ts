import { checkForUpdates, runGlobalUpdate } from "../updates/updates.js";
import { VERSION } from "../version.js";
import { ansi } from "./ansi.js";
import { getReplCommands, type CommandAction } from "./commands.js";
import { ConsoleRenderer } from "./console-renderer.js";
import { formatContextStatus } from "./context-status.js";
import { formatModelStatus } from "./runtime-model.js";
import type { ReplOptions } from "./repl.js";

export interface ReplCommandContext {
  options: ReplOptions;
  renderer: ConsoleRenderer;
}

export type CommandResult = "continue" | "exit";

export async function handleReplCommand(
  command: CommandAction,
  context: ReplCommandContext,
): Promise<CommandResult> {
  const { options, renderer } = context;
  const { client } = options;

  switch (command.type) {
    case "exit":
      if (client.activeSession) {
        console.log(ansi.dim(`Для продолжения сессии: ant -s ${client.activeSession.session.id}`));
      }
      return "exit";

    case "new":
      client.resetSession();
      console.log(ansi.dim("Новая сессия будет создана следующим сообщением."));
      return "continue";

    case "session":
      console.log(
        client.activeSession
          ? ansi.dim(
              `Сессия: ${client.activeSession.session.id}${
                client.activeSession.session.location
                  ? `\nХранилище: ${client.activeSession.session.location}`
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
      console.log(formatContextStatus(client.getContextStatus()));
      return "continue";

    case "compact": {
      const cancelCompaction = new AbortController();
      const onCompactionSigint = (): void => cancelCompaction.abort();
      process.on("SIGINT", onCompactionSigint);

      try {
        const result = await client.compactContext({
          signal: cancelCompaction.signal,
          onStarted: () => console.log(ansi.dim("Сжимаю старую часть контекста…")),
        });
        if (result.status === "no-session") {
          console.log(ansi.dim("Сессия ещё не создана."));
          return "continue";
        }
        if (result.status === "not-enough-history") {
          console.log(
            ansi.dim("Для сжатия нужно больше двух пользовательских ходов в активном контексте."),
          );
          return "continue";
        }
        if (result.status === "not-smaller") {
          console.warn(
            ansi.yellow(
              `Резюме не уменьшило контекст (~${result.before.estimatedTokens.toLocaleString("ru-RU")} → ~${result.after.estimatedTokens.toLocaleString("ru-RU")} токенов), поэтому сессия не изменена.`,
            ),
          );
          return "continue";
        }
        console.log(
          ansi.green(
            `Контекст сжат: ~${result.before.estimatedTokens.toLocaleString("ru-RU")} → ~${result.after.estimatedTokens.toLocaleString("ru-RU")} токенов. Последние ${result.retainedUserTurns} хода сохранены дословно.`,
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
          const models = await client.listModels();
          console.log(ansi.bold("Доступные модели DeepSeek:"));
          if (models.length === 0) console.log(ansi.dim("Provider не вернул доступные модели."));
          for (const id of models)
            console.log(
              `${id === client.modelSettings.id ? ansi.green("●") : ansi.dim("○")} ${id}`,
            );
        } catch (error) {
          console.error(
            ansi.red(
              `Не удалось получить список моделей: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      } else if (command.id === undefined) {
        console.log(ansi.dim(`Модель: ${formatModelStatus(client.modelSettings)}`));
      } else {
        try {
          const selection = await client.selectModel(command.id);
          console.log(
            ansi.dim(
              selection.changed
                ? `Модель переключена и сохранена: ${formatModelStatus(selection.settings)}`
                : `Модель уже активна: ${formatModelStatus(selection.settings)}`,
            ),
          );
          if (selection.changed && options.projectOverrides.modelId)
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
        console.log(ansi.dim(`Режим размышлений: ${formatModelStatus(client.modelSettings)}`));
      } else {
        try {
          const selection = await client.selectThinking(command.selection);
          console.log(
            ansi.dim(
              selection.changed
                ? `Рассуждения модели переключены и сохранены: ${formatModelStatus(selection.settings)}`
                : `Рассуждения модели уже настроены и сохранены: ${formatModelStatus(selection.settings)}`,
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
