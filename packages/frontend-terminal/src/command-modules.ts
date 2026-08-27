import type { ReasoningDisplayMode } from "@ant/app";
import { VERSION } from "@ant/contracts";
import { ansi } from "./ansi.js";
import {
  CommandRegistry,
  CommandUsageError,
  noArguments,
  type CommandContext,
  type CommandModule,
} from "./command-registry.js";
import { formatContextStatus } from "./context-status.js";
import { formatModelStatus } from "./runtime-model.js";

function module<T>(
  descriptor: CommandModule<T>["descriptor"],
  parse: CommandModule<T>["parse"],
  handle: CommandModule<T>["handle"],
): CommandModule<T> {
  return { descriptor, parse, handle };
}

function simple(
  name: string,
  usage: string,
  description: string,
  handle: (context: CommandContext) => ReturnType<CommandModule<void>["handle"]>,
): CommandModule<void> {
  return module(
    { name, usage, description },
    (args) => noArguments(args, usage),
    (_input, context) => handle(context),
  );
}

export const compactCommand = simple(
  "compact",
  "/compact",
  "Сжать старую часть текущей сессии в резюме.",
  async ({ options, terminal, process }) => {
    const cancel = new AbortController();
    const removeInterrupt = process.onInterrupt(() => cancel.abort());
    try {
      const result = await options.client.compactContext({
        signal: cancel.signal,
        onStarted: () => terminal.log(ansi.dim("Сжимаю старую часть контекста…")),
      });
      if (result.status === "no-session") terminal.log(ansi.dim("Сессия ещё не создана."));
      else if (result.status === "not-enough-history")
        terminal.log(
          ansi.dim("Для сжатия нужно больше двух пользовательских ходов в активном контексте."),
        );
      else if (result.status === "not-smaller")
        terminal.warn(
          ansi.yellow(
            `Резюме не уменьшило контекст (~${result.before.estimatedTokens.toLocaleString("ru-RU")} → ~${result.after.estimatedTokens.toLocaleString("ru-RU")} токенов), поэтому сессия не изменена.`,
          ),
        );
      else
        terminal.log(
          ansi.green(
            `Контекст сжат: ~${result.before.estimatedTokens.toLocaleString("ru-RU")} → ~${result.after.estimatedTokens.toLocaleString("ru-RU")} токенов. Последние ${result.retainedUserTurns} хода сохранены дословно.`,
          ),
        );
    } catch (error) {
      terminal.error(
        cancel.signal.aborted
          ? ansi.yellow("Сжатие контекста отменено.")
          : ansi.red(
              `Не удалось сжать контекст: ${error instanceof Error ? error.message : String(error)}`,
            ),
      );
    } finally {
      removeInterrupt();
    }
    return "continue" as const;
  },
);

interface ModelInput {
  id?: string;
  list?: true;
}
export const modelCommand = module<ModelInput>(
  {
    name: "model",
    usage: "/model [list|id]",
    description: "Показать, запросить список или сменить модель до перезапуска.",
  },
  (args) =>
    args.length === 0
      ? {}
      : args.length === 1 && args[0] === "list"
        ? { list: true }
        : args.length === 1
          ? { id: args[0]! }
          : (() => {
              throw new CommandUsageError("Использование: /model [list|id]");
            })(),
  async (input, { options, terminal }) => {
    const { client } = options;
    try {
      if (input.list) {
        const models = await client.listModels();
        terminal.log(ansi.bold("Доступные модели:"));
        if (models.length === 0) terminal.log(ansi.dim("Provider не вернул доступные модели."));
        for (const id of models)
          terminal.log(
            `${id === client.modelDescriptor.modelId ? ansi.green("●") : ansi.dim("○")} ${id}`,
          );
      } else if (input.id === undefined)
        terminal.log(ansi.dim(`Модель: ${formatModelStatus(client.modelDescriptor)}`));
      else {
        const selection = await client.selectModel(input.id);
        terminal.log(
          ansi.dim(
            selection.changed
              ? `Модель переключена и сохранена: ${formatModelStatus(selection.descriptor)}`
              : `Модель уже активна: ${formatModelStatus(selection.descriptor)}`,
          ),
        );
        if (selection.changed && options.projectOverrides.modelId)
          terminal.warn(
            ansi.yellow("⚠ Проектная настройка model.id перекроет это значение после перезапуска."),
          );
      }
    } catch (error) {
      terminal.error(
        ansi.red(
          `${input.list ? "Не удалось получить список моделей" : "Не удалось сохранить модель"}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    return "continue" as const;
  },
);

export const updateCommand = simple(
  "update",
  "/update",
  "Проверить и установить новую версию глобально.",
  async ({ terminal, process, updates }) => {
    const info = await updates.check(VERSION, process.timeout(5_000));
    if (!info) terminal.log(ansi.dim("Вы используете актуальную версию ant."));
    else if (!info.url)
      terminal.error(ansi.red("Не удалось найти установочный файл для обновления."));
    else {
      terminal.log(ansi.dim(`Обновляю ant до ${info.version}…`));
      try {
        await updates.install(info.url);
        terminal.log(
          ansi.green(`Обновлено до ${info.version}. Перезапустите: /exit, затем ant -c.`),
        );
      } catch (error) {
        terminal.error(
          ansi.red(
            `Не удалось обновиться: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
    return "continue" as const;
  },
);

export function createBuiltinCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(
    module(
      {
        name: "help",
        usage: "/help [команда]",
        description: "Показать список команд или справку по одной команде.",
      },
      (args, commands) => {
        if (args.length > 1) throw new CommandUsageError("Использование: /help [команда]");
        if (!args[0]) return undefined;
        const requested = commands.find(args[0].replace(/^\//u, ""));
        if (!requested)
          throw new CommandUsageError(`Команда /${args[0].replace(/^\//u, "")} не найдена.`);
        return requested;
      },
      (requested, { terminal }) => {
        if (requested) terminal.log(`${ansi.bold(requested.usage)}\n${requested.description}`);
        else {
          terminal.log(ansi.bold("Доступные команды:"));
          for (const available of registry.descriptors)
            terminal.log(`  ${ansi.cyan(available.usage.padEnd(20))} ${available.description}`);
        }
        return "continue";
      },
    ),
  );
  registry.register(
    simple("new", "/new", "Начать новую сессию следующим сообщением.", ({ options, terminal }) => {
      options.client.resetSession();
      terminal.log(ansi.dim("Новая сессия будет создана следующим сообщением."));
      return "continue";
    }),
  );
  registry.register(
    simple(
      "session",
      "/session",
      "Показать идентификатор и путь текущей сессии.",
      ({ options, terminal }) => {
        const active = options.client.activeSession;
        terminal.log(
          active
            ? ansi.dim(
                `Сессия: ${active.session.id}${active.session.location ? `\nХранилище: ${active.session.location}` : ""}`,
              )
            : ansi.dim("Сессия ещё не создана."),
        );
        return "continue";
      },
    ),
  );
  registry.register(
    simple("clear", "/clear", "Очистить экран терминала.", ({ terminal }) => {
      terminal.clear();
      return "continue";
    }),
  );
  registry.register(
    simple(
      "context",
      "/context",
      "Показать приблизительное использование контекстного окна.",
      ({ options, terminal }) => {
        terminal.log(formatContextStatus(options.client.getContextStatus()));
        return "continue";
      },
    ),
  );
  registry.register(compactCommand);
  registry.register(
    module<{ mode?: ReasoningDisplayMode }>(
      {
        name: "reasoning",
        usage: "/reasoning [off|compact|full]",
        description: "Скрыть, компактно показать или полностью вывести рассуждения модели.",
      },
      (args) => {
        if (args.length === 0) return {};
        const mode = args[0] === "on" ? "compact" : args[0];
        if (args.length !== 1 || (mode !== "off" && mode !== "compact" && mode !== "full"))
          throw new CommandUsageError("Использование: /reasoning [off|compact|full]");
        return { mode };
      },
      async ({ mode }, { options, renderer, terminal }) => {
        if (!mode)
          terminal.log(
            ansi.dim(
              `Рассуждения: ${renderer.reasoningMode}${renderer.reasoningMode === "compact" ? `, ${renderer.reasoningMaxLines} строк` : ""}.`,
            ),
          );
        else {
          renderer.setReasoningMode(mode);
          try {
            await options.settings.saveReasoningMode(mode);
            terminal.log(ansi.dim(`Режим рассуждений ${mode} сохранён.`));
            if (options.projectOverrides.reasoningMode)
              terminal.warn(
                ansi.yellow(
                  "⚠ Проектная настройка ui.reasoningMode перекроет это значение после перезапуска.",
                ),
              );
          } catch (error) {
            terminal.error(
              ansi.red(
                `Не удалось сохранить настройку рассуждений: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        }
        return "continue" as const;
      },
    ),
  );
  registry.register(modelCommand);
  registry.register(
    module<{ selection?: string }>(
      {
        name: "think",
        usage: "/think [off|effort]",
        description: "Показать или сменить режим и глубину размышлений до перезапуска.",
      },
      (args) => {
        if (args.length > 1) throw new CommandUsageError("Использование: /think [off|effort]");
        return args[0] === undefined ? {} : { selection: args[0] };
      },
      async ({ selection }, { options, terminal }) => {
        const { client } = options;
        if (!selection)
          terminal.log(ansi.dim(`Режим размышлений: ${formatModelStatus(client.modelDescriptor)}`));
        else
          try {
            const result = await client.selectThinking(selection);
            terminal.log(
              ansi.dim(
                result.changed
                  ? `Рассуждения модели переключены и сохранены: ${formatModelStatus(result.descriptor)}`
                  : `Рассуждения модели уже настроены и сохранены: ${formatModelStatus(result.descriptor)}`,
              ),
            );
            if (options.projectOverrides.modelThinking)
              terminal.warn(
                ansi.yellow(
                  "⚠ Проектная настройка model.thinking перекроет это значение после перезапуска.",
                ),
              );
          } catch (error) {
            terminal.error(
              ansi.red(
                `Не удалось сохранить настройки размышлений: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        return "continue" as const;
      },
    ),
  );
  registry.register(updateCommand);
  registry.register(
    simple("exit", "/exit", "Выйти из интерактивного режима.", ({ options, terminal }) => {
      if (options.client.activeSession)
        terminal.log(
          ansi.dim(`Для продолжения сессии: ant -s ${options.client.activeSession.session.id}`),
        );
      return "exit";
    }),
  );
  return registry;
}
